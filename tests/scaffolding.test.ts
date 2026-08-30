import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatTddCycleRecord } from "../packages/test-support/src/index.ts";

const root = join(import.meta.dir, "..");

function readJson(path: string) {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
}

describe("monorepo reproducible", () => {
  test("declares the approved Bun workspaces and blocking scripts", () => {
    const manifest = readJson("package.json");
    expect(manifest.packageManager).toMatch(/^bun@/);
    expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(manifest.scripts).toMatchObject({
      lint: expect.any(String),
      typecheck: expect.any(String),
      test: expect.any(String),
      "test:e2e": expect.any(String),
      "db:check": expect.any(String),
      build: expect.any(String),
    });
  });

  test("includes its own scaffolding gate in the aggregate suite", () => {
    const scripts = readJson("package.json").scripts as Record<string, string>;
    expect(scripts["test:scaffolding"]).toBe("bun test tests/scaffolding.test.ts");
    expect(scripts.test).toContain("bun run test:scaffolding");
  });

  test("records a TDD cycle with literal commands and exact result fields", () => {
    expect(formatTddCycleRecord({
      phase: "RED",
      detail: "aggregate omits scaffolding",
      file: "tests/scaffolding.test.ts",
      command: 'PATH="$HOME/.bun/bin:$PATH" bun test tests/scaffolding.test.ts',
      exitCode: 1,
      result: "2 pass, 1 fail",
    })).toBe('| — | aggregate omits scaffolding | — | — | — | `tests/scaffolding.test.ts` | `PATH="$HOME/.bun/bin:$PATH" bun test tests/scaffolding.test.ts` | 1 | 2 pass, 1 fail |');
  });

  test("contains every approved deployment and package boundary", () => {
    const paths = [
      "apps/web/package.json",
      "apps/api/package.json",
      "apps/whatsapp-manager/package.json",
      "apps/message-worker/package.json",
      "packages/domain/package.json",
      "packages/contracts/package.json",
      "packages/db/package.json",
      "packages/auth/package.json",
      "packages/observability/package.json",
      "packages/test-support/package.json",
    ];
    expect(paths.filter((path) => existsSync(join(root, path)))).toEqual(paths);
  });
});
