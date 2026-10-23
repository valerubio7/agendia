import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("delivery configuration", () => {
  test("the aggregate test command delegates to every runner instead of loading Playwright specs in Bun", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.test).toContain("bun run test:unit");
    expect(packageJson.scripts.test).toContain("bun run test:integration");
    expect(packageJson.scripts.test).toContain("bun run test:contracts");
    expect(packageJson.scripts.test).not.toContain(
      "bun run test:tenant-isolation",
    );
    expect(packageJson.scripts.test).not.toContain("bun run test:harness");
    expect(packageJson.scripts.test).toContain("bun run test:e2e");
    expect(packageJson.scripts["test:integration"]).toBe("bun test tests/integration");
    expect(existsSync("tests/integration/tenant-rls.integration.test.ts")).toBe(true);
    // Bun's directory runner includes the focused RLS file: aggregate and CI
    // integration must not invoke the focused alias a second time.
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow.match(/run: bun run test:integration\b/g)).toHaveLength(1);
    expect(workflow).not.toContain("bun run test:tenant-isolation");
  });

});
