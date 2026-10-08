import { afterAll, beforeAll, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { isResourceEligibleForService, isResourceScheduleWithinBusiness } from "@agendia/domain";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

const ORIGIN = "https://panel.agendia.test", url = "/me/resources";
let database: TestPostgres, pools: ReturnType<typeof createRuntimePools>, app: ReturnType<typeof buildApi>;
type Auth = { cookie: string; csrf: string; businessId: string; actorId: string };
let a: Auth, b: Auth, admin: Auth;
const input = { name: "Resource", serviceIds: [] as string[], weeklySchedule: {} };
const request = (method: "GET" | "POST" | "PUT" | "DELETE", path = url, auth?: Auth, body?: object, origin = ORIGIN, csrf = auth?.csrf) =>
  app.inject({ method, url: path, ...(body ? { payload: body } : {}), headers: {
    origin, ...(auth ? { cookie: auth.cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}),
  } });
const effects = async () => (await database.sql`select
  (select count(*)::int from resources) resources,
  (select count(*)::int from resource_services) assignments,
  (select count(*)::int from audit_events where event_type like 'resource.%' or event_type='business_calendar.updated') audit,
  (select count(*)::int from outbox_events where topic like 'resource.%' or topic='business_calendar.updated') outbox,
  (select count(*)::int from messages) messages,
  (select count(*)::int from outbox_events where topic like 'ai.%' or topic like 'whatsapp.%') replies`)[0]!;
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
    const res = await request("POST", "/auth/login", undefined, { email, password });
    expect(res.statusCode).toBe(200);
    const cookies = res.headers["set-cookie"]!;
    return { businessId, actorId, cookie: (Array.isArray(cookies) ? cookies[0]! : cookies).split(";")[0]!, csrf: res.json().csrfToken };
  };
  a = await fixture("resource-a@example.test"); b = await fixture("resource-b@example.test");
  admin = await fixture("resource-admin@example.test", true);
}, 120_000);
afterAll(async () => { await app?.close(); await pools?.end(); await database?.stop(); });

test("resource HTTP catalog scopes identity, canonical assignments, stable edits and lifecycle", async () => {
  expect((await request("GET", url, a)).json<unknown>()).toEqual([]);
  const service = (await request("POST", "/me/services", a, { name: "Owned", durationMinutes: 15, priceArs: 0 })).json();
  await request("PUT", `/me/services/${service.id}/status`, a, { status: "suspended" });
  const created = await request("POST", url, a, { ...input, name: " \tResource\ufeff", serviceIds: [service.id.toUpperCase(),service.id], businessId: b.businessId, actorId: b.actorId });
  expect(created.statusCode).toBe(201);
  const resource = created.json();
  expect(resource).toEqual({ ...input, name: "Resource", id: expect.any(String), description: null, status: "active", serviceIds: [service.id] });
  expect((await request("GET", url, b)).json<unknown>()).toEqual([]);
  expect(isResourceEligibleForService(resource,{ ...service,status: "suspended" })).toBe(false);
  expect(isResourceEligibleForService(resource,service)).toBe(true);
  for (const status of ["suspended","active"]) {
    const changed = await request("PUT", `${url}/${resource.id}/status`, a, { status });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ id: resource.id,status });
    expect(isResourceEligibleForService(changed.json(),service)).toBe(status === "active");
  }
  const edited = await request("PUT", `${url}/${resource.id}`, a, {
    ...input,name: "Edited",description: "Details",businessId: b.businessId,actorId: b.actorId,
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json()).toMatchObject({ id: resource.id,serviceIds: [],weeklySchedule: {},description: "Details" });
  expect((await request("GET", url, a)).json()).toContainEqual(edited.json());
  expect(await effects()).toEqual({ resources: 1,assignments: 0,audit: 4,outbox: 4,messages: 0,replies: 0 });
  expect((await database.sql`select actor_id from audit_events where event_type='resource.created'`)[0]?.actor_id).toBe(a.actorId);
});

