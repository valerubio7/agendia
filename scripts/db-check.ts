import { join } from "node:path";
import { verifyPostgresMigrations } from "./support/postgres-migrations.ts";

const result = await verifyPostgresMigrations({
  migrationDirectory: join(import.meta.dir, "../packages/db/migrations"),
});

console.log(
  `db:check passed: ${result.migrationCount} migrations applied to clean PostgreSQL; schema fingerprint ${result.schemaFingerprint} matched.`,
);
