import { afterAll, beforeAll, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { normalizeServiceName } from "@agendia/domain";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

const ORIGIN = "https://panel.agendia.test";
const password = "correct horse battery staple";
let database: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
let app: ReturnType<typeof buildApi>;
type Auth = { cookie: string; csrf: string; businessId: string; actorId: string };
let a: Auth, b: Auth, admin: Auth;
const input = { name: "Cut", durationMinutes: 30, priceArs: 0 };
const request = (method: "GET" | "POST" | "PUT", url = "/me/services", auth?: Auth, body?: object, origin = ORIGIN, csrf = auth?.csrf) =>
  app.inject({ method, url, ...(body ? { payload: body } : {}), headers: {
    origin, ...(auth ? { cookie: auth.cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}),
  } });
const ctx = (auth: Auth) => tenantContext({ businessId: auth.businessId, actorId: auth.actorId, role: "business_user", requestId: randomUUID() });
const effects = async () => {
  const [row] = await database.sql`select (select count(*)::int from audit_events where event_type like 'service.%') audit, (select count(*)::int from outbox_events where topic like 'service.%') outbox`;
  return row;
};

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: ORIGIN });
  const phc = await hash(password, { algorithm: Algorithm.Argon2id });
  const fixture = async (email: string, platform = false): Promise<Auth> => {
    const businessId = randomUUID(), actorId = randomUUID();
    if (!platform) await database.sql`insert into businesses(id,name) values(${businessId},${email})`;
    await database.sql`insert into auth_identities(id,normalized_email,password_phc,role,business_id) values(${actorId},${email},${phc},${platform ? "platform_admin" : "business_user"},${platform ? null : businessId})`;
    const res = await request("POST", "/auth/login", undefined, { email, password });
    expect(res.statusCode).toBe(200);
    const cookies = res.headers["set-cookie"]!;
    return { businessId, actorId, cookie: (Array.isArray(cookies) ? cookies[0]! : cookies).split(";")[0]!, csrf: res.json().csrfToken };
  };
  a = await fixture("services-a@example.test");
  b = await fixture("services-b@example.test");
  admin = await fixture("services-admin@example.test", true);
}, 120_000);
afterAll(async () => { await app?.close(); await pools?.end(); await database?.stop(); });

test("requires business session and protects every catalog mutation", async () => {
  for (const [method, url] of [["GET", "/me/services"], ["POST", "/me/services"], ["PUT", `/me/services/${randomUUID()}`], ["PUT", `/me/services/${randomUUID()}/status`]] as const) {
    expect((await request(method, url, undefined, input)).statusCode).toBe(401);
    expect((await request(method, url, admin, input)).statusCode).toBe(403);
    if (method !== "GET") {
      expect((await request(method, url, a, input, "https://evil.test")).statusCode).toBe(403);
      expect((await request(method, url, a, input, ORIGIN, "wrong")).statusCode).toBe(403);
      expect((await request(method, url, a, input, ORIGIN, "")).statusCode).toBe(403);
    }
  }
});

test("persists catalog, zero/subcent money, edits and activation without trusting businessId", async () => {
  const created = await request("POST", undefined, a, { ...input, name: " \tCatalog\u00a0\ufeff", businessId: b.businessId });
  expect(created.statusCode).toBe(201);
  const service = created.json();
  expect(service).toMatchObject({ name: "Catalog", description: null, durationMinutes: 30, priceArs: 0, status: "active" });
  expect((await request("GET", undefined, b)).json() as unknown).toEqual([]);
  const updated = await request("PUT", `/me/services/${service.id}`, a, { ...input, name: "Catalog edited", description: "Full description", priceArs: 0.00123456789 });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ priceArs: 0.00123456789, description: "Full description" });
  for (const status of ["suspended", "active"]) {
    const result = await request("PUT", `/me/services/${service.id}/status`, a, { status });
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe(status);
  }
  const [stored] = await database.sql`select business_id,price_ars::text price from services where id=${service.id}`;
  expect(stored).toEqual({ business_id: a.businessId, price: "0.00123456789" });
  expect((await request("GET", undefined, a)).json()).toContainEqual(updated.json());
  expect(await effects()).toEqual({ audit: 4, outbox: 4 });
});

