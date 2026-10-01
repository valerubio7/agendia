import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import {
  applyPostgresMigrations,
  startTestPostgres,
} from "../../tests/support/postgres.ts";

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
  const rows =
    await sql.unsafe<{ kind: string; identity: string; definition: string }[]>(
      schemaQuery,
    );
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export interface MigrationVerificationOptions {
  migrationDirectory: string;
  mutateActual?: (sql: Sql) => Promise<unknown> | unknown;
}

export async function verifyPostgresMigrations(
  options: MigrationVerificationOptions,
) {
  const expected = await startTestPostgres();
  let migrationCount: number;
  let expectedFingerprint: string;
  try {
    migrationCount = await applyPostgresMigrations(
      expected.sql,
      options.migrationDirectory,
    );
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
      throw new Error(
        `Schema drift detected: expected ${expectedFingerprint}, received ${actualFingerprint}`,
      );
    }
    return { migrationCount, schemaFingerprint: actualFingerprint };
  } finally {
    await actual.stop();
  }
}
