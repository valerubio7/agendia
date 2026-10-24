import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AiProvider, ToolConversationProvider } from "@agendia/domain";
import { join } from "node:path";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { PostgresAiJobProcessor } from "../../apps/message-worker/src/jobs/ai-job.ts";
import { AiOutboxDispatcher } from "../../apps/whatsapp-manager/src/ai-outbox.ts";
import { applyPostgresMigrations, createRoleLogin, startTestPostgres, type TestPostgres } from "../support/index.ts";

const A = randomUUID(), B = randomUUID(), connection = randomUUID(), ownership = randomUUID();
let db: TestPostgres, pools: ReturnType<typeof createRuntimePools>;
const context = (businessId = A) => tenantContext({ businessId, actorId: "pacing", role: "internal_worker", requestId: randomUUID() });

beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
  await db.sql`insert into businesses(id,name,status) values(${A},'A','active'),(${B},'B','active')`;
  await db.sql`insert into business_profiles(business_id,display_name) values(${A},'A'),(${B},'B')`;
  await db.sql`insert into assistant_configs(business_id,active) values(${A},true),(${B},true)`;
  await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state,owner_id,ownership_token)
    values(${connection},${A},${randomUUID()},'CONNECTED','pacing-manager',${ownership})`;
  const managerUrl = await createRoleLogin(db, "pacing_manager", "agendia_whatsapp_runtime");
  const workerUrl = await createRoleLogin(db, "pacing_worker", "agendia_worker_runtime");
  pools = createRuntimePools({ api: managerUrl, admin: managerUrl, manager: managerUrl, worker: workerUrl });
}, 120_000);
afterAll(async () => {
  await pools?.end();
  await db?.stop();
});

async function inbound(remoteJid: string) {
  const providerId = randomUUID();
  await pools.manager.run(context(), r => r.ingestInbound({
    businessId: A, connectionId: connection, providerId, remoteJid,
    text: "pending burst", receivedAt: new Date("2099-01-01"), classification: "accepted",
  }));
  return (await db.sql`select id,conversation_id from messages where business_id=${A} and provider_message_id=${providerId}`)[0]!;
}
async function burst() {
  const remote = randomUUID();
  const opener = await inbound(remote), latest = await inbound(remote);
  return { id: latest.conversation_id as string, opener: opener.id as string, latest: latest.id as string };
}
async function output(conversationId: string, source: string | null = null) {
  const id = randomUUID();
  await db.sql`insert into outbound_commands(outbound_id,business_id,conversation_id,connection_id,text,state,source_message_id)
    values(${id},${A},${conversationId},${connection},'existing output','generated',${source})`;
  return id;
}
const claim = () => pools.manager.run(undefined, r => r.claimOwnedOutbound("pacing-manager", [ownership]));

describe("current WhatsApp reply pacing", () => {
  test("source-less and stale output cannot consume or strand a newer pending burst", async () => {
    const group = await burst(), staleGroup = await burst();
    const unknown = await output(group.id), stale = await output(staleGroup.id, staleGroup.opener);
    const idle = randomUUID();
    await db.sql`insert into conversations(id,business_id,connection_id,remote_jid) values(${idle},${A},${connection},${idle})`;
    const compatible = await output(idle);
    const before = (await db.sql`select reply_due_at from conversations where id=${group.id}`)[0]!.reply_due_at;
    expect((await claim())?.outbound_id).toBe(compatible);
    expect(await claim()).toBeNull();
    expect((await db.sql`select reply_due_at from conversations where id=${group.id}`)[0]!.reply_due_at).toEqual(before);
    for (const id of [unknown, stale]) {
      expect((await db.sql`select state,failure_code from outbound_commands where outbound_id=${id}`)[0])
        .toEqual({ state: "failed", failure_code: "superseded" });
    }
    await db.sql`update conversations set reply_due_at=now()-interval '1 second' where id=${group.id}`;
    expect(await pools.worker.run(context(), r => r.loadAiMessage(group.latest, true))).not.toBeNull();
  });

  test("unknown output is retired before fresh output closes the burst", async () => {
    const group = await burst(), unknown = await output(group.id);
    await db.sql`update conversations set reply_due_at=now()-interval '1 second' where id=${group.id}`;
    const saved = await pools.worker.run(context(), r => r.saveGenerated(group.latest, A, "latest reply"));
    expect(saved).not.toBeNull();
    const row = await claim();
    expect(row?.outbound_id).toBe(saved!.outbound_id);
    expect((await db.sql`select state,failure_code from outbound_commands where outbound_id=${unknown}`)[0])
      .toEqual({ state: "failed", failure_code: "superseded" });
    expect((await db.sql`select reply_due_at from conversations where id=${group.id}`)[0]!.reply_due_at).toBeNull();
    await pools.manager.run(context(), r => r.finishOutbound(row!.outbound_id, "delivery_unknown", undefined, ownership));
    expect(await claim()).toBeNull();
  });

  test("accepted inbound supersedes source-less output atomically using the trusted clock", async () => {
    const id = randomUUID();
    await db.sql`insert into conversations(id,business_id,connection_id,remote_jid) values(${id},${A},${connection},${id})`;
    const unknown = await output(id);
    await inbound(id);
    expect((await db.sql`select state,failure_code from outbound_commands where outbound_id=${unknown}`)[0])
      .toEqual({ state: "failed", failure_code: "superseded" });
    const conversation = (await db.sql`select reply_due_at,last_exchange_at,latest_inbound_id from conversations where id=${id}`)[0]!;
    expect(new Date(conversation.reply_due_at).getTime()-new Date(conversation.last_exchange_at).getTime()).toBe(600_000);
    expect(new Date(conversation.last_exchange_at).getFullYear()).not.toBe(2099);
    expect(await claim()).toBeNull();
    expect((await db.sql`select reply_due_at from conversations where id=${id}`)[0]!.reply_due_at).toEqual(conversation.reply_due_at);
  });

  test("already-published early jobs make no provider call; a restart retains the current wakeup", async () => {
    const group = await burst();
    let calls = 0;
    const worker = new PostgresAiJobProcessor(pools, {
      generate: async () => { throw new Error("Unexpected generate"); },
      converse: async () => {
        calls++;
        return { message: { role: "assistant", content: "reply", toolCalls: [] }, providerId: "test", usageTokens: 1 };
      },
    } as AiProvider & ToolConversationProvider);
    // The superseded opener was published during ingestion; either job can still arrive early.
    expect((await db.sql`select published_at from outbox_events where payload->>'messageId'=${group.opener}`)[0]!.published_at).not.toBeNull();
    for (const messageId of [group.opener, group.latest]) {
      await worker.process({ businessId: A, messageId, correlationId: messageId });
    }
    expect(calls).toBe(0);
    const [wake] = await db.sql`select id,next_attempt_at,published_at from outbox_events where payload->>'messageId'=${group.latest}`;
    const [conversation] = await db.sql`select reply_due_at from conversations where id=${group.id}`;
    expect(wake!.published_at).toBeNull();
    expect(wake!.next_attempt_at).toEqual(conversation!.reply_due_at);
    const events: any[] = [];
    const restarted = new AiOutboxDispatcher(pools, { send: async (_name, data) => { events.push(data); return "test"; } });
    expect(await restarted.dispatchBatch()).toBe(0);
    expect(await db.sql`select id from outbox_events where id=${wake!.id} and published_at is null`).toHaveLength(1);
    await db.sql`update outbox_events set next_attempt_at=now()-interval '1 second' where id=${wake!.id}`;
    expect(await restarted.dispatchBatch()).toBe(1);
    expect(events.at(-1).messageId).toBe(group.latest);
    for (const event of events) await worker.process(event);
    expect(calls).toBe(0);
  });

  test("tenant isolation, current policies and narrow runtime grants remain enforced", async () => {
    const group = await burst();
    const policies = await db.sql`select policyname,cmd,roles from pg_policies where schemaname='public' and tablename='conversations'`;
    expect([...policies]).toEqual([{ policyname: "conversations_internal", cmd: "ALL", roles: ["agendia_whatsapp_runtime", "agendia_worker_runtime"] }]);
    expect(await pools.worker.run(context(B), r => r.loadAiMessage(group.latest))).toBeNull();
    const grants = (await db.sql`select
      has_function_privilege('agendia_whatsapp_runtime','claim_owned_outbound(text,uuid[])','EXECUTE') manager_claim,
      has_function_privilege('agendia_worker_runtime','claim_owned_outbound(text,uuid[])','EXECUTE') worker_claim,
      has_column_privilege('agendia_worker_runtime','conversations','reply_due_at','UPDATE') worker_lock,
      has_column_privilege('agendia_worker_runtime','conversations','last_reply_at','UPDATE') worker_activity,
      has_column_privilege('agendia_whatsapp_runtime','outbox_events','published_at','UPDATE') manager_publish,
      has_column_privilege('agendia_whatsapp_runtime','outbox_events','next_attempt_at','UPDATE') manager_deadline`)[0]!;
    expect(grants).toEqual({ manager_claim: true, worker_claim: false, worker_lock: true, worker_activity: false, manager_publish: true, manager_deadline: false });
    const before = [...await db.sql`select * from messages where conversation_id=${group.id}`];
    expect(await pools.worker.run(context(B), r => r.saveGenerated(group.latest, B, "wrong tenant"))).toBeNull();
    expect([...await db.sql`select * from messages where conversation_id=${group.id}`]).toEqual(before);
    expect(await db.sql`select outbound_id from outbound_commands where conversation_id=${group.id}`).toHaveLength(0);
  });
});
