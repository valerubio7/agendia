import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/postgres.ts";

// Deliberately local: this proof does not depend on the in-progress schema migration.
const records = pgTable("tenant_records", {
  businessId: uuid("business_id").notNull(),
  value: text("value").notNull(),
});
const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
let database: TestPostgres;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  await database.sql`insert into businesses (id, name) values (${tenantA}, 'A'), (${tenantB}, 'B')`;
  await database.sql`insert into tenant_records (business_id, value) values (${tenantA}, 'own'), (${tenantB}, 'foreign')`;
  db = drizzle(database.sql);
}, 120_000);
afterAll(async () => { await database?.stop(); });

test("Drizzle transaction shares tenant role and settings across ORM and parameterized SQL and rolls back", async () => {
  const marker = "quoted ' value; --";
  await expect(db.transaction(async tx => {
    await tx.execute(sql`set local role agendia_runtime`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantA}, true),
      set_config('app.actor_role', ${"business_user"}, true), set_config('app.actor_id', ${"actor-a"}, true),
      set_config('app.request_id', ${"request-a"}, true)`);
    const context = await tx.execute(sql`select current_user as role, current_setting('app.tenant_id') as tenant,
      current_setting('app.actor_role') as actor_role, current_setting('app.actor_id') as actor_id,
      current_setting('app.request_id') as request_id, pg_backend_pid() as pid`);
    expect(context[0]).toMatchObject({ role: "agendia_runtime", tenant: tenantA, actor_role: "business_user", actor_id: "actor-a", request_id: "request-a" });
    expect(await tx.select({ value: records.value }).from(records)).toEqual([{ value: "own" }]);
    await tx.insert(records).values({ businessId: tenantA, value: marker });
    const raw = await tx.execute(sql`select value, pg_backend_pid() as pid from tenant_records where value = ${marker}`);
    expect(raw[0]).toEqual({ value: marker, pid: context[0]!.pid });
    throw new Error("outer rollback");
  })).rejects.toThrow("outer rollback");
  expect(await database.sql`select value from tenant_records where value = ${marker}`).toHaveLength(0);
  expect([...(await database.sql`select value from tenant_records order by value`)]).toEqual([{ value: "foreign" }, { value: "own" }]);
});

test("nested Drizzle transactions use savepoints and retain role, settings and outer writes", async () => {
  await db.transaction(async tx => {
    await tx.execute(sql`set local role agendia_runtime`);
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantA}, true),
      set_config('app.actor_role', ${"business_user"}, true), set_config('app.actor_id', ${"actor-a"}, true),
      set_config('app.request_id', ${"request-a"}, true)`);
    await tx.insert(records).values({ businessId: tenantA, value: "outer" });
    await expect(tx.transaction(async nested => {
      const context = await nested.execute(sql`select current_user as role, current_setting('app.tenant_id') as tenant,
        current_setting('app.actor_role') as actor_role, current_setting('app.actor_id') as actor_id,
        current_setting('app.request_id') as request_id`);
      expect(context[0]).toEqual({ role: "agendia_runtime", tenant: tenantA, actor_role: "business_user", actor_id: "actor-a", request_id: "request-a" });
      await nested.insert(records).values({ businessId: tenantA, value: "nested-rollback" });
      throw new Error("savepoint rollback");
    })).rejects.toThrow("savepoint rollback");
    expect(await tx.select({ value: records.value }).from(records).where(eq(records.value, "nested-rollback"))).toEqual([]);
    await tx.transaction(async nested => {
      await nested.insert(records).values({ businessId: tenantA, value: "nested-commit" });
    });
    await expect(tx.transaction(async nested => {
      await nested.insert(records).values({ businessId: tenantB, value: "forbidden" });
    })).rejects.toThrow();
    expect(await tx.select({ value: records.value }).from(records).where(eq(records.value, "outer"))).toEqual([{ value: "outer" }]);
  });
  const values = await database.sql`select value from tenant_records order by value`;
  expect([...values]).toEqual([{ value: "foreign" }, { value: "nested-commit" }, { value: "outer" }, { value: "own" }]);
});
