import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Algorithm, hash } from "@node-rs/argon2";
import { createRuntimePools } from "@agendia/db";
import { buildApi } from "../../apps/api/src/app.ts";
import { PostgresAiJobProcessor, PostgresSummaryJobProcessor } from "../../apps/message-worker/src/jobs/ai-job.ts";
import { PostgresOutboundDispatcher } from "../../apps/whatsapp-manager/src/outbound.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/postgres.ts";

let database: TestPostgres;
const target = "10000000-0000-0000-0000-000000000001";
const other = "20000000-0000-0000-0000-000000000002";
const rollback = "30000000-0000-4000-8000-000000000003";
const tables = ["tenant_records", "business_profiles", "agent_configs", "technical_events", "outbox_events", "inbox_events", "whatsapp_connections", "whatsapp_auth_records", "whatsapp_link_codes", "conversations", "messages", "conversation_summaries", "outbound_commands", "services", "service_categories", "clients", "business_calendars", "business_calendar_closures", "resources", "resource_services", "appointments", "appointment_operation_receipts", "whatsapp_sender_bindings", "whatsapp_received_senders", "whatsapp_agenda_dialogues", "whatsapp_agenda_receipts"];

async function seed(id: string) {
  const sql = database.sql;
  await sql`insert into businesses(id,name) values (${id}, 'Business')`;
  const [identity] = await sql`insert into auth_identities(normalized_email,password_phc,role,business_id) values (${id + '@example.test'}, 'hash', 'business_user', ${id}) returning id`;
  await sql`insert into web_sessions(identity_id,token_sha256,csrf_sha256,absolute_expires_at,idle_expires_at) values (${identity!.id}, ${id}, 'csrf', now() + interval '1 day', now() + interval '1 day')`;
  await sql`insert into audit_events(business_id,actor_id,event_type,outcome,request_id,stream_sequence,previous_hash,event_hash,hmac_key_version,metadata) values (${id}, 'actor', 'historical', 'success', 'request', 1, 'GENESIS', ${'a'.repeat(64)}, 'v1', '{"personal":"retained"}'), (${id}, 'actor', 'historical', 'success', 'request', 2, ${'a'.repeat(64)}, ${'b'.repeat(64)}, 'v1', '{}')`;
  await sql`insert into tenant_records(business_id,value) values (${id}, 'value')`;
  await sql`insert into business_profiles(business_id,display_name) values (${id}, 'profile')`;
  await sql`insert into agent_configs(business_id) values (${id})`;
  await sql`insert into technical_events(business_id,component,code,severity) values (${id}, 'test', 'test', 'info')`;
  await sql`insert into outbox_events(business_id,topic,stable_key,payload) values (${id}, 'test', 'test', '{}')`;
  await sql`insert into inbox_events(business_id,source,stable_key) values (${id}, 'test', 'test')`;
  const [connection] = await sql`insert into whatsapp_connections(business_id) values (${id}) returning id`;
  const c = connection!.id;
  await sql`insert into whatsapp_auth_records(business_id,connection_id,record_name,version,nonce,ciphertext,auth_tag) values (${id},${c},'secret',1,'x','x','x')`;
  await sql`insert into whatsapp_link_codes(business_id,connection_id,token,ciphertext,nonce,auth_tag,expires_at) values (${id},${c},gen_random_uuid(),'x',decode(repeat('00',12),'hex'),decode(repeat('00',16),'hex'),now())`;
  const [conversation] = await sql`insert into conversations(business_id,connection_id,remote_jid) values (${id},${c},'jid') returning id`;
  const conv = conversation!.id;
  const [message] = await sql`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at) values (${id},${conv},${c},'provider',1,'inbound','text',now()) returning id`;
  const msg = message!.id;
  await sql`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) values (${id},${conv},1,1,'{}')`;
  const [outbound] = await sql`insert into outbound_commands(business_id,conversation_id,connection_id,text) values (${id},${conv},${c},'text') returning outbound_id`;
  await sql`insert into whatsapp_sender_bindings(business_id,connection_id,phone,pn_jid) values (${id},${c},'+12345678','jid')`;
  await sql`insert into whatsapp_received_senders(business_id,message_id,connection_id,phone) values (${id},${msg},${c},'+12345678')`;
  await sql`insert into whatsapp_agenda_dialogues(business_id,connection_id,phone,dialogue) values (${id},${c},'+12345678','{}')`;
  await sql`insert into whatsapp_agenda_receipts(business_id,message_id,outbound_id,operation) values (${id},${msg},${outbound!.outbound_id},'create')`;
  const [category] = await sql`insert into service_categories(business_id,name) values (${id},'category') returning id`;
  const [service] = await sql`insert into services(business_id,name,duration_minutes,price_ars,category_id) values (${id},'service',15,1,${category!.id}) returning id`;
  const [client] = await sql`insert into clients(business_id,first_name,last_name,phone) values (${id},'first','last','+12345678') returning id`;
  await sql`insert into business_calendars(business_id,weekly_schedule) values (${id},'{}')`;
  await sql`insert into business_calendar_closures(business_id,kind,closed_date) values (${id},'date','2026-01-01')`;
  const [resource] = await sql`insert into resources(business_id,name,weekly_schedule) values (${id},'resource','{}') returning id`;
  await sql`insert into resource_services(business_id,resource_id,service_id) values (${id},${resource!.id},${service!.id})`;
  await sql`insert into appointments(business_id,client_id,service_id,resource_id,service_label,resource_label,price_ars,duration_minutes,start_raw,start_ms,end_ms,state,origin) values (${id},${client!.id},${service!.id},${resource!.id},'service','resource',1,15,'time',0,900000,'confirmed','manual')`;
  await sql`insert into appointment_operation_receipts(business_id,actor_id,operation_key,kind,state) values (${id},${identity!.id},gen_random_uuid(),'create','cancelled')`;
}

