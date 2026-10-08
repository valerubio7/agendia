import { afterAll, beforeAll, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools } from "@agendia/db";
import { type AvailabilitySlot } from "@agendia/contracts";
import { type WeeklySchedule } from "@agendia/domain";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

let database: TestPostgres, pools: ReturnType<typeof createRuntimePools>, app: ReturnType<typeof buildApi>, phc: string;
type Owner = { business: string; actor: string; cookie: string; csrf: string; client: string; service: string; resource: string };
const origin = "https://panel.agendia.test", date = "2099-06-01";
const full: WeeklySchedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
const headers = (o: Owner) => ({ cookie: o.cookie, origin, "x-csrf-token": o.csrf });
const post = (o: Owner, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/me/appointments", headers: headers(o), payload });
const offer = async (o: Owner) => {
  const response = await app.inject({ method: "GET", url: `/me/appointments/availability?serviceId=${o.service}&resourceId=${o.resource}&date=${date}`, headers: { cookie: o.cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<AvailabilitySlot[]>()[40]!;
};
const body = (o: Owner, slot: AvailabilitySlot) => ({ serviceId: o.service, resourceId: o.resource, date, startRaw: slot.start, expectedTerms: slot.terms, confirmed: true, newClient: { firstName: " New ", lastName: " Client ", phone: "11 2345 6790" }, notes: "Manual note" });
const effects = async (o: Owner) => {
  const result: Record<string, unknown> = {};
  for (const table of ["appointments", "clients", "audit_events", "outbox_events", "outbound_commands", "messages"])
    result[table] = (await database.sql`select * from ${database.sql(table)} where business_id=${o.business}`).map(row => JSON.stringify(row)).sort();
  return result;
};
const fixture = async (platform = false): Promise<Owner> => {
  const o = { business: randomUUID(), actor: randomUUID(), cookie: "", csrf: "", client: randomUUID(), service: randomUUID(), resource: randomUUID() };
  const email = `${o.actor}@example.test`;
  if (!platform) await database.sql`insert into businesses(id,name) values(${o.business},'Manual fixture')`;
  await database.sql`insert into auth_identities(id,normalized_email,password_phc,role,business_id) values(${o.actor},${email},${phc},${platform ? "platform_admin" : "business_user"},${platform ? null : o.business})`;
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery staple" }, headers: { origin } });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers["set-cookie"]!;
  o.cookie = (Array.isArray(cookies) ? cookies[0]! : cookies).split(";")[0]!;
  o.csrf = login.json().csrfToken;
  if (platform) return o;
  await database.sql`insert into clients(id,business_id,first_name,last_name,phone) values(${o.client},${o.business},'Current','Identity','+5491123456789')`;
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${o.service},${o.business},'Service',30,12.34567)`;
  await database.sql`insert into business_calendars values(${o.business},${database.sql.json(full)})`;
  await database.sql`insert into resources(id,business_id,name,weekly_schedule) values(${o.resource},${o.business},'Resource',${database.sql.json(full)})`;
  await database.sql`insert into resource_services values(${o.business},${o.resource},${o.service})`;
  return o;
};
beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: origin });
  phc = await hash("correct horse battery staple", { algorithm: Algorithm.Argon2id });
}, 120_000);
afterAll(async () => { await app?.close(); await pools?.end(); await database?.stop(); });

test("POST commits server terms, normalized new identity, manual Confirmed and generic events only", async () => {
  const o = await fixture(), slot = await offer(o), payload = body(o, slot), before = await effects(o);
  const response = await post(o, { ...payload, serviceId: o.service.toUpperCase(), resourceId: o.resource.toUpperCase(), startRaw: "2099-06-01T10:00:00-03:00", expectedTerms: { ...slot.terms, serviceId: o.service.toUpperCase(), resourceId: o.resource.toUpperCase() } });
  expect(response.statusCode).toBe(201);
  const saved = response.json();
  expect(saved).toMatchObject({ terms: slot.terms, startMs: slot.startMs, state: "confirmed", origin: "manual", notes: "Manual note", customerResourcePreference: null, client: { firstName: "New", lastName: "Client", phone: "+5491123456790" } });
  expect(saved.client.id).not.toBe(o.client);
  const detail = await app.inject({ method: "GET", url: `/me/appointments/${saved.id}`, headers: { cookie: o.cookie } });
  expect(detail.json()).toEqual(saved);
  const result = await effects(o);
  expect(result.appointments).toHaveLength(1); expect(result.clients).toHaveLength(2);
  expect(result.audit_events).toHaveLength((before.audit_events as unknown[]).length + 1); expect(result.outbox_events).toHaveLength(1);
  expect(result.outbound_commands).toEqual([]); expect(result.messages).toEqual([]);
  const [event] = await database.sql`select topic from outbox_events where business_id=${o.business}`;
  expect(event!.topic).toBe("appointment.created");
});

test("existing client uses current identity, zero price and no preference transfer", async () => {
  const o = await fixture();
  await database.sql`update services set price_ars=0 where id=${o.service}`;
  const payload = body(o, await offer(o)), { newClient, ...existing } = payload;
  const before = (await effects(o)).clients;
  const response = await post(o, { ...existing, clientId: o.client.toUpperCase() });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({ client: { id: o.client, firstName: "Current", lastName: "Identity", phone: "+5491123456789" }, terms: { priceArs: 0 }, customerResourcePreference: null });
  expect((await effects(o)).clients).toEqual(before);
});

test("strict body rejects draft, XOR, nested authority, invalid values and all authority overrides", async () => {
  const o = await fixture(), payload = body(o, await offer(o)), before = await effects(o);
  const { newClient, ...neither } = payload;
  const invalid = [neither, { ...payload, clientId: o.client }, ...[false, undefined, "true"].map(confirmed => ({ ...payload, confirmed })),
    { ...payload, serviceId: "bad" }, { ...payload, resourceId: "bad" }, { ...neither, clientId: "bad" },
    { ...payload, date: "0000-01-01" }, { ...payload, date: "2099-02-30" }, { ...payload, startRaw: "2099-06-01T10:00:00" },
    { ...payload, notes: "bad\u0000" }, { ...payload, newClient: { ...newClient, firstName: "bad\u0000" } },
    { ...payload, newClient: { ...newClient, phone: "invalid" } },
    ...["id", "businessId", "force"].map(key => ({ ...payload, newClient: { ...newClient, [key]: o.business } })),
    ...["actor", "role", "channel", "now", "clock", "businessId", "origin", "state", "preferredResourceId", "customerResourceExpression", "priceArs", "durationMinutes", "force"].map(key => ({ ...payload, [key]: "hostile" })),
    { ...payload, expectedTerms: { ...payload.expectedTerms, priceArs: -1 } }, { ...payload, expectedTerms: { ...payload.expectedTerms, role: "customer" } }];
  for (const value of invalid) expect((await post(o, value)).statusCode).toBe(400);
  expect(await effects(o)).toEqual(before);
});

test("auth protections and foreign owned IDs fail safely without creating clients", async () => {
  const o = await fixture(), foreign = await fixture(), admin = await fixture(true), payload = body(o, await offer(o)), before = await effects(o);
  expect((await app.inject({ method: "POST", url: "/me/appointments", payload })).statusCode).toBe(401);
  expect((await post(admin, payload)).statusCode).toBe(403);
  for (const extra of [{ origin: "https://hostile.test" }, { "x-csrf-token": "bad" }])
    expect((await app.inject({ method: "POST", url: "/me/appointments", payload, headers: { ...headers(o), ...extra } })).statusCode).toBe(403);
  const { newClient, ...existing } = payload;
  for (const value of [{ ...payload, serviceId: foreign.service }, { ...payload, resourceId: foreign.resource }, { ...existing, clientId: foreign.client }, { ...existing, clientId: randomUUID() }]) {
    const response = await post(o, value);
    expect(response.statusCode).toBe(404); expect(response.json().code).toBe("NOT_FOUND");
  }
  for (const method of ["PATCH", "PUT", "DELETE"] as const)
    expect((await app.inject({ method, url: "/me/appointments", headers: headers(o), payload })).statusCode).toBe(404);
  expect(await effects(o)).toEqual(before);
});

test("stale price, duration and labels never become authority; a fresh offer commits current terms", async () => {
  const o = await fixture(), payload = body(o, await offer(o));
  const corrupted = { ...payload, expectedTerms: { ...payload.expectedTerms, priceArs: 999 } }, before = await effects(o);
  expect((await post(o, corrupted)).statusCode).toBe(409); expect(await effects(o)).toEqual(before);
  await database.sql`update services set name='Latest service',duration_minutes=60,price_ars=99 where id=${o.service}`;
  await database.sql`update resources set name='Latest resource' where id=${o.resource}`;
  expect((await post(o, payload)).statusCode).toBe(409); expect(await effects(o)).toEqual(before);
  const fresh = body(o, await offer(o)), response = await post(o, fresh);
  expect(response.statusCode).toBe(201); expect(response.json().terms).toEqual(fresh.expectedTerms);
});

test("unavailable, paused, retired, unassigned, wrong day, off-grid and short lead create no orphans", async () => {
  const o = await fixture(), payload = body(o, await offer(o)), before = await effects(o);
  for (const value of [{ ...payload, date: "2099-06-02" }, { ...payload, startRaw: "2099-06-01T10:01:00-03:00" }, { ...payload, date: "2001-01-01", startRaw: "2001-01-01T10:00:00-03:00" }])
    expect((await post(o, value)).statusCode).toBe(409);
  const near = new Date(Math.ceil((Date.now() + 15 * 60000) / (15 * 60000)) * (15 * 60000));
  const localDate = new Date(near.getTime() - 3 * 3600000).toISOString().slice(0, 10);
  expect((await post(o, { ...payload, date: localDate, startRaw: near.toISOString() })).statusCode).toBe(409);
  await database.sql`insert into business_calendar_closures(business_id,kind,closed_date) values(${o.business},'date',${date})`;
  expect((await post(o, payload)).statusCode).toBe(409);
  await database.sql`update business_calendar_closures set closed_date='2099-06-02' where business_id=${o.business}`;
  await database.sql`update resources set status='suspended' where id=${o.resource}`;
  expect((await post(o, payload)).statusCode).toBe(409);
  await database.sql`update resources set status='active',weekly_schedule='{}'::jsonb where id=${o.resource}`;
  expect((await post(o, payload)).statusCode).toBe(409);
  await database.sql`update resources set weekly_schedule=${database.sql.json(full)} where id=${o.resource}`;
  await database.sql`update services set status='suspended' where id=${o.service}`;
  expect((await post(o, payload)).statusCode).toBe(409);
  await database.sql`update services set status='active' where id=${o.service}`;
  const otherService = randomUUID();
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${otherService},${o.business},'Other',30,0)`;
  await database.sql`update resource_services set service_id=${otherService} where business_id=${o.business}`;
  expect((await post(o, payload)).statusCode).toBe(409);
  await database.sql`update resources set deleted_at=now() where id=${o.resource}`;
  expect((await post(o, payload)).statusCode).toBe(404);
  expect(await effects(o)).toEqual(before);
});

test("duplicate normalized phone and concurrent same-resource POST roll back losers completely", async () => {
  const o = await fixture(), payload = body(o, await offer(o)), before = await effects(o);
  expect((await post(o, { ...payload, newClient: { ...payload.newClient, phone: "11 2345 6789" } })).statusCode).toBe(409);
  expect(await effects(o)).toEqual(before);
  const responses = await Promise.all([post(o, payload), post(o, { ...payload, newClient: { ...payload.newClient, phone: "11 2345 6791" } })]);
  expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409]);
  const result = await effects(o);
  expect(result.clients).toHaveLength(2); expect(result.appointments).toHaveLength(1);
  expect(result.audit_events).toHaveLength((before.audit_events as unknown[]).length + 1); expect(result.outbox_events).toHaveLength(1); expect(result.outbound_commands).toEqual([]);
  const after = await effects(o);
  expect((await post(o, { ...payload, newClient: { ...payload.newClient, phone: "11 2345 6792" } })).statusCode).toBe(409);
  expect(await effects(o)).toEqual(after);
});

