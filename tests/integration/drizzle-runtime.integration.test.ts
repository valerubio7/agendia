import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { PostgresRepositories, RolePool, createRuntimePools, tenantContext, TenantUnitOfWork } from "@agendia/db";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/postgres.ts";

let database: TestPostgres;
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
let pools: ReturnType<typeof createRuntimePools>;
const businessId = randomUUID(), actorId = randomUUID(), connectionId = randomUUID();
const context = tenantContext({ businessId, actorId, role: "business_user", requestId: "drizzle-runtime" });

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  await database.sql`insert into businesses(id,name) values(${businessId},'Native runtime')`;
  await database.sql`insert into auth_identities(id,normalized_email,password_phc,role,business_id)
    values(${actorId},'native@example.test','test','business_user',${businessId})`;
  // Drizzle owns this client: constructing it must not change the admin fixture's codecs.
  client = postgres(database.container.getConnectionUri(), { max: 1 });
  db = drizzle(client);
  pools = createRuntimePools(database.container.getConnectionUri());
}, 120_000);
afterAll(async () => { await pools?.end(); await client?.end(); await database?.stop(); });

test("repositories use a public native Drizzle root and nested transaction without a raw-client bridge", async () => {
  const root = new PostgresRepositories(db);
  expect((await root.business(businessId))?.name).toBe("Native runtime");
  await expect(Promise.resolve().then(() => root.acquireBusinessCalendarLock(context))).rejects.toThrow("requires a transaction");
  await db.transaction(async tx => {
    await tx.execute(sql`set local role agendia_runtime`);
    await tx.execute(sql`select set_config('app.tenant_id',${businessId},true)`);
    const repo = new PostgresRepositories(tx);
    await repo.saveProfile(businessId, "outer");
    await expect(repo.appointmentOperationSavepoint(async nested => {
      await nested.saveProfile(businessId, "inner");
      throw new Error("rollback inner");
    })).rejects.toThrow("rollback inner");
    expect(await repo.profile()).toMatchObject({ displayName: "outer" });
  });
  expect(await pools.api.run(context, repo => repo.profile())).toMatchObject({ displayName: "outer" });
});

test("Date milliseconds/nulls and encrypted Buffers survive SQL and typed repository projections", async () => {
  const instant = new Date("2026-04-01T10:20:30.123Z");
  const before = await pools.admin.run(undefined, repo => repo.business(businessId));
  expect(before?.createdAt).toBeInstanceOf(Date);
  expect(before?.lastTechnicalActivityAt).toBeNull();
  await pools.manager.run(context, async repo => {
    await repo.saveConnection(connectionId, businessId);
    await repo.setWhatsAppState(connectionId, "CONNECTED", instant, "+5491123456789");
    const bytes = { ciphertext: Buffer.from([0, 255, 128]), iv: Buffer.alloc(12, 3), tag: Buffer.alloc(16, 4) };
    await repo.saveAuthEnvelope(connectionId, { ...bytes, kekVersion: "v1" });
    await repo.saveAuthRecord({ ...bytes, businessId, connectionId, name: "test", version: 1 });
    expect(await repo.authEnvelope(connectionId)).toEqual({ ...bytes, businessId, kekVersion: "v1" });
    expect(await repo.authRecord(connectionId, "test")).toEqual({ ...bytes, businessId, connectionId, name: "test", version: 1 });
    const state = await repo.whatsapp();
    expect(state?.linkedAt).toBeInstanceOf(Date);
    expect(state?.linkedAt?.getTime()).toBe(instant.getTime());
    expect(state?.lastConnectedAt?.getTime()).toBe(instant.getTime());
  });
  expect((await database.sql`select created_at from businesses where id=${businessId}`)[0]!.created_at).toBeInstanceOf(Date);
});

test("JSON normalizes through the public facade and rejected values leave data and counters unchanged", async () => {
  await pools.api.run(context, repo => repo.enqueueOutbox(businessId, "codec", "codec", {
    instant: new Date("2026-01-02T03:04:05.123Z"), missing: undefined, list: [undefined, NaN], nested: { value: null },
  }));
  const snapshot = () => pools.api.run(context, repo => repo.tenantSnapshot());
  const before = await snapshot();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [undefined, 1n, cycle]) {
    await expect(pools.api.run(context, repo => repo.enqueueOutbox(businessId, "codec", "rejected", value)))
      .rejects.toThrow("Value must be JSON serializable");
    expect(await snapshot()).toEqual(before);
  }
  const [row] = await database.sql`select payload,publish_attempts from outbox_events where stable_key='codec'`;
  expect(row).toEqual({ payload: { instant: "2026-01-02T03:04:05.123Z", list: [null, null], nested: { value: null } }, publish_attempts: 0 });
  // Cancelled receipts permit SQL NULL; normalization must not turn it into JSON null or a JSON string.
  for (const result of [null, { status: 200, body: null, toJSON: () => null }]) {
    const key = randomUUID();
    const receipt = { kind: "create" as const, target: null, fingerprint: null, state: "cancelled" as const, result };
    await pools.api.run(context, repo => repo.recordAppointmentOperation(context, key, receipt));
    expect(await pools.api.run(context, repo => repo.appointmentOperation(context, key))).toEqual({ ...receipt, result: null });
  }
  const key = randomUUID(), result = { status: 200, body: { nested: null, list: [null] } };
  const receipt = { kind: "create" as const, target: null, fingerprint: "json", state: "completed" as const, result };
  await pools.api.run(context, repo => repo.recordAppointmentOperation(context, key, receipt));
  expect(await pools.api.run(context, repo => repo.appointmentOperation(context, key))).toEqual(receipt);
});

