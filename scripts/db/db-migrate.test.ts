import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { executableMigrationSource } from "./db-migrate.ts";

const migration = new URL("../../packages/db/migrations/0007_private_business_purge.sql", import.meta.url);
const wrapped = "DO $$ BEGIN CREATE ROLE agendia_business_purge NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;";

test("a pending cluster role creation becomes a no-op when the role already exists", () => {
  const source = readFileSync(migration, "utf8");
  const executable = executableMigrationSource(source);
  expect(source).toContain("CREATE ROLE agendia_business_purge");
  expect(executable).toContain(wrapped);
  expect(executable).not.toContain("\nCREATE ROLE agendia_business_purge");
});

test("the execution transform is idempotent and leaves wrapped migrations untouched", () => {
  const source = readFileSync(migration, "utf8");
  const once = executableMigrationSource(source);
  expect(executableMigrationSource(once)).toBe(once);
  const base = readFileSync(new URL("../../packages/db/migrations/0000_base.sql", import.meta.url), "utf8");
  expect(executableMigrationSource(base)).toBe(base);
});
