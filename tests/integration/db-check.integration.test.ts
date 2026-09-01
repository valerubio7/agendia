import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPostgresMigrations } from "../../scripts/support/postgres-migrations.ts";

const temporaryDirectories: string[] = [];
const migrations = join(import.meta.dir, "../../packages/db/migrations");

function temporaryMigrations(sql: string): string {
  const directory = mkdtempSync(join(tmpdir(), "agendia-migrations-"));
  temporaryDirectories.push(directory);
  cpSync(migrations, directory, { recursive: true });
  writeFileSync(join(directory, "9999_invalid.sql"), sql);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories)
    rmSync(directory, { recursive: true, force: true });
});

describe("database migration and drift gate", () => {
  test("migrates two clean PostgreSQL databases and compares their real schemas", async () => {
    const result = await verifyPostgresMigrations({
      migrationDirectory: migrations,
    });
    expect(result.migrationCount).toBeGreaterThan(0);
    expect(result.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  test("rejects a temporary invalid migration", async () => {
    const invalid = temporaryMigrations("create table broken (");
    await expect(
      verifyPostgresMigrations({ migrationDirectory: invalid }),
    ).rejects.toThrow(/syntax|migration/i);
  }, 120_000);

  test("rejects real schema drift introduced after migration", async () => {
    await expect(
      verifyPostgresMigrations({
        migrationDirectory: migrations,
        mutateActual: (sql) =>
          sql.unsafe("create table drift_probe (id integer primary key)"),
      }),
    ).rejects.toThrow(/schema drift/i);
  }, 120_000);
});