test.each([
  ["null", null], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
  ["invalid Date", new Date(NaN)], ["toJSON(null)", { toJSON: () => null }],
])("top-level JSON %s binds SQL NULL and preserves native NOT NULL rejection without effects", async (_label, value) => {
  const before = [...await database.sql`select * from outbox_events order by id`];
  const snapshot = await pools.api.run(context, repo => repo.tenantSnapshot());
  const rejected = await pools.api.run(context, repo => repo.enqueueOutbox(businessId, "codec", "json-null", value))
    .then(() => null, (error: { name: string; code?: string; message: string; constraint_name?: string }) => ({
      name: error.name, code: error.code, message: error.message, constraint: error.constraint_name ?? null,
    }));
  expect(rejected).toEqual({ name: "PostgresError", code: "23502", constraint: null,
    message: 'null value in column "payload" of relation "outbox_events" violates not-null constraint' });
  expect(await pools.api.run(context, repo => repo.tenantSnapshot())).toEqual(snapshot);
  expect([...await database.sql`select * from outbox_events order by id`]).toEqual(before);
});

test("native errors retain PostgreSQL code/constraint without wrapper SQL or parameter messages", async () => {
  const create = () => pools.api.run(context, repo => repo.createClient(businessId, { firstName: "A", lastName: "B", phone: "+5491199999999" }));
  await create();
  await expect(create()).rejects.toMatchObject({ code: "23505", constraint_name: "clients_business_phone_key",
    message: 'duplicate key value violates unique constraint "clients_business_phone_key"' });
  expect(await pools.api.run(context, repo => repo.listClients())).toHaveLength(1);
});

test("deterministic failed-operation receipts commit only after native savepoint rollback; unknown failures roll back everything", async () => {
  const uow = new TenantUnitOfWork(pools.api);
  const events = { audit: { eventType: "native.failed", outcome: "success" as const, eventHash: "a".repeat(64) },
    outbox: { topic: "native.failed", stableKey: "native.failed", payload: {} } };
  const key = randomUUID();
  const operation = { key, kind: "create" as const, target: null, fingerprint: "f", status: 201,
    failure: (error: unknown) => error instanceof Error && error.message === "deterministic"
      ? { status: 409, body: { code: "TEST_CONFLICT" } } : null };
  const before = await pools.api.run(context, repo => repo.tenantSnapshot());
  await expect(uow.execute(context, events, async repo => {
    await repo.saveProfile(businessId, "must rollback"); throw new Error("deterministic");
  }, operation)).rejects.toMatchObject({ status: 409, body: { code: "TEST_CONFLICT" } });
  expect(await pools.api.run(context, repo => repo.tenantSnapshot())).toEqual(before);
  expect(await pools.api.run(context, repo => repo.auditCount())).toBe(0);
  expect(await pools.api.run(context, repo => repo.appointmentOperation(context, key))).toMatchObject({ state: "failed", result: { status: 409, body: { code: "TEST_CONFLICT" } } });
  const unknown = { ...operation, key: randomUUID() };
  await expect(uow.execute(context, events, async repo => {
    await repo.saveProfile(businessId, "unknown rollback"); throw new Error("unknown");
  }, unknown)).rejects.toThrow("unknown");
  expect(await pools.api.run(context, repo => repo.appointmentOperation(context, unknown.key))).toBeNull();
  expect(await pools.api.run(context, repo => repo.tenantSnapshot())).toEqual(before);
});

