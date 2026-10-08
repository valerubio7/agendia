import { afterAll, beforeAll, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { parseInstantMs } from "@agendia/domain";
import { AppointmentRecordSchema, type AppointmentRecord } from "@agendia/contracts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

let database: TestPostgres, pools: ReturnType<typeof createRuntimePools>, app: ReturnType<typeof buildApi>;
type Owner = { businessId: string; actorId: string; cookie: string; client: string; service: string; resource: string; ids: string[] };
let a: Owner, b: Owner, admin: Owner;
const from = "2026-06-01T00:00:00-03:00", to = "2026-06-02T00:00:00-03:00";
const get = (url = "/me/appointments", owner?: Owner) => app.inject({ method: "GET", url, headers: owner ? { cookie: owner.cookie } : {} });
const context = (owner: Owner) => tenantContext({ businessId: owner.businessId, actorId: owner.actorId, role: "business_user", requestId: randomUUID() });
const effects = async () => ({
  appointments: await database.sql`select * from appointments order by id`,
  clients: await database.sql`select * from clients order by id`,
  services: await database.sql`select * from services order by id`,
  resources: await database.sql`select * from resources order by id`,
  audit: await database.sql`select * from audit_events order by id`,
  outbox: await database.sql`select * from outbox_events order by id`,
  outbound: await database.sql`select * from outbound_commands order by outbound_id`,
  whatsapp: await database.sql`select * from whatsapp_connections order by business_id`,
  messages: await database.sql`select * from messages order by id`,
});
beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: "https://panel.agendia.test" });
  const phc = await hash("correct horse battery staple", { algorithm: Algorithm.Argon2id });
  const fixture = async (email: string, platform = false): Promise<Owner> => {
    const owner: Owner = { businessId: randomUUID(), actorId: randomUUID(), cookie: "", client: randomUUID(), service: randomUUID(), resource: randomUUID(), ids: [] };
    if (!platform) await database.sql`insert into businesses(id,name) values(${owner.businessId},'Read fixture')`;
    await database.sql`insert into auth_identities(id,normalized_email,password_phc,role,business_id) values(${owner.actorId},${email},${phc},${platform ? "platform_admin" : "business_user"},${platform ? null : owner.businessId})`;
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery staple" }, headers: { origin: "https://panel.agendia.test" } });
    expect(login.statusCode).toBe(200);
    const cookies = login.headers["set-cookie"]!;
    owner.cookie = (Array.isArray(cookies) ? cookies[0]! : cookies).split(";")[0]!;
    if (platform) return owner;
    await database.sql`insert into clients(id,business_id,first_name,last_name,phone) values(${owner.client},${owner.businessId},'Same','Name','+5491123456789')`;
    await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${owner.service},${owner.businessId},'Original service',15,0)`;
    await database.sql`insert into resources(id,business_id,name,weekly_schedule) values(${owner.resource},${owner.businessId},'Original resource','{}'::jsonb)`;
    for (const [i, state] of ["done", "cancelled", "confirmed", "no_show", "done", "done"].entries()) {
      const raw = ["2026-05-31T23:59:59.999-03:00", from, "2026-06-01T01:00:00-03:00", "2026-06-01T02:00:00-03:00", to, to][i]!;
      const id = randomUUID(), ms = parseInstantMs(raw)!;
      owner.ids.push(id);
      await database.sql`insert into appointments(id,business_id,client_id,service_id,resource_id,service_label,resource_label,duration_minutes,price_ars,start_raw,start_ms,end_ms,state,origin,notes,customer_resource_preference_id)
        values(${id},${owner.businessId},${owner.client},${owner.service},${owner.resource},'Frozen service','Frozen resource',15,${i ? 12.34567 : 0},${raw},${ms},${ms + 900000},${state},${i % 2 ? "ai" : "manual"},${i % 2 ? "History note" : null},${i % 2 ? owner.resource : null})`;
    }
    await database.sql`update clients set first_name='Renamed',phone='+5491198765432' where id=${owner.client}`;
    await database.sql`update services set name='Renamed service',price_ars=999,duration_minutes=30,deleted_at=now() where id=${owner.service}`;
    await database.sql`update resources set name='Renamed resource',deleted_at=now() where id=${owner.resource}`;
    return owner;
  };
  a = await fixture("reads-a@example.test"); b = await fixture("reads-b@example.test"); admin = await fixture("reads-admin@example.test", true);
}, 120_000);
afterAll(async () => { await app?.close(); await pools?.end(); await database?.stop(); });

test("business reads return all history, current client and frozen terms without effects or Origin/CSRF", async () => {
  const otherClient = randomUUID();
  await database.sql`insert into clients(id,business_id,first_name,last_name,phone) values(${otherClient},${a.businessId},'Renamed','Name','+5491111111111')`;
  const before = await effects();
  const [sessionBefore] = await database.sql`select last_seen_at from web_sessions where identity_id=${a.actorId}`;
  const expected = await pools.api.run(context(a), repo => repo.listAppointments(a.businessId));
  const response = await get(undefined, a);
  expect(response.statusCode).toBe(200);
  expect(response.json<AppointmentRecord[]>()).toEqual(expected);
  expect(expected).toHaveLength(6);
  expect(new Set(expected.map(row => row.state))).toEqual(new Set(["confirmed", "done", "cancelled", "no_show"]));
  expect(new Set(expected.map(row => row.origin))).toEqual(new Set(["manual", "ai"]));
  for (const row of expected) {
    expect(AppointmentRecordSchema.parse(row)).toEqual(row);
    expect(row.client).toEqual({ id: a.client, firstName: "Renamed", lastName: "Name", phone: "+5491198765432" });
    expect(row.terms).toEqual({ serviceId: a.service, resourceId: a.resource, serviceName: "Frozen service", resourceName: "Frozen resource", durationMinutes: 15, priceArs: row.id === a.ids[0] ? 0 : 12.34567 });
    const detail = await get(`/me/appointments/${row.id.toUpperCase()}`, a);
    expect(detail.statusCode).toBe(200); expect(detail.json<AppointmentRecord>()).toEqual(row);
  }
  expect(expected.filter(row => row.startMs === parseInstantMs(to)).map(row => row.id)).toEqual(a.ids.slice(4).sort());
  expect((await get(`/me/appointments?clientId=${a.client}`, a)).json<AppointmentRecord[]>()).toEqual(expected);
  for (const id of [b.client, randomUUID(), otherClient])
    expect((await get(`/me/appointments?clientId=${id}`, a)).json<AppointmentRecord[]>()).toEqual([]);
  const bodyRead = await app.inject({ method: "GET", url: "/me/appointments", headers: { cookie: a.cookie }, payload: { businessId: b.businessId, role: "platform_admin", clock: to, force: true } });
  expect(bodyRead.statusCode).toBe(200); expect(bodyRead.json<AppointmentRecord[]>()).toEqual(expected);
  expect(await effects()).toEqual(before);
  const [sessionAfter] = await database.sql`select last_seen_at from web_sessions where identity_id=${a.actorId}`;
  expect(sessionAfter!.last_seen_at.getTime()).toBeGreaterThan(sessionBefore!.last_seen_at.getTime());
});

test("explicit Argentina midnight bounds use inclusive/exclusive epochs, not a UTC calendar shortcut", async () => {
  const query = new URLSearchParams({ from, to });
  const response = await get(`/me/appointments?${query}`, a);
  expect(response.statusCode).toBe(200);
  const rows = response.json();
  expect(rows.map((row: { id: string }) => row.id)).toEqual(a.ids.slice(1, 4));
  expect((await get(`/me/appointments?${new URLSearchParams({ to: from })}`, a)).json().map((row: { id: string }) => row.id)).toEqual([a.ids[0]]);
  expect((await get(`/me/appointments?${new URLSearchParams({ from: to })}`, a)).json()).toHaveLength(2);
  expect((await get(`/me/appointments?${new URLSearchParams({ from: "2026-06-01T00:00:00Z", to: from })}`, a)).json().map((row: { id: string }) => row.id)).toEqual([a.ids[0]]);
});

test("tenant sessions isolate same-name identities and reject authority/filter injection safely", async () => {
  const before = await effects();
  for (const url of ["/me/appointments", `/me/appointments/${a.ids[0]}`]) {
    expect((await get(url)).statusCode).toBe(401); expect((await get(url, admin)).statusCode).toBe(403);
  }
  expect((await get(undefined, b)).json<AppointmentRecord[]>()).toEqual(await pools.api.run(context(b), repo => repo.listAppointments(b.businessId)));
  for (const id of [b.ids[0], randomUUID()]) {
    const response = await get(`/me/appointments/${id}`, a);
    expect(response.statusCode).toBe(404); expect(response.json().code).toBe("NOT_FOUND");
  }
  for (const query of ["clientId=bad", "clientId=%00", "from=2026-06-01", "from=2026-02-30T00%3A00%3A00Z", "from=%00", "from=2026-06-02T00%3A00%3A00Z&to=2026-06-01T00%3A00%3A00Z", "from=2026-06-01T00%3A00%3A00Z&to=2026-06-01T00%3A00%3A00Z", "clock=1", `businessId=${b.businessId}`, "role=platform_admin", "force=true", "state=confirmed", "resourceId=bad", "clientId=Same"]) {
    const response = await get(`/me/appointments?${query}`, a);
    expect(response.statusCode).toBe(400); expect(response.json().code).toBe("VALIDATION_FAILED");
    expect(response.body).not.toMatch(/postgres|select |SQLSTATE|appointments_/i);
  }
  expect((await get("/me/appointments/not-a-uuid", a)).statusCode).toBe(400);
  expect((await get(`/me/appointments/${a.ids[0]}?role=customer`, a)).statusCode).toBe(400);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
    expect((await app.inject({ method, url: `/me/appointments/${a.ids[0]}`, headers: { cookie: a.cookie }, payload: { state: "cancelled", businessId: b.businessId } })).statusCode).toBe(404);
  expect(await effects()).toEqual(before);
  expect(await pools.api.run(undefined, repo => repo.listAppointments(a.businessId))).toEqual([]);
});

test("read SQL failures use generic safe errors without business mutation", async () => {
  const before = await effects();
  await database.sql`revoke select on appointments from agendia_runtime`;
  try {
    for (const url of ["/me/appointments", `/me/appointments/${a.ids[0]}`]) {
      const response = await get(url, a);
      expect(response.statusCode).toBe(500); expect(response.json().code).toBe("INTERNAL_ERROR");
      expect(response.body).not.toMatch(/permission|postgres|select |42501|appointments_/i);
    }
    expect(await effects()).toEqual(before);
  } finally { await database.sql`grant select on appointments to agendia_runtime`; }
});
