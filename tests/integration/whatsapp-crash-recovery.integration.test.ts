import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { PostgresWhatsAppManager, type BaileysLifecycleEvent } from "../../apps/whatsapp-manager/src/connection.ts";
import { PostgresOutboundDispatcher } from "../../apps/whatsapp-manager/src/outbound.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

let db: TestPostgres, pools: ReturnType<typeof createRuntimePools>;
const managers: PostgresWhatsAppManager[] = [];
beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(db.container.getConnectionUri());
}, 120_000);
afterEach(async () => {
  for (const manager of managers) await manager.stop();
  await db.sql`update businesses set status='suspended'`;
});
afterAll(async () => {
  for (const manager of managers) await manager.stop();
  await pools?.end();
  await db?.stop();
});

async function fixture(state = "CONNECTED") {
  const business = randomUUID(), connection = randomUUID(), conversation = randomUUID();
  const context = tenantContext({ businessId: business, actorId: "reused-manager", role: "internal_worker", requestId: randomUUID() });
  await db.sql`insert into businesses(id,name) values(${business},'Recovery')`;
  await db.sql`insert into whatsapp_connections(id,business_id,state) values(${connection},${business},${state})`;
  await db.sql`insert into conversations(id,business_id,connection_id,remote_jid) values(${conversation},${business},${connection},'test@s.whatsapp.net')`;
  const generate = async () => (await db.sql`insert into outbound_commands(business_id,connection_id,conversation_id,text,state)
    values(${business},${connection},${conversation},'test reply','generated') returning outbound_id`)[0]!.outbound_id as string;
  const request = async () => (await db.sql`insert into outbox_events(business_id,topic,stable_key,payload)
    values(${business},'whatsapp.link_requested',${randomUUID()},'{}') returning id`)[0]!.id as string;
  const ownership = async () => (await db.sql`select * from whatsapp_connections where id=${connection}`)[0]!.ownership_token as string;
  return { business, connection, context, generate, request, ownership };
}

function gatewayManager() {
  let emit!: (event: BaileysLifecycleEvent) => unknown, connections = 0;
  const manager = new PostgresWhatsAppManager(pools, "reused-manager", () => ({
    connect: async (_id, callback) => {
      connections++;
      emit = callback;
      let close!: () => void;
      const closed = new Promise<void>(resolve => { close = resolve; });
      return { closed, close };
    },
  }));
  managers.push(manager);
  return { manager, emit: async (event: BaileysLifecycleEvent) => { await emit(event); }, connections: () => connections };
}