test("empty/nonempty assignments and decimal/bigint appointment DTOs retain their public JSON representation", async () => {
  const service = await pools.api.run(context, repo => repo.createService(businessId, { name: "Codec service", durationMinutes: 15, priceArs: 12.34567 }));
  const resource = await pools.api.run(context, repo => repo.createResource(businessId, { name: "Codec resource", weeklySchedule: {}, serviceIds: [] }));
  expect(resource.serviceIds).toEqual([]);
  const assigned = await pools.api.run(context, repo => repo.updateResource(businessId, resource.id, { name: resource.name, weeklySchedule: {}, serviceIds: [service.id.toUpperCase(), service.id] }));
  expect(assigned?.serviceIds).toEqual([service.id]);
  const before = await pools.api.run(context, repo => repo.getResource(businessId, resource.id));
  await expect(pools.api.run(context, repo => repo.updateResource(businessId, resource.id, { name: "rejected", weeklySchedule: {}, serviceIds: [randomUUID()] })))
    .rejects.toMatchObject({ code: "UNKNOWN_SERVICE" });
  expect(await pools.api.run(context, repo => repo.getResource(businessId, resource.id))).toEqual(before);
  const customer = (await pools.api.run(context, repo => repo.listClients()))[0]!;
  const id = randomUUID();
  const start = Date.parse("2000-01-01T10:00:00.123Z");
  await database.sql`insert into appointments(id,business_id,client_id,service_id,resource_id,service_label,resource_label,
    price_ars,duration_minutes,start_raw,start_ms,end_ms,state,origin) values(${id},${businessId},${customer.id},${service.id},${resource.id},
    'Frozen service','Frozen resource',12.34567,15,'2000-01-01T10:00:00.123Z',${start},${start + 900000},'done','manual')`;
  const saved = await pools.api.run(context, repo => repo.getAppointment(businessId, id));
  expect(saved).toMatchObject({ startMs: start, endMs: start + 900000, notes: null, customerResourcePreference: null, terms: { priceArs: 12.34567 } });
  expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
  expect((await pools.api.run(context, repo => repo.listAppointments(businessId))).map(row => row.id)).toEqual([id]);
  expect((await pools.api.run(context, repo => repo.listServices()))[0]?.priceArs).toBe(12.34567);
});

test("affected UPDATE count gates failure effects and uuid arrays retain ANY semantics for empty and owned claims", async () => {
  const token = randomUUID();
  await pools.manager.run(context, repo => repo.takeOverWhatsApp(connectionId, "native-owner", token, new Date()));
  const inbound = await pools.manager.run(context, repo => repo.ingestInbound({ businessId, connectionId, providerId: "count", remoteJid: "count@s.whatsapp.net",
    text: "hello", receivedAt: new Date("2026-01-01T00:00:00.123Z"), classification: "accepted" }));
  const messageId = inbound && "messageId" in inbound ? inbound.messageId! : "";
  const before = await pools.worker.run(context, repo => repo.auditCount());
  await pools.worker.run(context, repo => repo.failAi(randomUUID(), businessId, "ai.timeout"));
  expect(await pools.worker.run(context, repo => repo.auditCount())).toBe(before);
  await pools.worker.run(context, repo => repo.failAi(messageId, businessId, "ai.timeout"));
  expect(await pools.worker.run(context, repo => repo.auditCount())).toBe(before + 1);
  await pools.worker.run(context, repo => repo.failAi(messageId, businessId, "ai.timeout"));
  expect(await pools.worker.run(context, repo => repo.auditCount())).toBe(before + 1);
  expect((await database.sql`select count(*)::int count from technical_events where business_id=${businessId} and code='ai.timeout'`)[0]?.count).toBe(1);
  expect((await database.sql`select received_at from messages where id=${messageId}`)[0]?.received_at.getTime()).toBe(Date.parse("2026-01-01T00:00:00.123Z"));
  const [conversation] = await database.sql`select conversation_id from messages where id=${messageId}`;
  const outboundId = randomUUID();
  await database.sql`insert into outbound_commands(outbound_id,business_id,conversation_id,connection_id,text,state)
    values(${outboundId},${businessId},${conversation!.conversation_id},${connectionId},'test','generated')`;
  for (const ownership of [[], [randomUUID()]]) {
    expect(await pools.manager.run(context, repo => repo.claimOwnedOutbound("native-owner", ownership))).toBeNull();
    expect((await database.sql`select state from outbound_commands where outbound_id=${outboundId}`)[0]?.state).toBe("generated");
  }
  expect(await pools.manager.run(context, repo => repo.claimOwnedOutbound("native-owner", [token]))).toMatchObject({ outbound_id: outboundId, ownership_token: token });
  expect((await database.sql`select state from outbound_commands where outbound_id=${outboundId}`)[0]?.state).toBe("sending");
});

test("one-socket RolePool sets all four local context fields and cleans them after success, rollback and absent context", async () => {
  const pool = new RolePool(client, "agendia_runtime");
  await pool.run(context, repo => repo.appendAudit(businessId, { eventType: "context.probe", outcome: "success", eventHash: "b".repeat(64) }));
  const [audit] = await database.sql`select actor_id,request_id,business_id from audit_events where event_type='context.probe'`;
  expect(audit).toEqual({ actor_id: actorId, request_id: context.requestId, business_id: businessId });
  const clean = async () => {
    const [row] = await db.execute(sql`select current_user=session_user own_role,
      nullif(current_setting('app.tenant_id',true),'') tenant, nullif(current_setting('app.actor_role',true),'') actor_role,
      nullif(current_setting('app.actor_id',true),'') actor_id, nullif(current_setting('app.request_id',true),'') request_id`);
    expect(row).toEqual({ own_role: true, tenant: null, actor_role: null, actor_id: null, request_id: null });
  };
  await clean();
  await expect(pool.run(context, async repo => { await repo.saveProfile(businessId, "rollback context"); throw new Error("rollback context"); })).rejects.toThrow("rollback context");
  await clean();
  expect(await pool.run(undefined, repo => repo.profile())).toBeNull();
  await clean();
});
