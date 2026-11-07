import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { is, SQL } from "drizzle-orm";
import { PgDialect, getTableConfig, type UpdateDeleteAction } from "drizzle-orm/pg-core";
import { tenantRecords } from "../../packages/db/src/schema.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/postgres.ts";

let db: TestPostgres;
const config = getTableConfig(tenantRecords);
const dialect = new PgDialect();

beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
}, 120_000);
afterAll(async () => { await db?.stop(); });

test("tenant_records Drizzle columns and constraints match the migrated table", async () => {
  const columns = await db.sql<{ name: string; type: string; not_null: boolean; default_value: string | null }[]>`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
    a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default_value
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='public.tenant_records'::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum`;
  expect(config.columns.map(column => ({
    name: column.name,
    type: column.getSQLType(),
    not_null: column.notNull,
    default_value: column.default === undefined ? null : is(column.default, SQL)
      ? dialect.sqlToQuery(column.default).sql : String(column.default),
  }))).toEqual([...columns]);

  const constraints = await db.sql<{ name: string; type: string; definition: string }[]>`select conname as name, contype::text as type,
    pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid='public.tenant_records'::regclass and contype <> 'f' order by conname`;
  const foreignKeys = await db.sql<{
    name: string; target_schema: string; target_table: string; source_columns: string[];
    target_columns: string[]; on_update: UpdateDeleteAction; on_delete: UpdateDeleteAction;
  }[]>`select c.conname as name, n.nspname as target_schema, t.relname as target_table,
    array(select a.attname from unnest(c.conkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum order by k.ord) as source_columns,
    array(select a.attname from unnest(c.confkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum order by k.ord) as target_columns,
    case c.confupdtype when 'a' then 'no action' when 'r' then 'restrict' when 'c' then 'cascade'
      when 'n' then 'set null' when 'd' then 'set default' end as on_update,
    case c.confdeltype when 'a' then 'no action' when 'r' then 'restrict' when 'c' then 'cascade'
      when 'n' then 'set null' when 'd' then 'set default' end as on_delete
    from pg_constraint c join pg_class t on t.oid=c.confrelid
    join pg_namespace n on n.oid=t.relnamespace
    where c.conrelid='public.tenant_records'::regclass and c.contype='f' order by c.conname`;
  const foreign = config.foreignKeys.map(key => {
    const ref = key.reference();
    const target = getTableConfig(ref.foreignTable);
    return {
      name: key.getName(), target_schema: target.schema ?? "public", target_table: target.name,
      source_columns: ref.columns.map(column => column.name),
      target_columns: ref.foreignColumns.map(column => column.name),
      on_update: key.onUpdate ?? "no action", on_delete: key.onDelete ?? "no action",
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  expect(foreign).toEqual([...foreignKeys]);
  const unique = config.uniqueConstraints.map(key => ({
    name: key.getName(), type: "u", definition: `UNIQUE (${key.columns.map(c => c.name).join(", ")})`,
  }));
  const primary = config.columns.filter(column => column.primary);
  expect([...unique, { name: "tenant_records_pkey", type: "p", definition: `PRIMARY KEY (${primary.map(c => c.name).join(", ")})` }]
    .sort((a, b) => a.name!.localeCompare(b.name!))).toEqual([...constraints]);
});

test("Drizzle policies produce the migrated policy definitions", async () => {
  const [flags] = await db.sql`select relrowsecurity, relforcerowsecurity from pg_class where oid='public.tenant_records'::regclass`;
  expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  expect(config.enableRLS).toBe(true);
  await db.sql`create schema drizzle_parity`;
  await db.sql`create table drizzle_parity.tenant_records (business_id uuid not null)`;
  for (const policy of config.policies) {
    // Only fixed migration-owned identifiers can be used in this test DDL.
    expect(policy.name).toMatch(/^[a-z_]+$/);
    expect(typeof policy.to).toBe("string");
    expect(policy.to).toMatch(/^[a-z_]+$/);
    const using = policy.using ? ` USING (${dialect.sqlToQuery(policy.using).sql})` : "";
    const check = policy.withCheck ? ` WITH CHECK (${dialect.sqlToQuery(policy.withCheck).sql})` : "";
    await db.sql.unsafe(`CREATE POLICY ${policy.name} ON drizzle_parity.tenant_records AS ${policy.as ?? "permissive"} FOR ${policy.for ?? "all"} TO ${policy.to}${using}${check}`);
  }
  const policies = (schema: string) => db.sql`select policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname=${schema} and tablename='tenant_records' order by policyname`;
  expect([...(await policies("drizzle_parity"))]).toEqual([...(await policies("public"))]);
});
