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

test("operation status admits authenticated recovery without interpreting absence as rollback", async () => {
  const o = await fixture(), key = randomUUID();
  const response = await app.inject({ method: "GET", url: `/me/appointment-operations/${key}`, headers: { cookie: o.cookie } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ key, businessId: o.business, identityId: o.actor, state: "not_found", appointment: null });
});

const receipt = (o: Owner, key: string) => app.inject({ method: "GET", url: `/me/appointment-operations/${key}`, headers: { cookie: o.cookie } });
const fenced = (o: Owner, key: string, kind = "create", target: string | null = null) => app.inject({
  method: "POST", url: `/me/appointment-operations/${key}/cancel`, headers: headers(o), payload: { key, kind, target },
});
const keyedPost = (o: Owner, key: string, payload: Record<string, unknown>) => app.inject({
  method: "POST", url: "/me/appointments", headers: { ...headers(o), "x-appointment-operation-key": key }, payload,
});

test("same operation concurrently commits exactly once and canonical replay rejects payload changes", async () => {
  const o = await fixture(), key = randomUUID(), payload = body(o, await offer(o)), before = await effects(o);
  const responses = await Promise.all([keyedPost(o, key, payload), keyedPost(o, key, payload)]);
  expect(responses.map(response => response.statusCode)).toEqual([201, 201]);
  expect(responses[0]!.json()).toEqual(responses[1]!.json());
  const saved = responses[0]!.json(), after = await effects(o);
  expect(after.appointments).toHaveLength(1); expect(after.clients).toHaveLength(2);
  expect(after.audit_events).toHaveLength((before.audit_events as unknown[]).length + 1); expect(after.outbox_events).toHaveLength(1);
  expect((await receipt(o, key)).json()).toMatchObject({ state: "completed", httpStatus: 201, appointment: saved });
  const replay = await keyedPost(o, key, { ...payload, serviceId: o.service.toUpperCase() });
  expect(replay.statusCode).toBe(201); expect(replay.json()).toEqual(saved);
  expect((await keyedPost(o, key, { ...payload, notes: "different" })).statusCode).toBe(409);
  expect(await effects(o)).toEqual(after);
  expect((await fenced(o, key)).json()).toMatchObject({ state: "completed", appointment: saved });
});

test("terminal conflict uses a savepoint, replays safely, and pre-arrival fence prevents every late effect", async () => {
  const o = await fixture(), payload = body(o, await offer(o)), before = await effects(o), key = randomUUID();
  const conflict = { ...payload, newClient: { ...payload.newClient, phone: "+5491123456789" } };
  const first = await keyedPost(o, key, conflict);
  expect(first.statusCode).toBe(409);
  expect((await receipt(o, key)).json()).toMatchObject({ state: "failed", httpStatus: 409, appointment: null });
  expect((await keyedPost(o, key, conflict)).body).toBe(first.body);
  expect(await effects(o)).toEqual(before);
  const cancelledKey = randomUUID();
  expect((await fenced(o, cancelledKey)).json().state).toBe("cancelled");
  expect((await receipt(o, cancelledKey)).json().state).toBe("cancelled");
  expect((await keyedPost(o, cancelledKey, payload)).statusCode).toBe(409);
  expect((await keyedPost(o, cancelledKey, { ...payload, notes: "late change" })).statusCode).toBe(409);
  expect(await effects(o)).toEqual(before);
});