async function inventory(id: string) {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await database.sql.unsafe(`select count(*)::int as count from ${table} where business_id = $1`, [id]);
    counts[table] = rows[0]!.count;
  }
  counts.auth_identities = Number((await database.sql`select count(*)::int as count from auth_identities where business_id=${id}`)[0]!.count);
  counts.web_sessions = Number((await database.sql`select count(*)::int as count from web_sessions s join auth_identities i on i.id=s.identity_id where i.business_id=${id}`)[0]!.count);
  return counts;
}

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, '../../packages/db/migrations'));
  for (const id of [target, other, rollback]) await seed(id);
  await database.sql.unsafe(`create function test_reject_service_delete() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$; create trigger test_reject_service_delete before delete on services for each row when (old.business_id = '${rollback}'::uuid) execute function test_reject_service_delete()`);
}, 120_000);
afterAll(async () => { await database?.stop(); });

test('purges the complete tenant inventory, retains audit and other tenant, and releases email', async () => {
  const before = await inventory(target);
  expect(Object.values(before).every(n => n === 1)).toBe(true);
  const otherBefore = await inventory(other);
  const audit = await database.sql`select * from audit_events order by business_id,stream_sequence`;
  await database.sql`select purge_business_data_private(${target})`;
  expect(Object.values(await inventory(target)).every(n => n === 0)).toBe(true);
  expect(await inventory(other)).toEqual(otherBefore);
  expect(Array.from(await database.sql`select * from audit_events order by business_id,stream_sequence`)).toEqual(Array.from(audit));
  const retained = await database.sql`select id,name,status from businesses where id=${target}`;
  expect(Array.from(retained)).toEqual([{ id: target, name: 'Business', status: 'suspended' }]);
  const submitted = await database.sql`select submit_registration('New business', ${target + '@example.test'}, '$argon2id$test') as accepted`;
  expect(submitted[0]!.accepted).toBe(true);
});

test('failure rolls back every deletion and the retained business state', async () => {
  const before = await inventory(rollback);
  const audit = await database.sql`select * from audit_events where business_id=${rollback} order by stream_sequence`;
  await expect((async () => { await database.sql`select purge_business_data_private(${rollback})`; })()).rejects.toThrow('injected failure');
  expect(await inventory(rollback)).toEqual(before);
  expect(Array.from(await database.sql`select * from audit_events where business_id=${rollback} order by stream_sequence`)).toEqual(Array.from(audit));
  expect((await database.sql`select status from businesses where id=${rollback}`)[0]!.status).toBe('active');
});

