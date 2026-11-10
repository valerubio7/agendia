import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, getViewConfig, isPgView, PgColumn, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../packages/db/src/schema.ts";
import { materializeTables, render, tableCatalog } from "../support/drizzle-schema-parity.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/postgres.ts";

const names = [
  "businesses", "tenant_records", "auth_identities", "web_sessions", "business_profiles", "agent_configs",
  "audit_events", "technical_events", "outbox_events", "inbox_events", "operational_controls",
  "whatsapp_connections", "whatsapp_auth_records", "whatsapp_link_codes", "conversations", "messages",
  "conversation_summaries", "outbound_commands", "services", "clients", "business_calendars",
  "business_calendar_closures", "resources", "resource_services", "appointments", "appointment_operation_receipts",
  "whatsapp_sender_bindings", "whatsapp_received_senders", "whatsapp_agenda_dialogues", "whatsapp_agenda_receipts",
  "login_throttle_global", "login_throttle_accounts", "registration_throttle", "pending_registrations", "service_categories",
].sort();
const tables = Object.values(schema).filter(value => is(value, PgTable));
const views = Object.values<unknown>(schema).filter(isPgView);
const shadow = "drizzle_catalog_parity";
let db: TestPostgres;

beforeAll(async () => {
  db = await startTestPostgres();
  expect(await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"))).toBe(9);
  await materializeTables(db.sql, tables, shadow);
  for (const view of views) {
    const config = getViewConfig(view);
    if (!config.query) throw new Error("View definition is required for parity");
    await db.sql.unsafe(`CREATE VIEW ${shadow}.${config.name} AS ${render(config.query)}`);
  }
}, 120_000);
afterAll(async () => { await db?.stop(); });

test("complete final public application table/view inventory", async () => {
  const inventory = await db.sql`select relname, relkind::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and relkind in ('r','v') order by relname`;
  expect(inventory.filter(row => row.relkind === "r").map(row => row.relname)).toEqual(names);
  expect(tables.map(table => getTableConfig(table).name).sort()).toEqual(names);
  expect(views.map(view => getViewConfig(view).name)).toEqual(["admin_business_status"]);
  expect(inventory.filter(row => row.relkind === "v").map(row => row.relname)).toEqual(["admin_business_status"]);
});

for (const name of names) {
  test(`${name}: columns, constraints, indexes, policies and ENABLE/FORCE RLS`, async () => {
    const table = tables.find(table => getTableConfig(table).name === name);
    expect(table, `Missing Drizzle table ${name}`).toBeDefined();
    expect(await tableCatalog(db.sql, shadow, name)).toEqual(await tableCatalog(db.sql, "public", name));
    const [flags] = await db.sql`select relrowsecurity, relforcerowsecurity from pg_class where oid=to_regclass(${"public." + name})`;
    // FORCE has no public Drizzle API; retain and pin its SQL alongside ENABLE metadata.
    expect(flags).toEqual({ relrowsecurity: getTableConfig(table!).enableRLS, relforcerowsecurity: getTableConfig(table!).enableRLS });
  });
}

test("admin_business_status: declared result columns and final filtered view definition", async () => {
  const view = views.find(view => getViewConfig(view).name === "admin_business_status");
  expect(view).toBeDefined();
  expect(await tableCatalog(db.sql, shadow, "admin_business_status")).toEqual(await tableCatalog(db.sql, "public", "admin_business_status"));
  const [definition] = await db.sql`select pg_get_viewdef('public.admin_business_status'::regclass) as actual,
    pg_get_viewdef(to_regclass(${shadow + ".admin_business_status"})) as represented`;
  expect(definition!.represented).toBe(definition!.actual);
  const config = getViewConfig(view!);
  const actual = (await tableCatalog(db.sql, "public", config.name)).columns;
  expect(Object.values(config.selectedFields).map(column => {
    if (!is(column, PgColumn)) throw new Error("View needs declared columns");
    return { name: column.name, type: column.getSQLType() };
  })).toEqual(actual.map(column => ({ name: column.name, type: column.type.replace("character varying", "varchar") })));
});

test("representative column/default, FK action, standalone index and policy drift is detected", async () => {
  for (const statement of [
    `ALTER TABLE ${shadow}.web_sessions ALTER COLUMN idle_ttl_ms SET DEFAULT 123`,
    `ALTER TABLE ${shadow}.whatsapp_link_codes DROP CONSTRAINT whatsapp_link_codes_business_id_connection_id_fkey;
     ALTER TABLE ${shadow}.whatsapp_link_codes ADD CONSTRAINT whatsapp_link_codes_business_id_connection_id_fkey
       FOREIGN KEY (business_id,connection_id) REFERENCES ${shadow}.whatsapp_connections(business_id,id)`,
    `CREATE INDEX parity_unexpected_index ON ${shadow}.messages(raw_text)`,
    `ALTER POLICY conversations_internal ON ${shadow}.conversations TO agendia_runtime USING (false)`,
  ]) {
    const name = statement.includes("web_sessions") ? "web_sessions" : statement.includes("whatsapp_link_codes") ? "whatsapp_link_codes" : statement.includes("messages") ? "messages" : "conversations";
    // Roll back each mutation, retaining the same baseline for every check.
    await db.sql.begin(async tx => {
      await tx.unsafe(statement);
      expect(await tableCatalog(tx, shadow, name)).not.toEqual(await tableCatalog(tx, "public", name));
      throw new Error("rollback parity drift");
    }).catch(error => { if (error.message !== "rollback parity drift") throw error; });
  }
});

test("retained SQL-only guarantees: exclusion, collations, roles, routines, ACLs, triggers, extension and seeds", async () => {
  const exclusions = await db.sql`select conname, pg_get_constraintdef(oid) as definition from pg_constraint where contype='x' and connamespace='public'::regnamespace`;
  expect([...exclusions]).toEqual([{ conname: "appointments_confirmed_capacity", definition: "EXCLUDE USING gist (business_id WITH =, resource_id WITH =, int8range(start_ms, end_ms, '[)'::text) WITH &&) WHERE ((state = 'confirmed'::text))" }]);
  const [collation] = await db.sql`select collprovider::text, collisdeterministic, colliculocale from pg_collation where collname='service_name_case'`;
  expect(collation).toEqual({ collprovider: "i", collisdeterministic: true, colliculocale: "und" });
  const collated = await db.sql`select table_name, collation_name from information_schema.columns where table_schema='public' and column_name='normalized_name' order by table_name`;
  expect([...collated]).toEqual([{ table_name: "resources", collation_name: "C" }, { table_name: "services", collation_name: "C" }]);
  const roles = await db.sql`select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls from pg_roles where rolname like 'agendia_%' order by rolname`;
  expect([...roles]).toEqual(["agendia_admin_runtime", "agendia_business_purge", "agendia_runtime", "agendia_whatsapp_runtime", "agendia_worker_runtime"].map(rolname => ({ rolname, rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false })));
  const memberships = await db.sql`select member.rolname as member from pg_auth_members m join pg_roles role on role.oid=m.roleid join pg_roles member on member.oid=m.member where role.rolname='agendia_business_purge'`;
  expect(memberships.map(row => row.member)).toEqual(["test"]);
  const [routine] = await db.sql`select prosecdef, proconfig, pg_get_functiondef(oid) as definition from pg_proc where oid='guard_live_business_write()'::regprocedure`;
  expect(routine!.prosecdef).toBe(true);
  expect(routine!.proconfig).toEqual(["search_path=pg_catalog, public"]);
  expect(routine!.definition).toContain("ERRCODE = '42501'");
  const [purge] = await db.sql`select pg_get_userbyid(proowner) as owner, prosecdef from pg_proc where oid='delete_business(uuid,uuid,uuid,text)'::regprocedure`;
  expect(purge).toEqual({ owner: "agendia_business_purge", prosecdef: true });
  const publicDefiners = await db.sql`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    where n.nspname='public' and p.prosecdef and acl.grantee=0 and acl.privilege_type='EXECUTE' order by p.proname`;
  // Trigger functions predate explicit EXECUTE revokes; no callable capability function is public.
  expect(publicDefiners.map(row => row.proname)).toEqual(["guard_live_business_session", "guard_live_business_write", "project_last_technical_activity"]);
  const [permissions] = await db.sql`select
    has_function_privilege('agendia_admin_runtime','delete_business(uuid,uuid,uuid,text)','EXECUTE') as admin_delete,
    has_function_privilege('agendia_runtime','delete_business(uuid,uuid,uuid,text)','EXECUTE') as tenant_delete,
    has_table_privilege('agendia_business_purge','audit_events','DELETE') as audit_delete,
    has_column_privilege('agendia_admin_runtime','pending_registrations','password_phc','SELECT') as password_read,
    has_table_privilege('agendia_worker_runtime','outbox_events','UPDATE') as broad_outbox_update,
    has_column_privilege('agendia_worker_runtime','outbox_events','published_at','UPDATE') as publish_update`;
  expect(permissions).toEqual({ admin_delete: true, tenant_delete: false, audit_delete: false, password_read: false, broad_outbox_update: false, publish_update: true });
  const triggers = await db.sql`select c.relname, t.tgname, t.tgenabled::text from pg_trigger t join pg_class c on c.oid=t.tgrelid
    where not t.tgisinternal and c.relnamespace='public'::regnamespace order by c.relname,t.tgname`;
  expect(triggers.filter(t => t.tgname === "business_live_write").map(t => t.relname)).toEqual(names.filter(name => !["businesses", "web_sessions", "operational_controls", "login_throttle_global", "login_throttle_accounts", "registration_throttle", "pending_registrations"].includes(name)));
  expect(triggers.filter(t => t.tgname !== "business_live_write").map(t => [t.relname, t.tgname])).toEqual([["audit_events", "audit_events_immutable"], ["businesses", "business_deleted_immutable"], ["technical_events", "technical_events_project_activity"], ["web_sessions", "business_live_session"]]);
  expect(triggers.every(t => t.tgenabled === "O")).toBe(true);
  expect(await db.sql`select extname from pg_extension where extname='btree_gist'`).toHaveLength(1);
  expect(await db.sql`select nspname from pg_namespace where nspname='pgboss'`).toHaveLength(1);
  expect([...await db.sql`select singleton, automation_disabled, initial_delay_seconds, active_delay_seconds, inactivity_reset_seconds from operational_controls`]).toEqual([{ singleton: true, automation_disabled: false, initial_delay_seconds: 600, active_delay_seconds: 90, inactivity_reset_seconds: 3600 }]);
  for (const name of ["login_throttle_global", "registration_throttle"]) expect([...await db.sql.unsafe<{ singleton: boolean; attempts: number }[]>(`select singleton, attempts from ${name}`)]).toEqual([{ singleton: true, attempts: 0 }]);
});