test("rejects invalid input, IDs/status and foreign edits with no catalog audit effects", async () => {
  const created = await request("POST", undefined, b, { ...input, name: "Foreign" });
  expect(created.statusCode).toBe(201);
  const id = created.json().id;
  const before = await effects();
  for (const invalid of [{ name: "\t\u00a0\ufeff" }, { durationMinutes: 0 }, { durationMinutes: 16 }, { durationMinutes: 15.5 }, { priceArs: -1 }, { priceArs: "1" }, { description: null }]) {
    expect((await request("POST", undefined, a, { ...input, ...invalid })).statusCode).toBe(400);
    expect((await request("PUT", `/me/services/${id}`, b, { ...input, ...invalid })).statusCode).toBe(400);
  }
  expect((await request("PUT", `/me/services/${id}/status`, b, { status: "deleted" })).statusCode).toBe(400);
  expect((await request("PUT", `/me/services/${id}`, b, { ...input, durationMinutes: 3_000_000_000 })).statusCode).toBe(400);
  for (const target of [id, randomUUID()]) {
    expect((await request("PUT", `/me/services/${target}`, a, input)).statusCode).toBe(404);
    expect((await request("PUT", `/me/services/${target}/status`, a, { status: "suspended" })).statusCode).toBe(404);
  }
  expect((await request("PUT", "/me/services/not-a-uuid", a, input)).statusCode).toBe(400);
  expect((await request("PUT", "/me/services/not-a-uuid/status", a, { status: "active" })).statusCode).toBe(400);
  expect((await request("GET", undefined, b)).json()).toContainEqual(created.json());
  expect(await effects()).toEqual(before);
});

