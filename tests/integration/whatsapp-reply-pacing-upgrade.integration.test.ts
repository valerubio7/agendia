import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { PostgresAiJobProcessor } from "../../apps/message-worker/src/ai-job.ts";
import { AiOutboxDispatcher } from "../../apps/whatsapp-manager/src/ai-outbox-dispatcher.ts";
import { createRoleLogin, startTestPostgres, type TestPostgres } from "../support/index.ts";

const A = randomUUID(), B = randomUUID(), connection = randomUUID();
const directory = join(import.meta.dir, "../../packages/db/migrations");
let db: TestPostgres, pools: ReturnType<typeof createRuntimePools>;
const groups: Array<{
  id: string; latest: string; opener: string; opened: Date; delay: number;
  label: string; published: boolean;
}> = [];
let legacy: string, compatible: string, stale: string, policyCount: number;

beforeAll(async () => {
  db = await startTestPostgres();
  for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql") && name < "0021").sort()) {
    await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
  }
  await db.sql`insert into businesses(id,name,status) values(${A},'A','active'),(${B},'B','active')`;
  await db.sql`insert into business_profiles(business_id,display_name) values(${A},'A'),(${B},'B')`;
  await db.sql`insert into assistant_configs(business_id,active) values(${A},true),(${B},true)`;
  await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state,owner_id) values(${connection},${A},${randomUUID()},'CONNECTED','upgrade-manager')`;
  const opened = new Date(Date.now() + 60_000);
  for (const published of [false, true]) {
    for (const [label, gap, delay] of [
      ['active', 600_000, 90], ['exact-hour', 3_600_000, 90],
      ['over-hour', 3_600_001, 600], ['two-hours', 7_200_000, 600],
      ['never-replied', null, 600],
    ] as const) {
      const id = randomUUID(), opener = randomUUID(), latest = randomUUID();
      groups.push({ id, opener, latest, opened, delay, label, published });
      await db.sql`insert into conversations(id,business_id,connection_id,remote_jid,next_sequence) values(${id},${A},${connection},${id},5)`;
      if (gap !== null) {
        // A sent reply is older than the preceding accepted inbound. Its
        // provider timestamp deliberately disagrees with the trusted outbox time.
        const prior = randomUUID();
        await db.sql`insert into messages(id,business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at,processing_state) values
          (${randomUUID()},${A},${id},${connection},${randomUUID()},1,'outbound','sent',${new Date(opened.getTime()-10_800_000)},'sent'),
          (${prior},${A},${id},${connection},${randomUUID()},2,'inbound','prior',${opened},'generated')`;
        await db.sql`insert into outbox_events(business_id,topic,stable_key,payload,created_at,published_at) values(${A},'ai.generate',${prior},${db.sql.json({ businessId: A, messageId: prior })},${new Date(opened.getTime()-gap)},now())`;
      }
      for (const [message, sequence, accepted] of [[opener, 3, opened], [latest, 4, new Date(opened.getTime()+30_000)]] as const) {
        await db.sql`insert into messages(id,business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at) values(${message},${A},${id},${connection},${message},${sequence},'inbound','pending',${new Date('2099-01-01')})`;
        await db.sql`insert into outbox_events(business_id,topic,stable_key,payload,created_at,published_at) values(${A},'ai.generate',${message},${db.sql.json({ businessId: A, messageId: message })},${accepted},${published ? opened : null})`;
      }
    }
  }
  legacy = randomUUID();
  stale = randomUUID();
  await db.sql`insert into outbound_commands(outbound_id,business_id,conversation_id,connection_id,text,state,source_message_id) values
    (${legacy},${A},${groups[0]!.id},${connection},'unknown old source','generated',null),
    (${stale},${A},${groups[1]!.id},${connection},'old source','generated',${groups[1]!.opener})`;
  // Compatibility case: source-less legacy output with no newer pending burst.
  const idle = randomUUID();
  compatible = randomUUID();
  await db.sql`insert into conversations(id,business_id,connection_id,remote_jid) values(${idle},${A},${connection},${idle})`;
  await db.sql`insert into outbound_commands(outbound_id,business_id,conversation_id,connection_id,text,state) values(${compatible},${A},${idle},${connection},'legacy compatible','generated')`;
  policyCount = Number((await db.sql`select count(*) n from pg_policies where schemaname='public'`)[0]!.n);
  await db.sql.begin(async tx => {
    await tx.unsafe(await readFile(join(directory, '0021_whatsapp_reply_pacing.sql'), 'utf8'));
  });
  // Preserve the historical upgrade above, then align the current runtime schema.
  for (const name of ['0022_business_profile_cleanup.sql', '0023_assistant_config_consolidation.sql']) {
    await db.sql.unsafe(await readFile(join(directory, name), 'utf8'));
  }
  const managerUrl = await createRoleLogin(db, 'upgrade_manager', 'agendia_whatsapp_runtime');
  const workerUrl = await createRoleLogin(db, 'upgrade_worker', 'agendia_worker_runtime');
  pools = createRuntimePools({ api: managerUrl, admin: managerUrl, manager: managerUrl, worker: workerUrl });
}, 120_000);

afterAll(async () => {
  await pools?.end();
  await db?.stop();
});

const context = (businessId = A) => tenantContext({ businessId, actorId: 'upgrade', role: 'internal_worker', requestId: randomUUID() });

describe('populated WhatsApp pacing upgrade', () => {
  for (const published of [false, true]) {
    for (const label of ['active', 'exact-hour', 'over-hour', 'two-hours', 'never-replied']) {
      test(`${label}, ${published ? 'published' : 'unpublished'}: uses activity before the fixed burst opener`, async () => {
        const group = groups.find(g => g.label === label && g.published === published)!;
        const row = (await db.sql`select reply_due_at,last_exchange_at from conversations where id=${group.id}`)[0]!;
        expect(new Date(row.reply_due_at).getTime()-group.opened.getTime()).toBe(group.delay*1000);
        expect(new Date(row.last_exchange_at).getTime()).toBe(group.opened.getTime()+30_000);
        const fresh = await db.sql`select next_attempt_at,published_at,payload from outbox_events where stable_key=${`ai:pacing:${group.latest}`}`;
        expect(fresh).toHaveLength(1);
        expect(fresh[0]!.published_at).toBeNull();
        expect(fresh[0]!.next_attempt_at).toEqual(row.reply_due_at);
        expect(fresh[0]!.payload.messageId).toBe(group.latest);
      });
    }
  }

  test('NULL-source legacy output cannot consume or strand a newer pending burst', async () => {
    const before = (await db.sql`select reply_due_at from conversations where id=${groups[0]!.id}`)[0]!.reply_due_at;
    const claimed: string[] = [];
    for (let i = 0; i < 4; i++) {
      const row = await pools.manager.run(undefined, r => r.claimOwnedOutbound('upgrade-manager'));
      if (!row) break;
      claimed.push(row.outbound_id);
    }
    expect((await db.sql`select reply_due_at from conversations where id=${groups[0]!.id}`)[0]!.reply_due_at).toEqual(before);
    expect(claimed).toEqual([compatible]);
    expect((await db.sql`select state,failure_code from outbound_commands where outbound_id=${legacy}`)[0]).toMatchObject({ state: 'failed', failure_code: 'superseded' });
    expect((await db.sql`select state from outbound_commands where outbound_id=${stale}`)[0]!.state).toBe('failed');
    await db.sql`update conversations set reply_due_at=now()-interval '1 second' where id=${groups[0]!.id}`;
    expect(await pools.worker.run(context(), r => r.loadAiMessage(groups[0]!.latest, true))).not.toBeNull();
  });

  test('unknown legacy output is retired before fresh output closes the burst', async () => {
    const group = groups[0]!;
    const unknown = randomUUID();
    await db.sql`insert into outbound_commands(outbound_id,business_id,conversation_id,connection_id,text,state) values(${unknown},${A},${group.id},${connection},'unknown alongside latest','generated')`;
    const saved = await pools.worker.run(context(), r => r.saveGenerated(group.latest, A, 'latest reply'));
    expect(saved).not.toBeNull();
    const row = await pools.manager.run(undefined, r => r.claimOwnedOutbound('upgrade-manager'));
    expect(row?.outbound_id).toBe(saved!.outbound_id);
    expect((await db.sql`select state from outbound_commands where outbound_id=${unknown}`)[0]!.state).toBe('failed');
    expect((await db.sql`select reply_due_at from conversations where id=${group.id}`)[0]!.reply_due_at).toBeNull();
    await pools.manager.run(context(), r => r.finishOutbound(row!.outbound_id, 'delivery_unknown'));
    expect(await pools.manager.run(undefined, r => r.claimOwnedOutbound('upgrade-manager'))).toBeNull();
  });

  test('accepted post-upgrade input supersedes source-less legacy output atomically', async () => {
    const id = randomUUID(), unknown = randomUUID();
    await db.sql`insert into conversations(id,business_id,connection_id,remote_jid) values(${id},${A},${connection},${id})`;
    await db.sql`insert into outbound_commands(outbound_id,business_id,conversation_id,connection_id,text,state) values(${unknown},${A},${id},${connection},'old legacy output','generated')`;
    await pools.manager.run(context(), r => r.ingestInbound({
      businessId: A, connectionId: connection, providerId: randomUUID(), remoteJid: id,
      text: 'new pending burst', receivedAt: new Date('2099-01-01'), classification: 'accepted',
    }));
    expect((await db.sql`select state,failure_code from outbound_commands where outbound_id=${unknown}`)[0]).toMatchObject({ state: 'failed', failure_code: 'superseded' });
    const conversation = (await db.sql`select reply_due_at,last_exchange_at,latest_inbound_id from conversations where id=${id}`)[0]!;
    expect(new Date(conversation.reply_due_at).getTime()-new Date(conversation.last_exchange_at).getTime()).toBe(600_000);
    expect(await pools.manager.run(undefined, r => r.claimOwnedOutbound('upgrade-manager'))).toBeNull();
    expect((await db.sql`select reply_due_at from conversations where id=${id}`)[0]!.reply_due_at).toEqual(conversation.reply_due_at);
  });

  test('already-published early jobs make no provider call; a restart retains fresh wakeups', async () => {
    let calls = 0;
    const group = groups.find(g => g.published && g.label === 'over-hour')!;
    const worker = new PostgresAiJobProcessor(pools, { generate: async () => {
      calls++;
      return { text: 'reply', providerId: 'test', usageTokens: 1 };
    } });
    for (const messageId of [group.opener, group.latest]) {
      await worker.process({ businessId: A, messageId, correlationId: messageId });
    }
    expect(calls).toBe(0);
    const events: any[] = [];
    const restarted = new AiOutboxDispatcher(pools, { send: async (_name, data) => { events.push(data); return 'test'; } });
    await restarted.dispatchBatch();
    // Old non-latest events may publish early; their worker must suppress calls.
    for (const event of events) await worker.process(event);
    expect(calls).toBe(0);
    expect(await db.sql`select id from outbox_events where stable_key=${`ai:pacing:${group.latest}`} and published_at is null`).toHaveLength(1);
    await db.sql`update outbox_events set next_attempt_at=now()-interval '1 second' where stable_key=${`ai:pacing:${group.latest}`}`;
    expect(await restarted.dispatchBatch()).toBe(1);
    expect(events.at(-1).messageId).toBe(group.latest);
  });

  test('upgrade retains tenant isolation, RLS policies and narrow runtime grants', async () => {
    expect(Number((await db.sql`select count(*) n from pg_policies where schemaname='public'`)[0]!.n)).toBe(policyCount);
    expect(await pools.worker.run(context(B), r => r.loadAiMessage(groups[2]!.latest))).toBeNull();
    const grants = (await db.sql`select
      has_function_privilege('agendia_whatsapp_runtime','claim_owned_outbound(text)','EXECUTE') manager_claim,
      has_function_privilege('agendia_worker_runtime','claim_owned_outbound(text)','EXECUTE') worker_claim,
      has_column_privilege('agendia_worker_runtime','conversations','reply_due_at','UPDATE') worker_lock,
      has_column_privilege('agendia_worker_runtime','conversations','last_reply_at','UPDATE') worker_activity,
      has_column_privilege('agendia_whatsapp_runtime','outbox_events','published_at','UPDATE') manager_publish,
      has_column_privilege('agendia_whatsapp_runtime','outbox_events','next_attempt_at','UPDATE') manager_deadline`)[0]!;
    expect(grants).toMatchObject({ manager_claim: true, worker_claim: false, worker_lock: true, worker_activity: false, manager_publish: true, manager_deadline: false });
    await expect(pools.worker.run(context(B), r => r.saveGenerated(groups[2]!.latest, B, 'wrong tenant'))).resolves.toBeNull();
  });
});
