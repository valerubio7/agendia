import { afterAll, beforeAll, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

const ORIGIN = "https://panel.agendia.test", url = "/me/business-calendar";
let database: TestPostgres, pools: ReturnType<typeof createRuntimePools>, app: ReturnType<typeof buildApi>;
type Auth = { cookie: string; csrf: string; businessId: string; actorId: string };
let a: Auth, b: Auth, admin: Auth;
const ctx = (auth: Auth) => tenantContext({ businessId: auth.businessId, actorId: auth.actorId, role: "business_user", requestId: randomUUID() });
const request = (method: "GET" | "PUT", auth?: Auth, body?: object, origin = ORIGIN, csrf = auth?.csrf) =>
  app.inject({ method, url, ...(body ? { payload: body } : {}), headers: {
    origin, ...(auth ? { cookie: auth.cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}),
  } });
const effects = async () => (await database.sql`select
  (select count(*)::int from business_calendars) calendars,
  (select count(*)::int from audit_events where event_type='business_calendar.updated') audit,
  (select count(*)::int from outbox_events where topic='business_calendar.updated') outbox,
  (select count(*)::int from messages) messages,
  (select count(*)::int from outbox_events where topic like 'ai.%' or topic like 'whatsapp.%') replies`)[0]!;
const weeklySchedule = {
  0: [{ startMinute: 0, endMinute: 1440 }], 1: [],
  2: [{ startMinute: 487, endMinute: 600 }, { startMinute: 780, endMinute: 1021 }],
  5: [{ startMinute: 1380, endMinute: 60 }], 6: [{ startMinute: 1380, endMinute: 60 }],
};
beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: ORIGIN });
  const password = "correct horse battery staple", phc = await hash(password, { algorithm: Algorithm.Argon2id });
  const fixture = async (email: string, platform = false): Promise<Auth> => {
    const businessId = randomUUID(), actorId = randomUUID();
    if (!platform) await database.sql`insert into businesses(id,name) values(${businessId},${email})`;
    await database.sql`insert into auth_identities(id,normalized_email,password_phc,role,business_id) values(${actorId},${email},${phc},${platform ? "platform_admin" : "business_user"},${platform ? null : businessId})`;
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password }, headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(200);
    const cookies = res.headers["set-cookie"]!;
    return { businessId, actorId, cookie: (Array.isArray(cookies) ? cookies[0]! : cookies).split(";")[0]!, csrf: res.json().csrfToken };
  };
  a = await fixture("calendar-a@example.test"); b = await fixture("calendar-b@example.test");
  admin = await fixture("calendar-admin@example.test", true);
  await database.sql`insert into business_profiles(business_id,display_name,business_hours) values(${a.businessId},'A','Legacy free text, not a schedule')`;
  // The API must hold the shared lock already when its first mutation runs.
  await database.sql.unsafe(`create function require_calendar_lock() returns trigger language plpgsql as $$
    declare key bigint := hashtextextended('business-calendar:' || NEW.business_id::text,0);
    begin if not exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid()
      and classid=((key >> 32) & 4294967295)::oid and objid=(key & 4294967295)::oid and objsubid=1 and granted)
      then raise exception 'calendar write without lock'; end if; return NEW; end $$`);
  await database.sql.unsafe(`create trigger require_calendar_lock before insert or update on business_calendars for each row execute function require_calendar_lock()`);
}, 120_000);
afterAll(async () => { await app?.close(); await pools?.end(); await database?.stop(); });

test("missing is null without writes; weekly singleton preserves spans, off/full days and week wrap", async () => {
  const initial = await request("GET", a);
  expect(initial.statusCode).toBe(200);
  expect(initial.json<unknown>()).toEqual({ weeklySchedule: null });
  expect(await effects()).toEqual({ calendars: 0, audit: 0, outbox: 0, messages: 0, replies: 0 });
  const saved = await request("PUT", a, { weeklySchedule, businessId: b.businessId, actorId: b.actorId });
  expect(saved.statusCode).toBe(200);
  expect(saved.json<unknown>()).toEqual({ weeklySchedule });
  expect((await request("GET", b)).json<unknown>()).toEqual({ weeklySchedule: null });
  expect((await request("GET", a)).json<unknown>()).toEqual({ weeklySchedule });
  expect(await effects()).toEqual({ calendars: 1, audit: 1, outbox: 1, messages: 0, replies: 0 });
  expect((await database.sql`select actor_id from audit_events where event_type='business_calendar.updated'`)[0]?.actor_id).toBe(a.actorId);
  expect((await request("PUT", a, { weeklySchedule: {} })).json<unknown>()).toEqual({ weeklySchedule: {} });
  expect((await request("GET", a)).json<unknown>()).toEqual({ weeklySchedule: {} });
  expect((await request("PUT", a, { weeklySchedule })).statusCode).toBe(200);
  expect((await effects()).calendars).toBe(1);
  expect((await database.sql`select business_hours from business_profiles where business_id=${a.businessId}`)[0]?.business_hours).toBe("Legacy free text, not a schedule");
  expect(await pools.api.run(ctx(a), repo => repo.getBusinessCalendar(a.businessId))).toEqual({ weeklySchedule });
});