test('cross-tenant receipt survives while the referenced identity loses access and its email is reusable', async () => {
  const id = '40000000-0000-4000-8000-000000000004';
  const email = id + '@example.test';
  const password = 'secure registration password';
  const origin = 'https://panel.agendia.test';
  await seed(id);
  await database.sql`update auth_identities set password_phc=${await hash(password, { algorithm: Algorithm.Argon2id })} where business_id=${id}`;
  const [identity] = await database.sql`select id from auth_identities where business_id=${id}`;
  await database.sql`insert into appointment_operation_receipts(business_id,actor_id,operation_key,kind,state) values (${other},${identity!.id},gen_random_uuid(),'create','cancelled')`;
  const receipts = await database.sql`select * from appointment_operation_receipts where business_id=${other} order by actor_id,operation_key`;
  const pools = createRuntimePools(database.container.getConnectionUri());
  const app = buildApi({ pools, expectedOrigin: origin });
  try {
    const login = () => app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { email, password } });
    const signedIn = await login();
    expect(signedIn.statusCode).toBe(200);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!;
    const audit = await database.sql`select * from audit_events where business_id=${id} order by stream_sequence`;
    await database.sql`select purge_business_data_private(${id})`;
    expect(Array.from(await database.sql`select * from appointment_operation_receipts where business_id=${other} order by actor_id,operation_key`)).toEqual(Array.from(receipts));
    expect(Array.from(await database.sql`select * from audit_events where business_id=${id} order by stream_sequence`)).toEqual(Array.from(audit));
    const remaining = await inventory(id);
    expect(remaining.auth_identities).toBe(1);
    expect(Object.entries(remaining).filter(([key]) => key !== 'auth_identities').every(([, n]) => n === 0)).toBe(true);
    const [placeholder] = await database.sql`select normalized_email,password_phc,active from auth_identities where id=${identity!.id}`;
    expect(placeholder!.normalized_email).not.toBe(email);
    expect(placeholder!.password_phc).not.toStartWith('$argon2');
    expect(placeholder!.active).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { email: placeholder!.normalized_email, password } })).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/register', headers: { origin }, payload: { name: 'New business', email, password } })).statusCode).toBe(202);
  } finally {
    await app.close();
    await pools.end();
  }
});

