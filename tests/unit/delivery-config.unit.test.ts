import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { checkV1Scope, scanForSecrets } from "../../scripts/policy-checks.ts";

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
    expect(packageJson.scripts.test).toContain("bun run test:harness");
    expect(packageJson.scripts.test).toContain("bun run test:e2e");
    expect(packageJson.scripts["test:tenant-isolation"]).toBe(
      "bun test tests/integration/tenant-rls.integration.test.ts",
    );
    expect(packageJson.scripts["test:integration"]).toBe("bun test tests/integration");
    expect(existsSync("tests/integration/tenant-rls.integration.test.ts")).toBe(true);
    // Bun's directory runner includes the focused RLS file: aggregate and CI
    // integration must not invoke the focused alias a second time.
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow.match(/run: bun run test:integration\b/g)).toHaveLength(1);
    expect(workflow).not.toContain("bun run test:tenant-isolation");
  });

  test("fails closed for provider secrets and future conversation capabilities", () => {
    expect(
      scanForSecrets({ "safe.ts": "const key = 'deterministic-test-double'" }),
    ).toEqual([]);
    expect(
      scanForSecrets({
        "leak.ts": "const key = 'sk-abcdefghijklmnopqrstuvwxyz123456'",
      }),
    ).toEqual(["leak.ts: DeepSeek credential pattern"]);
    expect(
      checkV1Scope(["/me/assistant"], ["apps/web/app/assistant/page.tsx"]),
    ).toEqual([]);
    expect(
      checkV1Scope(["/conversations"], ["apps/web/app/conversations/page.tsx"]),
    ).toEqual([
      "route outside v1: /conversations",
      "path outside v1: apps/web/app/conversations/page.tsx",
    ]);
  });
});
