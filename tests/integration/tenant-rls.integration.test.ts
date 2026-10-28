import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Sql } from "postgres";
import { randomUUID, createHash } from "node:crypto";
import { PostgresRepositories } from "../../packages/db/src/repositories.ts";
import { normalizeResourceName } from "@agendia/domain";
import {
  tenantContext,
  withTenantTransaction,
} from "../../packages/db/src/tenant-context.ts";
import {
  applyPostgresMigrations,
  assertNonEmptyTenantRows,
  startTestPostgres,
  type TestPostgres,
} from "../support/index.ts";

let database: TestPostgres;
let admin: Sql;
const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  database = await startTestPostgres();
  admin = database.sql;
  await applyPostgresMigrations(
    admin,
    join(import.meta.dir, "../../packages/db/migrations"),
  );
  await admin`insert into businesses (id, name) values (${tenantA}, 'A'), (${tenantB}, 'B')`;
  await admin`insert into tenant_records (business_id, value) values (${tenantA}, 'solo-a'), (${tenantB}, 'solo-b')`;
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

const resourceContext = (businessId = tenantA) => tenantContext({ businessId, actorId: "resource-test", role: "business_user", requestId: randomUUID() });
const resourceWork = <T>(work: (repo: PostgresRepositories) => Promise<T>, businessId = tenantA) =>
  withTenantTransaction(admin, resourceContext(businessId), tx => work(new PostgresRepositories(tx)));
const resourceInput = { name: "Resource", serviceIds: [] as string[], weeklySchedule: {} };

async function workerCatalogProbe(table: string) {
  const read = (businessId: string) => admin.begin(async tx => {
    await tx.unsafe("set local role agendia_worker_runtime");
    await tx`select set_config('app.tenant_id', ${businessId}, true)`;
    return tx.unsafe<{ business_id: string }[]>(`select business_id::text from ${table}`);
  });
  expect(await read("")).toHaveLength(0);
  for (const tenant of [tenantA, tenantB]) assertNonEmptyTenantRows(await read(tenant), tenant);
  // Clients intentionally permit INSERT, but never editing/deleting existing content.
  for (const operation of ["UPDATE", "DELETE", "TRUNCATE", ...(table === "clients" ? [] : ["INSERT"])]) {
    const [permission] = await admin`select has_table_privilege('agendia_worker_runtime',${table},${operation}) allowed`;
    expect(permission!.allowed).toBe(false);
  }
  for (const operation of [`update ${table} set business_id='${tenantB}'`, `delete from ${table}`])
    await expect(admin.begin(async tx => {
      await tx.unsafe("set local role agendia_worker_runtime");
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      return tx.unsafe(operation);
    })).rejects.toMatchObject({ code: "42501" });
  if (table === "clients") await expect(admin.begin(async tx => {
    await tx.unsafe("set local role agendia_worker_runtime");
    await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
    return tx`insert into clients(business_id,first_name,last_name,phone) values(${tenantB},'Foreign','Write','+5491198765432')`;
  })).rejects.toMatchObject({ code: "42501" });
}