test("bad/missing/null weekly bodies and invalid JSON leave existing data and effects unchanged", async () => {
  const before = await effects();
  for (const body of [{}, { weeklySchedule: null }, { weeklySchedule: [] }, { weeklySchedule: { 7: [] } },
    { weeklySchedule: { 1: null } }, ...[
      { startMinute: 0, endMinute: 0 }, { startMinute: -1, endMinute: 60 },
      { startMinute: 1440, endMinute: 60 }, { startMinute: 0.5, endMinute: 60 },
      { startMinute: 0, endMinute: 1441 }, { startMinute: 0, endMinute: 60.5 },
      { startMinute: "0", endMinute: 60 }, { startMinute: 0 },
    ].map(span => ({ weeklySchedule: { 1: [span] } }))]) {
    const res = await request("PUT", a, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
  }
  expect((await request("PUT", a)).statusCode).toBe(400);
  for (const payload of ["{", "null"]) {
    const malformed = await app.inject({ method: "PUT", url, payload, headers: {
      cookie: a.cookie, origin: ORIGIN, "x-csrf-token": a.csrf, "content-type": "application/json",
    } });
    expect(malformed.statusCode).toBe(400);
  }
  expect((await request("GET", a)).json<unknown>()).toEqual({ weeklySchedule });
  expect(await effects()).toEqual(before);
});

test("business session required and Origin/CSRF enforced without cross-business mutation", async () => {
  const before = await effects();
  for (const method of ["GET", "PUT"] as const) {
    expect((await request(method, undefined, { weeklySchedule })).statusCode).toBe(401);
    expect((await request(method, admin, { weeklySchedule })).statusCode).toBe(403);
  }
  expect((await request("PUT", a, { weeklySchedule }, "https://evil.test")).statusCode).toBe(403);
  for (const csrf of ["", "wrong"]) expect((await request("PUT", a, { weeklySchedule }, ORIGIN, csrf)).statusCode).toBe(403);
  expect(await effects()).toEqual(before);
  expect((await request("PUT", b, { weeklySchedule: { 3: [] }, businessId: a.businessId })).statusCode).toBe(200);
  expect((await request("GET", a)).json<unknown>()).toEqual({ weeklySchedule });
  expect((await request("GET", b)).json<unknown>()).toEqual({ weeklySchedule: { 3: [] } });
  expect(await pools.api.run(ctx(a), repo => repo.getBusinessCalendar(b.businessId))).toEqual({ weeklySchedule: null });
});

test("outbox failure rolls back calendar and audit without messages or reply jobs", async () => {
  await database.sql.unsafe(`create function reject_calendar_effect() returns trigger language plpgsql as $$ begin if NEW.topic='business_calendar.updated' then raise exception 'forced effect failure'; end if; return NEW; end $$`);
  await database.sql.unsafe(`create trigger reject_calendar_effect before insert on outbox_events for each row execute function reject_calendar_effect()`);
  const before = await effects();
  const res = await request("PUT", a, { weeklySchedule: {} });
  expect(res.statusCode).toBe(500);
  expect(res.body).not.toMatch(/forced effect|postgres|sql/i);
  expect((await request("GET", a)).json<unknown>()).toEqual({ weeklySchedule });
  expect(await effects()).toEqual(before);
  await database.sql.unsafe(`create or replace function reject_calendar_effect() returns trigger language plpgsql as $$ begin return NEW; end $$`);
});

test("weekly HTTP conflicts reject suspended configured resource hours without truncation", async () => {
  const id = randomUUID(), resourceHours = { 2: [{ startMinute: 487,endMinute: 600 }] };
  await database.sql`insert into resources(id,business_id,name,status,weekly_schedule)
    values(${id},${a.businessId},'Reciprocal guard','suspended',${database.sql.json(resourceHours)})`;
  const before = await effects();
  const rejected = await request("PUT",a,{ weeklySchedule: {} });
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json()).toMatchObject({ code: "CONFLICT" });
  expect((await request("GET",a)).json<unknown>()).toEqual({ weeklySchedule });
  expect((await database.sql`select weekly_schedule from resources where id=${id}`)[0]?.weekly_schedule).toEqual(resourceHours);
  expect(await effects()).toEqual(before);
  await database.sql`update resources set weekly_schedule='{}' where id=${id}`;
});