test("execution and fence serialize; pending is observed without a crash-stuck admission row", async () => {
  const o = await fixture(), key = randomUUID(), payload = body(o, await offer(o));
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const holder = database.sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"business-calendar:" + o.business},0))`;
    acquired(); await gate;
  });
  await ready;
  const executing = keyedPost(o, key, payload);
  let cancellation: ReturnType<typeof fenced> | null = null;
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const [row] = await database.sql`select exists(select 1 from pg_locks where locktype='advisory' and not granted) waiting`;
      waiting = row!.waiting; if (!waiting) await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect((await receipt(o, key)).json().state).toBe("pending");
    cancellation = fenced(o, key);
  } finally { release(); await holder; }
  const result = await executing;
  expect(result.statusCode).toBe(201);
  expect((await cancellation!).json()).toMatchObject({ state: "completed", appointment: result.json() });
  expect((await effects(o)).appointments).toHaveLength(1);
});

test("physical rollback cannot record completion; a restarted API can fence abandoned admission", async () => {
  const o = await fixture(), key = randomUUID(), payload = body(o, await offer(o)), before = await effects(o);
  await database.sql`create function fail_receipt_write() returns trigger language plpgsql as $$ begin raise exception 'receipt rollback fixture'; end $$`;
  await database.sql`create trigger fail_receipt before insert on outbox_events for each row execute function fail_receipt_write()`;
  try { expect((await keyedPost(o, key, payload)).statusCode).toBe(500); }
  finally {
    await database.sql`drop trigger fail_receipt on outbox_events`;
    await database.sql`drop function fail_receipt_write()`;
  }
  expect(await effects(o)).toEqual(before);
  expect((await receipt(o, key)).json().state).toBe("not_found");
  const restarted = buildApi({ pools, expectedOrigin: origin });
  try {
    const cancellation = await restarted.inject({ method: "POST", url: `/me/appointment-operations/${key}/cancel`, headers: headers(o), payload: { key, kind: "create", target: null } });
    expect(cancellation.json().state).toBe("cancelled");
    expect((await restarted.inject({ method: "POST", url: "/me/appointments", headers: { ...headers(o), "x-appointment-operation-key": key }, payload })).statusCode).toBe(409);
  } finally { await restarted.close(); }
  expect(await effects(o)).toEqual(before);
});

test("receipt/fence scope is tenant AND identity, with original auth/CSRF/role checks and RLS", async () => {
  const o = await fixture(), foreign = await fixture(), admin = await fixture(true), key = randomUUID();
  const saved = (await keyedPost(o, key, body(o, await offer(o)))).json();
  expect((await receipt(foreign, key)).json()).toMatchObject({ state: "not_found", appointment: null });
  expect((await receipt(admin, key)).statusCode).toBe(403);
  expect((await fenced(admin, key)).statusCode).toBe(403);
  expect((await app.inject({ method: "GET", url: `/me/appointment-operations/${key}` })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url: `/me/appointment-operations/${key}/cancel`, headers: { ...headers(o), "x-csrf-token": "wrong" }, payload: { key, kind: "create", target: null } })).statusCode).toBe(403);
  const actor = randomUUID(), email = `${actor}@example.test`;
  // Replace the binding, never bypass the one-business-user invariant.
  await database.sql`update auth_identities set role='platform_admin',business_id=null where id=${o.actor}`;
  await database.sql`insert into auth_identities(id,normalized_email,password_phc,role,business_id) values(${actor},${email},${phc},'business_user',${o.business})`;
  const login = await app.inject({ method: "POST", url: "/auth/login", headers: { origin }, payload: { email, password: "correct horse battery staple" } });
  const cookies = login.headers["set-cookie"]!;
  const second = { ...o, actor, cookie: (Array.isArray(cookies) ? cookies[0]! : cookies).split(";")[0]!, csrf: login.json().csrfToken };
  expect((await receipt(second, key)).json()).toMatchObject({ state: "not_found", appointment: null });
  expect((await fenced(second, key)).json().state).toBe("cancelled");
  await database.sql`update auth_identities set role='platform_admin',business_id=null where id=${actor}`;
  await database.sql`update auth_identities set role='business_user',business_id=${o.business} where id=${o.actor}`;
  expect((await receipt(o, key)).json()).toMatchObject({ state: "completed", appointment: saved });
  const visible = await pools.api.run({ businessId: o.business, actorId: actor, role: "business_user", requestId: randomUUID() }, repo => repo.appointmentOperation({ businessId: o.business, actorId: o.actor, role: "business_user", requestId: randomUUID() }, key));
  expect(visible).toBeNull();
});

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

const patch = (o: Owner, id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/me/appointments/${id}`, headers: headers(o), payload });
const editBody = (o: Owner, slot: AvailabilitySlot) => ({ serviceId: o.service, resourceId: slot.resourceId, date, startRaw: slot.start, expectedTerms: slot.terms, confirmed: true });
const booking = async (o: Owner) => {
  const response = await post(o, body(o, await offer(o)));
  expect(response.statusCode).toBe(201);
  return response.json();
};
const editOffer = async (o: Owner, id: string, index = 44) => {
  const response = await app.inject({ method: "GET", url: `/me/appointments/availability?serviceId=${o.service}&resourceId=${o.resource}&date=${date}&appointmentId=${id}`, headers: { cookie: o.cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<AvailabilitySlot[]>()[index]!;
};
const alternate = async (o: Owner) => {
  const service = randomUUID(), resource = randomUUID();
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${service},${o.business},'New service',60,99)`;
  await database.sql`insert into resources(id,business_id,name,weekly_schedule) values(${resource},${o.business},'New resource',${database.sql.json(full)})`;
  for (const s of [o.service, service]) await database.sql`insert into resource_services values(${o.business},${resource},${s})`;
  await database.sql`insert into resource_services values(${o.business},${o.resource},${service})`;
  return { ...o, service, resource };
};
const setEpoch = async (id: string, epoch: number) => {
  await database.sql`update appointments set start_raw=${new Date(epoch).toISOString()},start_ms=${epoch},end_ms=${epoch}::bigint + duration_minutes * 60000 where id=${id}`;
};

test("PATCH structural changes preserve identity, historical terms and retired customer preference", async () => {
  const o = await fixture(), saved = await booking(o), next = await alternate(o);
  await database.sql`update appointments set customer_resource_preference_id=${o.resource},origin='ai' where id=${saved.id}`;
  await database.sql`update services set name='Renamed',duration_minutes=90,price_ars=500 where id=${o.service}`;
  await database.sql`update resources set name='Renamed resource' where id=${o.resource}`;
  const time = await patch(o, saved.id, editBody(o, await editOffer(o, saved.id)));
  expect(time.statusCode).toBe(200);
  expect(time.json().terms).toEqual(saved.terms);
  expect(time.json().endMs - time.json().startMs).toBe(30 * 60000);
  const resourceOnly = { ...o, resource: next.resource };
  const moved = await patch(o, saved.id, editBody(resourceOnly, await editOffer(resourceOnly, saved.id)));
  expect(moved.statusCode).toBe(200);
  expect(moved.json()).toMatchObject({ client: saved.client, notes: saved.notes, origin: "ai", customerResourcePreference: o.resource,
    terms: { ...saved.terms, resourceId: next.resource, resourceName: "New resource" } });
  await database.sql`update resources set deleted_at=now() where id=${o.resource}`;
  const payload = editBody(next, await editOffer(next, saved.id));
  await database.sql`update services set price_ars=101 where id=${next.service}`;
  const before = await effects(o);
  expect((await patch(o, saved.id, payload)).statusCode).toBe(409); expect(await effects(o)).toEqual(before);
  const changed = await patch(o, saved.id, editBody(next, await editOffer(next, saved.id)));
  expect(changed.statusCode).toBe(200);
  expect(changed.json()).toMatchObject({ client: saved.client, notes: saved.notes, origin: "ai", customerResourcePreference: o.resource,
    terms: { serviceId: next.service, serviceName: "New service", resourceId: next.resource, resourceName: "New resource", durationMinutes: 60, priceArs: 101 } });
  expect(changed.json().endMs - changed.json().startMs).toBe(60 * 60000);
});

test("PATCH true epoch/ID no-op retains every physical field despite started, retired or closed catalogs", async () => {
  const o = await fixture(), saved = await booking(o);
  await database.sql`update appointments set customer_resource_preference_id=${o.resource} where id=${saved.id}`;
  const payload = { ...editBody(o, await offer(o)), startRaw: "2099-06-01T13:00:00Z", expectedTerms: saved.terms };
  await database.sql`update services set status='suspended',name='Changed',price_ars=900 where id=${o.service}`;
  await database.sql`update resources set status='suspended',name='Changed' where id=${o.resource}`;
  await database.sql`insert into business_calendar_closures(business_id,kind,closed_date) values(${o.business},'date',${date})`;
  let before = await effects(o);
  expect((await patch(o, saved.id, payload)).statusCode).toBe(200);
  expect((await effects(o)).appointments).toEqual(before.appointments);
  const past = Date.now() - 3600000;
  await setEpoch(saved.id, past);
  await database.sql`update services set deleted_at=now() where id=${o.service}`;
  await database.sql`update resources set deleted_at=now() where id=${o.resource}`;
  before = await effects(o);
  const alias = new Date(past + 3600000).toISOString().replace("Z", "+01:00");
  const noop = { ...payload, date: "0001-01-01", startRaw: alias, serviceId: o.service.toUpperCase(), resourceId: o.resource.toUpperCase(),
    expectedTerms: { ...saved.terms, serviceId: o.service.toUpperCase(), resourceId: o.resource.toUpperCase() } };
  expect((await patch(o, saved.id.toUpperCase(), noop)).statusCode).toBe(200);
  expect((await effects(o)).appointments).toEqual(before.appointments);
  expect((await effects(o)).outbound_commands).toEqual([]);
  expect((await patch(o, saved.id, { ...noop, expectedTerms: { ...noop.expectedTerms, priceArs: 901 } })).statusCode).toBe(409);
  await database.sql`update appointments set start_raw=${new Date(past + 1).toISOString()} where id=${saved.id}`;
  const incoherent = await effects(o);
  expect((await patch(o, saved.id, noop)).statusCode).toBe(400); expect(await effects(o)).toEqual(incoherent);
  await setEpoch(saved.id, past);
  const coherent = await effects(o);
  // Native duration/end constraint prevents this hostile row before it can reach the API.
  await expect(database.sql`update appointments set end_ms=end_ms+1 where id=${saved.id}`.then(rows => rows)).rejects.toMatchObject({ code: "23514" });
  expect(await effects(o)).toEqual(coherent);
});

test("PATCH upcoming original within one hour permits resource/service edits but not a new short-lead start or started/final changes", async () => {
  const o = await fixture(), saved = await booking(o), next = await alternate(o), near = Math.ceil((Date.now() + 30 * 60000) / (15 * 60000)) * (15 * 60000);
  await setEpoch(saved.id, near);
  const localDate = new Date(near - 3 * 3600000).toISOString().slice(0, 10);
  const payload = { serviceId: next.service, resourceId: next.resource, date: localDate, startRaw: new Date(near).toISOString(), confirmed: true,
    expectedTerms: { serviceId: next.service, resourceId: next.resource, serviceName: "New service", resourceName: "New resource", durationMinutes: 60, priceArs: 99 } };
  expect((await patch(o, saved.id, payload)).statusCode).toBe(200);
  const before = await effects(o);
  expect((await patch(o, saved.id, { ...payload, startRaw: new Date(near + 15 * 60000).toISOString() })).statusCode).toBe(409);
  expect(await effects(o)).toEqual(before);
  await setEpoch(saved.id, Date.now() - 60000);
  expect((await patch(o, saved.id, payload)).statusCode).toBe(409);
  for (const state of ["cancelled", "done", "no_show"]) {
    await database.sql`update appointments set state=${state} where id=${saved.id}`;
    const [row] = await database.sql`select start_raw from appointments where id=${saved.id}`;
    const locked = await effects(o);
    expect((await patch(o, saved.id, { ...payload, startRaw: row!.start_raw })).statusCode).toBe(409);
    expect((await patch(o, saved.id, payload)).statusCode).toBe(409); expect(await effects(o)).toEqual(locked);
  }
});

test("PATCH same labels with new catalog IDs is a real change, not a stored no-op", async () => {
  const o = await fixture(), saved = await booking(o), next = await alternate(o);
  await database.sql`update services set name='Renamed old service' where id=${o.service}`;
  await database.sql`update resources set name='Renamed old resource' where id=${o.resource}`;
  await database.sql`update services set name='Service' where id=${next.service}`;
  await database.sql`update resources set name='Resource' where id=${next.resource}`;
  const payload = { ...editBody(next, await editOffer(next, saved.id, 40)), startRaw: saved.startsAt };
  const changed = await patch(o, saved.id, payload);
  expect(changed.statusCode).toBe(200);
  expect(changed.json().terms).toMatchObject({ serviceId: next.service, resourceId: next.resource, serviceName: "Service", resourceName: "Resource", durationMinutes: 60, priceArs: 99 });
  expect(changed.json().endMs).toBe(saved.startMs + 60 * 60000);
  await setEpoch(saved.id, Date.now() - 60000);
  const before = await effects(o);
  expect((await patch(o, saved.id, { ...payload, serviceId: o.service, resourceId: o.resource, expectedTerms: saved.terms })).statusCode).toBe(409);
  expect(await effects(o)).toEqual(before);
});

test("PATCH strict authority, auth, ownership and unavailable guards are atomic and safe", async () => {
  const o = await fixture(), saved = await booking(o), foreign = await fixture(), admin = await fixture(true), payload = editBody(o, await editOffer(o, saved.id)), before = await effects(o);
  expect((await app.inject({ method: "PATCH", url: `/me/appointments/${saved.id}`, payload })).statusCode).toBe(401);
  expect((await patch(admin, saved.id, payload)).statusCode).toBe(403);
  // Reserved static GET URI must never become an authorized structural-write target.
  expect((await patch(o, "availability", payload)).statusCode).toBe(404);
  expect(await effects(o)).toEqual(before);
  expect((await app.inject({ method: "PATCH", url: "/me/appointments/bad", payload })).statusCode).toBe(401);
  for (const extra of [{ origin: "https://hostile.test" }, { "x-csrf-token": "bad" }])
    expect((await app.inject({ method: "PATCH", url: `/me/appointments/${saved.id}`, payload, headers: { ...headers(o), ...extra } })).statusCode).toBe(403);
  for (const id of [randomUUID(), (await booking(foreign)).id]) expect((await patch(o, id, payload)).statusCode).toBe(404);
  expect((await patch(o, "bad", payload)).statusCode).toBe(400);
  for (const key of ["clientId", "newClient", "notes", "state", "origin", "actor", "role", "channel", "now", "clock", "businessId", "preferredResourceId", "customerResourceExpression", "priceArs", "durationMinutes"])
    expect((await patch(o, saved.id, { ...payload, [key]: "hostile" })).statusCode).toBe(400);
  for (const value of [{ ...payload, confirmed: false }, { ...payload, date: "2099-02-30" }, { ...payload, serviceId: "bad" }, { ...payload, startRaw: "bad\u0000" }, { ...payload, expectedTerms: { ...payload.expectedTerms, serviceName: "bad\u0000" } }])
    expect((await patch(o, saved.id, value)).statusCode).toBe(400);
  expect((await patch(o, saved.id, { ...payload, serviceId: foreign.service })).statusCode).toBe(404);
  expect((await patch(o, saved.id, { ...payload, startRaw: "2099-06-01T10:01:00-03:00" })).statusCode).toBe(409);
  await database.sql`update resources set status='suspended' where id=${o.resource}`;
  expect((await patch(o, saved.id, payload)).statusCode).toBe(409);
  expect(await effects(o)).toEqual(before);
});

test("PATCH and POST race for one new slot; loser retains old record without orphan effects", async () => {
  const o = await fixture(), saved = await booking(o), payload = editBody(o, await editOffer(o, saved.id)), before = await effects(o);
  const create = { ...body(o, await offer(o)), ...payload, newClient: { firstName: "Race", lastName: "Client", phone: "1123456791" } };
  const [edit, made] = await Promise.all([patch(o, saved.id, payload), post(o, create)]);
  expect([edit.statusCode, made.statusCode].sort()).toEqual(edit.statusCode === 200 ? [200, 409] : [201, 409]);
  const after = await effects(o);
  expect(after.audit_events).toHaveLength((before.audit_events as unknown[]).length + 1);
  expect(after.outbox_events).toHaveLength((before.outbox_events as unknown[]).length + 1);
  expect(after.clients).toHaveLength(edit.statusCode === 200 ? 2 : 3);
  if (edit.statusCode === 409) {
    const detail = await app.inject({ method: "GET", url: `/me/appointments/${saved.id}`, headers: { cookie: o.cookie } });
    expect(detail.json()).toEqual(saved);
  }
});

test("PATCH P0001 UPDATE/audit/outbox failures roll back every old field and effect", async () => {
  const o = await fixture(), saved = await booking(o), payload = editBody(o, await editOffer(o, saved.id));
  await database.sql`update appointments set customer_resource_preference_id=${o.resource},origin='ai' where id=${saved.id}`;
  const before = await effects(o);
  await database.sql`create function fail_manual_patch() returns trigger language plpgsql as $$ begin raise exception 'private SQL identifiers'; end $$`;
  for (const table of ["appointments", "audit_events", "outbox_events"]) {
    await database.sql.unsafe(`create trigger fail_patch before ${table === "appointments" ? "update" : "insert"} on ${table} for each row execute function fail_manual_patch()`);
    try {
      const response = await patch(o, saved.id, payload);
      expect(response.statusCode).toBe(500); expect(response.json().code).toBe("INTERNAL_ERROR");
      expect(response.body).not.toMatch(/private|SQL|P0001|postgres|trigger|identifiers/i);
      expect(await effects(o)).toEqual(before);
    } finally { await database.sql`drop trigger fail_patch on ${database.sql(table)}`; }
  }
  const source = await readFile(join(import.meta.dir, "../../apps/api/src/app.ts"), "utf8");
  const handler = source.slice(source.indexOf('app.patch("/me/appointments/:appointmentId"'), source.indexOf('app.get("/me/appointments/availability"'));
  expect(handler).toMatch(/await repo\.acquireBusinessCalendarLock\(context\(auth, request\)\);\s*const now = new Date\(\)\.toISOString\(\);/);
  expect(handler).toContain("{ appointmentId, clock: () => now }"); expect(handler).toContain("{ now }");
});

const action = (o: Owner, id: string, suffix: "notes" | "state", payload: unknown) =>
  app.inject({ method: "PATCH", url: `/me/appointments/${id}/${suffix}`, headers: headers(o), payload: payload as Record<string, unknown> });
const physical = async (id: string) => (await database.sql`select * from appointments where id=${id}`)[0]!;
const detail = async (o: Owner, id: string) => (await app.inject({ method: "GET", url: `/me/appointments/${id}`, headers: { cookie: o.cookie } })).json();

for (const suffix of ["notes", "state"] as const) test(`${suffix} suffix authenticates before input and rejects all injected authority atomically`, async () => {
  const o = await fixture(), saved = await booking(o), foreign = await fixture(), admin = await fixture(true);
  const payload = suffix === "notes" ? { notes: "Changed" } : { state: "cancelled", confirmed: true }, before = await effects(o);
  expect((await app.inject({ method: "PATCH", url: `/me/appointments/bad/${suffix}`, payload })).statusCode).toBe(401);
  expect((await action(admin, saved.id, suffix, payload)).statusCode).toBe(403);
  for (const extra of [{ origin: "https://hostile.test" }, { "x-csrf-token": "bad" }])
    expect((await app.inject({ method: "PATCH", url: `/me/appointments/${saved.id}/${suffix}`, payload, headers: { ...headers(o), ...extra } })).statusCode).toBe(403);
  for (const id of [randomUUID(), (await booking(foreign)).id]) expect((await action(o, id, suffix, payload)).statusCode).toBe(404);
  expect((await action(o, "bad", suffix, payload)).statusCode).toBe(400);
  expect((await app.inject({ method: "PATCH", url: `/me/appointments/${saved.id}/${suffix}?now=2099`, payload, headers: headers(o) })).statusCode).toBe(400);
  for (const key of ["actor", "role", "channel", "now", "clock", "businessId", "clientId", "newClient", "serviceId", "resourceId", "expectedTerms", "origin", "customerResourcePreference", "customerResourceExpression", "startRaw", "priceArs", suffix === "notes" ? "state" : "notes"])
    expect((await action(o, saved.id, suffix, { ...payload, [key]: "hostile" })).statusCode).toBe(400);
  const invalid = suffix === "notes" ? [{}, { notes: 1 }, { notes: "bad\u0000" }, { notes: null, confirmed: true }]
    : [{}, { state: "done" }, ...[false, "true", null].map(confirmed => ({ state: "cancelled", confirmed })), ...["confirmed", "pending", "Done"].map(state => ({ state, confirmed: true }))];
  for (const value of invalid) expect((await action(o, saved.id, suffix, value)).statusCode).toBe(400);
  expect(await effects(o)).toEqual(before);
});

test("notes preserve every saved field, clear null, retain empty string and work after start despite retired catalogs", async () => {
  const o = await fixture(), saved = await booking(o);
  await database.sql`update appointments set origin='ai',customer_resource_preference_id=${o.resource} where id=${saved.id}`;
  await database.sql`update clients set first_name='Latest' where id=${saved.client.id}`;
  for (const notes of ["Changed", "", null, "x".repeat(10000)]) {
    const before = await physical(saved.id), response = await action(o, saved.id.toUpperCase(), "notes", { notes });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...await detail(o, saved.id), notes });
    expect(response.json().client.firstName).toBe("Latest");
    const after = await physical(saved.id);
    expect(after).toEqual({ ...before, notes, updated_at: after.updated_at });
  }
  await setEpoch(saved.id, Date.now() - 60000);
  await database.sql`update services set status='suspended',deleted_at=now(),name='Changed',price_ars=999 where id=${o.service}`;
  await database.sql`update resources set status='suspended',deleted_at=now(),weekly_schedule='{}',name='Changed' where id=${o.resource}`;
  await database.sql`update business_calendars set weekly_schedule='{}' where business_id=${o.business}`;
  await database.sql`insert into business_calendar_closures(business_id,kind,closed_date) values(${o.business},'date',${date})`;
  const before = await physical(saved.id);
  expect((await action(o, saved.id, "notes", { notes: "Started" })).statusCode).toBe(200);
  const after = await physical(saved.id);
  expect(after).toEqual({ ...before, notes: "Started", updated_at: after.updated_at });
  expect((await action(o, saved.id, "state", { state: "cancelled", confirmed: true })).statusCode).toBe(200);
  expect((await effects(o)).outbound_commands).toEqual([]); expect((await effects(o)).messages).toEqual([]);
});

for (const state of ["cancelled", "done", "no_show"]) test(`manual ${state} uses start not end, preserves all fields and permanently frees native occupancy`, async () => {
  const o = await fixture(), saved = await booking(o);
  await database.sql`update appointments set origin='ai',customer_resource_preference_id=${o.resource} where id=${saved.id}`;
  if (state !== "cancelled") {
    const before = await effects(o);
    expect((await action(o, saved.id, "state", { state, confirmed: true })).statusCode).toBe(409);
    expect(await effects(o)).toEqual(before);
    await setEpoch(saved.id, Date.now() - 1000); // Attendance before end is legal.
  }
  await database.sql`update services set status='suspended',deleted_at=now(),name='Changed',duration_minutes=90,price_ars=999 where id=${o.service}`;
  await database.sql`update resources set status='suspended',deleted_at=now(),weekly_schedule='{}',name='Changed' where id=${o.resource}`;
  await database.sql`update business_calendars set weekly_schedule='{}' where business_id=${o.business}`;
  await database.sql`insert into business_calendar_closures(business_id,kind,closed_date) values(${o.business},'date',${date})`;
  const duplicate = () => database.sql`insert into appointments(id,business_id,client_id,service_id,resource_id,service_label,resource_label,duration_minutes,price_ars,start_raw,start_ms,end_ms,state,origin)
    select ${randomUUID()},business_id,client_id,service_id,resource_id,service_label,resource_label,duration_minutes,price_ars,start_raw,start_ms,end_ms,'confirmed','manual' from appointments where id=${saved.id}`;
  await expect(duplicate().then(rows => rows)).rejects.toMatchObject({ code: "23P01" });
  const before = await physical(saved.id), beforeDto = await detail(o, saved.id), beforeEffects = await effects(o);
  expect((await action(o, saved.id, "state", { state })).statusCode).toBe(400); // AI creation is not AI action authority.
  const response = await action(o, saved.id, "state", { state, confirmed: true });
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ...beforeDto, state });
  const after = await physical(saved.id);
  expect(after).toEqual({ ...before, state, updated_at: after.updated_at });
  const committed = await effects(o);
  for (const table of ["audit_events", "outbox_events"]) expect(committed[table]).toHaveLength((beforeEffects[table] as unknown[]).length + 1);
  expect(committed.outbound_commands).toEqual([]); expect(committed.messages).toEqual([]);
  const [event] = await database.sql`select topic from outbox_events where business_id=${o.business} order by created_at desc limit 1`;
  expect(event!.topic).toBe("appointment.updated");
  const locked = await effects(o);
  for (const target of ["cancelled", "done", "no_show"]) expect((await action(o, saved.id, "state", { state: target, confirmed: true })).statusCode).toBe(409);
  expect((await action(o, saved.id, "state", { state: "confirmed", confirmed: true })).statusCode).toBe(400);
  expect((await action(o, saved.id, "notes", { notes: null })).statusCode).toBe(409);
  expect(await effects(o)).toEqual(locked);
  // A physical duplicate in this interval is now legal only because the API really changed state.
  await duplicate();
  expect((await effects(o)).appointments).toHaveLength(2);
});

for (const suffix of ["notes", "state"] as const) test(`${suffix} waits on the real tenant calendar lock and derives fresh action time`, async () => {
  const o = await fixture(), saved = await booking(o), before = await effects(o);
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = database.sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"business-calendar:" + o.business},0))`;
    acquired(); await gate;
  });
  await ready;
  const pending = action(o, saved.id, suffix, suffix === "notes" ? { notes: "After wait" } : { state: "done", confirmed: true });
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const [row] = await database.sql`select exists(select 1 from pg_locks where locktype='advisory' and not granted) waiting`;
      waiting = row!.waiting;
      if (!waiting) await Bun.sleep(10);
    }
    expect(waiting).toBe(true); expect(await effects(o)).toEqual(before);
    // Move start to NOW only after the HTTP action is waiting. A pre-lock clock denies Done.
    await setEpoch(saved.id, Date.now());
    await Bun.sleep(20);
  } finally { release(); await holder; }
  expect((await pending).statusCode).toBe(200);
});