test("resource storage has composite ownership, forced RLS and least privileges", async () => {
  const serviceA = randomUUID(), serviceB = randomUUID(), resourceA = randomUUID(), resourceB = randomUUID();
  await admin`insert into services(id,business_id,name,duration_minutes,price_ars) values
    (${serviceA},${tenantA},'Owned service',15,0),(${serviceB},${tenantB},'Foreign service',15,0)`;
  await admin`insert into resources(id,business_id,name,weekly_schedule) values
    (${resourceA},${tenantA},'SQL A','{}'),(${resourceB},${tenantB},'SQL B','{}')`;
  for (const [resource, service] of [[resourceA, serviceB], [resourceB, serviceA]])
    await expect(admin`insert into resource_services(business_id,resource_id,service_id) values(${tenantA},${resource!},${service!})`.execute()).rejects.toMatchObject({ code: "23503" });
  await admin`insert into resource_services values(${tenantA},${resourceA},${serviceA}),(${tenantB},${resourceB},${serviceB})`;
  for (const table of ["resources", "resource_services"]) {
    const [flags] = await admin`select relrowsecurity enabled,relforcerowsecurity forced,
      has_table_privilege('agendia_runtime',oid,'DELETE') deletion,
      has_table_privilege('agendia_runtime',oid,'UPDATE') updating,
      has_table_privilege('agendia_runtime',oid,'SELECT,INSERT') catalog from pg_class where oid=${table}::regclass`;
    expect(flags).toEqual({ enabled: true, forced: true, catalog: true,
      deletion: table === "resource_services", updating: table === "resources" });
    expect(await admin.begin(async tx => { await tx.unsafe("set local role agendia_runtime"); return tx.unsafe(`select * from ${table}`); })).toHaveLength(0);
    for (const role of ["agendia_admin_runtime", "agendia_whatsapp_runtime"])
      await expect(admin.begin(async tx => { await tx.unsafe(`set local role ${role}`); return tx.unsafe(`select * from ${table}`); })).rejects.toThrow(/permission denied/i);
    await workerCatalogProbe(table);
    const own = await withTenantTransaction(admin, resourceContext(), tx => tx.unsafe<{ business_id: string }[]>(`select business_id::text from ${table}`));
    assertNonEmptyTenantRows(own, tenantA);
    const crossWrite = withTenantTransaction(admin, resourceContext(), tx => table === "resources"
      ? tx`insert into resources(business_id,name,weekly_schedule) values(${tenantB},'Forbidden','{}')`
      : tx`insert into resource_services values(${tenantB},${resourceB},${serviceB})`);
    await expect(crossWrite).rejects.toMatchObject({ code: "42501" });
  }
  expect(await withTenantTransaction(admin, resourceContext(), tx => tx`delete from resource_services where resource_id=${resourceB} returning *`)).toHaveLength(0);
  expect(await withTenantTransaction(admin, resourceContext(), tx => tx`delete from resource_services where resource_id=${resourceA} returning *`)).toHaveLength(1);
  await expect(withTenantTransaction(admin, resourceContext(), tx => tx`delete from resources`)).rejects.toMatchObject({ code: "42501" });
  for (const [name, status, hours] of [[" ","active","{}"],["Bad","deleted","{}"],["Bad","active","{\"7\":[]}"]])
    await expect(admin`insert into resources(business_id,name,status,weekly_schedule) values(${tenantA},${name!},${status!},${hours!}::jsonb)`.execute()).rejects.toMatchObject({ code: "23514" });
});

test("resource repository preserves identity, canonical owned assignments and transaction rollback", async () => {
  const service = randomUUID(), second = randomUUID(), foreign = randomUUID();
  await admin`insert into services(id,business_id,name,duration_minutes,price_ars,status) values
    (${service},${tenantA},'Suspended assignable',15,0,'suspended'),
    (${second},${tenantA},'Second owned',15,0,'active'),(${foreign},${tenantB},'Not owned',15,0,'active')`;
  const created = await resourceWork(repo => repo.createResource(tenantA, {
    ...resourceInput, serviceIds: [second, service.toUpperCase(), service],
  }));
  expect(created).toMatchObject({ name: "Resource", description: null, status: "active",
    serviceIds: [service,second].sort(), weeklySchedule: {} });
  expect(await resourceWork(repo => repo.getResource(tenantA,created.id))).toEqual(created);
  expect(await resourceWork(repo => repo.getResource(tenantB,created.id),tenantB)).toBeNull();
  expect(await resourceWork(repo => repo.updateResource(tenantB,created.id,resourceInput),tenantB)).toBeNull();
  expect(await resourceWork(repo => repo.setResourceStatus(tenantB,created.id,"active"),tenantB)).toBeNull();
  for (const status of ["suspended", "active"] as const)
    expect(await resourceWork(repo => repo.setResourceStatus(tenantA,created.id,status))).toMatchObject({ id: created.id, status });
  for (const id of [foreign,randomUUID()])
    await expect(resourceWork(repo => repo.updateResource(tenantA,created.id,{ ...resourceInput, serviceIds: [id] }))).rejects.toMatchObject({ code: "UNKNOWN_SERVICE" });
  await expect(resourceWork(async repo => {
    await repo.updateResource(tenantA,created.id,{ ...resourceInput, name: "Rolled back",serviceIds: [] });
    throw new Error("effect failure");
  })).rejects.toThrow("effect failure");
  // A failure during assignment insertion must undo both the row update and set deletion.
  await admin.unsafe(`create function reject_resource_assignment() returns trigger language plpgsql as $$
    begin if NEW.service_id='${second}'::uuid then raise exception 'assignment failure'; end if; return NEW; end $$`);
  await admin.unsafe(`create trigger reject_resource_assignment before insert on resource_services
    for each row execute function reject_resource_assignment()`);
  await expect(resourceWork(repo => repo.updateResource(tenantA,created.id,{
    ...resourceInput, name: "Assignment rollback",serviceIds: [second],
  }))).rejects.toThrow("assignment failure");
  await admin.unsafe(`create or replace function reject_resource_assignment() returns trigger language plpgsql as $$ begin return NEW; end $$`);
  expect(await resourceWork(repo => repo.getResource(tenantA,created.id))).toEqual(created);
  const updated = await resourceWork(repo => repo.updateResource(tenantA,created.id,{ ...resourceInput, name: "Edited", description: "Description" }));
  expect(updated).toMatchObject({ id: created.id, serviceIds: [], description: "Description" });
  expect(updated).not.toBeNull();
  expect(await resourceWork(repo => repo.listResources(tenantA))).toContainEqual(updated!);
  await expect(new PostgresRepositories(admin).createResource(tenantA,resourceInput)).rejects.toThrow(/transaction/i);
});

