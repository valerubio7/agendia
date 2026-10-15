import { afterAll, beforeAll, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { parseInstantMs, type WeeklySchedule } from "@agendia/domain";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

let database: TestPostgres, pools: ReturnType<typeof createRuntimePools>, app: ReturnType<typeof buildApi>, phc: string;
type Owner = { business: string; actor: string; cookie: string; client: string; service: string; resources: string[] };
type Slot = { start: string; startMs: number; endMs: number; resourceId: string; terms: { serviceId: string; serviceName: string; resourceId: string; resourceName: string; durationMinutes: number; priceArs: number } };
const full: WeeklySchedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
const date = "2099-06-01", hour = 3600000;
const context = (o: Owner) => tenantContext({ businessId: o.business, actorId: o.actor, role: "business_user", requestId: randomUUID() });
const get = (o?: Owner, query: Record<string, string> = {}) => app.inject({ method: "GET", url: `/me/appointments/availability?${new URLSearchParams({ serviceId: o?.service ?? randomUUID(), date, ...query })}`, headers: o ? { cookie: o.cookie } : {} });
const effects = async () => {
  const result: Record<string, unknown> = {};
  for (const table of ["businesses", "business_calendars", "business_calendar_closures", "appointments", "clients", "services", "resources", "resource_services", "audit_events", "outbox_events", "outbound_commands", "whatsapp_connections", "messages"])
    result[table] = (await database.sql`select * from ${database.sql(table)}`).map(row => JSON.stringify(row)).sort();
  return result;
};
const fixture = async (platform = false): Promise<Owner> => {
  const o: Owner = { business: randomUUID(), actor: randomUUID(), cookie: "", client: randomUUID(), service: randomUUID(), resources: [randomUUID(), randomUUID()] };
  const email = `${o.actor}@example.test`;
  if (!platform) await database.sql`insert into businesses(id,name) values(${o.business},'Availability fixture')`;
  await database.sql`insert into auth_identities(id,normalized_email,password_phc,role,business_id) values(${o.actor},${email},${phc},${platform ? "platform_admin" : "business_user"},${platform ? null : o.business})`;
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery staple" }, headers: { origin: "https://panel.agendia.test" } });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers["set-cookie"]!;
  o.cookie = (Array.isArray(cookies) ? cookies[0]! : cookies).split(";")[0]!;
  if (platform) return o;
  await database.sql`insert into clients(id,business_id,first_name,last_name,phone) values(${o.client},${o.business},'Current','Client','+5491123456789')`;
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${o.service},${o.business},'Service',30,12.34567)`;
  await database.sql`insert into business_calendars values(${o.business},${database.sql.json(full)})`;
  for (const resource of o.resources) {
    await database.sql`insert into resources(id,business_id,name,weekly_schedule) values(${resource},${o.business},${resource},${database.sql.json(full)})`;
    await database.sql`insert into resource_services values(${o.business},${resource},${o.service})`;
  }
  return o;
};
const book = (o: Owner, startRaw: string, resourceId = o.resources[0]!) => pools.api.run(context(o), repo => repo.createAppointment(o.business,
  { serviceId: o.service, resourceId, clientId: o.client, startRaw }, { now: "2000-01-01T00:00:00Z", origin: "manual" }));
beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: "https://panel.agendia.test" });
  phc = await hash("correct horse battery staple", { algorithm: Algorithm.Argon2id });
}, 120_000);
afterAll(async () => { await app?.close(); await pools?.end(); await database?.stop(); });

test("static GET returns all advisory choices, exact D2 JSON and no business effects", async () => {
  const o = await fixture(), before = await effects();
  const [session] = await database.sql`select last_seen_at from web_sessions where identity_id=${o.actor}`;
  const response = await get(o);
  expect(response.statusCode).toBe(200);
  const slots = response.json<Slot[]>();
  expect(slots).toEqual(await pools.api.run(context(o), repo => repo.listAppointmentAvailability(o.business, { serviceId: o.service, date })));
  expect(slots).toHaveLength(192);
  expect(new Set(slots.map(s => s.resourceId))).toEqual(new Set(o.resources));
  for (const s of slots) {
    expect(s.startMs).toBe(parseInstantMs(s.start)!);
    expect(s.endMs).toBe(s.startMs + 30 * 60000);
    expect(s.terms).toEqual({ serviceId: o.service, serviceName: "Service", resourceId: s.resourceId, resourceName: s.resourceId, durationMinutes: 30, priceArs: 12.34567 });
  }
  const selected = (await get(o, { serviceId: o.service.toUpperCase(), resourceId: o.resources[1]!.toUpperCase() })).json<Slot[]>();
  expect(selected).toEqual(slots.filter(s => s.resourceId === o.resources[1]));
  expect(selected).toHaveLength(96);
  expect(selected.at(-1)!.start).toBe("2099-06-02T02:45:00.000Z");
  expect(selected.at(-1)!.endMs).toBe(parseInstantMs("2099-06-02T00:15:00-03:00")!);
  expect((await get(o, { date: "0001-01-01" })).json<Slot[]>()).toEqual([]);
  const boundary = await get(o, { date: "9999-12-31", resourceId: o.resources[0]! });
  expect(boundary.statusCode).toBe(200);
  expect(boundary.json<Slot[]>()).toEqual(await pools.api.run(context(o), repo => repo.listAppointmentAvailability(o.business, { serviceId: o.service, date: "9999-12-31", resourceId: o.resources[0]! })));
  expect(await effects()).toEqual(before);
  const [after] = await database.sql`select last_seen_at from web_sessions where identity_id=${o.actor}`;
  expect(after!.last_seen_at.getTime()).toBeGreaterThan(session!.last_seen_at.getTime());
});

test("Confirmed numeric capacity, cancellation, adjacency, pauses and closures cover whole intervals", async () => {
  const o = await fixture(), resourceId = o.resources[0]!, saved = await book(o, `${date}T10:00:00-03:00`);
  await database.sql`update appointments set start_raw='2001-01-01T00:00:00Z' where id=${saved.id}`;
  const slots = (await get(o, { resourceId })).json<Slot[]>();
  expect(slots.some(s => s.startMs === saved.startMs - 30 * 60000)).toBe(true);
  expect(slots.some(s => s.startMs === saved.startMs + 30 * 60000)).toBe(true);
  expect(slots.some(s => s.startMs === saved.startMs || s.startMs === saved.startMs - 15 * 60000)).toBe(false);
  await database.sql`update appointments set state='cancelled' where id=${saved.id}`;
  expect((await get(o, { resourceId })).json<Slot[]>()).toHaveLength(96);
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const hours = { [day]: [{ startMinute: 600, endMinute: 615 }, { startMinute: 630, endMinute: 660 }] };
  await database.sql`update resources set weekly_schedule=${database.sql.json(hours)} where id=${resourceId}`;
  expect((await get(o, { resourceId })).json<Slot[]>().map(s => s.start)).toEqual(["2099-06-01T13:30:00.000Z"]);
  await database.sql`insert into business_calendar_closures(business_id,kind,start_raw,end_raw,start_ms,end_ms)
    values(${o.business},'interval',${`${date}T10:45:00-03:00`},${`${date}T11:00:00-03:00`},${saved.startMs + 45 * 60000},${saved.startMs + hour})`;
  expect((await get(o, { resourceId })).json<Slot[]>()).toEqual([]);
});

test("server clock enforces new lead while owned upcoming reschedule keeps agreed terms and only excludes self", async () => {
  const o = await fixture(), beforeNow = Date.now();
  const today = new Date(beforeNow - 3 * hour).toISOString().slice(0, 10);
  const fresh = await get(o, { date: today });
  expect(fresh.statusCode).toBe(200);
  expect(fresh.json<Slot[]>().every(s => s.startMs >= beforeNow + hour)).toBe(true);
  const startMs = Math.ceil((Date.now() + 15 * 60000) / (15 * 60000)) * (15 * 60000);
  const raw = new Date(startMs - 3 * hour).toISOString().replace(".000Z", "-03:00");
  const saved = await book(o, raw), other = await book(o, raw, o.resources[1]!);
  await database.sql`update appointments set notes='Historical note',customer_resource_preference_id=${o.resources[1]!} where id=${saved.id}`;
  await database.sql`update services set name='Changed',duration_minutes=60,price_ars=999 where id=${o.service}`;
  await database.sql`update resources set name='Changed resource' where id=${o.resources[0]!}`;
  const before = await effects(), query = { date: raw.slice(0, 10), appointmentId: saved.id.toUpperCase() };
  const response = await get(o, query);
  expect(response.statusCode).toBe(200);
  const slots = response.json<Slot[]>(), original = slots.find(s => s.startMs === startMs)!;
  expect(original).toEqual({ start: saved.startsAt, startMs, endMs: saved.endMs, resourceId: saved.terms.resourceId, terms: saved.terms });
  expect(slots.some(s => s.startMs === startMs && s.resourceId === other.terms.resourceId)).toBe(false);
  expect(slots.every(s => s.startMs === startMs || s.startMs >= beforeNow + hour)).toBe(true);
  expect((await get(o, { date: query.date })).json<Slot[]>().some(s => s.startMs === startMs)).toBe(false);
  expect(await effects()).toEqual(before);
  const changed = randomUUID();
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${changed},${o.business},'New service',15,77)`;
  await database.sql`insert into resource_services values(${o.business},${o.resources[0]!},${changed})`;
  const different = await get(o, { ...query, serviceId: changed, date });
  expect(different.statusCode).toBe(200);
  expect(different.json<Slot[]>()[0]!.terms).toEqual({ serviceId: changed, serviceName: "New service", resourceId: o.resources[0]!, resourceName: saved.terms.resourceName, durationMinutes: 15, priceArs: 77 });
  expect((await app.inject({ method: "GET", url: `/me/appointments/${saved.id}`, headers: { cookie: o.cookie } })).statusCode).toBe(200);
});

