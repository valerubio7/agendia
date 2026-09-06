import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildApi } from "../../apps/api/src/app.ts";

describe("release health endpoint contracts", () => {
  test("RED: API live is provider-independent and ready returns only coded 200/503 JSON", async () => {
    const pools = { api: { run: async (_context: unknown, operation: (repo: { releaseReadiness: () => Promise<{ ready: boolean; code: string }> }) => Promise<unknown>) => operation({ releaseReadiness: async () => ({ ready: false, code: "environment.marker_missing" }) }) } } as never;
    const app = buildApi({ pools, expectedOrigin: "https://panel.test" });
    expect((await app.inject({ method: "GET", url: "/internal/live" })).statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/internal/ready" });
    expect(ready.statusCode).toBe(503);
    expect(JSON.parse(ready.body)).toEqual({ code: "environment.marker_missing" });
    await app.close();
  });

  test("RED: web routes expose dependency-free live and proxy only coded API readiness", async () => {
    const live = await readFile("apps/web/app/_health/live/route.ts", "utf8");
    const ready = await readFile("apps/web/app/_health/ready/route.ts", "utf8");
    expect(live).toContain('code: "live"');
    expect(ready).toContain("AGENDIA_API_ORIGIN");
    expect(ready).toContain("/internal/ready");
    expect(ready).not.toMatch(/response\.text|console\./);
  });

  test("RED: manager and worker wire loopback readiness to durable draining state", async () => {
    const probe = await readFile("packages/runtime-config/src/operations.ts", "utf8");
    expect(probe).toContain('host: "127.0.0.1"');
    expect(probe).toContain("port: options.port ?? 9090");
    for (const [file, service] of [["apps/message-worker/src/index.ts", "message-worker"], ["apps/whatsapp-manager/src/index.ts", "whatsapp-manager"]] as const) {
      const source = await readFile(file, "utf8");
      expect(source).toContain("createLoopbackProbe");
      expect(source).toContain("createDurableReadiness");
      expect(source).toContain(`service: "${service}"`);
      expect(source).toContain('state: "draining"');
      expect(source).toContain("markUnready: () => readiness.markUnready()");
    }
  });

  test("RED: API, manager, and worker lifecycle logging uses only the redacting structured serializer", async () => {
    for (const file of ["apps/api/src/index.ts", "apps/message-worker/src/index.ts", "apps/whatsapp-manager/src/index.ts"]) {
      const source = await readFile(file, "utf8");
      expect(source).toContain("serializeOperationalLog");
      for (const code of ["startup", "draining", "stopped", "timeout"])
        expect(source).toContain(`"${code}"`);
      expect(source).not.toMatch(/console\.(?:error|warn)\(JSON\.stringify/);
    }
  });
});