test("resource names use uncapped Unicode case/outer trim hashing, not accent or inner-space folding", async () => {
  const longName = Array.from({ length: 100 },(_,i) => createHash("sha256").update(String(i)).digest("hex")).join("") + "é";
  for (const name of ["ÉCOLE", "A  B", longName]) {
    const saved = await resourceWork(repo => repo.createResource(tenantA,{ ...resourceInput, name: "\t" + name + "\ufeff" }));
    expect(saved.name).toBe(name);
    const [row] = await admin`select normalized_name,encode(service_name_sha256(normalized_name),'hex') digest from resources where id=${saved.id}`;
    expect(row).toEqual({ normalized_name: normalizeResourceName(name), digest: createHash("sha256").update(normalizeResourceName(name)).digest("hex") });
    await expect(resourceWork(repo => repo.createResource(tenantA,{ ...resourceInput, name: name.toLowerCase() }))).rejects.toMatchObject({ code: "23505" });
    expect(await resourceWork(repo => repo.createResource(tenantB,{ ...resourceInput, name }),tenantB)).toMatchObject({ name });
  }
  for (const name of ["ECOLE", "A B"])
    expect(await resourceWork(repo => repo.createResource(tenantA,{ ...resourceInput, name }))).toMatchObject({ name });
  const direct = randomUUID();
  await admin`insert into resources(id,business_id,name,weekly_schedule) values(${direct},${tenantA},${"\tDIRECT\ufeff"},'{}')`;
  expect((await admin`select normalized_name from resources where id=${direct}`)[0]?.normalized_name).toBe("direct");
  await expect(resourceWork(repo => repo.updateResource(tenantA,direct,{ ...resourceInput,name: "école" }))).rejects.toMatchObject({ code: "23505" });
  expect((await resourceWork(repo => repo.getResource(tenantA,direct)))?.name).toBe("\tDIRECT\ufeff");
});