test("strict queries and body reject hostile authority, tenant ownership and locked context map safely", async () => {
  const o = await fixture(), foreign = await fixture(), admin = await fixture(true);
  const saved = await book(o, `${date}T10:00:00-03:00`), foreignSaved = await book(foreign, `${date}T10:00:00-03:00`);
  const before = await effects();
  expect((await get()).statusCode).toBe(401); expect((await get(admin)).statusCode).toBe(403);
  for (const query of [{ serviceId: foreign.service }, { resourceId: foreign.resources[0]! }, { appointmentId: foreignSaved.id }, { appointmentId: randomUUID() }, { serviceId: randomUUID() }]) {
    const response = await get(o, query);
    expect(response.statusCode).toBe(404); expect(response.json().code).toBe("NOT_FOUND");
  }
  for (const query of [{ serviceId: "bad" }, { resourceId: "bad" }, { appointmentId: "bad" }, { date: "0000-01-01" }, { date: "2099-02-30" }, { date: "10000-01-01" }, ...["now", "clock", "role", "businessId", "force", "priceArs", "durationMinutes", "start", "customerResourceExpression", "excludeAppointmentId"].map(key => ({ [key]: "hostile" }))])
    expect((await get(o, query)).statusCode).toBe(400);
  const body = await app.inject({ method: "GET", url: `/me/appointments/availability?serviceId=${o.service}&date=${date}`, headers: { cookie: o.cookie }, payload: { appointmentId: saved.id, clock: "2000-01-01", role: "customer" } });
  expect(body.statusCode).toBe(400);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
    expect((await app.inject({ method, url: "/me/appointments/availability", headers: { cookie: o.cookie } })).statusCode).toBe(404);
  expect(await effects()).toEqual(before);
  await database.sql`update appointments set state='done' where id=${saved.id}`;
  expect((await get(o, { appointmentId: saved.id })).statusCode).toBe(409);
  await database.sql`update appointments set state='confirmed',start_raw='2001-01-01T00:00:00Z',start_ms=${parseInstantMs("2001-01-01T00:00:00Z")!},end_ms=${parseInstantMs("2001-01-01T00:30:00Z")!} where id=${saved.id}`;
  expect((await get(o, { appointmentId: saved.id })).statusCode).toBe(409);
  await database.sql`update resources set status='suspended' where id=${o.resources[0]!}`;
  expect((await get(o, { resourceId: o.resources[0]! })).json<Slot[]>()).toEqual([]);
  const unassigned = randomUUID();
  await database.sql`insert into resources(id,business_id,name,weekly_schedule) values(${unassigned},${o.business},'Unassigned',${database.sql.json(full)})`;
  expect((await get(o, { resourceId: unassigned })).json<Slot[]>()).toEqual([]);
  await database.sql`update resources set deleted_at=now() where id=${o.resources[1]!}`;
  expect((await get(o, { resourceId: o.resources[1]! })).statusCode).toBe(404);
  await database.sql`update services set status='suspended' where id=${o.service}`;
  expect((await get(o)).json<Slot[]>()).toEqual([]);
  await database.sql`update services set deleted_at=now() where id=${o.service}`;
  expect((await get(o)).statusCode).toBe(404);
  const history = await app.inject({ method: "GET", url: `/me/appointments/${saved.id}`, headers: { cookie: o.cookie } });
  expect(history.statusCode).toBe(200); expect(history.json().terms).toEqual(saved.terms);
});

test("physical SQL failure is generic and inquiry has no effects", async () => {
  const o = await fixture(), before = await effects();
  await database.sql`revoke select on appointments from agendia_runtime`;
  try {
    const response = await get(o);
    expect(response.statusCode).toBe(500); expect(response.json().code).toBe("INTERNAL_ERROR");
    expect(response.body).not.toMatch(/permission|postgres|select |42501|appointments_/i);
    expect(await effects()).toEqual(before);
  } finally { await database.sql`grant select on appointments to agendia_runtime`; }
});
