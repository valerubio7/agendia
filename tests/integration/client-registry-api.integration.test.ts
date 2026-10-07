import { afterAll, beforeAll, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

const ORIGIN = "https://panel.agendia.test";
const password = "correct horse battery staple";
let database: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
let app: ReturnType<typeof buildApi>;
type Auth = { cookie: string; csrf: string; businessId: string; actorId: string };
let a: Auth, b: Auth, admin: Auth;
const input = { firstName: " Ada ", lastName: " Lovelace ", phone: "11 2345 6789" };
const request = (method: "GET" | "POST" | "PUT" | "DELETE", url = "/me/clients", auth?: Auth, body?: object, origin = ORIGIN, csrf = auth?.csrf) =>
  app.inject({ method, url, ...(body ? { payload: body } : {}), headers: {
    origin, ...(auth ? { cookie: auth.cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}),
  } });
const ctx = (auth: Auth) => tenantContext({ businessId: auth.businessId, actorId: auth.actorId, role: "business_user", requestId: randomUUID() });
const effects = async () => {
  const [row] = await database.sql`select (select count(*)::int from clients) clients, (select count(*)::int from audit_events where event_type like 'client.%') audit, (select count(*)::int from outbox_events where topic like 'client.%') outbox, (select count(*)::int from outbox_events where topic like 'ai.%' or topic like 'whatsapp.%') replies`;
  return row!;
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
  a = await fixture("clients-a@example.test");
  b = await fixture("clients-b@example.test");
  admin = await fixture("clients-admin@example.test", true);
}, 120_000);
afterAll(async () => { await app?.close(); await pools?.end(); await database?.stop(); });

test("empty registry, server-derived tenant, trimmed names and canonical phone", async () => {
  const empty = await request("GET", undefined, a);
  expect(empty.statusCode).toBe(200);
  expect(empty.json<unknown>()).toEqual([]);
  const created = await request("POST", undefined, a, { ...input, businessId: b.businessId });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ firstName: "Ada", lastName: "Lovelace", phone: "+5491123456789" });
  expect((await request("GET", undefined, a)).json<unknown>()).toEqual([created.json()]);
  expect((await request("GET", undefined, b)).json<unknown>()).toEqual([]);
  expect(await effects()).toEqual({ clients: 1, audit: 1, outbox: 1, replies: 0 });
});

test("requires business session and Origin/CSRF on mutations; no delete API", async () => {
  for (const [method, url] of [["GET", "/me/clients"], ["POST", "/me/clients"], ["PUT", `/me/clients/${randomUUID()}`]] as const) {
    expect((await request(method, url, undefined, input)).statusCode).toBe(401);
    expect((await request(method, url, admin, input)).statusCode).toBe(403);
    if (method !== "GET") {
      expect((await request(method, url, a, input, "https://evil.test")).statusCode).toBe(403);
      for (const csrf of ["wrong", ""]) expect((await request(method, url, a, input, ORIGIN, csrf)).statusCode).toBe(403);
    }
  }
  expect((await request("DELETE", `/me/clients/${randomUUID()}`, a)).statusCode).toBe(404);
});

test("safe validation and foreign/missing IDs leave no effects", async () => {
  const foreign = await request("POST", undefined, b, input);
  expect(foreign.statusCode).toBe(201);
  const id = foreign.json().id;
  const before = await effects();
  for (const invalid of [{ firstName: " " }, { lastName: "\t" }, { firstName: 4 }, { lastName: null }, { phone: 4 }, { phone: "not a phone" }, { phone: "+123" }, { firstName: "nul\u0000name" }, { lastName: "nul\u0000name" }]) {
    for (const [method, url] of [["POST", "/me/clients"], ["PUT", `/me/clients/${id}`]] as const) {
      const result = await request(method, url, b, { ...input, ...invalid });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(result.body).not.toMatch(/postgres|235|220|clients_|sql/i);
    }
  }
  for (const body of [{}, { firstName: "Ada", phone: input.phone }, { lastName: "Lovelace", phone: input.phone }, { firstName: "Ada", lastName: "Lovelace" }])
    expect((await request("POST", undefined, a, body)).statusCode).toBe(400);
  for (const target of [id, randomUUID()]) expect((await request("PUT", `/me/clients/${target}`, a, input)).statusCode).toBe(404);
  expect((await request("PUT", "/me/clients/not-uuid", a, input)).statusCode).toBe(400);
  expect((await request("GET", "/me/clients?q=x&q=y", a)).statusCode).toBe(400);
  expect(await effects()).toEqual(before);
});

