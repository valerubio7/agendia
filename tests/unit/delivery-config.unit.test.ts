import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkV1Scope, scanForSecrets } from "../../scripts/policy-checks.ts";

const read = (path: string) => readFileSync(path, "utf8");

describe("blocking delivery configuration", () => {
  test("CI pins Bun on Node LTS and runs every acceptance gate without provider credentials", () => {
    const workflow = read(".github/workflows/ci.yml");
    for (const command of [
      "bun install --frozen-lockfile",
      "bun run lint",
      "bun run typecheck",
      "bun run test:unit",
      "bun run test:integration",
      "bun run test:contracts",
      "bun run test:tenant-isolation",
      "bun run test:e2e",
      "bun run test",
      "bun run db:check",
      "bun run backup:drill",
      "bun run security:scan",
      "bun run scope:check",
      "docker info",
      "bun run db:generate",
      "git diff --exit-code -- packages/db",
      "bun run build",
    ]) expect(workflow).toContain(command);
    expect(workflow).toContain("node-version: 22");
    expect(workflow).not.toMatch(/DEEPSEEK_API_KEY|WHATSAPP_TOKEN|BAILEYS_CREDENTIAL/i);
  });

  test("the aggregate test command delegates to every runner instead of loading Playwright specs in Bun", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(packageJson.scripts.test).toContain("bun run test:unit");
    expect(packageJson.scripts.test).toContain("bun run test:integration");
    expect(packageJson.scripts.test).toContain("bun run test:contracts");
    expect(packageJson.scripts.test).toContain("bun run test:tenant-isolation");
    expect(packageJson.scripts.test).toContain("bun run test:e2e");
  });

  test("fails closed for provider secrets and future conversation capabilities", () => {
    expect(scanForSecrets({ "safe.ts": "const key = 'deterministic-test-double'" })).toEqual([]);
    expect(scanForSecrets({ "leak.ts": "const key = 'sk-abcdefghijklmnopqrstuvwxyz123456'" })).toEqual(["leak.ts: DeepSeek credential pattern"]);
    expect(checkV1Scope(["/me/assistant"], ["apps/web/app/assistant/page.tsx"])).toEqual([]);
    expect(checkV1Scope(["/conversations"], ["apps/web/app/conversations/page.tsx"])).toEqual([
      "route outside v1: /conversations",
      "path outside v1: apps/web/app/conversations/page.tsx",
    ]);
  });

  test("operations and acceptance docs define encrypted PITR restore, rollback and v1 scope", () => {
    const operations = read("docs/operations.md");
    for (const phrase of ["PITR", "14 días", "30 días", "KEK históricas", "restore trimestral", "migración correctiva", "despliegue gradual"]) {
      expect(operations).toContain(phrase);
    }
    const acceptance = read("docs/acceptance.md");
    expect(acceptance).toContain("admin → tenant → vínculo único → mensaje → IA doble → ACK");
    expect(acceptance).toContain("No existen `/conversations` ni `/messages`");
    expect(acceptance).toContain("dobles deterministas");
  });
});