test('API deletion serializes with an admitted worker and rejects stale writes', async () => {
  const id = '50000000-0000-4000-8000-000000000005';
  const origin = 'https://panel.agendia.test';
  const password = 'secure registration password';
  await seed(id);
  await database.sql`insert into auth_identities(normalized_email,password_phc,role) values ('purge-admin@example.test',${await hash(password, { algorithm: Algorithm.Argon2id })},'platform_admin')`;
  const pools = createRuntimePools(database.container.getConnectionUri());
  const app = buildApi({ pools, expectedOrigin: origin });
  try {
    const login = await app.inject({ method: 'POST', url: '/auth/admin/login', headers: { origin }, payload: { email: 'purge-admin@example.test', password } });
    expect(login.statusCode).toBe(200);
    const headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
    const context = { businessId: id, actorId: 'message-worker', role: 'internal_worker' as const, requestId: 'stale-summary' };
    const [message] = await database.sql`select id,conversation_id from messages where business_id=${id}`;
    const [identity] = await database.sql`select id from auth_identities where business_id=${id}`;
    await database.sql`insert into appointment_operation_receipts(business_id,actor_id,operation_key,kind,state) values (${other},${identity!.id},gen_random_uuid(),'create','cancelled')`;
    const historical = Array.from(await database.sql`select * from audit_events where business_id=${id} order by stream_sequence`);
    const otherBefore = await inventory(other);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const writer = pools.worker.run(context, async repo => { await repo.recordSummaryFailure(id); entered(); await held; });
    await started;
    let finished = false;
    const deletion = app.inject({ method: 'DELETE', url: `/admin/businesses/${id}`, headers }).then(response => { finished = true; return response; });
    await Bun.sleep(100);
    expect(finished).toBe(false);
    release();
    await writer;
    expect((await deletion).statusCode).toBe(200);
    await expect(pools.worker.run(context, repo => repo.recordSummaryFailure(id))).rejects.toThrow();
    expect((await database.sql`select count(*)::int as count from technical_events where business_id=${id}`)[0]!.count).toBe(0);
    const remaining = await inventory(id);
    expect(remaining.auth_identities).toBe(1);
    expect(Object.entries(remaining).filter(([key]) => key !== 'auth_identities').every(([, n]) => n === 0)).toBe(true);
    await expect(database.sql.begin(async tx => {
      await tx`set local role agendia_admin_runtime`;
      await tx`update auth_identities set active=true where id=${identity!.id}`;
    })).rejects.toThrow('business is deleted');
    await expect(database.sql.begin(async tx => {
      await tx`set local role agendia_admin_runtime`;
      await tx`update businesses set status='active',deleted_at=null where id=${id}`;
    })).rejects.toThrow('business is deleted');
    await expect(database.sql.begin(async tx => {
      await tx`set local role agendia_runtime`;
      await tx`select set_config('app.tenant_id',${id},true)`;
      await tx`insert into business_profiles(business_id,display_name) values(${id},'stale')`;
    })).rejects.toThrow('business is deleted');
    expect(await inventory(other)).toEqual(otherBefore);
    const audit = Array.from(await database.sql`select * from audit_events where business_id=${id} order by stream_sequence`);
    expect(audit.slice(0, historical.length)).toEqual(historical);
    expect(audit.at(-1)!.event_type).toBe('business.deleted');
    expect(audit.at(-1)!.previous_hash).toBe(historical.at(-1)!.event_hash);
    expect((await app.inject({ method: 'PUT', url: `/admin/businesses/${id}/status`, headers, payload: { status: 'active' } })).statusCode).toBe(404);
    const provider = { generate: async () => { throw new Error('unexpected provider'); }, converse: async () => { throw new Error('unexpected provider'); } };
    const job = { businessId: id, messageId: message!.id, correlationId: 'queued-after-delete' };
    const ai = new PostgresAiJobProcessor(pools, provider);
    expect(await ai.planSummary(job)).toBeNull();
    await ai.process(job);
    const summaries = new PostgresSummaryJobProcessor(pools, { summarize: async () => { throw new Error('unexpected provider'); } });
    expect(await summaries.process({ businessId: id, conversationId: message!.conversation_id, coveredThrough: 1, correlationId: 'stale-summary' })).toBe('stale');
    const raceId = '60000000-0000-4000-8000-000000000006';
    const token = '70000000-0000-4000-8000-000000000007';
    await seed(raceId);
    await database.sql`update whatsapp_connections set state='CONNECTED',owner_id='test-manager',ownership_token=${token} where business_id=${raceId}`;
    await database.sql`update outbound_commands set state='generated' where business_id=${raceId}`;
    let claimed!: () => void;
    let resume!: () => void;
    const claimedSignal = new Promise<void>(resolve => { claimed = resolve; });
    const resumeSignal = new Promise<void>(resolve => { resume = resolve; });
    let first = true;
    const manager = new Proxy(pools.manager, { get(target, key) {
      if (key !== 'run') return Reflect.get(target, key, target);
      return async (...args: any[]) => {
        const result = await (target.run as any).apply(target, args);
        if (first) { first = false; claimed(); await resumeSignal; }
        return result;
      };
    } });
    let sends = 0;
    const dispatcher = new PostgresOutboundDispatcher({ ...pools, manager }, { send: async () => { sends++; return { outcome: 'rejected' }; } }, 'test-manager', () => [token]);
    const dispatch = dispatcher.dispatchNext();
    await claimedSignal;
    const raceDeletion = await app.inject({ method: 'DELETE', url: `/admin/businesses/${raceId}`, headers });
    resume();
    expect(raceDeletion.statusCode).toBe(200);
    expect(await dispatch).toBe(true);
    expect(sends).toBe(0);
    const inflightId = '80000000-0000-4000-8000-000000000008';
    await seed(inflightId);
    await database.sql`update whatsapp_connections set state='CONNECTED',owner_id='test-manager',ownership_token=${token} where business_id=${inflightId}`;
    await database.sql`update outbound_commands set state='generated' where business_id=${inflightId}`;
    let sent!: () => void;
    let acknowledge!: () => void;
    const sentSignal = new Promise<void>(resolve => { sent = resolve; });
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    const inflight = new PostgresOutboundDispatcher(pools, { send: async () => {
      sent(); await acknowledgement; return { outcome: 'ack', providerMessageId: 'delivered' };
    } }, 'test-manager', () => [token]);
    const sending = inflight.dispatchNext();
    await sentSignal;
    const inflightDeletion = await app.inject({ method: 'DELETE', url: `/admin/businesses/${inflightId}`, headers });
    acknowledge();
    expect(inflightDeletion.statusCode).toBe(200);
    expect(await sending).toBe(true);
    expect(Object.values(await inventory(inflightId)).every(n => n === 0)).toBe(true);
    const rollbackBefore = await inventory(rollback);
    expect((await app.inject({ method: 'DELETE', url: `/admin/businesses/${rollback}`, headers })).statusCode).toBe(500);
    expect(await inventory(rollback)).toEqual(rollbackBefore);
    expect((await database.sql`select deleted_at from businesses where id=${rollback}`)[0]!.deleted_at).toBeNull();
  } finally { await app.close(); await pools.end(); }
});

test('ordinary capability roles and public cannot execute the primitive', async () => {
  const before = await inventory(other);
  for (const role of ['public', 'agendia_runtime', 'agendia_admin_runtime', 'agendia_whatsapp_runtime', 'agendia_worker_runtime']) {
    const result = await database.sql`select has_function_privilege(${role}, 'purge_business_data_private(uuid)', 'EXECUTE') as allowed`;
    expect(result[0]!.allowed).toBe(false);
  }
  for (const role of ['agendia_runtime', 'agendia_admin_runtime', 'agendia_whatsapp_runtime', 'agendia_worker_runtime']) {
    await expect(database.sql.begin(async tx => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select purge_business_data_private(${other})`;
    })).rejects.toThrow();
  }
  expect(await inventory(other)).toEqual(before);
});