test("POST waits on actual calendar lock; source binds its single clock after acquisition", async () => {
  const o = await fixture(), payload = body(o, await offer(o));
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = database.sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"business-calendar:" + o.business},0))`;
    acquired(); await gate;
  });
  await ready;
  const pending = post(o, payload);
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const [row] = await database.sql`select exists(select 1 from pg_locks where locktype='advisory' and not granted) waiting`;
      waiting = row!.waiting;
      if (!waiting) await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect((await effects(o)).appointments).toEqual([]);
  } finally { release(); await holder; }
  expect((await pending).statusCode).toBe(201);
  const source = await readFile(join(import.meta.dir, "../../apps/api/src/app.ts"), "utf8");
  const handler = source.slice(source.indexOf('app.post("/me/appointments"'), source.indexOf('app.get("/me/appointments/availability"'));
  expect(handler).toMatch(/await repo\.acquireBusinessCalendarLock\(context\(auth, request\)\);\s*const now = new Date\(\)\.toISOString\(\);/);
  expect(handler).toContain("{ clock: () => now }"); expect(handler).toContain('{ origin: "manual", now }');
});

test("physical P0001 failures at each atomic stage roll back client, booking, audit and outbox", async () => {
  const o = await fixture(), payload = body(o, await offer(o)), before = await effects(o);
  await database.sql`create function fail_manual_insert() returns trigger language plpgsql as $$ begin raise exception 'private SQL identifiers'; end $$`;
  for (const table of ["clients", "appointments", "audit_events", "outbox_events"]) {
    await database.sql`create trigger fail_manual before insert on ${database.sql(table)} for each row execute function fail_manual_insert()`;
    try {
      const response = await post(o, payload);
      expect(response.statusCode).toBe(500); expect(response.json().code).toBe("INTERNAL_ERROR");
      expect(response.body).not.toMatch(/private|SQL|P0001|postgres|trigger|identifiers/i);
      expect(await effects(o)).toEqual(before);
    } finally { await database.sql`drop trigger fail_manual on ${database.sql(table)}`; }
  }
});