const closures = url + "/closures";
const closureRequest = (method: "GET" | "POST" | "PUT" | "DELETE", auth?: Auth, body?: object, id = "", origin = ORIGIN, csrf = auth?.csrf) =>
  app.inject({ method, url: closures + (id ? "/" + id : ""), ...(body ? { payload: body } : {}), headers: {
    origin, ...(auth ? { cookie: auth.cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}),
  } });
const closureEffects = async () => (await database.sql`select
  (select count(*)::int from business_calendar_closures) closures,
  (select count(*)::int from audit_events where event_type like 'business_closure.%') audit,
  (select count(*)::int from outbox_events where topic like 'business_closure.%') outbox,
  (select count(*)::int from messages) messages,
  (select count(*)::int from outbox_events where topic like 'ai.%' or topic like 'whatsapp.%') replies`)[0]!;

test("global closure CRUD preserves IDs/raw epochs and deletes only the requested overlapping record", async () => {
  expect((await closureRequest("GET", a)).json<unknown>()).toEqual([]);
  // A statement trigger checks the lock before even an empty UPDATE/DELETE lookup.
  await database.sql.unsafe(`create function require_closure_lock() returns trigger language plpgsql as $$
    declare key bigint := hashtextextended('business-calendar:' || current_setting('app.tenant_id'),0);
    begin if not exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid()
      and classid=((key >> 32) & 4294967295)::oid and objid=(key & 4294967295)::oid and objsubid=1 and granted)
      then raise exception 'closure write without early lock'; end if; return null; end $$`);
  await database.sql.unsafe(`create trigger require_closure_lock before insert or update or delete on business_calendar_closures for each statement execute function require_closure_lock()`);
  const date = { kind: "date", date: "2028-01-03" };
  const first = await closureRequest("POST", a, date);
  expect(first.statusCode).toBe(201);
  const saved = first.json();
  expect(saved).toEqual({ ...date, id: expect.any(String) });
  const duplicate = (await closureRequest("POST", a, date)).json();
  const interval = { kind: "interval", start: "0001-01-01T00:00:00.001000+23:59", end: "0001-01-01T00:00:00.002000+23:59" };
  const updated = await closureRequest("PUT", a, interval, saved.id);
  expect(updated.statusCode).toBe(200);
  expect(updated.json<unknown>()).toEqual({ ...interval, id: saved.id });
  const [stored] = await database.sql`select start_raw, end_raw, start_ms::text, end_ms::text from business_calendar_closures where id=${saved.id}`;
  expect(stored).toEqual({ start_raw: interval.start, end_raw: interval.end, start_ms: "-62135683139999", end_ms: "-62135683139998" });
  const sameEpoch = { kind: "interval", start: "2028-01-01T10:00:00.001000+03:00", end: "2028-01-01T07:00:00.002Z" };
  expect((await closureRequest("PUT", a, sameEpoch, saved.id)).json<unknown>()).toEqual({ ...sameEpoch, id: saved.id });
  const [epochs] = await database.sql`select start_ms::text,end_ms::text from business_calendar_closures where id=${saved.id}`;
  expect(epochs).toEqual({ start_ms: String(Date.parse(sameEpoch.start)), end_ms: String(Date.parse(sameEpoch.end)) });
  const adjacent = { kind: "interval", start: sameEpoch.end, end: "2028-01-01T07:00:00.003Z" };
  const adjacentSaved = await closureRequest("POST", a, adjacent);
  expect(adjacentSaved.statusCode).toBe(201);
  expect((await closureRequest("DELETE", a, undefined, adjacentSaved.json().id)).statusCode).toBe(204);
  expect((await closureRequest("PUT", a, date, saved.id)).json<unknown>()).toEqual({ ...date, id: saved.id });
  const before = await closureEffects();
  for (const body of [{}, { kind: "date", date: "2027-02-29" }, { ...date, resourceId: "unknown" },
    { ...date, businessId: b.businessId }, { ...sameEpoch, start: sameEpoch.end }, { ...sameEpoch, start: "2028-01-01T07:00:00.0001Z" }])
    for (const method of ["POST", "PUT"] as const)
      expect((await closureRequest(method, a, body, method === "PUT" ? saved.id : "")).statusCode).toBe(400);
  for (const method of ["POST", "PUT"] as const) {
    const path = closures + (method === "PUT" ? "/" + saved.id : "");
    expect((await closureRequest(method, a, undefined, method === "PUT" ? saved.id : "")).statusCode).toBe(400);
    for (const payload of ["{", "null"])
      expect((await app.inject({ method, url: path, payload, headers: {
        cookie: a.cookie, origin: ORIGIN, "x-csrf-token": a.csrf, "content-type": "application/json",
      } })).statusCode).toBe(400);
  }
  for (const method of ["PUT", "DELETE"] as const) {
    expect((await closureRequest(method, a, date, "bad-uuid")).statusCode).toBe(400);
    expect((await closureRequest(method, a, date, randomUUID())).statusCode).toBe(404);
    expect((await closureRequest(method, b, date, saved.id)).statusCode).toBe(404);
  }
  expect((await closureRequest("GET", b)).json<unknown>()).toEqual([]);
  expect(await closureEffects()).toEqual(before);
  expect((await closureRequest("DELETE", a, undefined, saved.id)).statusCode).toBe(204);
  expect((await closureRequest("GET", a)).json<unknown>()).toEqual([duplicate]);
  expect((await request("GET", a)).json<unknown>()).toEqual({ weeklySchedule });
  expect((await closureEffects()).messages).toBe(0);
  expect((await closureEffects()).replies).toBe(0);
  expect((await database.sql`select distinct actor_id from audit_events where event_type like 'business_closure.%'`).map(row => row.actor_id)).toEqual([a.actorId]);
});

