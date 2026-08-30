import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRuntimePools, tenantContext, TenantUnitOfWork } from "@agendia/db";
import { applyPostgresMigrations, startTestPostgres, testTenantContext, type TestPostgres } from "@agendia/test-support";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = (businessId: string) => tenantContext(testTenantContext(businessId));
let database: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(database.container.getConnectionUri());
}, 120_000);
afterAll(async () => { await pools?.end(); await database?.stop(); });

describe("production PostgreSQL repositories", () => {
  test("persists auth, administration and each tenant runtime aggregate", async () => {
    await pools.admin.run(undefined, async (repo) => {
      await repo.saveBusiness({ id: A, name: "Tenant A" });
      await repo.saveBusiness({ id: B, name: "Tenant B" });
      await repo.saveIdentity({ email: "owner@example.test", passwordPhc: "$argon2id$test", businessId: A });
      expect((await repo.findIdentity("owner@example.test"))?.business_id).toBe(A);
    });
    await pools.api.run(context(A), async (repo) => {
      await repo.saveProfile(A, "Comercio A");
      await repo.saveAssistant(A, true);
      await repo.recordInbox(A, "baileys", "incoming-1");
    });
    await pools.manager.run(context(A), async (repo) => repo.saveConnection(CONNECTION, A));
    const snapshot = await pools.api.run(context(A), (repo) => repo.tenantSnapshot());
    expect(snapshot).toEqual({ profile: "Comercio A", assistantActive: true, inbox: 1, outbox: 0 });
    expect((await pools.manager.run(context(A), (repo) => repo.connection()))?.id).toBe(CONNECTION);
  });

  test("fails closed for absent/falsified context and keeps two tenants separate", async () => {
    await pools.api.run(context(B), (repo) => repo.saveProfile(B, "Comercio B"));
    expect(await pools.api.run(undefined, (repo) => repo.tenantSnapshot())).toEqual({ profile: null, assistantActive: null, inbox: 0, outbox: 0 });
    await expect(pools.api.run(context(A), (repo) => repo.saveProfile(B, "intrusion"))).rejects.toThrow(/policy|security/i);
    expect((await pools.api.run(context(A), (repo) => repo.tenantSnapshot())).profile).toBe("Comercio A");
    expect((await pools.api.run(context(B), (repo) => repo.tenantSnapshot())).profile).toBe("Comercio B");
  });

  test("rolls mutation, audit and outbox back atomically", async () => {
    const uow = new TenantUnitOfWork(pools.api);
    await expect(uow.execute(context(A), {
      audit: { eventType: "profile.changed", outcome: "success", eventHash: "a".repeat(64) },
      outbox: { topic: "profile.changed", stableKey: "profile:rollback", payload: { revision: 2 } },
    }, async (repo) => { await repo.saveProfile(A, "Must rollback"); throw new Error("forced rollback"); })).rejects.toThrow("forced rollback");
    const snapshot = await pools.api.run(context(A), (repo) => repo.tenantSnapshot());
    expect(snapshot).toEqual({ profile: "Comercio A", assistantActive: true, inbox: 1, outbox: 0 });
    expect(await pools.api.run(context(A), (repo) => repo.auditCount())).toBe(0);
  });
});
