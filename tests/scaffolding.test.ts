import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function readJson(path: string) {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<
    string,
    unknown
  >;
}

// Normalize scalar lines, not YAML structure; this gate covers our small workflow
// policy without introducing a YAML parser dependency.
const workflow = () =>
  readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const policyLines = (source: string) =>
  source.split("\n").map((line) => line.trim().replace(/\s+#.*$/, ""));

describe("fast CI policy", () => {
  test("targets main with read-only access and bounded isolated runs", () => {
    const source = workflow();
    const lines = policyLines(source);
    for (const event of ["pull_request", "push"]) {
      expect(source).toMatch(
        new RegExp(`${event}:\\s*\\n\\s+branches:\\s*\\[main\\]`),
      );
    }
    expect(source).not.toMatch(/pull_request_target/);
    const permissions = source.match(/^permissions:[^\n]*\n((?:[ \t]+[^\n]*\n|\n)*)/m);
    expect(permissions).not.toBeNull();
    expect(policyLines(permissions?.[1] ?? "").filter(Boolean)).toEqual([
      "contents: read",
    ]);
    expect(lines).toContain("group: ${{ github.workflow }}-${{ github.ref }}");
    expect(lines).toContain("cancel-in-progress: true");
    expect(lines).toContain("runs-on: ubuntu-latest");
    expect(lines).toContain("name: Validation");
    const timeout = source.match(/timeout-minutes:\s*(\d+)/);
    expect(timeout).not.toBeNull();
    expect(Number(timeout?.[1])).toBeGreaterThan(0);
    expect(Number(timeout?.[1])).toBeLessThanOrEqual(15);
  });

  test("pins trusted actions and the declared Bun runtime", () => {
    const lines = policyLines(workflow());
    expect(lines.filter((line) => line.startsWith("uses:"))).toEqual([
      "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    ]);
    expect(lines).toContain("persist-credentials: false");
    const version = String(readJson("package.json").packageManager).replace("bun@", "");
    expect(lines).toContain(`bun-version: ${version}`);
  });

  test("runs only installation and the six independent fast checks", () => {
    const source = workflow();
    const lines = policyLines(source);
    expect(lines.filter((line) => line.startsWith("run:"))).toEqual([
      "run: bun install --frozen-lockfile",
      "run: bun run typecheck",
      "run: bun run test:scaffolding",
      "run: bun run test:unit",
      "run: bun run test:contracts",
      "run: bun run scope:check",
      "run: bun run security:scan",
    ]);
    expect(lines.filter((line) => line.startsWith("- name:"))).toHaveLength(9);
    expect(source).not.toMatch(/\bsecrets\b|\bdeploy\b|write-all|contents:\s*write/i);
  });
});

describe("monorepo reproducible", () => {
  test("declares the approved Bun workspaces and blocking scripts", () => {
    const manifest = readJson("package.json");
    expect(manifest.packageManager).toMatch(/^bun@/);
    expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(manifest.scripts).toMatchObject({
      typecheck: expect.any(String),
      test: expect.any(String),
      "test:e2e": expect.any(String),
      "db:check": expect.any(String),
      build: expect.any(String),
    });
  });

  test("includes its own scaffolding gate in the aggregate suite", () => {
    const scripts = readJson("package.json").scripts as Record<string, string>;
    expect(scripts["test:scaffolding"]).toBe(
      "bun test tests/scaffolding.test.ts",
    );
    expect(scripts.test).toContain("bun run test:scaffolding");
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
    ];
    expect(paths.filter((path) => existsSync(join(root, path)))).toEqual(paths);
  });
});
