import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

export interface MigrationDependencies {
  connect(url: string): Pick<postgres.Sql, "begin" | "end">;
  list(): string[];
  read(name: string): string;
}
const directory = new URL("../../packages/db/migrations/", import.meta.url);
const systemDependencies: MigrationDependencies = {
  connect: (url) => postgres(url, { max: 1 }),
  list: () => readdirSync(directory),
  read: (name) => readFileSync(new URL(name, directory), "utf8"),
};

// Only these controlled diagnostics are safe to expose at either CLI boundary.
export class MigrationHistoryError extends Error {}

export async function migrateDatabase(
  sql: Pick<postgres.Sql, "begin">,
  files: Pick<MigrationDependencies, "list" | "read"> = systemDependencies,
) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('agendia:production-setup'))`;
    const migrations = files.list().filter((name) => name.endsWith(".sql")).sort().map((name) => {
      const source = files.read(name);
      return { name, source, checksum: createHash("sha256").update(source).digest("hex") };
    });
    if (!migrations.length) throw new MigrationHistoryError("No migrations found");
    const [existing] = await tx`select to_regclass('public.agendia_production_migrations') ledger`;
    const applied = existing?.ledger
      ? await tx<{ name: string; checksum: string }[]>`select name, checksum from public.agendia_production_migrations`
      : [];
    if (!applied.length) {
      // Refuse to replay an untracked schema, including one with an empty ledger.
      const [state] = await tx`select (
        exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')
          and c.relname <> 'agendia_production_migrations')
        or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public')
      ) initialized`;
      if (state?.initialized)
        throw new MigrationHistoryError("Migration history is required for an initialized database");
    }
    // Validate the ENTIRE existing history before any pending SQL or ledger writes.
    const sources = new Map(migrations.map((migration) => [migration.name, migration]));
    for (const entry of applied) {
      const migration = sources.get(entry.name);
      if (!migration) throw new MigrationHistoryError("Applied migration is missing from migration files");
      if (entry.checksum !== migration.checksum) throw new MigrationHistoryError("Applied migration changed");
    }
    if (!existing?.ledger) {
      await tx`create table if not exists public.agendia_production_migrations
        (name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
    }
    const completed = new Set(applied.map((entry) => entry.name));
    for (const migration of migrations) {
      if (completed.has(migration.name)) continue;
      await tx.unsafe(migration.source);
      await tx`insert into public.agendia_production_migrations(name,checksum) values(${migration.name},${migration.checksum})`;
    }
  });
}

export async function migrateDevelopmentDatabase(
  url: string | undefined = process.env.DATABASE_URL,
  dependencies: MigrationDependencies = systemDependencies,
) {
  if (!url?.trim()) throw new Error("DATABASE_URL is required");
  const sql = dependencies.connect(url);
  try {
    await migrateDatabase(sql, dependencies);
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  try {
    await migrateDevelopmentDatabase();
    console.log("Pending database migrations applied.");
  } catch (error) {
    // Driver errors can contain connection credentials or SQL; never print them.
    console.error(!process.env.DATABASE_URL?.trim() ? "DATABASE_URL is required"
      : error instanceof MigrationHistoryError ? error.message
      : "Development migration failed; database details withheld.");
    process.exitCode = 1;
  }
}
