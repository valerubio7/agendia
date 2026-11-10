import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Client } from "pg";

// Only controlled diagnostics may cross the public CLI boundary.
export class MigrationHistoryError extends Error {}
export class MigrationOutcomeError extends Error {}

export function validatedMigrations(folder: string) {
  try {
    const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8"));
    const names = readdirSync(folder).filter(name => name.endsWith(".sql")).sort();
    if (!names.length) throw new MigrationHistoryError("No migrations found");
    if (journal.version !== "7" || journal.dialect !== "postgresql" || !Array.isArray(journal.entries)
      || journal.entries.length !== names.length) throw new Error("Invalid journal");
    let previous = 0;
    for (const [idx, entry] of journal.entries.entries()) {
      if (!entry || entry.idx !== idx || entry.version !== "7" || !Number.isSafeInteger(entry.when)
        || entry.when <= previous || typeof entry.tag !== "string" || !/^[a-zA-Z0-9_-]+$/.test(entry.tag)
        || `${entry.tag}.sql` !== names[idx] || typeof entry.breakpoints !== "boolean"
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid journal");
      previous = entry.when;
    }
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    return migrations.map((migration, idx) => {
      if (migration.hash !== journal.entries[idx].sha256)
        throw new MigrationHistoryError("Migration source does not match journal checksum");
      return { ...migration, name: names[idx]! };
    });
  } catch (error) {
    if (error instanceof MigrationHistoryError) throw error;
    throw new MigrationHistoryError("Migration journal or file set is invalid");
  }
}

export async function validateAndAdopt(client: Client, migrations: ReturnType<typeof validatedMigrations>) {
  const { rows: [existing] } = await client.query<{ legacy: string | null; ledger: string | null }>(
    `select to_regclass('public.agendia_production_migrations') as legacy,
      to_regclass('drizzle.__drizzle_migrations') as ledger`);
  const legacy = existing?.legacy ? (await client.query<{ name: string; checksum: string }>(
    "select name, checksum from public.agendia_production_migrations order by name")).rows : [];
  const recorded = existing?.ledger ? (await client.query<{ id: number; hash: string; created_at: string }>(
    "select id, hash, created_at from drizzle.__drizzle_migrations order by created_at, id")).rows : [];
  for (const [idx, row] of legacy.entries()) {
    const migration = migrations.find(migration => migration.name === row.name);
    if (!migration) throw new MigrationHistoryError("Applied migration is missing from migration files");
    if (row.checksum !== migration.hash) throw new MigrationHistoryError("Applied migration changed");
    if (row.name !== migrations[idx]?.name)
      throw new MigrationHistoryError("Legacy history is not an unchanged chronological prefix");
  }
  for (const [idx, row] of recorded.entries()) {
    const migration = migrations[idx];
    // SERIAL values can have gaps after rollback; timestamps/hashes define the prefix.
    if (!migration || !Number.isSafeInteger(row.id) || row.id <= 0 || row.hash !== migration.hash
      || row.created_at !== String(migration.folderMillis))
      throw new MigrationHistoryError("Drizzle history is not an unchanged chronological prefix");
  }
  if (recorded.length && recorded.length < legacy.length)
    throw new MigrationHistoryError("Conflicting migration histories");
  if (!legacy.length && !recorded.length) {
    const { rows: [state] } = await client.query<{ initialized: boolean }>(`select (
      exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')
        and c.relname <> 'agendia_production_migrations')
      or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')
    ) initialized`);
    if (state?.initialized)
      throw new MigrationHistoryError("Migration history is required for an initialized database");
  }
  if (!recorded.length && legacy.length) {
    // Stock has no bootstrap-only public API; adoption uses its exact ledger shape.
    await client.query("create schema if not exists drizzle");
    await client.query(`create table if not exists drizzle.__drizzle_migrations
      (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    for (const migration of migrations.slice(0, legacy.length)) {
      await client.query("insert into drizzle.__drizzle_migrations(hash, created_at) values ($1, $2)",
        [migration.hash, migration.folderMillis]);
    }
  }
}
