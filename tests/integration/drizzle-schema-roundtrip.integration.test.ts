import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../packages/db/src/schema.ts";
import { materializeTables } from "../support/drizzle-schema-parity.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/postgres.ts";

let db: TestPostgres;
const a = "10000000-0000-4000-8000-000000000001";
const b = "20000000-0000-4000-8000-000000000002";
const ca = "30000000-0000-4000-8000-000000000003";
const cb = "40000000-0000-4000-8000-000000000004";
beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
}, 120_000);
afterAll(async () => { await db?.stop(); });

test("bytea/bigint/numeric codecs and generated/default values round-trip", async () => {
  const orm = drizzle(db.sql);
  await orm.insert(schema.businesses).values({ id: a, name: "Verifier" });
  const bytes = Buffer.from([0, 255, 92, 128]);
  const [connection] = await orm.insert(schema.whatsappConnections).values({
    id: ca, businessId: a, wrappedDek: bytes, wrappedDekNonce: Buffer.alloc(0),
  }).returning();
  expect(connection!.wrappedDek).toEqual(bytes);
  expect(connection!.wrappedDekNonce).toEqual(Buffer.alloc(0));
  expect(connection!.wrappedDekTag).toBeNull();
  const [conversation] = await orm.insert(schema.conversations).values({
    businessId: a, connectionId: ca, remoteJid: "verifier@s.whatsapp.net",
  }).returning();
  expect(conversation!.nextSequence).toBe(1n);
  const [service] = await orm.insert(schema.services).values({
    businessId: a, name: "\u00a0CAFÉ\uFEFF", durationMinutes: 5, priceArs: "123456.70",
  }).returning();
  expect(service!.normalizedName).toBe("café");
  expect(service!.priceArs).toBe("123456.70");
});

test("materialized role array and composite FK enforce tenant ownership", async () => {
  await materializeTables(db.sql, Object.values(schema).filter(value => is(value, PgTable)), "verifier_owned");
  await db.sql`insert into verifier_owned.businesses(id,name) values (${a},'A'),(${b},'B')`;
  await db.sql`insert into verifier_owned.whatsapp_connections(id,business_id) values (${ca},${a}),(${cb},${b})`;
  await db.sql`insert into verifier_owned.conversations(business_id,connection_id,remote_jid) values (${a},${ca},'owned')`;
  await db.sql`grant usage on schema verifier_owned to agendia_worker_runtime, agendia_whatsapp_runtime`;
  await db.sql`grant select,insert on verifier_owned.conversations to agendia_worker_runtime, agendia_whatsapp_runtime`;
  const orm = drizzle(db.sql);
  const rows = async (role: "agendia_worker_runtime" | "agendia_whatsapp_runtime", tenant: string) => orm.transaction(async tx => {
    await tx.execute(sql.raw("set local search_path to verifier_owned, public"));
    await tx.execute(sql.raw(`set local role ${role}`));
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
    return tx.select().from(schema.conversations);
  });
  for (const role of ["agendia_worker_runtime", "agendia_whatsapp_runtime"] as const) {
    expect((await rows(role, a)).map(row => row.remoteJid)).toEqual(["owned"]);
    expect(await rows(role, b)).toEqual([]);
    expect(await rows(role, "")).toEqual([]);
  }
  const digest = async () => createHash("sha256").update(JSON.stringify([...await db.sql`select * from verifier_owned.conversations order by id`])).digest("hex");
  const before = await digest();
  const rejected = await orm.transaction(async tx => {
    await tx.execute(sql.raw("set local search_path to verifier_owned, public"));
    await tx.execute(sql.raw("set local role agendia_worker_runtime"));
    await tx.execute(sql`select set_config('app.tenant_id', ${a}, true)`);
    await tx.insert(schema.conversations).values({ businessId: a, connectionId: cb, remoteJid: "cross-owner" });
  }).then(() => "accepted", (error: { cause?: { code?: string } }) => error.cause?.code);
  expect(rejected).toBe("23503");
  expect(await digest()).toBe(before);
  const denied = await orm.transaction(async tx => {
    await tx.execute(sql.raw("set local search_path to verifier_owned, public"));
    await tx.execute(sql.raw("set local role agendia_worker_runtime"));
    await tx.execute(sql`select set_config('app.tenant_id', ${a}, true)`);
    await tx.insert(schema.conversations).values({ businessId: b, connectionId: cb, remoteJid: "cross-tenant" });
  }).then(() => "accepted", (error: { cause?: { code?: string } }) => error.cause?.code);
  expect(denied).toBe("42501");
  expect(await digest()).toBe(before);
});