for (const boundary of ["before transport", "after provider acceptance"] as const) {
  test(`takeover recovers committed sending ${boundary}, fences reused IDs and never resends`, async () => {
    const f = await fixture(), first = gatewayManager(), second = gatewayManager();
    await first.manager.restart();
    const id = await f.generate(), oldToken = await f.ownership();
    let sends = 0, acknowledge!: () => void, accepted!: () => void;
    const acceptance = new Promise<void>(resolve => { accepted = resolve; });
    const pending = new Promise<void>(resolve => { acknowledge = resolve; });
    let dispatch: Promise<boolean> | undefined;
    if (boundary === "before transport") {
      const claim = await pools.manager.run(undefined, r => r.claimOwnedOutbound("reused-manager", [oldToken]));
      expect(claim?.outbound_id).toBe(id);
    } else {
      dispatch = new PostgresOutboundDispatcher(pools, { send: async () => {
        sends++;
        accepted();
        await pending;
        return { outcome: "ack", providerMessageId: id };
      } }, "reused-manager", () => [oldToken]).dispatchNext();
      await acceptance;
    }
    try {
      expect((await db.sql`select state from outbound_commands where outbound_id=${id}`)[0]!.state).toBe("sending");
      // A second live manager, even reusing the same configured ID, cannot recover or send this work.
      await second.manager.restart();
      expect(second.connections()).toBe(0);
      expect((await db.sql`select state from outbound_commands where outbound_id=${id}`)[0]!.state).toBe("sending");
      expect(await pools.manager.run(undefined, r => r.claimOwnedOutbound("reused-manager", [randomUUID()]))).toBeNull();
      // Drop the old lifetime lease without ever finishing the committed claim.
      await first.manager.stop();
      await second.manager.restart();
      expect((await db.sql`select state,failure_code from outbound_commands where outbound_id=${id}`)[0]).toMatchObject({ state: "delivery_unknown", failure_code: "delivery_unknown" });
      expect(await f.ownership()).not.toBe(oldToken);
      expect(await db.sql`select id from audit_events where business_id=${f.business} and event_type='whatsapp.delivery_unknown'`).toHaveLength(1);
      expect(await db.sql`select id from technical_events where business_id=${f.business} and code='whatsapp.delivery_unknown'`).toHaveLength(1);
      acknowledge();
      if (dispatch) await dispatch;
      expect(await pools.manager.run(f.context, r => r.finishOutbound(id, "sent", id, oldToken))).toBe(false);
      await first.emit({ type: "logout" });
      await first.emit({ type: "qr", value: "obsolete-test-qr" });
      expect((await db.sql`select state from whatsapp_connections where id=${f.connection}`)[0]!.state).toBe("CONNECTED");
      expect(await db.sql`select token from whatsapp_link_codes where connection_id=${f.connection}`).toHaveLength(0);
      const retry = new PostgresOutboundDispatcher(pools, { send: async () => {
        sends++;
        return { outcome: "ack", providerMessageId: id };
      } }, "reused-manager", () => second.manager.ownershipTokens());
      expect(await retry.dispatchNext()).toBe(false);
      expect(sends).toBe(boundary === "before transport" ? 0 : 1);
      expect((await db.sql`select state from outbound_commands where outbound_id=${id}`)[0]!.state).toBe("delivery_unknown");
      // A stale process cannot claim OR finish fresh work, even with the same manager ID.
      const fresh = await f.generate(), newToken = await f.ownership();
      expect(await pools.manager.run(undefined, r => r.claimOwnedOutbound("reused-manager", [oldToken]))).toBeNull();
      expect(await pools.manager.run(undefined, r => r.claimOwnedOutbound("reused-manager", [randomUUID()]))).toBeNull();
      expect((await pools.manager.run(undefined, r => r.claimOwnedOutbound("reused-manager", [newToken])))?.outbound_id).toBe(fresh);
      expect(await pools.manager.run(f.context, r => r.finishOutbound(fresh, "sent", fresh, oldToken))).toBe(false);
      expect((await db.sql`select state from outbound_commands where outbound_id=${fresh}`)[0]!.state).toBe("sending");
      await pools.manager.run(f.context, r => r.releaseWhatsApp(f.connection, "reused-manager", oldToken));
      expect(await f.ownership()).toBe(newToken);
      expect(await pools.manager.run(f.context, r => r.finishOutbound(fresh, "sent", fresh, newToken))).toBe(true);
    } finally {
      acknowledge();
      await dispatch;
      await first.manager.stop();
      await second.manager.stop();
    }
  }, 20_000);
}

test("a link claim stays unpublished until durable admission and expires with token fencing", async () => {
  const f = await fixture("LINK_REQUIRED"), id = await f.request();
  const oldToken = randomUUID(), newToken = randomUUID();
  expect((await pools.manager.run(undefined, r => r.claimWhatsAppLink(oldToken)))?.command_id).toBe(id);
  expect((await db.sql`select published_at from outbox_events where id=${id}`)[0]!.published_at).toBeNull();
  expect(await pools.manager.run(undefined, r => r.claimWhatsAppLink(newToken))).toBeNull();
  await db.sql`update outbox_events set claimed_at=now()-interval '1 minute' where id=${id}`;
  expect((await pools.manager.run(undefined, r => r.claimWhatsAppLink(newToken)))?.command_id).toBe(id);
  expect(await pools.manager.run(f.context, r => r.admitWhatsAppLink(f.connection, id, oldToken))).toBe(false);
  const manager = gatewayManager();
  await db.sql`update outbox_events set claimed_at=now()-interval '1 minute' where id=${id}`;
  expect(await manager.manager.processNext()).toBe(true);
  expect(manager.connections()).toBe(1);
  expect((await db.sql`select published_at from outbox_events where id=${id}`)[0]!.published_at).not.toBeNull();
  await manager.manager.stop();
}, 20_000);

