import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  sql: Sql;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const sql = postgres(container.getConnectionUri(), { max: 4 });
  return {
    container,
    sql,
    async stop() {
      await sql.end();
      await container.stop();
    },
  };
}

export function testTenantContext(businessId: string, role: "business_user" | "internal_worker" = "business_user") {
  const suffix = businessId[0];
  return { businessId, actorId: `${role}-${suffix}`, role, requestId: `test-${suffix}` } as const;
}

export async function createRoleLogin(database: TestPostgres, login: string, membership: `agendia_${string}`): Promise<string> {
  if (!/^[a-z][a-z0-9_]+$/.test(login) || !/^agendia_[a-z_]+$/.test(membership)) throw new Error("Unsafe PostgreSQL test role");
  const password = "test-only-password";
  await database.sql.unsafe(`create role "${login}" login password '${password}' in role ${membership}`);
  const url = new URL(database.container.getConnectionUri());
  url.username = login;
  url.password = password;
  return url.toString();
}

export function migrationNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
}

export async function applyPostgresMigrations(sql: Sql, directory: string): Promise<number> {
  const names = migrationNames(directory);
  if (names.length === 0) throw new Error("No migrations found");
  for (const name of names) {
    try {
      await sql.unsafe(readFileSync(join(directory, name), "utf8"));
    } catch (cause) {
      throw new Error(`Migration ${name} failed`, { cause });
    }
  }
  return names.length;
}

const schemaQuery = `
  select kind, identity, definition from (
    select 'relation' as kind, n.nspname || '.' || c.relname as identity,
      concat(c.relkind, ':rls=', c.relrowsecurity, ':force=', c.relforcerowsecurity) as definition
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
    union all
    select 'column', n.nspname || '.' || c.relname || '.' || a.attname,
      format_type(a.atttypid, a.atttypmod) || ':notnull=' || a.attnotnull || ':default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
    union all
    select 'constraint', n.nspname || '.' || c.relname || '.' || x.conname, pg_get_constraintdef(x.oid, true)
    from pg_constraint x join pg_class c on c.oid = x.conrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    union all
    select 'index', schemaname || '.' || tablename || '.' || indexname, indexdef
    from pg_indexes where schemaname = 'public'
    union all
    select 'policy', schemaname || '.' || tablename || '.' || policyname,
      concat(cmd, ':', permissive, ':', coalesce(qual, ''), ':', coalesce(with_check, ''))
    from pg_policies where schemaname = 'public'
    union all
    select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid, true)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
    union all
    select 'function', n.nspname || '.' || p.proname || '.' || p.oid::text, pg_get_functiondef(p.oid)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    union all
    select 'role', rolname, concat('bypassrls=', rolbypassrls, ':super=', rolsuper, ':login=', rolcanlogin)
    from pg_roles where rolname like 'agendia_%'
  ) schema_objects order by kind, identity, definition`;

async function schemaFingerprint(sql: Sql): Promise<string> {
  const rows = await sql.unsafe<{ kind: string; identity: string; definition: string }[]>(schemaQuery);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export interface MigrationVerificationOptions {
  migrationDirectory: string;
  mutateActual?: (sql: Sql) => Promise<unknown> | unknown;
}

export async function verifyPostgresMigrations(options: MigrationVerificationOptions) {
  const expected = await startTestPostgres();
  let migrationCount: number;
  let expectedFingerprint: string;
  try {
    migrationCount = await applyPostgresMigrations(expected.sql, options.migrationDirectory);
    expectedFingerprint = await schemaFingerprint(expected.sql);
  } finally {
    await expected.stop();
  }

  const actual = await startTestPostgres();
  try {
    await applyPostgresMigrations(actual.sql, options.migrationDirectory);
    await options.mutateActual?.(actual.sql);
    const actualFingerprint = await schemaFingerprint(actual.sql);
    if (actualFingerprint !== expectedFingerprint) {
      throw new Error(`Schema drift detected: expected ${expectedFingerprint}, received ${actualFingerprint}`);
    }
    return { migrationCount, schemaFingerprint: actualFingerprint };
  } finally {
    await actual.stop();
  }
}