test("closure permissions and effect failures roll back create/update/delete and audit", async () => {
  const owned = (await closureRequest("GET", a)).json()[0];
  const before = await closureEffects();
  for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
    const id = method === "PUT" || method === "DELETE" ? owned.id : "";
    expect((await closureRequest(method, undefined, undefined, id)).statusCode).toBe(401);
    expect((await closureRequest(method, admin, undefined, id)).statusCode).toBe(403);
    if (method !== "GET") {
      expect((await closureRequest(method, a, owned, id, "https://evil.test")).statusCode).toBe(403);
      for (const csrf of ["", "wrong"])
        expect((await closureRequest(method, a, owned, id, ORIGIN, csrf)).statusCode).toBe(403);
    }
  }
  await database.sql.unsafe(`create or replace function reject_calendar_effect() returns trigger language plpgsql as $$ begin if NEW.topic like 'business_closure.%' then raise exception 'forced closure effect failure'; end if; return NEW; end $$`);
  for (const method of ["POST", "PUT", "DELETE"] as const) {
    const res = await closureRequest(method, a, { kind: "date", date: "2028-01-04" }, method === "POST" ? "" : owned.id);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/forced closure|postgres|sql/i);
    expect(await closureEffects()).toEqual(before);
    expect((await closureRequest("GET", a)).json<unknown>()).toEqual([owned]);
  }
  await database.sql.unsafe(`create or replace function reject_calendar_effect() returns trigger language plpgsql as $$ begin return NEW; end $$`);
});

test("audit failure also rolls back closure mutations before outbox emission", async () => {
  const owned = (await closureRequest("GET", a)).json()[0];
  const before = await closureEffects();
  await database.sql.unsafe(`create function reject_closure_audit() returns trigger language plpgsql as $$ begin if NEW.event_type like 'business_closure.%' then raise exception 'forced audit failure'; end if; return NEW; end $$`);
  await database.sql.unsafe(`create trigger reject_closure_audit before insert on audit_events for each row execute function reject_closure_audit()`);
  for (const method of ["POST", "PUT", "DELETE"] as const) {
    expect((await closureRequest(method, a, { kind: "date", date: "2028-01-04" }, method === "POST" ? "" : owned.id)).statusCode).toBe(500);
    expect(await closureEffects()).toEqual(before);
    expect((await closureRequest("GET", a)).json<unknown>()).toEqual([owned]);
  }
  await database.sql.unsafe(`create or replace function reject_closure_audit() returns trigger language plpgsql as $$ begin return NEW; end $$`);
});

test("transaction lock precedes mutation even without a calendar row and releases on commit/rollback", async () => {
  await expect(pools.api.run(ctx(a), repo => repo.acquireBusinessCalendarLock(ctx(b)))).rejects.toThrow(/matching tenant context/);
  const fresh = tenantContext({ ...ctx(a), businessId: randomUUID() });
  await database.sql`insert into businesses(id,name) values(${fresh.businessId},'Lock fixture')`;
  const probe = () => database.sql.begin(async tx => (await tx`select pg_try_advisory_xact_lock(hashtextextended(${"business-calendar:" + fresh.businessId},0)) acquired`)[0]?.acquired);
  for (const rollback of [false, true]) {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const work = pools.api.run(fresh, async repo => {
      await repo.acquireBusinessCalendarLock(fresh);
      expect(await repo.getBusinessCalendar(fresh.businessId)).toEqual({ weeklySchedule: null });
      entered(); await gate;
      if (rollback) throw new Error("rollback lock probe");
    });
    const outcome = work.catch(error => error);
    await Promise.race([ready, outcome.then(result => { if (result instanceof Error) throw result; })]);
    try { expect(await probe()).toBe(false); } finally { release(); }
    const result = await outcome;
    if (rollback) expect(result).toBeInstanceOf(Error);
    expect(await probe()).toBe(true);
  }
});