// Physical RLS probes precede the later test's global advisory-lock trigger.
test("tombstones preserve forced physical RLS and least privileges separately from retirement scope guards", async () => {
  const service = randomUUID(), resource = randomUUID();
  await admin`insert into services(id,business_id,name,duration_minutes,price_ars) values(${service},${tenantB},'Retirement foreign service',15,0)`;
  await admin`insert into resources(id,business_id,name,weekly_schedule) values(${resource},${tenantB},'Retirement foreign resource','{}')`;
  for (const [table, id] of [["services", service], ["resources", resource]] as const) {
    const before = await admin.unsafe(`select * from ${table} where id=$1`, [id]);
    const changed = await withTenantTransaction(admin, resourceContext(), async tx => {
      expect((await tx`select current_user role`)[0]!.role).toBe("agendia_runtime");
      expect(await tx.unsafe(`select * from ${table} where id=$1`, [id])).toHaveLength(0);
      return tx.unsafe(`update ${table} set deleted_at=now() where id=$1 returning id`, [id]);
    });
    expect(changed).toHaveLength(0);
    expect(await admin.unsafe(`select * from ${table} where id=$1`, [id])).toEqual(before);
    for (const operation of [`delete from ${table} where id='${id}'`, `truncate ${table}`])
      await expect(withTenantTransaction(admin, resourceContext(), tx => tx.unsafe(operation))).rejects.toMatchObject({ code: "42501" });
    await expect(resourceWork(repo => table === "services" ? repo.deleteService(tenantB, id) : repo.deleteResource(tenantB, id))).rejects.toThrow("matching tenant context");
    expect(await resourceWork(repo => table === "services" ? repo.deleteService(tenantA, id) : repo.deleteResource(tenantA, id))).toBe(false);
    await expect((table === "services" ? new PostgresRepositories(admin).deleteService(tenantB, id)
      : new PostgresRepositories(admin).deleteResource(tenantB, id))).rejects.toThrow("requires a transaction");
  }
  await expect(withTenantTransaction(admin, resourceContext(), tx => tx`insert into services(business_id,name,duration_minutes,price_ars)
    values(${tenantB},'Physical foreign insert',15,0)`)).rejects.toMatchObject({ code: "42501" });
  await expect(withTenantTransaction(admin, resourceContext(), tx => tx`insert into resources(business_id,name,weekly_schedule)
    values(${tenantB},'Physical foreign insert','{}')`)).rejects.toMatchObject({ code: "42501" });
  expect((await admin`select count(*)::int count from services where name='Physical foreign insert'`)[0]!.count).toBe(0);
  expect((await admin`select count(*)::int count from resources where name='Physical foreign insert'`)[0]!.count).toBe(0);
});

test("repository hours guards hold the early shared lock and preserve both directions including suspended hours", async () => {
  const businessId = randomUUID();
  await admin`insert into businesses(id,name) values(${businessId},'Hours')`;
  const work = <T>(fn: (repo: PostgresRepositories) => Promise<T>) => resourceWork(fn,businessId);
  const hours = { 6: [{ startMinute: 1387,endMinute: 60 }], 0: [{ startMinute: 60,endMinute: 121 }] };
  expect(await work(repo => repo.getBusinessCalendar(businessId))).toEqual({ weeklySchedule: null });
  await expect(work(repo => repo.createResource(businessId,{ ...resourceInput, weeklySchedule: hours }))).rejects.toMatchObject({ code: "HOURS_CONFLICT" });
  expect(await work(repo => repo.listResources(businessId))).toHaveLength(0);
  const off = await work(repo => repo.createResource(businessId,resourceInput));
  await work(repo => repo.saveBusinessCalendar(businessId,hours));
  // Verify a lock is held by the first write, not just by eventual audit work.
  await admin.unsafe(`create function resource_lock_check() returns trigger language plpgsql as $$
    declare key bigint := hashtextextended('business-calendar:' || NEW.business_id::text,0);
    begin if not exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid()
      and classid=((key >> 32) & 4294967295)::oid and objid=(key & 4294967295)::oid and objsubid=1 and granted)
      then raise exception 'missing early lock'; end if; return NEW; end $$`);
  await admin.unsafe(`create trigger resource_lock_check before insert or update on resources for each row execute function resource_lock_check()`);
  const union = { 6: [{ startMinute: 1387,endMinute: 121 }] };
  const configured = await work(repo => repo.updateResource(businessId,off.id,{ ...resourceInput,weeklySchedule: union }));
  expect(configured?.weeklySchedule).toEqual(union);
  await work(repo => repo.setResourceStatus(businessId,off.id,"suspended"));
  await expect(work(repo => repo.saveBusinessCalendar(businessId,{}))).rejects.toMatchObject({ code: "HOURS_CONFLICT" });
  const paused = { ...hours, 0: [{ startMinute: 61,endMinute: 121 }] };
  await expect(work(repo => repo.saveBusinessCalendar(businessId,paused))).rejects.toMatchObject({ code: "HOURS_CONFLICT" });
  await expect(work(repo => repo.updateResource(businessId,off.id,{ ...resourceInput,weeklySchedule: { 1: [{startMinute: 0,endMinute: 1}] } }))).rejects.toMatchObject({ code: "HOURS_CONFLICT" });
  expect(await work(repo => repo.getResource(businessId,off.id))).toMatchObject({ status: "suspended",weeklySchedule: union });
  expect(await work(repo => repo.getBusinessCalendar(businessId))).toEqual({ weeklySchedule: hours });
  await work(repo => repo.updateResource(businessId,off.id,resourceInput));
  expect(await work(repo => repo.saveBusinessCalendar(businessId,{}))).toEqual({ weeklySchedule: {} });
});

