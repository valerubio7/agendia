import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { PostgresInboundHandler, type InboundWhatsAppEvent } from "../../apps/whatsapp-manager/src/inbound-handler.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
let db: TestPostgres, pools: ReturnType<typeof createRuntimePools>, handler: PostgresInboundHandler;
const context = (businessId = A) => tenantContext({ businessId, actorId: "test", role: "internal_worker", requestId: "manual-history" });
const event = (key: string, overrides: Partial<InboundWhatsAppEvent> = {}): InboundWhatsAppEvent => ({
  sessionPublicId: SA, providerMessageId: key, remoteJid: `${key}@s.whatsapp.net`,
  chatType: "individual", fromMe: false, kind: "text", text: "customer", receivedAt: 1,
  ...overrides,
});
const send = (key: string, providerId: string, overrides: Partial<InboundWhatsAppEvent> = {}) =>
  handler.handle(event(key, { providerMessageId: providerId, ...overrides }));
const conversation = async (key: string) => (await db.sql`select * from conversations where business_id=${A} and remote_jid=${`${key}@s.whatsapp.net`}`)[0]!;
const history = (key: string) => db.sql`select m.* from messages m join conversations c on c.id=m.conversation_id where c.business_id=${A} and c.remote_jid=${`${key}@s.whatsapp.net`} order by sequence`;
const eligible = async (key: string) => { await db.sql`update conversations set reply_due_at=now()-interval '1 second' where remote_jid=${`${key}@s.whatsapp.net`}`; };
const generate = async (key: string) => {
  await eligible(key);
  const c = await conversation(key);
  const output = await pools.worker.run(context(), r => r.saveGenerated(c.latest_inbound_id, A, "generated reply"));
  expect(output).not.toBeNull();
  return output!.outbound_id;
};

beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
  await db.sql`insert into businesses(id,name,status) values(${A},'A','active'),(${B},'B','active')`;
  await db.sql`insert into assistant_configs(business_id,active) values(${A},true),(${B},false)`;
  await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state,owner_id) values(${CA},${A},${SA},'CONNECTED','manual-manager'),(${CB},${B},${SB},'CONNECTED','other-manager')`;
  pools = createRuntimePools(db.container.getConnectionUri());
  handler = new PostgresInboundHandler(pools);
}, 120_000);
afterAll(async () => { await pools?.end(); await db?.stop(); });

describe("manual business history and pending automation", () => {
  test("persists ordered business text, cancels pending generation and resumes on fresh customer input", async () => {
    const key = "pending";
    await send(key, "pending-customer");
    const before = await conversation(key);
    const manual = event(key, { providerMessageId: "pending-manual", fromMe: true, text: "manual reply" });
    expect(await handler.handle(manual)).toEqual({ outcome: "accepted_business", sequence: 2 });
    expect(await handler.handle(manual)).toEqual({ outcome: "duplicate" });
    const c = await conversation(key);
    expect(c.latest_inbound_id).toBeNull();
    expect(c.reply_due_at).toBeNull();
    expect(c.last_reply_at).toEqual(c.last_exchange_at);
    expect(new Date(c.last_reply_at).getTime()).toBeGreaterThan(1);
    const turns = await history(key);
    expect(turns.map(m => [Number(m.sequence), m.direction, m.processing_state])).toEqual([[1, "inbound", "superseded"], [2, "outbound", "sent"]]);
    expect(await pools.worker.run(context(), r => r.loadAiMessage(before.latest_inbound_id, true))).toBeNull();
    expect(await pools.worker.run(context(), r => r.saveGenerated(before.latest_inbound_id, A, "stale"))).toBeNull();
    expect((await db.sql`select * from outbox_events where payload->>'messageId'=${before.latest_inbound_id} and published_at is null`)).toHaveLength(0);
    await send(key, "pending-next");
    const resumed = await conversation(key);
    const wait = new Date(resumed.reply_due_at).getTime() - new Date(resumed.last_exchange_at).getTime();
    expect(wait).toBe(90_000);
    await send(key, "pending-next-2");
    expect((await conversation(key)).reply_due_at).toEqual(resumed.reply_due_at);
  });

  test("retires generated output before claim without retracting anything sent", async () => {
    const key = "generated";
    await send(key, "generated-customer");
    const id = await generate(key);
    await send(key, "generated-manual", { fromMe: true });
    expect((await db.sql`select state from outbound_commands where outbound_id=${id}`)[0]!.state).toBe("failed");
    expect(await pools.manager.run(undefined, r => r.claimOwnedOutbound("manual-manager"))).toBeNull();
  });

  test("recognizes pre-confirmation and confirmed echoes without cancelling a newer customer burst", async () => {
    const key = "echo";
    await send(key, "echo-customer");
    const id = await generate(key);
    expect((await pools.manager.run(undefined, r => r.claimOwnedOutbound("manual-manager")))?.outbound_id).toBe(id);
    await send(key, "echo-new-customer");
    const before = await conversation(key);
    // Generated ID, not text, determines echo identity.
    expect((await send(key, id, { fromMe: true, text: "different text" })).outcome).toBe("generated_echo");
    expect((await conversation(key)).latest_inbound_id).toBe(before.latest_inbound_id);
    expect((await conversation(key)).reply_due_at).toEqual(before.reply_due_at);
    expect(await pools.manager.run(context(), r => r.finishOutbound(id, "sent", id))).toBe(true);
    expect(await pools.manager.run(context(), r => r.finishOutbound(id, "sent", id))).toBe(false);
    expect((await send(key, id, { fromMe: true })).outcome).toBe("duplicate");
    // A confirmed legacy provider ID is also recognized, without an inbox entry.
    await db.sql`update outbound_commands set provider_message_id='legacy-echo' where outbound_id=${id}`;
    expect((await send(key, "legacy-echo", { fromMe: true })).outcome).toBe("generated_echo");
    const after = await conversation(key);
    expect(after.latest_inbound_id).toBe(before.latest_inbound_id);
    expect(after.reply_due_at).toEqual(before.reply_due_at);
    expect((await history(key)).filter(m => m.direction === "outbound")).toHaveLength(1);
    expect(Number(after.next_sequence)).toBe(4);
  });

  test("manual text identical to generated text does not retract an irreversible claim", async () => {
    const key = "claimed";
    await send(key, "claimed-customer");
    const id = await generate(key);
    expect((await pools.manager.run(undefined, r => r.claimOwnedOutbound("manual-manager")))?.outbound_id).toBe(id);
    await send(key, "claimed-next");
    await send(key, "claimed-manual", { fromMe: true, text: "generated reply" });
    expect((await db.sql`select state from outbound_commands where outbound_id=${id}`)[0]!.state).toBe("sending");
    expect((await conversation(key)).reply_due_at).toBeNull();
    expect(await pools.manager.run(context(), r => r.finishOutbound(id, "delivery_unknown"))).toBe(true);
    expect(await pools.manager.run(undefined, r => r.claimOwnedOutbound("manual-manager"))).toBeNull();
    expect((await history(key)).filter(m => m.direction === "outbound")).toHaveLength(1);
  });

  test("a late generated echo after terminal send failure cannot cancel fresh work", async () => {
    const key = "late-failed-echo";
    await send(key, "late-failed-customer");
    const id = await generate(key);
    expect((await pools.manager.run(undefined, r => r.claimOwnedOutbound("manual-manager")))?.outbound_id).toBe(id);
    expect(await pools.manager.run(context(), r => r.finishOutbound(id, "failed"))).toBe(true);
    await send(key, "late-failed-next");
    const before = await conversation(key);
    expect((await send(key, id, { fromMe: true })).outcome).toBe("generated_echo");
    expect((await send(key, id, { fromMe: true })).outcome).toBe("duplicate");
    const after = await conversation(key);
    expect(after.latest_inbound_id).toBe(before.latest_inbound_id);
    expect(after.reply_due_at).toEqual(before.reply_due_at);
    expect(after.next_sequence).toBe(before.next_sequence);
    expect((await history(key)).filter(m => m.direction === "outbound")).toHaveLength(0);
    expect((await db.sql`select state from outbound_commands where outbound_id=${id}`)[0]!.state).toBe("failed");
  });

  test("serializes cancellation with concurrent generation save and outbound claim", async () => {
    const key = "locked";
    await send(key, "locked-customer");
    const id = await generate(key);
    const c = await conversation(key);
    let locked!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const manual = pools.manager.run(context(), async r => {
      await r.ingestInbound({
        businessId: A, connectionId: CA, providerId: "locked-manual",
        remoteJid: `${key}@s.whatsapp.net`, text: "manual", receivedAt: new Date(1),
        classification: "accepted_business",
      });
      locked();
      await hold;
    });
    await entered;
    const save = pools.worker.run(context(), r => r.saveGenerated(c.latest_inbound_id, A, "stale"));
    const claim = pools.manager.run(undefined, r => r.claimOwnedOutbound("manual-manager"));
    release();
    await manual;
    expect(await save).toBeNull();
    expect(await claim).toBeNull();
    expect((await db.sql`select state from outbound_commands where outbound_id=${id}`)[0]!.state).toBe("failed");
    expect((await conversation(key)).latest_inbound_id).toBeNull();
  });

  test("uses manual reply activity for active pacing and strictly over one hour idle reset", async () => {
    const key = "manual-opener";
    expect(await send(key, "manual-opener-business", { fromMe: true })).toEqual({ outcome: "accepted_business", sequence: 1 });
    const manual = await conversation(key);
    expect((await db.sql`select * from outbox_events where business_id=${A} and stable_key='ai:manual-opener-business'`)).toHaveLength(0);
    await send(key, "manual-opener-customer");
    const active = await conversation(key);
    expect(new Date(active.reply_due_at).getTime() - new Date(active.last_exchange_at).getTime()).toBe(90_000);
    await send(key, "manual-opener-cancel", { fromMe: true });
    await db.sql`update conversations set last_exchange_at=now()-interval '1 hour 1 second' where id=${manual.id}`;
    await send(key, "manual-opener-idle-customer");
    const idle = await conversation(key);
    expect(new Date(idle.reply_due_at).getTime() - new Date(idle.last_exchange_at).getTime()).toBe(600_000);
  });

  test("filters unsupported events and isolates inactive tenants with overlapping provider IDs", async () => {
    expect((await send("filter", "group", { fromMe: true, chatType: "group" })).outcome).toBe("ignored_group");
    expect((await send("filter", "media", { fromMe: true, kind: "image", text: null })).outcome).toBe("ignored_non_text");
    expect((await send("filter", "unknown", { sessionPublicId: "cccccccc-1111-4111-8111-111111111111", fromMe: true })).outcome).toBe("unknown_session");
    expect(await history("filter")).toHaveLength(0);
    expect((await send("tenants", "shared-manual", { fromMe: true })).outcome).toBe("accepted_business");
    expect((await send("tenants", "shared-manual", { sessionPublicId: SB, fromMe: true })).outcome).toBe("accepted_business");
    const a = await conversation("tenants");
    expect(await pools.manager.run(context(B), r => r.loadSummarySource(a.id, 1))).toBeNull();
    expect((await db.sql`select * from outbox_events where business_id=${B}`)).toHaveLength(0);
  });
});