test("admitted link replay preserves new auth, restores interrupted linking but not deliberate logout", async () => {
  const f = await fixture("LINK_REQUIRED"), id = await f.request(), token = randomUUID();
  await pools.manager.run(undefined, r => r.claimWhatsAppLink(token));
  expect(await pools.manager.run(f.context, r => r.admitWhatsAppLink(f.connection, id, token))).toBe(true);
  // Admission committed; emulate socket credentials saved before the process died, before ACK.
  await db.sql`insert into whatsapp_auth_records(business_id,connection_id,record_name,version,ciphertext,nonce,auth_tag)
    values(${f.business},${f.connection},'test-creds',1,decode('01','hex'),decode('02','hex'),decode('03','hex'))`;
  const restored = gatewayManager();
  expect(await restored.manager.restart()).toContain(f.connection);
  await db.sql`update outbox_events set claimed_at=now()-interval '1 minute' where id=${id}`;
  await restored.manager.processNext();
  expect(await db.sql`select record_name from whatsapp_auth_records where connection_id=${f.connection}`).toHaveLength(1);
  expect((await db.sql`select published_at from outbox_events where id=${id}`)[0]!.published_at).not.toBeNull();
  // Replaying the same admitted command under a fresh claim must not reset credentials either.
  await db.sql`update outbox_events set published_at=null,claim_token=null,claimed_at=null where id=${id}`;
  await restored.manager.stop();
  const replay = gatewayManager();
  expect(await replay.manager.processNext()).toBe(true);
  expect(await db.sql`select record_name from whatsapp_auth_records where connection_id=${f.connection}`).toHaveLength(1);
  await replay.emit({ type: "logout" });
  await replay.manager.stop();
  // Even an unacknowledged old request cannot turn a deliberate logout into relinking.
  await db.sql`update outbox_events set published_at=null,claim_token=null,claimed_at=null where id=${id}`;
  const afterLogout = gatewayManager();
  expect(await afterLogout.manager.restart()).not.toContain(f.connection);
  expect(await afterLogout.manager.processNext()).toBe(true);
  expect(afterLogout.connections()).toBe(0);
  expect(await afterLogout.manager.processNext()).toBe(false);
}, 20_000);

test("replaying an older admitted link after a newer request cannot clear current credentials", async () => {
  const f = await fixture("LINK_REQUIRED"), oldCommand = await f.request();
  const first = gatewayManager();
  expect(await first.manager.processNext()).toBe(true);
  await first.manager.stop();
  const newer = await f.request(), second = gatewayManager();
  expect(await second.manager.processNext()).toBe(true);
  await second.manager.stop();
  await db.sql`insert into whatsapp_auth_records(business_id,connection_id,record_name,version,ciphertext,nonce,auth_tag)
    values(${f.business},${f.connection},'new-test-creds',1,decode('01','hex'),decode('02','hex'),decode('03','hex'))`;
  await db.sql`update outbox_events set published_at=null,claim_token=null,claimed_at=null where id=${oldCommand}`;
  const replay = gatewayManager();
  expect(await replay.manager.processNext()).toBe(true);
  expect(replay.connections()).toBe(0);
  expect((await db.sql`select link_command_id from whatsapp_connections where id=${f.connection}`)[0]!.link_command_id).toBe(newer);
  expect(await db.sql`select record_name from whatsapp_auth_records where connection_id=${f.connection}`).toHaveLength(1);
  expect(await replay.manager.restart()).toContain(f.connection);
}, 20_000);

