import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
    expect(packageJson.scripts.test).toContain("bun run test:e2e");
    expect(packageJson.scripts["test:tenant-isolation"]).toBe(
      "bun test tests/tenant-isolation tests/integration/tenant-rls.integration.test.ts",
    );
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