test("resource routes enforce authentication, Origin/CSRF, valid fields/JSON and owned UUIDs", async () => {
  const foreign = (await request("POST", url, b, { ...input,name: "Foreign" })).json();
  const foreignService = (await request("POST", "/me/services", b, { name: "Foreign service",durationMinutes: 15,priceArs: 0 })).json();
  const own = (await request("GET",url,a)).json()[0];
  const before = await effects();
  for (const [method,path] of [["GET",url],["POST",url],["PUT",`${url}/${foreign.id}`],["PUT",`${url}/${foreign.id}/status`]] as const) {
    expect((await request(method,path,undefined,input)).statusCode).toBe(401);
    expect((await request(method,path,admin,input)).statusCode).toBe(403);
    if (method !== "GET") {
      expect((await request(method,path,a,input,"https://evil.test")).statusCode).toBe(403);
      for (const csrf of ["","wrong"]) expect((await request(method,path,a,input,ORIGIN,csrf)).statusCode).toBe(403);
    }
  }
  for (const invalid of [{ name: " " },{ description: null },{ serviceIds: "bad" },{ serviceIds: ["bad"] },
    { serviceIds: [foreignService.id] },{ serviceIds: [randomUUID()] },{ weeklySchedule: null },{ weeklySchedule: { 7: [] } }]) {
    expect((await request("POST",url,a,{ ...input,...invalid })).statusCode).toBe(400);
    expect((await request("PUT",`${url}/${own.id}`,a,{ ...input,...invalid })).statusCode).toBe(400);
  }
  for (const path of [url,`${url}/${own.id}`,`${url}/${own.id}/status`])
    for (const payload of ["{","null"]) expect((await app.inject({ method: path === url ? "POST" : "PUT",url: path,payload,headers: {
      origin: ORIGIN,cookie: a.cookie,"x-csrf-token": a.csrf,"content-type": "application/json",
    } })).statusCode).toBe(400);
  for (const body of [{},{ name: "Missing hours",serviceIds: [] },{ name: "Missing services",weeklySchedule: {} }])
    expect((await request("POST",url,a,body)).statusCode).toBe(400);
  for (const id of [foreign.id,randomUUID()]) {
    expect((await request("PUT",`${url}/${id}`,a,input)).statusCode).toBe(404);
    expect((await request("PUT",`${url}/${id}/status`,a,{ status: "suspended" })).statusCode).toBe(404);
  }
  for (const suffix of ["","/status"]) expect((await request("PUT",`${url}/bad${suffix}`,a,input)).statusCode).toBe(400);
  expect((await request("PUT",`${url}/${foreign.id}/status`,b,{ status: "deleted" })).statusCode).toBe(400);
  expect((await request("DELETE",`${url}/${foreign.id}`,b)).statusCode).toBe(404);
  expect(await effects()).toEqual(before);
});

test("uncapped Unicode names use case/outer trim only, arbitrate duplicates and safely reject NUL", async () => {
  const longName = Array.from({ length: 100 },(_,i) => createHash("sha256").update(String(i)).digest("hex")).join("").replace(/[a-f]/g,c => String.fromCharCode(c.charCodeAt(0) + 128));
  expect(longName.length).toBe(6400);
  for (const name of ["École","A  B",longName]) {
    const created = await request("POST",url,a,{ ...input,name,description: longName });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name,description: longName });
    expect((await request("POST",url,a,{ ...input,name: "\t" + name.toUpperCase() + "\u00a0\ufeff" })).statusCode).toBe(409);
    expect((await request("POST",url,b,{ ...input,name })).statusCode).toBe(201);
    if (name === longName) {
      const edited = await request("PUT",`${url}/${created.json().id}`,a,{ ...input,name: name + "尾",description: longName });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({ id: created.json().id,name: name + "尾" });
      expect((await request("GET",url,a)).json()).toContainEqual(edited.json());
    }
  }
  for (const name of ["Ecole","A B"]) expect((await request("POST",url,a,{ ...input,name })).statusCode).toBe(201);
  const race = await Promise.all([" Race ","rAcE"].map(name => request("POST",url,a,{ ...input,name })));
  expect(race.map(r => r.statusCode).sort()).toEqual([201,409]);
  const winner = race.find(r => r.statusCode === 201)!.json();
  const before = await effects();
  for (const body of [{ name: "NUL\0" },{ description: "NUL\0" }]) {
    expect((await request("POST",url,a,{ ...input,...body })).statusCode).toBe(400);
    expect((await request("PUT",`${url}/${winner.id}`,a,{ ...input,...body })).statusCode).toBe(400);
  }
  const conflict = await request("PUT",`${url}/${winner.id}`,a,{ ...input,name: "école" });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.body).not.toMatch(/23505|resources_|postgres|duplicate key/i);
  expect((await request("GET",url,a)).json()).toContainEqual(winner);
  expect(await effects()).toEqual(before);
});