for (const state of ["done", "no_show"]) test(`${state} also remains legal after end`, async () => {
  const o = await fixture(), saved = await booking(o);
  await setEpoch(saved.id, Date.now() - 3600000);
  expect((await action(o, saved.id, "state", { state, confirmed: true })).statusCode).toBe(200);
});

for (const suffix of ["notes", "state"] as const) test(`${suffix} P0001 update/audit/outbox failures safely roll back everything`, async () => {
  const o = await fixture(), saved = await booking(o), before = await effects(o);
  await database.sql.unsafe(`create function fail_action_${suffix}() returns trigger language plpgsql as $$ begin raise exception 'private SQL identifiers'; end $$`);
  try {
    for (const table of ["appointments", "audit_events", "outbox_events"]) {
      await database.sql.unsafe(`create trigger fail_action before ${table === "appointments" ? "update" : "insert"} on ${table} for each row execute function fail_action_${suffix}()`);
      try {
        const response = await action(o, saved.id, suffix, suffix === "notes" ? { notes: "Changed" } : { state: "cancelled", confirmed: true });
        expect(response.statusCode).toBe(500); expect(response.json().code).toBe("INTERNAL_ERROR");
        expect(response.body).not.toMatch(/private|SQL|P0001|postgres|trigger|identifiers/i);
        expect(await effects(o)).toEqual(before);
      } finally { await database.sql`drop trigger fail_action on ${database.sql(table)}`; }
    }
  } finally { await database.sql.unsafe(`drop function fail_action_${suffix}()`); }
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
