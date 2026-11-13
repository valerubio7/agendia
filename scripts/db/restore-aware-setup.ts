import postgres from "postgres";
import { MigrationHistoryError, migrateDevelopmentDatabase } from "./db-migrate.ts";
import {
  RestoreRepairError,
  repairRestoredDatabase,
  type RepairResult,
} from "./repair-restored-db.ts";

// Dokploy's native backup omits ACLs (`pg_dump --no-acl`) and its restore
// recreates objects without them (`pg_restore -O`). Missing capability grants
// are therefore the signature of a restored database: the app can connect, but
// every statement executed through a capability role is denied.
export async function needsRestoreRepair(url: string): Promise<boolean> {
  const sql = postgres(url, {
    max: 1,
    connection: { application_name: "agendia-restore-probe" },
  });
  try {
    const [row] = await sql<{ runtime_select: boolean; worker_publish: boolean }[]>`
      select has_table_privilege('agendia_runtime','public.businesses','SELECT') runtime_select,
        has_column_privilege('agendia_worker_runtime','public.outbox_events','published_at','UPDATE') worker_publish`;
    return row?.runtime_select !== true || row?.worker_publish !== true;
  } finally {
    await sql.end();
  }
}

export type RestoreAwareSetupResult =
  | { repaired: false }
  | { repaired: true; result: RepairResult };

// Runs on every deployment and application start, before the API and workers.
// A healthy database only applies pending migrations. A database restored by
// Dokploy is repaired in place: owners and capability grants are rebuilt and
// restored pending work is cancelled before any consumer can process it.
export async function runRestoreAwareSetup(
  url: string | undefined = process.env.DATABASE_URL,
): Promise<RestoreAwareSetupResult> {
  if (!url?.trim()) throw new MigrationHistoryError("DATABASE_URL is required");
  await migrateDevelopmentDatabase(url);
  if (!(await needsRestoreRepair(url))) return { repaired: false };
  return { repaired: true, result: await repairRestoredDatabase(url) };
}

if (import.meta.main) {
  try {
    const outcome = await runRestoreAwareSetup();
    if (outcome.repaired) {
      console.log(
        `Restore detected. Repaired ${outcome.result.ownersRepaired} owners and ` +
          `${outcome.result.grantsRepaired} grants; cancelled ${outcome.result.outboxCancelled} outbox events, ` +
          `${outcome.result.commandsCancelled} outbound commands and ${outcome.result.jobsCancelled} queued jobs.`,
      );
    } else {
      console.log("Database migrations applied; no restore repair needed.");
    }
  } catch (error) {
    // Driver errors can contain connection credentials or SQL; never print them.
    console.error(!process.env.DATABASE_URL?.trim() ? "DATABASE_URL is required"
      : error instanceof MigrationHistoryError || error instanceof RestoreRepairError
        ? error.message
        : "Database setup failed; database details withheld.");
    process.exitCode = 1;
  }
}