test("canonical duplicates are race-safe, tenant-local, and fixed/mobile remain distinct", async () => {
  const before = await effects();
  const race = await Promise.all(["11 3456 7890", "+5491134567890"].map(phone => request("POST", undefined, a, { ...input, phone })));
  expect(race.map(r => r.statusCode).sort()).toEqual([201, 409]);
  const conflict = race.find(r => r.statusCode === 409)!;
  expect(conflict.json()).toMatchObject({ code: "CONFLICT", message: "Client phone already exists" });
  expect(conflict.body).not.toMatch(/23505|clients_|duplicate key|postgres/i);
  expect((await request("POST", undefined, b, { ...input, phone: "+5491134567890" })).statusCode).toBe(201);
  for (const phone of ["+541134567890", "+442079460018", "00 1 202 555 0123"]) {
    const res = await request("POST", undefined, a, { ...input, phone });
    expect(res.statusCode).toBe(201);
    expect(res.json().phone).toBe(phone.startsWith("00") ? "+12025550123" : phone);
  }
  const after = await effects();
  expect(after.clients - before.clients).toBe(5);
  expect(after.audit - before.audit).toBe(5);
  expect(after.outbox - before.outbox).toBe(5);
});

test("edits preserve ID, own unchanged phone is valid, exact lookup revokes old phone", async () => {
  const original = (await request("POST", undefined, a, { ...input, phone: "+5491145678901" })).json();
  const unchanged = await request("PUT", `/me/clients/${original.id}`, a, { ...input, firstName: "Edited", phone: original.phone });
  expect(unchanged.statusCode).toBe(200);
  const changed = await request("PUT", `/me/clients/${original.id}`, a, { firstName: "Edited again", lastName: "Last", phone: "+5491156789012" });
  expect(changed.statusCode).toBe(200);
  expect(changed.json().id).toBe(original.id);
  expect(await pools.api.run(ctx(a), repo => repo.findClientByCanonicalPhone(original.phone))).toBeNull();
  expect(await pools.api.run(ctx(a), repo => repo.findClientByCanonicalPhone(changed.json().phone))).toEqual(changed.json());
  expect(await pools.api.run(ctx(a), repo => repo.findClientByCanonicalPhone("11 5678 9012"))).toBeNull();
  expect(await pools.api.run(ctx(a), repo => repo.findClientByCanonicalPhone("+541156789012"))).toBeNull();
  expect(await pools.api.run(ctx(b), repo => repo.findClientByCanonicalPhone(changed.json().phone))).toBeNull();
  expect(await pools.api.run(ctx(b), repo => repo.getClientById(original.id))).toBeNull();
  const before = await effects();
  expect((await request("PUT", `/me/clients/${original.id}`, a, input)).statusCode).toBe(409);
  expect(await pools.api.run(ctx(a), repo => repo.getClientById(original.id))).toEqual(changed.json());
  expect(await effects()).toEqual(before);
  const other = (await request("POST", undefined, a, { ...input, phone: "+5491167890123" })).json();
  const races = await Promise.all([original.id, other.id].map(id => request("PUT", `/me/clients/${id}`, a, { ...input, phone: "+5491178901234" })));
  expect(races.map(r => r.statusCode).sort()).toEqual([200, 409]);
});

test("literal case-insensitive first/last/phone search and deterministic ordering", async () => {
  const res = await request("POST", undefined, a, { firstName: "Literal%_\\É", lastName: "SearchLAST", phone: "+5491189012345" });
  expect(res.statusCode).toBe(201);
  for (const q of ["literal%_\\é", "%_\\", "searchlast", "89012345", "+5491189012345"]) {
    const found = await request("GET", `/me/clients?q=${encodeURIComponent(q)}`, a);
    expect(found.statusCode).toBe(200);
    expect(found.json<unknown>()).toEqual([res.json()]);
  }
  expect((await request("GET", "/me/clients?q=%25", a)).json<unknown>()).toEqual([res.json()]);
  expect((await request("GET", "/me/clients?q=nonexistent", a)).json<unknown>()).toEqual([]);
  const ordered = [];
  for (const [firstName, lastName, phone] of [["Zulu", "OrderProbe", "+5491123456790"], ["Alpha", "OrderProbeZ", "+5491123456791"], ["alpha", "OrderProbeA", "+5491123456792"]]) {
    const created = await request("POST", undefined, a, { firstName, lastName, phone });
    expect(created.statusCode).toBe(201);
    ordered.push(created.json());
  }
  expect((await request("GET", "/me/clients?q=orderprobe", a)).json<unknown>()).toEqual([ordered[2], ordered[1], ordered[0]]);
});

