import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { PgBoss } from "pg-boss";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { applyPostgresMigrations, createRoleLogin, startTestPostgres, testTenantContext, type TestPostgres } from "@agendia/test-support";

const TENANT = "33333333-3333-4333-8333-333333333333";
const context = tenantContext(testTenantContext(TENANT, "internal_worker"));
let database: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
let boss: PgBoss;

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  await database.sql`insert into businesses (id, name) values (${TENANT}, 'Worker tenant')`;
  const workerUrl = await createRoleLogin(database, "worker_test", "agendia_worker_runtime");
  pools = createRuntimePools(database.container.getConnectionUri());
  boss = new PgBoss({ connectionString: workerUrl, schema: "pgboss", createSchema: false });
  await boss.start();
}, 120_000);
afterAll(async () => { await boss?.stop(); await pools?.end(); await database?.stop(); });

test("worker consumes tenant outbox and a pg-boss job", async () => {
  await pools.api.run(context, (repo) => repo.enqueueOutbox(TENANT, "ai.generate", "worker-event", { messageId: "m-1" }));
  const other = tenantContext(testTenantContext("44444444-4444-4444-8444-444444444444", "internal_worker"));
  expect(await pools.worker.run(other, (repo) => repo.claimOutbox())).toBeNull();
  const claimed = await pools.worker.run(context, (repo) => repo.claimOutbox());
  expect(claimed).toMatchObject({ topic: "ai.generate", stable_key: "worker-event" });
  expect(await pools.worker.run(context, (repo) => repo.markOutboxPublished(claimed!.id))).toBe(1);

  await boss.createQueue("unit-20");
  const received = new Promise<string>((resolve) => boss.work("unit-20", async ([job]) => {
    if (!job) throw new Error("pg-boss returned an empty batch");
    resolve(String((job.data as { messageId: string }).messageId));
  }));
  await boss.send("unit-20", { messageId: "m-1" });
  expect(await received).toBe("m-1");
});

test("worker reads only tenant context while admin and worker cannot read Baileys credentials", async () => {
  await expect(pools.admin.run(context, (repo) => repo.conversationTexts())).rejects.toThrow(/permission denied/i);
  expect(await pools.worker.run(context, (repo) => repo.conversationTexts())).toHaveLength(0);
  for (const pool of [pools.admin, pools.worker]) await expect(pool.run(context, (repo) => repo.authRecordNames())).rejects.toThrow(/permission denied/i);
});