test("database-normalized names match JS trim/lowercase and preserve inner spaces", async () => {
  const whitespace = "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  for (const name of ["MiXeD", "ÉCOLE", "İstanbul", "ΟΣ", "Straße", "A  B", "Back\\\\slash é"]) {
    const padded = whitespace + name + whitespace;
    const created = await request("POST", undefined, a, { ...input, name: padded });
    expect(created.statusCode).toBe(201);
    const [row] = await database.sql`select normalized_name, encode(service_name_sha256(normalized_name),'hex') digest from services where id=${created.json().id}`;
    expect(row!.normalized_name).toBe(normalizeServiceName(padded));
    expect(row!.digest).toBe(createHash("sha256").update(normalizeServiceName(padded), "utf8").digest("hex"));
    expect((await request("POST", undefined, a, { ...input, name: normalizeServiceName(padded) })).statusCode).toBe(409);
    expect((await request("POST", undefined, b, { ...input, name: padded })).statusCode).toBe(201);
  }
  expect((await request("POST", undefined, a, { ...input, name: "A B" })).statusCode).toBe(201);
  expect((await request("POST", undefined, a, { ...input, name: "ECOLE" })).statusCode).toBe(201);
  // Direct writes exercise DB normalization, not only the schema's trim transformation.
  const id = randomUUID();
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${id},${a.businessId},${whitespace + "DIRECT" + whitespace},15,0)`;
  const [row] = await database.sql`select normalized_name from services where id=${id}`;
  expect(row!.normalized_name).toBe("direct");
  expect((await request("POST", undefined, a, { ...input, name: "direct" })).statusCode).toBe(409);
});

test("unique constraints arbitrate simultaneous create/update; conflicts roll back data/audit", async () => {
  const before = await effects();
  const creates = await Promise.all([" Race ", "rAcE"].map(name => request("POST", undefined, a, { ...input, name })));
  expect(creates.map(r => r.statusCode).sort()).toEqual([201, 409]);
  const one = (await request("POST", undefined, a, { ...input, name: "First racer" })).json();
  const two = (await request("POST", undefined, a, { ...input, name: "Second racer" })).json();
  const edits = await Promise.all([one, two].map((s, i) => request("PUT", `/me/services/${s.id}`, a, { ...input, name: i ? "WINNER" : " winner ", priceArs: 0.005 })));
  expect(edits.map(r => r.statusCode).sort()).toEqual([200, 409]);
  const loserIndex = edits.findIndex(r => r.statusCode === 409);
  const loser = [one, two][loserIndex];
  expect((await request("GET", undefined, a)).json()).toContainEqual(loser);
  const conflict = await request("PUT", `/me/services/${loser.id}`, a, { ...input, name: "race" });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toMatchObject({ code: "CONFLICT", message: "Service name already exists" });
  expect(conflict.body).not.toMatch(/23505|services_|duplicate key|postgres/i);
  const after = await effects();
  expect(after!.audit - before!.audit).toBe(4);
  expect(after!.outbox - before!.outbox).toBe(4);

  const mixedRace = await Promise.all([
    request("POST", undefined, a, { ...input, name: "Mixed race" }),
    request("PUT", `/me/services/${loser.id}`, a, { ...input, name: " MIXED RACE " }),
  ]);
  expect(mixedRace.filter(r => r.statusCode === 409)).toHaveLength(1);
  expect(mixedRace.filter(r => r.statusCode === 200 || r.statusCode === 201)).toHaveLength(1);
  const final = await effects();
  expect(final!.audit - after!.audit).toBe(1);
  expect(final!.outbox - after!.outbox).toBe(1);
});

test("supports unbounded, noncompressible service names without a hidden index limit", async () => {
  const name = Array.from({ length: 100 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("");
  const created = await request("POST", undefined, a, { ...input, name });
  expect(created.statusCode).toBe(201);
  expect(created.json().name).toBe(name);
  expect((await request("GET", undefined, a)).json()).toContainEqual(created.json());
  expect((await request("POST", undefined, a, { ...input, name: "\t" + name.toUpperCase() + "\u00a0\ufeff" })).statusCode).toBe(409);
  expect((await request("POST", undefined, b, { ...input, name })).statusCode).toBe(201);

  const updatedName = name + "é\\\\ tail";
  const updated = await request("PUT", `/me/services/${created.json().id}`, a, { ...input, name: updatedName });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().name).toBe(updatedName);
  expect((await request("GET", undefined, a)).json()).toContainEqual(updated.json());
  const [stored] = await database.sql`select name,encode(service_name_sha256(normalized_name),'hex') digest from services where id=${created.json().id}`;
  expect(stored!.name).toBe(updatedName);
  expect(stored!.digest).toBe(createHash("sha256").update(normalizeServiceName(updatedName), "utf8").digest("hex"));
  expect((await request("POST", undefined, a, { ...input, name: updatedName.toUpperCase() })).statusCode).toBe(409);
  expect((await request("PUT", `/me/services/${created.json().id}`, a, { ...input, name: "race" })).statusCode).toBe(409);
  expect((await request("GET", undefined, a)).json()).toContainEqual(updated.json());
});

test("runtime RLS isolates reads/inserts/updates and has no DELETE grant; DB validates values", async () => {
  const own = (await request("POST", undefined, b, { ...input, name: "RLS target" })).json();
  expect((await pools.api.run(undefined, repo => repo.listServices())).length).toBe(0);
  const rows = await pools.api.run(ctx(a), repo => repo.listServices());
  expect(rows.some(row => row.id === own.id)).toBe(false);
  expect(await pools.api.run(ctx(a), repo => repo.updateService(own.id, input))).toBeNull();
  expect(await pools.api.run(ctx(a), repo => repo.setServiceStatus(own.id, "suspended"))).toBeNull();
  await expect(pools.api.run(ctx(a), repo => repo.createService(b.businessId, { ...input, name: "Forbidden" }))).rejects.toMatchObject({ code: "42501" });
  const [permissions] = await database.sql`select has_table_privilege('agendia_runtime','services','DELETE') deletion, relrowsecurity enabled, relforcerowsecurity forced from pg_class where oid='services'::regclass`;
  expect(permissions).toEqual({ deletion: false, enabled: true, forced: true });
  for (const [duration, price, name, status] of [[0, "0", "bad", "active"], [16, "0", "bad", "active"], [15, "-1", "bad", "active"], [15, "NaN", "bad", "active"], [15, "Infinity", "bad", "active"], [15, "0", "\t\ufeff", "active"], [15, "0", "bad", "deleted"]] as const) {
    await expect(database.sql`insert into services(business_id,name,duration_minutes,price_ars,status) values(${a.businessId},${name},${duration},${price}::numeric,${status})`.execute()).rejects.toMatchObject({ code: "23514" });
  }
  expect((await request("GET", undefined, b)).json()).toContainEqual(own);
});