describe("forced tenant RLS", () => {
  test("fails closed without transaction context and leaves the pool clean", async () => {
    const rows = await admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_runtime");
      return tx`select value from tenant_records order by value`;
    });
    expect(rows.length).toBe(0);
  });

  test("returns only the server-derived tenant and rejects cross-tenant writes", async () => {
    const own = await withTenantTransaction(
      admin,
      tenantContext({
        businessId: tenantA,
        actorId: "user-a",
        role: "business_user",
        requestId: "req-a",
      }),
      (tx) =>
        tx<
          { value: string }[]
        >`select value from tenant_records order by value`,
    );
    expect(own.map((row) => row.value)).toEqual(["solo-a"]);

    const crossWrite = withTenantTransaction(
      admin,
      tenantContext({
        businessId: tenantA,
        actorId: "user-a",
        role: "business_user",
        requestId: "req-b",
      }),
      (tx) =>
        tx`insert into tenant_records (business_id, value) values (${tenantB}, 'intrusion')`,
    );
    await expect(crossWrite).rejects.toThrow(/row-level security|policy/i);
  });

  test("keeps the administration role away from tenant content", async () => {
    const access = admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_admin_runtime");
      return tx`select value from tenant_records`;
    });
    await expect(access).rejects.toThrow(/permission denied/i);
  });

  test("client registry is forced tenant-scoped with no delete or admin content access", async () => {
    await admin`insert into clients(business_id,first_name,last_name,phone) values
      (${tenantA},'A','Client','+5491123456789'), (${tenantB},'B','Client','+5491123456789')`;
    const rows = await withTenantTransaction(admin, tenantContext({
      businessId: tenantA, actorId: "user-a", role: "business_user", requestId: "clients-rls",
    }), tx => tx<{ business_id: string }[]>`select business_id::text from clients`);
    assertNonEmptyTenantRows(rows, tenantA);
    expect(rows).toHaveLength(1);
    const missing = await admin.begin(async tx => {
      await tx.unsafe("set local role agendia_runtime");
      return tx`select id from clients`;
    });
    expect(missing).toHaveLength(0);
    for (const role of ["agendia_admin_runtime", "agendia_whatsapp_runtime"]) {
      await expect(admin.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        return tx`select id from clients`;
      })).rejects.toThrow(/permission denied/i);
    }
    await workerCatalogProbe("clients");
    await expect(withTenantTransaction(admin, tenantContext({
      businessId: tenantA, actorId: "user-a", role: "business_user", requestId: "clients-delete",
    }), tx => tx`delete from clients`)).rejects.toThrow(/permission denied/i);
  });

  test("weekly calendar enforces shape, forced RLS and SELECT/INSERT/UPDATE only", async () => {
    await admin`insert into business_calendars(business_id,weekly_schedule) values(${tenantA},'{}'),(${tenantB},'{"1":[]}')`;
    const context = tenantContext({ businessId: tenantA, actorId: "user-a", role: "business_user", requestId: "calendar-rls" });
    const rows = await withTenantTransaction(admin, context, tx => tx<{ business_id: string }[]>`select business_id::text from business_calendars`);
    assertNonEmptyTenantRows(rows, tenantA);
    expect(rows).toHaveLength(1);
    expect(await admin.begin(async tx => {
      await tx.unsafe("set local role agendia_runtime");
      return tx`select * from business_calendars`;
    })).toHaveLength(0);
    await expect(withTenantTransaction(admin, context, tx => tx`update business_calendars set weekly_schedule='{}' where business_id=${tenantB}`)).resolves.toHaveLength(0);
    await expect(withTenantTransaction(admin, context, tx => tx`insert into business_calendars(business_id,weekly_schedule) values(${tenantB},'{}')`)).rejects.toThrow(/row-level security|policy/i);
    await expect(withTenantTransaction(admin, context, tx => tx`delete from business_calendars`)).rejects.toThrow(/permission denied/i);
    const [permissions] = await admin`select relrowsecurity enabled, relforcerowsecurity forced,
      has_table_privilege('agendia_runtime','business_calendars','SELECT,INSERT,UPDATE') writes,
      has_table_privilege('agendia_runtime','business_calendars','DELETE') deletion
      from pg_class where oid='business_calendars'::regclass`;
    expect(permissions).toEqual({ enabled: true, forced: true, writes: true, deletion: false });
    for (const role of ["agendia_admin_runtime", "agendia_whatsapp_runtime"]) {
      await expect(admin.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        return tx`select * from business_calendars`;
      })).rejects.toThrow(/permission denied/i);
    }
    await workerCatalogProbe("business_calendars");
    for (const invalid of [null, [], { 7: [] }, { 0: null }, { 1: [{}] },
      ...[{ startMinute: 0, endMinute: 0 }, { startMinute: -1, endMinute: 60 },
        { startMinute: 1440, endMinute: 60 }, { startMinute: 0, endMinute: 1441 },
        { startMinute: 0.5, endMinute: 60 }, { startMinute: 0, endMinute: "60" }].map(span => ({ 1: [span] }))]) {
      await expect(admin`update business_calendars set weekly_schedule=${admin.json(invalid)} where business_id=${tenantA}`.execute()).rejects.toMatchObject({ code: invalid === null ? "23502" : "23514" });
    }
    await expect(admin`update business_calendars set weekly_schedule='null'::jsonb where business_id=${tenantA}`.execute()).rejects.toMatchObject({ code: "23514" });
  });

  test("global closures force RLS, constrain shape/range and permit owned DELETE only", async () => {
    await admin`insert into business_calendar_closures(business_id,kind,closed_date) values(${tenantA},'date','2028-01-03'),(${tenantB},'date','2028-01-03')`;
    const context = tenantContext({ businessId: tenantA, actorId: "user-a", role: "business_user", requestId: "closures-rls" });
    const rows = await withTenantTransaction(admin, context, tx => tx<{ business_id: string }[]>`select business_id::text from business_calendar_closures`);
    assertNonEmptyTenantRows(rows, tenantA);
    expect(rows).toHaveLength(1);
    expect(await admin.begin(async tx => {
      await tx.unsafe("set local role agendia_runtime");
      return tx`select * from business_calendar_closures`;
    })).toHaveLength(0);
    const [permissions] = await admin`select relrowsecurity enabled,relforcerowsecurity forced,
      has_table_privilege('agendia_runtime','business_calendar_closures','SELECT,INSERT,UPDATE,DELETE') crud
      from pg_class where oid='business_calendar_closures'::regclass`;
    expect(permissions).toEqual({ enabled: true, forced: true, crud: true });
    await expect(withTenantTransaction(admin, context, tx => tx`insert into business_calendar_closures(business_id,kind,closed_date) values(${tenantB},'date','2028-01-04')`)).rejects.toThrow(/row-level security|policy/i);
    for (const role of ["agendia_admin_runtime", "agendia_whatsapp_runtime"])
      await expect(admin.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        return tx`select * from business_calendar_closures`;
      })).rejects.toThrow(/permission denied/i);
    await workerCatalogProbe("business_calendar_closures");
    for (const mutation of ["kind='other'", "closed_date=null", "closed_date='10000-01-01'", "start_raw='extra'",
      "kind='interval',closed_date=null,start_raw='s',end_raw='e',start_ms=1,end_ms=1",
      "kind='interval',closed_date=null,start_raw='s',end_raw='e',start_ms=2,end_ms=1",
      "kind='interval',closed_date=null,start_raw='s',end_raw='e',start_ms=0,end_ms=253402387140000"])
      await expect(admin.unsafe(`update business_calendar_closures set ${mutation} where business_id='${tenantA}'`).execute()).rejects.toMatchObject({ code: "23514" });
    expect(await withTenantTransaction(admin, context, tx => tx`update business_calendar_closures set closed_date='2028-01-04' where business_id=${tenantB} returning id`)).toHaveLength(0);
    expect(await withTenantTransaction(admin, context, tx => tx`delete from business_calendar_closures where business_id=${tenantB} returning id`)).toHaveLength(0);
    expect(await withTenantTransaction(admin, context, tx => tx`delete from business_calendar_closures returning id`)).toHaveLength(1);
    expect((await admin`select * from business_calendar_closures`)).toHaveLength(1);
  });

  test("deduplicates a provider event into one message and one durable effect", async () => {
    const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await admin`insert into whatsapp_connections (id, business_id) values (${connectionId}, ${tenantA})`;
    await admin`insert into conversations (id, business_id, connection_id, remote_jid) values (${conversationId}, ${tenantA}, ${connectionId}, '549111@s.whatsapp.net')`;
    const ingest = () =>
      admin.begin(async (tx) => {
        const inserted = await tx<
          { id: string }[]
        >`insert into inbox_events (business_id, source, stable_key) values (${tenantA}, 'baileys', 'provider-1') on conflict do nothing returning id`;
        if (inserted.length === 0) return;
        await tx`insert into messages (business_id, conversation_id, connection_id, provider_message_id, sequence, direction, raw_text, received_at) values (${tenantA}, ${conversationId}, ${connectionId}, 'provider-1', 1, 'inbound', 'Hola', now())`;
        await tx`insert into outbox_events (business_id, topic, stable_key, payload) values (${tenantA}, 'ai.generate', 'ai:provider-1', ${tx.json({ conversationId, sequence: 1 })})`;
      });
    await Promise.all([ingest(), ingest()]);
    expect(
      (
        await admin`select id from messages where provider_message_id = 'provider-1'`
      ).length,
    ).toBe(1);
    expect(
      (
        await admin`select id from outbox_events where stable_key = 'ai:provider-1'`
      ).length,
    ).toBe(1);
  });

  test("persists outbound claims under the owning tenant and connection", async () => {
    const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const outboundId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await admin`insert into outbound_commands (outbound_id, business_id, conversation_id, connection_id, text, state) values (${outboundId}, ${tenantA}, ${conversationId}, ${connectionId}, 'Respuesta', 'generated')`;
    const own = await admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_whatsapp_runtime");
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      return tx<
        { outbound_id: string }[]
      >`select outbound_id from outbound_commands`;
    });
    expect(own.map((row) => row.outbound_id)).toEqual([outboundId]);
    const crossTenant = await admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_whatsapp_runtime");
      await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
      return tx`select outbound_id from outbound_commands`;
    });
    expect(crossTenant).toHaveLength(0);
  });

  test("projects safe technical activity for administration", async () => {
    const occurredAt = "2026-03-01T10:03:00.000Z";
    await admin`insert into technical_events (business_id, component, code, severity, safe_details, occurred_at) values (${tenantA}, 'whatsapp-manager', 'whatsapp.send_failed', 'error', ${admin.json({ outboundRef: "out_abc" })}, ${occurredAt})`;
    const projection = await admin<
      { last_technical_activity_at: Date }[]
    >`select last_technical_activity_at from businesses where id = ${tenantA}`;
    expect(projection[0]?.last_technical_activity_at.toISOString()).toBe(
      occurredAt,
    );
  });

  test("reconstructs summary plus recent raw history after a database restart boundary", async () => {
    const connectionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await admin`insert into whatsapp_connections (id, business_id) values (${connectionId}, ${tenantB})`;
    await admin`insert into conversations (id, business_id, connection_id, remote_jid) values (${conversationId}, ${tenantB}, ${connectionId}, '549222@s.whatsapp.net')`;
    for (const [sequence, text] of [
      [1, "Primero"],
      [2, "Segundo"],
      [3, "Reciente"],
    ] as const) {
      await admin`insert into messages (business_id, conversation_id, connection_id, provider_message_id, sequence, direction, raw_text, received_at) values (${tenantB}, ${conversationId}, ${connectionId}, ${`ctx-${sequence}`}, ${sequence}, 'inbound', ${text}, now())`;
    }
    await admin`insert into conversation_summaries (business_id, conversation_id, version, covered_through, structured_summary) values (${tenantB}, ${conversationId}, 1, 2, ${admin.json({ facts: ["Primero y segundo"] })})`;
    const raw = await admin<
      { sequence: number; raw_text: string }[]
    >`select sequence, raw_text from messages where business_id = ${tenantB} and conversation_id = ${conversationId} order by sequence`;
    const summary = await admin<
      { covered_through: number }[]
    >`select covered_through from conversation_summaries where business_id = ${tenantB} and conversation_id = ${conversationId}`;
    expect(raw.map((row) => row.raw_text)).toEqual([
      "Primero",
      "Segundo",
      "Reciente",
    ]);
    expect(Number(summary[0]?.covered_through)).toBe(2);
  });

  test("rejects a vacuous tenant-isolation collection before evaluating every row", () => {
    expect(() => assertNonEmptyTenantRows([], tenantA)).toThrow(/non-empty/i);
    expect(() =>
      assertNonEmptyTenantRows([{ business_id: tenantA }], tenantA),
    ).not.toThrow();
  });

  test("denies cross-tenant data across every v1 repository boundary", async () => {
    const connectionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const connectionB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const conversationB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await admin`insert into business_profiles (business_id, display_name) values (${tenantA}, 'A'), (${tenantB}, 'B')`;
    await admin`insert into agent_configs (business_id) values (${tenantA}), (${tenantB})`;
    await admin`insert into audit_events (business_id, actor_id, event_type, outcome, request_id, stream_sequence, previous_hash, event_hash, hmac_key_version) values
      (${tenantA}, 'worker', 'ai.failed', 'failure', 'req-audit-a', 1, 'GENESIS', ${"a".repeat(64)}, 'v1'),
      (${tenantB}, 'worker', 'ai.failed', 'failure', 'req-audit-b', 1, 'GENESIS', ${"b".repeat(64)}, 'v1')`;
    await admin`insert into technical_events (business_id, component, code, severity) values (${tenantB}, 'ai-provider', 'ai.failed', 'error')`;
    await admin`insert into whatsapp_auth_records (business_id, connection_id, record_name, version, nonce, ciphertext, auth_tag) values
      (${tenantA}, ${connectionA}, 'creds', 1, decode('00', 'hex'), decode('01', 'hex'), decode('02', 'hex')),
      (${tenantB}, ${connectionB}, 'creds', 1, decode('03', 'hex'), decode('04', 'hex'), decode('05', 'hex'))`;
    await admin`insert into outbound_commands (outbound_id, business_id, conversation_id, connection_id, text, state) values ('ffffffff-ffff-4fff-8fff-ffffffffffff', ${tenantB}, ${conversationB}, ${connectionB}, 'Respuesta B', 'generated')`;

    const queryAs = (role: string, table: string) =>
      admin.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
        return tx.unsafe<{ business_id: string }[]>(
          `select business_id::text from ${table} order by business_id`,
        );
      });
    for (const table of [
      "business_profiles",
      "agent_configs",
      "audit_events",
      "technical_events",
    ]) {
      const rows = await queryAs("agendia_runtime", table);
      assertNonEmptyTenantRows(rows, tenantA);
    }
    for (const table of [
      "whatsapp_connections",
      "whatsapp_auth_records",
      "conversations",
      "messages",
      "outbound_commands",
    ]) {
      const rows = await queryAs("agendia_whatsapp_runtime", table);
      assertNonEmptyTenantRows(rows, tenantA);
    }
    const adminContent = admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_admin_runtime");
      return tx`select raw_text from messages`;
    });
    await expect(adminContent).rejects.toThrow(/permission denied/i);
  });
});
