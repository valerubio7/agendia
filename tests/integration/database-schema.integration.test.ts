import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

let db: TestPostgres;
beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
}, 120_000);
afterAll(async () => { await db?.stop(); });

async function columns(table: string) {
  return [...await db.sql`select column_name,data_type,is_nullable,column_default from information_schema.columns
    where table_schema='public' and table_name=${table} order by ordinal_position`];
}

test("fresh schema has only retained profile fields and unbounded assistant text with inactive defaults", async () => {
  expect(await columns("business_profiles")).toEqual([
    { column_name: "business_id", data_type: "uuid", is_nullable: "NO", column_default: null },
    { column_name: "display_name", data_type: "character varying", is_nullable: "NO", column_default: null },
    { column_name: "description", data_type: "character varying", is_nullable: "NO", column_default: "''::character varying" },
    { column_name: "address", data_type: "character varying", is_nullable: "NO", column_default: "''::character varying" },
    { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
  ]);
  expect(await columns("assistant_configs")).toEqual([
    { column_name: "business_id", data_type: "uuid", is_nullable: "NO", column_default: null },
    { column_name: "active", data_type: "boolean", is_nullable: "NO", column_default: "false" },
    { column_name: "revision", data_type: "integer", is_nullable: "NO", column_default: "0" },
    { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" },
    { column_name: "style", data_type: "text", is_nullable: "NO", column_default: "''::text" },
    { column_name: "business_instructions", data_type: "text", is_nullable: "NO", column_default: "''::text" },
  ]);
  const businessId = randomUUID();
  await db.sql`insert into businesses(id,name) values(${businessId},'Assistant defaults')`;
  await db.sql`insert into assistant_configs(business_id) values(${businessId})`;
  expect((await db.sql`select style,business_instructions,active,revision from assistant_configs where business_id=${businessId}`)[0])
    .toEqual({ style: "", business_instructions: "", active: false, revision: 0 });
  const style = " \n\t😀".repeat(8_000), instructions = " Atención Ελληνικά 😀\n".repeat(8_000);
  await db.sql`update assistant_configs set style=${style},business_instructions=${instructions},active=true,revision=7 where business_id=${businessId}`;
  expect((await db.sql`select style,business_instructions,active,revision from assistant_configs where business_id=${businessId}`)[0])
    .toEqual({ style, business_instructions: instructions, active: true, revision: 7 });
});

test("structured services, calendars and resource assignments retain tenant-composite foreign keys", async () => {
  const businessId = randomUUID(), other = randomUUID(), serviceId = randomUUID(), foreignService = randomUUID(), resourceId = randomUUID();
  const schedule = { 1: [{ startMinute: 540, endMinute: 1080 }] };
  await db.sql`insert into businesses(id,name) values(${businessId},'Structured fixture'),(${other},'Other tenant')`;
  await db.sql`insert into business_profiles(business_id,display_name,description,address)
    values(${businessId},'Retained name','Retained description','Retained address')`;
  await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars)
    values(${serviceId},${businessId},'Structured service',30,1200),(${foreignService},${other},'Other service',30,1200)`;
  await db.sql`insert into business_calendars(business_id,weekly_schedule) values(${businessId},${db.sql.json(schedule)})`;
  await db.sql`insert into resources(id,business_id,name,weekly_schedule)
    values(${resourceId},${businessId},'Structured resource',${db.sql.json(schedule)})`;
  await db.sql`insert into resource_services(business_id,resource_id,service_id) values(${businessId},${resourceId},${serviceId})`;
  const snapshot = async () => ({
    profiles: [...await db.sql`select * from business_profiles where business_id=${businessId}`],
    services: [...await db.sql`select * from services where business_id=${businessId}`],
    calendars: [...await db.sql`select * from business_calendars where business_id=${businessId}`],
    resources: [...await db.sql`select * from resources where business_id=${businessId}`],
    assignments: [...await db.sql`select * from resource_services where business_id=${businessId}`],
  });
  const before = await snapshot();
  expect(before.profiles[0]).toMatchObject({ business_id: businessId, display_name: 'Retained name', description: 'Retained description', address: 'Retained address' });
  expect(before.calendars[0]!.weekly_schedule).toEqual(schedule);
  expect(before.resources[0]!.weekly_schedule).toEqual(schedule);
  expect(before.assignments).toEqual([{ business_id: businessId, resource_id: resourceId, service_id: serviceId }]);
  await expect(db.sql`insert into resource_services(business_id,resource_id,service_id)
    values(${businessId},${resourceId},${foreignService})`.execute()).rejects.toMatchObject({ code: "23503" });
  expect(await snapshot()).toEqual(before);
});

test("capability roles, forced tenant policies and owner-only throttle storage remain narrow", async () => {
  const roles = [...await db.sql`select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls
    from pg_roles where rolname in ('agendia_runtime','agendia_admin_runtime','agendia_whatsapp_runtime','agendia_worker_runtime') order by rolname`];
  expect(roles).toEqual(['agendia_admin_runtime','agendia_runtime','agendia_whatsapp_runtime','agendia_worker_runtime'].map(rolname => ({
    rolname, rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false,
  })));
  expect((await db.sql`select has_table_privilege('agendia_admin_runtime','public.tenant_records','SELECT') allowed`)[0]!.allowed).toBe(false);
  await expect(db.sql.begin(async tx => {
    await tx`set local role agendia_admin_runtime`;
    await tx`select * from tenant_records`;
  })).rejects.toMatchObject({ code: '42501' });
  const tenantTables = ['tenant_records','audit_events','technical_events','outbox_events','inbox_events',
    'business_profiles','assistant_configs','whatsapp_connections','whatsapp_auth_records','whatsapp_link_codes',
    'conversations','messages','conversation_summaries','outbound_commands','services','clients','business_calendars',
    'business_calendar_closures','resources','resource_services','appointments','appointment_operation_receipts',
    'whatsapp_sender_bindings','whatsapp_received_senders','whatsapp_agenda_dialogues','whatsapp_agenda_receipts'];
  const flags = await db.sql`select relname,relrowsecurity,relforcerowsecurity from pg_class
    where relnamespace='public'::regnamespace and relname=any(${tenantTables})`;
  expect(flags).toHaveLength(tenantTables.length);
  expect(flags.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  const policy = (await db.sql`select cmd,roles,qual,with_check from pg_policies
    where schemaname='public' and tablename='business_profiles' and policyname='business_profiles_tenant'`)[0]!;
  expect(policy).toMatchObject({ cmd: 'ALL', roles: ['agendia_runtime'] });
  expect(policy.qual).toBe(policy.with_check);
  expect(policy.qual).toContain("current_setting('app.tenant_id'::text, true)");
  const businessId = randomUUID(), other = randomUUID();
  await db.sql`insert into businesses(id,name) values(${businessId},'Visible'),(${other},'Hidden')`;
  await db.sql`insert into business_profiles(business_id,display_name) values(${businessId},'Visible'),(${other},'Hidden')`;
  await db.sql.begin(async tx => {
    await tx`set local role agendia_runtime`;
    await tx`select set_config('app.tenant_id',${businessId},true)`;
    expect([...await tx`select business_id from business_profiles`]).toEqual([{ business_id: businessId }]);
    await tx`select set_config('app.tenant_id','',true)`;
    expect(await tx`select business_id from business_profiles`).toHaveLength(0);
  });
  const throttleTables = ['login_throttle_global','login_throttle_accounts'];
  const owner = (await db.sql`select current_user owner`)[0]!.owner;
  const grants = [...await db.sql`select grantee,table_name,privilege_type,is_grantable from information_schema.table_privileges
    where table_schema='public' and table_name=any(${throttleTables}) order by grantee,table_name,privilege_type`];
  expect(grants).toEqual([...throttleTables].sort().flatMap(table_name =>
    ['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE'].map(privilege_type =>
      ({ grantee: owner, table_name, privilege_type, is_grantable: 'YES' }))));
  expect([...await db.sql`select singleton,attempts from login_throttle_global`]).toEqual([{ singleton: true, attempts: 0 }]);
  expect(await db.sql`select * from login_throttle_accounts`).toHaveLength(0);
  for (const role of roles.map(row => row.rolname)) {
    for (const table of throttleTables) {
      await expect(db.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx.unsafe(`select * from ${table}`);
      })).rejects.toMatchObject({ code: '42501' });
    }
    expect((await db.sql`select has_function_privilege(${role},'admit_login(text)','EXECUTE') allowed`)[0]!.allowed)
      .toBe(role === 'agendia_runtime');
  }
});