test("unbounded Unicode names have no name uniqueness or Btree-size limit", async () => {
  const firstName = Array.from({ length: 120 }, (_, i) => "漢é" + createHash("sha256").update(String(i)).digest("hex")).join("");
  const created = await request("POST", undefined, a, { firstName, lastName: firstName, phone: "+5491123456796" });
  expect(created.statusCode).toBe(201);
  expect(created.json().firstName).toBe(firstName);
  const edited = await request("PUT", `/me/clients/${created.json().id}`, a, { firstName: firstName + "尾", lastName: firstName, phone: created.json().phone });
  expect(edited.statusCode).toBe(200);
  expect(edited.json().firstName).toBe(firstName + "尾");
  expect((await request("POST", undefined, a, { firstName, lastName: firstName, phone: "+5491123456780" })).statusCode).toBe(201);
});

test("RLS fails closed and runtime cannot delete or insert another business", async () => {
  expect(await pools.api.run(undefined, repo => repo.listClients())).toHaveLength(0);
  expect(await pools.api.run(undefined, repo => repo.findClientByCanonicalPhone("+5491123456789"))).toBeNull();
  await expect(pools.api.run(ctx(a), repo => repo.createClient(b.businessId, { ...input, phone: "+5491123456781" }))).rejects.toMatchObject({ code: "42501" });
  const [permissions] = await database.sql`select has_table_privilege('agendia_runtime','clients','DELETE') deletion, relrowsecurity enabled, relforcerowsecurity forced from pg_class where oid='clients'::regclass`;
  expect(permissions).toEqual({ deletion: false, enabled: true, forced: true });
  for (const [firstName, lastName] of [["\t\ufeff", "Last"], ["First", "\u00a0 "]]) {
    await expect(database.sql`insert into clients(business_id,first_name,last_name,phone) values(${a.businessId},${firstName!},${lastName!},'+5491123456799')`.execute()).rejects.toMatchObject({ code: "23514" });
  }
  for (const phone of ["1123456789", "+0123456789", "+54911 23456789", "+1234567890123456"]) {
    await expect(database.sql`insert into clients(business_id,first_name,last_name,phone) values(${a.businessId},'A','B',${phone})`.execute()).rejects.toMatchObject({ code: "23514" });
  }
});

test("audit and outbox failures roll back create/update without orphans or reply jobs", async () => {
  const own = (await request("POST", undefined, a, { ...input, phone: "+5491123456782" })).json();
  for (const table of ["audit_events", "outbox_events"]) {
    // Keep the trigger installed, then replace its function with a no-op after
    // each failure probe; no destructive teardown DDL is needed.
    await database.sql.unsafe(`create or replace function reject_client_effect_${table}() returns trigger language plpgsql as $$ begin if (to_jsonb(NEW)->>'${table === "audit_events" ? "event_type" : "topic"}') like 'client.%' then raise exception 'forced effect failure'; end if; return NEW; end $$`);
    await database.sql.unsafe(`create trigger reject_client_effect_${table} before insert on ${table} for each row execute function reject_client_effect_${table}()`);
    const before = await effects();
    const created = await request("POST", undefined, a, { ...input, phone: "+5491123456783" });
    expect(created.statusCode).toBe(500);
    expect(created.body).not.toMatch(/forced effect|postgres|sql/i);
    const updated = await request("PUT", `/me/clients/${own.id}`, a, { ...input, firstName: "Not saved", phone: "+5491123456784" });
    expect(updated.statusCode).toBe(500);
    expect(await pools.api.run(ctx(a), repo => repo.getClientById(own.id))).toEqual(own);
    expect(await pools.api.run(ctx(a), repo => repo.findClientByCanonicalPhone("+5491123456783"))).toBeNull();
    expect(await effects()).toEqual(before);
    await database.sql.unsafe(`create or replace function reject_client_effect_${table}() returns trigger language plpgsql as $$ begin return NEW; end $$`);
  }
  expect((await effects()).replies).toBe(0);
});
