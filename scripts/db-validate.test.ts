import { expect, test } from "bun:test";
import { validateReviewedMigration } from "./db-validate.ts";

test("validates only the reviewed base migration's presence", () => {
  const paths: string[] = [];
  validateReviewedMigration((path) => { paths.push(path); return true; });
  expect(paths).toEqual(["packages/db/migrations/0000_base.sql"]);
  expect(() => validateReviewedMigration(() => false)).toThrow("Missing reviewed base migration");
});

test("standard unit runner includes scripts and exposes only honest DB commands", async () => {
  const { scripts } = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(scripts["test:unit"].split(" ")).toContain("scripts");
  expect(scripts["db:validate"]).toBe("bun run scripts/db-validate.ts");
  expect(scripts["db:migrate:dev"]).toBe("bun run scripts/db-migrate.ts");
  expect(scripts["db:generate"]).toBeUndefined();
  expect(scripts["db:migrate"]).toBeUndefined();
});