test("link acknowledgement rejects expired claims, stale ownership and cross-tenant admission", async () => {
  const f = await fixture("LINK_REQUIRED"), other = await fixture("LINK_REQUIRED");
  const id = await f.request(), claim = randomUUID();
  await pools.manager.run(undefined, r => r.claimWhatsAppLink(claim));
  expect(await pools.manager.run(other.context, r => r.admitWhatsAppLink(other.connection, id, claim))).toBe(false);
  expect(await pools.manager.run(f.context, r => r.admitWhatsAppLink(f.connection, id, claim))).toBe(true);
  const first = gatewayManager();
  await first.manager.restart();
  const oldOwnership = await f.ownership();
  await first.manager.stop();
  const second = gatewayManager();
  await second.manager.restart();
  const current = await f.ownership();
  expect(await pools.manager.run(f.context, r => r.completeWhatsAppLink(id, claim, oldOwnership))).toBe(false);
  expect(await pools.manager.run(f.context, r => r.completeWhatsAppLink(id, randomUUID(), current))).toBe(false);
  await db.sql`update outbox_events set claimed_at=now()-interval '1 minute' where id=${id}`;
  expect(await pools.manager.run(f.context, r => r.completeWhatsAppLink(id, claim, current))).toBe(false);
  const freshClaim = randomUUID();
  await pools.manager.run(undefined, r => r.claimWhatsAppLink(freshClaim));
  expect(await pools.manager.run(f.context, r => r.completeWhatsAppLink(id, freshClaim, current))).toBe(true);
  expect(await db.sql`select id from outbox_events where id=${id} and published_at is not null`).toHaveLength(1);
}, 20_000);

test("an old link acknowledgement waits for concurrent takeover and then loses its fence", async () => {
  const f = await fixture("LINK_REQUIRED"), id = await f.request(), claim = randomUUID();
  await pools.manager.run(undefined, r => r.claimWhatsAppLink(claim));
  await pools.manager.run(f.context, r => r.admitWhatsAppLink(f.connection, id, claim));
  const first = gatewayManager();
  await first.manager.restart();
  const oldOwnership = await f.ownership();
  await first.manager.stop();
  // A dead process leaves its persisted identity even though its advisory session is gone.
  await db.sql`update whatsapp_connections set owner_id='reused-manager',ownership_token=${oldOwnership} where id=${f.connection}`;
  const unlock = await pools.manager.reserveAdvisoryLock(f.connection);
  expect(unlock).not.toBeNull();
  let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { resume = resolve; });
  const takeover = pools.manager.run(f.context, async r => {
    await r.takeOverWhatsApp(f.connection, "reused-manager", randomUUID(), new Date());
    entered();
    await hold;
  });
  try {
    await ready;
    const oldAck = pools.manager.run(f.context, r => r.completeWhatsAppLink(id, claim, oldOwnership));
    expect(await Promise.race([oldAck.then(() => "completed"), Bun.sleep(100).then(() => "blocked")])).toBe("blocked");
    resume();
    await takeover;
    expect(await oldAck).toBe(false);
    expect((await db.sql`select published_at from outbox_events where id=${id}`)[0]!.published_at).toBeNull();
  } finally {
    resume();
    await takeover;
    await unlock?.();
  }
}, 20_000);

test("recovery bootstrap functions retain active tenant joins and manager-only grants", async () => {
  const f = await fixture("LINK_REQUIRED"), id = await f.request();
  await db.sql`update businesses set status='suspended' where id=${f.business}`;
  expect(await pools.manager.run(undefined, r => r.claimWhatsAppLink(randomUUID()))).toBeNull();
  expect(await pools.manager.run(undefined, r => r.restorableWhatsApp())).not.toContainEqual({ id: f.connection, business_id: f.business });
  expect((await db.sql`select published_at from outbox_events where id=${id}`)[0]!.published_at).toBeNull();
  for (const name of ["claim_whatsapp_link_command", "complete_whatsapp_link_command", "restorable_whatsapp_connections", "claim_owned_outbound"]) {
    const functions = await db.sql`select p.oid,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=${name}`;
    expect(functions).toHaveLength(1);
    const fn = functions[0]!;
    expect(fn.proconfig).toContain("search_path=public, pg_temp");
    const grants = (await db.sql`select has_function_privilege('agendia_whatsapp_runtime',${fn.oid}::oid,'EXECUTE') manager,
      has_function_privilege('agendia_worker_runtime',${fn.oid}::oid,'EXECUTE') worker,
      has_function_privilege('agendia_runtime',${fn.oid}::oid,'EXECUTE') api`)[0]!;
    expect(grants).toEqual({ manager: true, worker: false, api: false });
  }
});