test("resource assignments have no arbitrary catalog count cap", async () => {
  const ids = Array.from({ length: 101 },() => randomUUID());
  await database.sql`insert into services ${database.sql(ids.map((id,i) => ({
    id,business_id: a.businessId,name: `Many service ${i}`,duration_minutes: 15,price_ars: 0,
  })))}`;
  const created = await request("POST",url,a,{ ...input,name: "Many assignments",serviceIds: ids });
  expect(created.statusCode).toBe(201);
  expect(created.json().serviceIds).toEqual(ids.sort());
});

test("HTTP hours preserve null/off, minute precision, overnight week union and reciprocal rejection", async () => {
  const before = await effects();
  expect((await request("POST",url,a,{ ...input,name: "Outside",weeklySchedule: { 1: [{startMinute: 1,endMinute: 2}] } })).statusCode).toBe(409);
  expect(await effects()).toEqual(before);
  const hours = { 6: [{startMinute: 1387,endMinute: 60}],0: [{startMinute: 60,endMinute: 121}],
    2: [{startMinute: 480,endMinute: 600},{startMinute: 660,endMinute: 720}] };
  expect((await request("PUT","/me/business-calendar",a,{ weeklySchedule: hours })).statusCode).toBe(200);
  const union = { 6: [{startMinute: 1387,endMinute: 121}] };
  const created = await request("POST",url,a,{ ...input,name: "Hours",weeklySchedule: union });
  expect(created.statusCode).toBe(201);
  const saved = created.json();
  await request("PUT",`${url}/${saved.id}/status`,a,{ status: "suspended" });
  const snapshot = await effects();
  for (const weeklySchedule of [{},{ ...hours,0: [{startMinute: 61,endMinute: 121}] }])
    expect((await request("PUT","/me/business-calendar",a,{ weeklySchedule })).statusCode).toBe(409);
  for (const weeklySchedule of [{ 0: [{startMinute: 0,endMinute: 122}] },{ 2: [{startMinute: 590,endMinute: 670}] }])
    expect((await request("PUT",`${url}/${saved.id}`,a,{ ...input,name: "Bad hours",weeklySchedule })).statusCode).toBe(409);
  expect((await request("GET",url,a)).json()).toContainEqual({ ...saved,status: "suspended" });
  expect((await request("GET","/me/business-calendar",a)).json<unknown>()).toEqual({ weeklySchedule: hours });
  expect(await effects()).toEqual(snapshot);
  expect((await request("PUT",`${url}/${saved.id}`,a,{ ...input,name: "Hours off" })).statusCode).toBe(200);
  expect((await request("PUT","/me/business-calendar",a,{ weeklySchedule: {} })).statusCode).toBe(200);
});

test("incompatible concurrent business/resource changes serialize to one consistent outcome", async () => {
  const opening = { 2: [{startMinute: 480,endMinute: 720}] };
  await request("PUT","/me/business-calendar",b,{ weeklySchedule: opening });
  const resource = (await request("POST",url,b,{ ...input,name: "Concurrent hours" })).json();
  const results = await Promise.all([
    request("PUT","/me/business-calendar",b,{ weeklySchedule: {} }),
    request("PUT",`${url}/${resource.id}`,b,{ ...input,name: resource.name,weeklySchedule: opening }),
  ]);
  expect(results.map(r => r.statusCode).sort()).toEqual([200,409]);
  const calendar = (await request("GET","/me/business-calendar",b)).json();
  const resources = (await request("GET",url,b)).json();
  expect(resources.every((r: {weeklySchedule: typeof opening}) => isResourceScheduleWithinBusiness(r.weeklySchedule,calendar.weeklySchedule))).toBe(true);
});

