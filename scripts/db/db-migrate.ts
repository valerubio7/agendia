import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { MigrationHistoryError, MigrationOutcomeError, validateAndAdopt, validatedMigrations } from "./drizzle-migrations.ts";

export { MigrationHistoryError, MigrationOutcomeError } from "./drizzle-migrations.ts";
export interface MigrationDependencies {
  connect(url: string): Client;
  migrationsFolder: string;
}
const systemDependencies: MigrationDependencies = {
  connect: url => new Client({ connectionString: url, application_name: "agendia-db-migrate" }),
  migrationsFolder: fileURLToPath(new URL("../../packages/db/migrations/", import.meta.url)),
};

export async function migrateDatabase(url: string, dependencies: MigrationDependencies = systemDependencies) {
  // Validate every complete source before any database writes, including pending SQL.
  const migrations = validatedMigrations(dependencies.migrationsFolder);
  const client = dependencies.connect(url);
  let lost = false;
  let closing = false;
  let stockStarted = false;
  let transactionStarted = false;
  let committed = false;
  client.on("error", () => { lost = true; });
  client.on("end", () => { if (!closing) lost = true; });
  try {
    await client.connect();
    await client.query("select pg_advisory_lock(hashtext('agendia:production-setup'))");
    if (lost) throw new Error("Session lost");
    // Stock BEGIN nests without a savepoint; its COMMIT ends this outer transaction.
    transactionStarted = true;
    await client.query("BEGIN");
    await validateAndAdopt(client, migrations);
    if (lost) throw new Error("Session lost");
    stockStarted = true;
    await migrate(drizzle(client), { migrationsFolder: dependencies.migrationsFolder });
    committed = true;
    if (lost) throw new MigrationOutcomeError("Migration connection lost; durable outcome requires reconciliation");
    // No required writes follow stock COMMIT. Closing releases the session lock.
  } catch (error) {
    if (transactionStarted && !committed && !lost) {
      try { await client.query("ROLLBACK"); }
      catch { lost = true; }
    }
    if (lost) throw new MigrationOutcomeError(stockStarted
      ? "Migration connection lost; durable outcome requires reconciliation"
      : "Migration connection lost before stock execution; transaction aborted");
    throw error;
  } finally {
    closing = true;
    await client.end();
  }
}

export async function migrateDevelopmentDatabase(
  url: string | undefined = process.env.DATABASE_URL,
  dependencies: MigrationDependencies = systemDependencies,
) {
  if (!url?.trim()) throw new Error("DATABASE_URL is required");
  await migrateDatabase(url, dependencies);
}

if (import.meta.main) {
  try {
    await migrateDevelopmentDatabase();
    console.log("Pending database migrations applied.");
  } catch (error) {
    // Driver errors can contain connection credentials or SQL; never print them.
    console.error(!process.env.DATABASE_URL?.trim() ? "DATABASE_URL is required"
      : error instanceof MigrationHistoryError || error instanceof MigrationOutcomeError ? error.message
      : "Development migration failed; database details withheld.");
    process.exitCode = 1;
  }
}
