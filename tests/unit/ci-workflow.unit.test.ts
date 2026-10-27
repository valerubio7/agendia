import { describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const workflow = YAML.parse(read(".github/workflows/ci.yml")) as {
  name: string;
  on: unknown;
  permissions: unknown;
  concurrency: unknown;
  // Trusted heterogeneous fixtures; the assertions below validate each job's structure.
  jobs: Record<"validation" | "integration" | "browser_shards" | "browser", any>;
};
const { validation, integration, browser_shards: shards, browser: gate } = workflow.jobs;
const setup = [
  {
    name: "Checkout",
    uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    with: { "persist-credentials": false },
  },
  {
    name: "Set up Bun",
    uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    with: { "bun-version": "1.4.0" },
  },
  { name: "Install dependencies", run: "bun install --frozen-lockfile" },
];

describe("CI browser sharding", () => {
  test("preserves triggers, permissions, concurrency and required validation/integration jobs", () => {
    expect(workflow.name).toBe("CI");
    expect(workflow.on).toEqual({ pull_request: { branches: ["main"] }, push: { branches: ["main"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress": true,
    });
    expect(validation).toEqual({
      name: "Validation",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      steps: [
        ...setup,
        { name: "Typecheck", run: "bun run typecheck" },
        { name: "Unit tests", run: "bun run test:unit" },
        { name: "Contracts", run: "bun run test:contracts" },
      ],
    });
    expect(integration).toEqual({
      name: "Integration (includes tenant RLS)",
      needs: "validation",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      steps: [
        ...setup,
        { name: "Check Docker readiness", run: "docker info" },
        { name: "Integration tests", run: "bun run test:integration" },
      ],
    });
  });

  test("runs all three shards independently on supported runners without filters or retries", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(["browser", "browser_shards", "integration", "validation"]);
    expect(shards).toBeDefined();
    expect(shards.strategy).toEqual({ "fail-fast": false, matrix: { shard: [1, 2, 3] } });
    expect(shards.name).toBe("Playwright shard ${{ matrix.shard }}/3");
    expect(shards.needs).toBe("validation");
    expect(shards["runs-on"]).toBe("ubuntu-24.04");
    expect(shards["timeout-minutes"]).toBe(30);
    expect(shards.env).toEqual({ CI: "true" });
    const command = shards.steps[5].run;
    expect(shards.steps[5]).toEqual({
      name: "Browser tests",
      run: "bun run test:e2e --shard=${{ matrix.shard }}/3",
    });
    expect(shards.strategy.matrix.shard.map((shard: number) => command.replace("${{ matrix.shard }}", String(shard))))
      .toEqual(["bun run test:e2e --shard=1/3", "bun run test:e2e --shard=2/3", "bun run test:e2e --shard=3/3"]);
    expect(new Set(shards.strategy.matrix.shard.map((shard: number) => shards.name.replace("${{ matrix.shard }}", String(shard)))).size).toBe(3);
  });

  test("retains pinned setup and diagnostics with disjoint shard artifact names", () => {
    expect(shards).toBeDefined();
    expect(Object.keys(shards).sort()).toEqual(["env", "name", "needs", "runs-on", "steps", "strategy", "timeout-minutes"]);
    expect(shards.steps.slice(0, 3)).toEqual(setup);
    expect(shards.steps.slice(3, 5)).toEqual([
      { name: "Check Docker readiness", run: "docker info" },
      { name: "Install Chromium and system dependencies", run: "bunx --no-install playwright install --with-deps chromium" },
    ]);
    expect(shards.steps).toHaveLength(7);
    const upload = shards.steps[6];
    expect(upload).toEqual({
      name: "Upload Playwright diagnostics",
      if: "${{ !cancelled() }}",
      uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      with: {
        name: "playwright-results-${{ matrix.shard }}",
        path: "test-results/\nplaywright-report/\n",
        "if-no-files-found": "warn",
        "retention-days": 7,
      },
    });
    expect(shards.strategy.matrix.shard.map((shard: number) => upload.with.name.replace("${{ matrix.shard }}", String(shard))))
      .toEqual(["playwright-results-1", "playwright-results-2", "playwright-results-3"]);
  });

  test("preserves one worker, original test timeout, test-scoped systems and serial Turnos", () => {
    const config = read("playwright.config.ts");
    expect(config).toMatch(/workers: 1,/);
    expect(config).toMatch(/timeout: 180_000,/);
    expect(config).not.toMatch(/fullyParallel\s*:|retries\s*:/);
    expect(JSON.parse(read("package.json")).scripts["test:e2e"]).toBe("playwright test");
    const fixtures = read("tests/e2e/support/fixtures.ts");
    expect(fixtures).toContain("system: async ({}, use) => {");
    expect(fixtures).toContain("const system = await startSystem();");
    expect(fixtures).toContain("try { await use(system); } finally { await system.stop(); }");
    expect(fixtures).not.toContain('scope: "worker"');
    expect(read("tests/e2e/system-turnos-ui.spec.ts")).toContain('test.describe.configure({ mode: "serial" });');
  });

  test("keeps the exact required Playwright gate always evaluated and setup-free", () => {
    expect(gate).toEqual({
      name: "Playwright",
      needs: "browser_shards",
      if: "${{ always() }}",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 1,
      steps: [{ name: "Require every shard to succeed", run: expect.any(String) }],
    });
  });

  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    test(`actual aggregate shell predicate fails closed for ${result}`, () => {
      expect(gate.steps).toHaveLength(1);
      const predicate = gate.steps[0].run;
      expect(predicate).toContain("${{ needs.browser_shards.result }}");
      const script = predicate.replaceAll("${{ needs.browser_shards.result }}", result);
      expect(script).not.toContain("${{");
      const execution = spawnSync("/bin/bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
        encoding: "utf8", timeout: 1000, env: { NODE_ENV: "test" },
      });
      expect(execution.error).toBeUndefined();
      expect(execution.signal).toBeNull();
      expect(execution.status).toBe(result === "success" ? 0 : 1);
      expect(execution.stdout).toBe("");
      expect(execution.stderr).toBe("");
    });
  }
});