test("audit/outbox failures roll back resource, assignment, status and calendar without reply jobs", async () => {
  const service = (await request("POST","/me/services",a,{ name: "Rollback service",durationMinutes: 15,priceArs: 0 })).json();
  const resource = (await request("POST",url,a,{ ...input,name: "Rollback resource",serviceIds: [service.id] })).json();
  for (const [table,field] of [["audit_events","event_type"],["outbox_events","topic"]]) {
    const functionName = `reject_resource_${table}`;
    await database.sql.unsafe(`create function ${functionName}() returns trigger language plpgsql as $$
      begin if NEW.${field} like 'resource.%' or NEW.${field}='business_calendar.updated' then raise exception 'forced effect failure'; end if; return NEW; end $$`);
    await database.sql.unsafe(`create trigger reject_resource_effect before insert on ${table} for each row execute function ${functionName}()`);
    const before = await effects();
    for (const [path,body,method] of [[url,{ ...input,name: "Failed create",serviceIds: [service.id] },"POST"],
      [`${url}/${resource.id}`,{ ...input,name: "Failed edit" },"PUT"],
      [`${url}/${resource.id}/status`,{ status: "suspended" },"PUT"],
      ["/me/business-calendar",{ weeklySchedule: { 1: [] } },"PUT"]] as const) {
      const failed = await request(method,path,a,body);
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toMatch(/forced effect|postgres|sql/i);
      expect(await effects()).toEqual(before);
      expect((await request("GET",url,a)).json()).toContainEqual(resource);
      expect((await request("GET","/me/business-calendar",a)).json<unknown>()).toEqual({ weeklySchedule: {} });
    }
    await database.sql.unsafe(`create or replace function ${functionName}() returns trigger language plpgsql as $$ begin return NEW; end $$`);
  }
  expect((await effects()).messages).toBe(0);
  expect((await effects()).replies).toBe(0);
});

test("HTTP resource future conflicts return safe 409 and cannot be evaded by body clocks", async () => {
  const full = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
  expect((await request("PUT", "/me/business-calendar", a, { weeklySchedule: full })).statusCode).toBe(200);
  const service = (await request("POST", "/me/services", a, { name: "Future guard service", durationMinutes: 45, priceArs: 10 })).json();
  const client = (await request("POST", "/me/clients", a, { firstName: "Future", lastName: "Client", phone: "+5491123456785" })).json();
  const body = { name: "Future guard resource", serviceIds: [service.id], weeklySchedule: full };
  const created = await request("POST", url, a, body);
  expect(created.statusCode).toBe(201);
  const resource = created.json();
  const saved = await pools.api.run(tenantContext({ businessId: a.businessId, actorId: a.actorId, role: "business_user", requestId: randomUUID() }), repo =>
    repo.createAppointment(a.businessId, { serviceId: service.id, resourceId: resource.id, clientId: client.id, startRaw: "2099-06-01T10:00:00-03:00" }, { origin: "manual", now: "2099-01-01T00:00:00Z" }));
  const bookingBefore = (await database.sql`select * from appointments where id=${saved.id}`)[0];
  const counts = await effects();
  for (const extra of [{ weeklySchedule: {} }, { serviceIds: [] }]) {
    const failed = await request("PUT", `${url}/${resource.id}`, a, { ...body, ...extra, name: "Not saved", now: "2200-01-01T00:00:00Z" });
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toMatchObject({ code: "CONFLICT", message: "Resource change conflicts with future appointments" });
    expect(failed.body).not.toMatch(/postgres|sql|2099|Future guard service/i);
    expect((await request("GET", url, a)).json()).toContainEqual(resource);
    expect((await database.sql`select * from appointments where id=${saved.id}`)[0]).toEqual(bookingBefore);
    expect(await effects()).toEqual(counts);
  }
});
