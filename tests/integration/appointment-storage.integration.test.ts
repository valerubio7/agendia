import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { parseInstantMs, type WeeklySchedule, type AppointmentActionContext } from "@agendia/domain";
import { PostgresRepositories, RolePool, TenantUnitOfWork, tenantContext,
  type AppointmentCreationContext, type AppointmentChangeContext } from "@agendia/db";
import { applyPostgresMigrations, createRoleLogin, startTestPostgres, type TestPostgres } from "../support/index.ts";

let database: TestPostgres;
let runtime: Sql;
type Owner = { business: string; client: string; service: string; resource: string; alternate: string };
let a: Owner, b: Owner;
const start = parseInstantMs("2026-06-01T10:00:00-03:00")!;
const minutes = 60_000;
const fixture = async (): Promise<Owner> => {
  const owner = { business: randomUUID(), client: randomUUID(), service: randomUUID(), resource: randomUUID(), alternate: randomUUID() };
  await database.sql`insert into businesses(id,name) values(${owner.business},'Storage fixture')`;
  await database.sql`insert into clients(id,business_id,first_name,last_name,phone) values(${owner.client},${owner.business},'Current','Name','+5491123456789')`;
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${owner.service},${owner.business},'Current service',15,12.34567)`;
  for (const resource of [owner.resource, owner.alternate]) {
    await database.sql`insert into resources(id,business_id,name,weekly_schedule) values(${resource},${owner.business},${resource},'{}'::jsonb)`;
  }
  return owner;
};
const row = (owner = a, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), business_id: owner.business, client_id: owner.client,
  service_id: owner.service, resource_id: owner.resource,
  customer_resource_preference_id: null, service_label: "Frozen service", resource_label: "Frozen resource",
  price_ars: "12.34567", duration_minutes: 15, start_raw: "2026-06-01T10:00:00-03:00",
  start_ms: start, end_ms: start + 15 * minutes, state: "done", origin: "manual", notes: null,
  ...extra,
});
const insert = async (value = row(), sql = database.sql) => {
  const [saved] = await sql`insert into appointments ${sql(value)} returning *`;
  return saved!;
};
const code = async (work: Promise<unknown>, expected: string) => {
  await expect(Promise.resolve(work)).rejects.toMatchObject({ code: expected });
};
const tenant = <T>(business: string | undefined, work: (sql: Sql) => Promise<T>) => runtime.begin(async tx => {
  await tx`select set_config('app.tenant_id',${business ?? ""},true)`;
  return work(tx as unknown as Sql);
});

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  runtime = postgres(await createRoleLogin(database, "appointment_test", "agendia_runtime"));
  a = await fixture();
  b = await fixture();
}, 120_000);
afterAll(async () => { await runtime?.end(); await database?.stop(); });

test("appointment storage exists with generated stable UUID and owned composite uniqueness", async () => {
  const value = row();
  const { id: _id, ...withoutId } = value;
  const saved = await insert(withoutId as typeof value);
  expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(saved.created_at).toBeInstanceOf(Date);
  expect(saved.updated_at).toBeInstanceOf(Date);
  await code(insert(row(b, { id: saved.id })), "23505");
});

test("composite ownership and history references are enforced for privileged SQL too", async () => {
  for (const field of ["client_id", "service_id", "resource_id", "customer_resource_preference_id"]) {
    const foreign = field === "client_id" ? b.client : field === "service_id" ? b.service : b.resource;
    await code(insert(row(a, { [field]: foreign })), "23503");
  }
  await database.sql`update resources set status='suspended' where id=${a.alternate}`;
  const saved = await insert(row(a, { customer_resource_preference_id: a.alternate }));
  await database.sql`update appointments set resource_id=${a.alternate} where id=${saved.id}`;
  const [retained] = await database.sql`select customer_resource_preference_id from appointments where id=${saved.id}`;
  expect(retained!.customer_resource_preference_id).toBe(a.alternate);
  for (const [table, id] of [["clients", a.client], ["services", a.service], ["resources", a.resource], ["resources", a.alternate]]) {
    await code(database.sql.unsafe(`delete from ${table} where id=$1`, [id!]), "23503");
  }
});

test("catalog edits preserve frozen terms while client names remain current through stable ID", async () => {
  const saved = await insert(row());
  await database.sql`update clients set first_name='Renamed' where id=${a.client}`;
  await database.sql`update services set name='New service',price_ars=999,duration_minutes=30 where id=${a.service}`;
  await database.sql`update resources set name='New resource' where id=${a.resource}`;
  const [joined] = await database.sql`select ap.client_id,ap.service_label,ap.resource_label,ap.price_ars,ap.duration_minutes,c.first_name
    from appointments ap join clients c on (c.business_id,c.id)=(ap.business_id,ap.client_id) where ap.id=${saved.id}`;
  expect(joined).toEqual({ client_id: a.client, service_label: "Frozen service", resource_label: "Frozen resource", price_ars: "12.34567", duration_minutes: 15, first_name: "Renamed" });
});

test("SQL rejects primitive invalid fields without inventing catalog authority or caps", async () => {
  const invalid = [
    { state: "pending" }, { state: "Confirmed" }, { origin: "web" },
    ...["NaN", "Infinity", "-Infinity", "-0.01"].map(price_ars => ({ price_ars })),
    ...[0, -15, 16].map(duration_minutes => ({ duration_minutes })),
    { service_label: "" }, { resource_label: "" },
    { service_label: "\t\ufeff" }, { resource_label: "\u00a0 " },
    { start_ms: -62135683140001 }, { end_ms: 253402387140000 },
    { end_ms: start }, { end_ms: start - 1 }, { end_ms: start + 1 },
    { start_ms: "9223372036854775807", end_ms: "9223372036854775807" },
  ];
  for (const extra of invalid) await code(insert(row(a, extra)), "23514");
  for (const field of ["client_id", "service_id", "resource_id", "start_raw", "start_ms", "end_ms", "duration_minutes", "price_ars", "state", "origin", "service_label", "resource_label"]) {
    await code(insert(row(a, { [field]: null })), "23502");
  }
  await code(insert(row(a, { duration_minutes: "15.5" })), "22P02");
  const long = "漢é".repeat(5000);
  const saved = await insert(row(a, { service_label: long, resource_label: long, notes: long, price_ars: "0.1234567890123456789", duration_minutes: 2147483640, end_ms: start + 2147483640 * minutes, origin: "ai" }));
  expect(saved.notes).toBe(long);
  expect(saved.price_ars).toBe("0.1234567890123456789");
});

test("exact raw offsets and millisecond epochs round trip without PostgreSQL calendar parsing", async () => {
  for (const raw of ["0001-01-01T00:00:00+23:59", "2026-06-01T10:00:00.123000-03:00", "9999-12-31T22:00:00-01:00"]) {
    const epoch = parseInstantMs(raw)!;
    const saved = await insert(row(a, { start_raw: raw, start_ms: epoch, end_ms: epoch + 15 * minutes }));
    expect(saved.start_raw).toBe(raw);
    expect(Number(saved.start_ms)).toBe(epoch);
    expect(Number(saved.end_ms)).toBe(epoch + 15 * minutes);
  }
  // As for closures, SQL stores scalars; repository B must validate raw/epoch consistency.
  const saved = await insert(row(a, { start_ms: -62135683140000, end_ms: -62135683140000 + 15 * minutes }));
  expect(Number(saved.start_ms)).toBe(-62135683140000);
  await insert(row(a, { start_ms: 253402387139999 - 15 * minutes, end_ms: 253402387139999 }));
  await code(insert(row(a, { start_ms: 253402387139999, end_ms: 253402387139999 })), "23514");
});

test("runtime physical grants and forced tenant RLS prevent cross-business access", async () => {
  const own = await insert(row());
  const foreign = await insert(row(b));
  const [security] = await database.sql`select relrowsecurity enabled, relforcerowsecurity forced,
    has_table_privilege('agendia_runtime','appointments','SELECT') readable,
    has_table_privilege('agendia_runtime','appointments','INSERT') insertable,
    has_table_privilege('agendia_runtime','appointments','UPDATE') updatable,
    has_table_privilege('agendia_runtime','appointments','DELETE') deletable,
    has_table_privilege('agendia_runtime','appointments','TRUNCATE') truncatable
    from pg_class where oid='appointments'::regclass`;
  expect(security).toEqual({ enabled: true, forced: true, readable: true, insertable: true, updatable: true, deletable: false, truncatable: false });
  expect(await tenant(undefined, sql => sql`select * from appointments`)).toHaveLength(0);
  const visible = await tenant(a.business, sql => sql`select * from appointments`);
  expect(visible.every(item => item.business_id === a.business)).toBe(true);
  expect(visible.some(item => item.id === own.id)).toBe(true);
  await code(tenant(undefined, sql => insert(row(), sql)), "42501");
  await code(tenant(a.business, sql => insert(row(b), sql)), "42501");
  await code(tenant(a.business, sql => sql`update appointments set business_id=${b.business},client_id=${b.client},service_id=${b.service},resource_id=${b.resource} where id=${own.id}`), "42501");
  expect(await tenant(a.business, sql => sql`update appointments set notes='hidden' where id=${foreign.id} returning id`)).toHaveLength(0);
  const created = await tenant(a.business, sql => insert(row(), sql));
  const edited = await tenant(a.business, sql => sql`update appointments set notes='edited' where id=${created.id} returning id,notes`);
  expect([...edited]).toEqual([{ id: created.id, notes: "edited" }]);
  await code(tenant(a.business, sql => sql`delete from appointments where id=${own.id}`), "42501");
  await code(tenant(a.business, sql => sql`truncate appointments`), "42501");
});

test("half-open confirmed capacity covers insert/update and all nonoccupying final states", async () => {
  const base = start + 100 * minutes;
  const confirmed = await insert(row(a, { state: "confirmed", start_ms: base, end_ms: base + 15 * minutes }));
  const overlap = { state: "confirmed", start_ms: base + minutes, end_ms: base + 16 * minutes };
  await code(insert(row(a, overlap)), "23P01");
  const adjacent = await insert(row(a, { state: "confirmed", start_ms: base + 15 * minutes, end_ms: base + 30 * minutes }));
  await code(database.sql`update appointments set start_ms=${base + minutes},end_ms=${base + 16 * minutes} where id=${adjacent.id}`, "23P01");
  await insert(row(a, { ...overlap, resource_id: a.alternate }));
  await insert(row(b, overlap));
  for (const state of ["done", "cancelled", "no_show"]) {
    const terminal = await insert(row(a, { ...overlap, state }));
    await code(database.sql`update appointments set state='confirmed' where id=${terminal.id}`, "23P01");
  }
  await database.sql`update appointments set state='cancelled' where id=${confirmed.id}`;
  const replacement = await insert(row(a, { state: "confirmed", start_ms: base, end_ms: base + 15 * minutes }));
  await code(database.sql`update appointments set state='confirmed' where id=${confirmed.id}`, "23P01");
  await code(database.sql`update appointments set resource_id=${a.alternate} where id=${replacement.id}`, "23P01");
});

test("native GiST exclusion blocks concurrent raw SQL and releases final-state occupancy", async () => {
  const [extension] = await database.sql`select extversion from pg_extension where extname='btree_gist'`;
  expect(extension!.extversion).toBe("1.7");
  const base = start + 300 * minutes;
  const winnerRow = row(a, { state: "confirmed", start_ms: base, end_ms: base + 15 * minutes });
  let release!: () => void;
  let held!: () => void;
  const ready = new Promise<void>(resolve => { held = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const winner = database.sql.begin(async tx => {
    await insert(winnerRow, tx as unknown as Sql);
    held();
    await gate;
  });
  await ready;
  let pid!: number;
  let launched!: () => void;
  const launchedPromise = new Promise<void>(resolve => { launched = resolve; });
  const loser = database.sql.begin(async tx => {
    const [backend] = await tx`select pg_backend_pid() pid`;
    pid = backend!.pid;
    launched();
    await insert(row(a, { ...winnerRow, id: randomUUID() }), tx as unknown as Sql);
  }).then(() => "unexpected success", error => error.code);
  try {
    await launchedPromise;
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const [activity] = await database.sql`select wait_event_type from pg_stat_activity where pid=${pid}`;
      blocked = activity?.wait_event_type === "Lock";
      if (!blocked) await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
  } finally {
    release();
    await winner;
  }
  expect(await loser).toBe("23P01");
  await database.sql`update appointments set state='no_show' where id=${winnerRow.id}`;
  await insert(row(a, { ...winnerRow, id: randomUUID() }));
  await code(insert(row(a, { ...winnerRow, id: randomUUID() })), "23P01");
});

// Typed caller facts in these tests are not production sender/authorization proof.
const now = "2026-06-01T09:00:00-03:00";
const full: WeeklySchedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
const clientInput = { firstName: " New ", lastName: " Client ", phone: "11 3456 7890" };
const context = (owner: Owner) => tenantContext({ businessId: owner.business, actorId: "storage-caller", role: "business_user", requestId: randomUUID() });
const command = (owner: Owner, extra: Record<string, unknown> = {}) => ({ serviceId: owner.service, resourceId: owner.resource,
  startRaw: "2026-06-01T10:00:00-03:00", clientId: owner.client, ...extra });
const effects = async (owner: Owner) => {
  const [counts] = await database.sql`select
    (select count(*)::int from clients where business_id=${owner.business}) clients,
    (select count(*)::int from appointments where business_id=${owner.business}) appointments,
    (select count(*)::int from audit_events where business_id=${owner.business}) audit,
    (select count(*)::int from outbox_events where business_id=${owner.business}) outbox`;
  return counts!;
};
const readyOwner = async () => {
  const owner = await fixture();
  await database.sql`insert into business_calendars values(${owner.business},${database.sql.json(full)})`;
  await database.sql`update resources set weekly_schedule=${database.sql.json(full)} where business_id=${owner.business}`;
  for (const resource of [owner.resource, owner.alternate])
    await database.sql`insert into resource_services values(${owner.business},${resource},${owner.service})`;
  return owner;
};
const availability = (owner: Owner, input: unknown = { serviceId: owner.service, date: "2026-06-01" },
  trusted: { appointmentId?: string; clock?: () => string } = { clock: () => now }) =>
  new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.listAppointmentAvailability(owner.business, input, trusted));

test("availability returns all resource choices without effects and offers persistable advisory slots", async () => {
  const owner = await readyOwner(), before = await effects(owner);
  const choices = await availability(owner);
  expect(choices).toHaveLength(112);
  expect(new Set(choices.map(choice => choice.resourceId))).toEqual(new Set([owner.resource, owner.alternate]));
  expect(choices[0]).toMatchObject({ startMs: start, endMs: start + 15 * minutes, terms: { durationMinutes: 15, priceArs: 12.34567 } });
  expect(await effects(owner)).toEqual(before);
  const offer = choices[0]!;
  await book(owner, command(owner, { resourceId: offer.resourceId, startRaw: offer.start }));
  await rejected(owner, command(owner, { resourceId: offer.resourceId, startRaw: offer.start, newClient: clientInput, clientId: undefined }), "BUSY");
});

test("availability rejects hostile body fields before clock and resolves only owned live IDs", async () => {
  const owner = await readyOwner(), foreign = await readyOwner(), before = await effects(owner);
  let calls = 0;
  const trusted = { clock: () => { calls++; return now; } };
  for (const field of ["priceArs", "durationMinutes", "start", "now", "role", "businessId", "appointmentId", "excludeAppointmentId"])
    await code(availability(owner, { serviceId: owner.service, date: "2026-06-01", [field]: foreign.resource }, trusted), "INVALID_INPUT");
  await code(availability(owner, { serviceId: owner.service, date: "2026-02-30" }, trusted), "INVALID_INPUT");
  expect(calls).toBe(0);
  for (const input of [{ serviceId: foreign.service, date: "2026-06-01" },
    { serviceId: owner.service, date: "2026-06-01", resourceId: foreign.resource }])
    await code(availability(owner, input), "UNKNOWN_OWNED_ID");
  for (const id of [randomUUID(), (await book(foreign)).id])
    await code(availability(owner, undefined, { clock: () => now, appointmentId: id }), "UNKNOWN_OWNED_ID");
  await code(availability(owner, undefined, { clock: () => "bad" }), "INVALID_INPUT");
  await availability(owner, undefined, trusted);
  expect(calls).toBe(1);
  await database.sql`update resources set status='suspended' where id=${owner.resource}`;
  expect(await availability(owner, { serviceId: owner.service, date: "2026-06-01", resourceId: owner.resource })).toEqual([]);
  await database.sql`update resources set deleted_at=now() where id=${owner.resource}`;
  await code(availability(owner, { serviceId: owner.service, date: "2026-06-01", resourceId: owner.resource }), "UNKNOWN_OWNED_ID");
  await database.sql`delete from resource_services where resource_id=${owner.alternate}`;
  expect(await availability(owner)).toEqual([]);
  await database.sql`update services set deleted_at=now() where id=${owner.service}`;
  await code(availability(owner), "UNKNOWN_OWNED_ID");
  expect(await effects(owner)).toEqual(before);
});

test("availability consumes only numeric Confirmed selected-resource half-open occupancy", async () => {
  const owner = await readyOwner();
  // Deliberately incoherent raw dates: occupancy must use only SQL epochs.
  await insert(row(owner, { state: "confirmed" }));
  await insert(row(owner, { state: "confirmed", start_ms: start - 15 * minutes, end_ms: start }));
  for (const state of ["done", "cancelled", "no_show"])
    await insert(row(owner, { state, start_ms: start + 15 * minutes, end_ms: start + 30 * minutes }));
  const before = await effects(owner), offers = await availability(owner);
  expect(offers.filter(offer => offer.startMs === start).map(offer => offer.resourceId)).toEqual([owner.alternate]);
  expect(offers.filter(offer => offer.startMs === start + 15 * minutes)).toHaveLength(2);
  expect(await effects(owner)).toEqual(before);
});

test("availability checks whole pauses, off hours, overnight and cross-date closures", async () => {
  const owner = await readyOwner();
  await database.sql`update services set duration_minutes=30 where id=${owner.service}`;
  const query = { serviceId: owner.service, date: "2026-06-01", resourceId: owner.resource };
  for (const hours of [{}, { 1: [{ startMinute: 600, endMinute: 615 }, { startMinute: 630, endMinute: 660 }] }]) {
    await database.sql`update resources set weekly_schedule=${database.sql.json(hours)} where id=${owner.resource}`;
    const offers = await availability(owner, query);
    expect(offers.map(offer => offer.startMs)).toEqual(Object.keys(hours).length ? [start + 30 * minutes] : []);
  }
  const overnight = { 1: [{ startMinute: 1380, endMinute: 60 }] };
  await database.sql`update resources set weekly_schedule=${database.sql.json(overnight)} where id=${owner.resource}`;
  const before = await effects(owner);
  const overnightOffers = await availability(owner, query);
  expect(overnightOffers).toHaveLength(4);
  expect(overnightOffers.at(-1)!.startMs).toBe(parseInstantMs("2026-06-01T23:45:00-03:00")!);
  await database.sql`insert into business_calendar_closures(business_id,kind,closed_date) values(${owner.business},'date','2026-06-02')`;
  expect((await availability(owner, query)).map(offer => offer.startMs)).toEqual(overnightOffers.slice(0, 3).map(offer => offer.startMs));
  await database.sql`insert into business_calendar_closures(business_id,kind,start_raw,end_raw,start_ms,end_ms)
    values(${owner.business},'interval','2026-06-01T23:15:00-03:00','2026-06-01T23:30:00-03:00',
      ${parseInstantMs("2026-06-01T23:15:00-03:00")!},${parseInstantMs("2026-06-01T23:30:00-03:00")!})`;
  expect((await availability(owner, query)).map(offer => offer.startMs)).toEqual([parseInstantMs("2026-06-01T23:30:00-03:00")!]);
  await database.sql`update business_calendars set weekly_schedule='{}'::jsonb where business_id=${owner.business}`;
  expect(await availability(owner, query)).toEqual([]);
  const unconfigured = await fixture();
  expect(await availability(unconfigured)).toEqual([]);
  expect(await effects(owner)).toEqual(before);
});

test("reschedule availability retains agreed identities, excludes only owned self and permits unchanged upcoming epoch inside lead", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  await database.sql`update services set name='Changed',duration_minutes=30,price_ars=999 where id=${owner.service}`;
  await database.sql`update resources set name='Changed resource' where id=${owner.resource}`;
  const trusted = { appointmentId: saved.id.toUpperCase(), clock: () => "2026-06-01T09:45:00-03:00" };
  const before = await effects(owner), offers = await availability(owner, undefined, trusted);
  const unchanged = offers.find(offer => offer.startMs === start && offer.resourceId === owner.resource)!;
  expect(unchanged.start).toBe(saved.startsAt);
  expect(unchanged.terms).toEqual(saved.terms);
  expect(offers.find(offer => offer.startMs === start && offer.resourceId === owner.alternate)!.terms.resourceName).toBe(owner.alternate);
  expect(offers.every(offer => offer.startMs === start || offer.startMs >= start + 45 * minutes)).toBe(true);
  await insert(row(owner, { state: "confirmed", resource_id: owner.alternate }));
  expect((await availability(owner, undefined, trusted)).some(offer => offer.startMs === start && offer.resourceId === owner.alternate)).toBe(false);
  const service = randomUUID();
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${service},${owner.business},'New',30,99)`;
  await database.sql`insert into resource_services values(${owner.business},${owner.resource},${service})`;
  const changed = await availability(owner, { serviceId: service, date: "2026-06-01", resourceId: owner.resource }, trusted);
  expect(changed[0]).toMatchObject({ startMs: start, terms: { serviceId: service, serviceName: "New", durationMinutes: 30, priceArs: 99, resourceName: saved.terms.resourceName } });
  expect(await effects(owner)).toEqual({ ...before, appointments: before.appointments + 1 });
  await code(availability(owner, undefined, { appointmentId: saved.id, clock: () => saved.startsAt }), "STARTED_STRUCTURE_LOCKED");
  await database.sql`update appointments set state='done' where id=${saved.id}`;
  await code(availability(owner, undefined, trusted), "STATE_LOCKED");
  await database.sql`update appointments set state='confirmed',start_raw='2026-06-01T11:00:00-03:00' where id=${saved.id}`;
  await code(availability(owner, undefined, trusted), "INVALID_INPUT");
});

test("availability never aliases a retired preference or offers an inactive stored no-op", async () => {
  const owner = await readyOwner();
  const saved = await book(owner, command(owner), { origin: "manual", now,
    customerResourceExpression: { kind: "chosen", resourceId: owner.alternate } });
  await database.sql`update resources set deleted_at=now() where id=${owner.alternate}`;
  const before = await effects(owner);
  const offers = await availability(owner, undefined, { appointmentId: saved.id, clock: () => now });
  expect(offers.length).toBeGreaterThan(3);
  expect(offers.every(offer => offer.resourceId === owner.resource)).toBe(true);
  const loaded = await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.getAppointment(owner.business, saved.id));
  expect(loaded!.customerResourcePreference).toBe(owner.alternate);
  await database.sql`update services set status='suspended' where id=${owner.service}`;
  expect(await availability(owner, undefined, { appointmentId: saved.id, clock: () => now })).toEqual([]);
  await database.sql`update services set deleted_at=now() where id=${owner.service}`;
  await code(availability(owner, undefined, { appointmentId: saved.id, clock: () => now }), "UNKNOWN_OWNED_ID");
  expect(await effects(owner)).toEqual(before);
});

test("availability has no horizon and boundary offers retain exact grid serialization and persist", async () => {
  const owner = await readyOwner();
  for (const date of ["0001-01-01", "9999-12-31"]) {
    const before = await effects(owner);
    const offers = await availability(owner, { serviceId: owner.service, date, resourceId: owner.resource },
      { clock: () => "0001-01-01T00:00:00+23:59" });
    expect(offers.length).toBeGreaterThan(3);
    expect(offers.every(offer => parseInstantMs(offer.start) === offer.startMs && Number.isSafeInteger(offer.endMs)
      && offer.endMs <= 253402387139999)).toBe(true);
    expect(await effects(owner)).toEqual(before);
    const offer = offers.at(-1)!;
    const saved = await book(owner, command(owner, { startRaw: offer.start }), { origin: "manual", now: "0001-01-01T00:00:00+23:59" });
    expect(saved.startMs).toBe(offer.startMs);
  }
});

test("availability clock waits for actual matching-tenant calendar lock and snapshot", async () => {
  const owner = await readyOwner();
  let release!: () => void, held!: () => void, pid = 0, calls = 0;
  const ready = new Promise<void>(resolve => { held = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = tenant(owner.business, async sql => {
    await new PostgresRepositories(sql).acquireBusinessCalendarLock({ businessId: owner.business });
    held(); await gate;
    await sql`update services set status='suspended' where id=${owner.service}`;
  });
  await ready;
  const waiting = tenant(owner.business, async sql => {
    const [backend] = await sql`select pg_backend_pid() pid`; pid = backend!.pid;
    return new PostgresRepositories(sql).listAppointmentAvailability(owner.business,
      { serviceId: owner.service, date: "2026-06-01" }, { clock: () => { calls++; return now; } });
  });
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const [activity] = await database.sql`select wait_event_type from pg_stat_activity where pid=${pid}`;
      blocked = activity?.wait_event_type === "Lock";
      if (!blocked) await Bun.sleep(10);
    }
    expect(blocked).toBe(true); expect(calls).toBe(0);
  } finally { release(); await holder; }
  expect(await waiting).toEqual([]); expect(calls).toBe(1);
  await expect(new PostgresRepositories(runtime).listAppointmentAvailability(owner.business, {})).rejects.toThrow("transaction");
  await expect(tenant(b.business, sql => new PostgresRepositories(sql).listAppointmentAvailability(owner.business, {}))).rejects.toThrow("matching tenant");
});

const book = (owner: Owner, input: unknown = command(owner), trusted: AppointmentCreationContext = { origin: "manual", now }) => {
  const key = randomUUID();
  return new TenantUnitOfWork(new RolePool(runtime, "agendia_runtime")).execute(context(owner), {
    audit: { eventType: "appointment.created", outcome: "success", eventHash: createHash("sha256").update(key).digest("hex") },
    outbox: { topic: "appointment.created", stableKey: key, payload: { businessId: owner.business } },
  }, repo => repo.createAppointment(owner.business, input, trusted));
};
const rejected = async (owner: Owner, input: unknown, expected: string, trusted?: { origin: "manual" | "ai"; now: string }) => {
  const before = await effects(owner);
  await code(book(owner, input, trusted), expected);
  expect(await effects(owner)).toEqual(before);
};

test("repository books server terms and exact epochs; read DTO joins current client names", async () => {
  const owner = await readyOwner();
  const saved = await book(owner, command(owner, { notes: "notes", priceArs: 999, durationMinutes: 30, state: "done" }));
  expect(saved).toMatchObject({ state: "confirmed", origin: "manual", startsAt: "2026-06-01T10:00:00-03:00",
    startMs: start, endMs: start + 15 * minutes, notes: "notes", customerResourcePreference: null,
    client: { id: owner.client, firstName: "Current", lastName: "Name", phone: "+5491123456789" },
    terms: { serviceId: owner.service, resourceId: owner.resource, serviceName: "Current service", resourceName: owner.resource, durationMinutes: 15, priceArs: 12.34567 } });
  expect(() => JSON.stringify(saved)).not.toThrow();
  await database.sql`update clients set first_name='Latest' where id=${owner.client}`;
  await database.sql`update services set price_ars=900,duration_minutes=30 where id=${owner.service}`;
  await database.sql`update resources set name='Latest resource' where id=${owner.resource}`;
  const loaded = await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.getAppointment(owner.business, saved.id));
  expect(loaded!.terms).toEqual(saved.terms);
  expect(loaded!.client.firstName).toBe("Latest");
  const foreign = await readyOwner();
  expect(await new RolePool(runtime, "agendia_runtime").run(context(foreign), repo => repo.getAppointment(foreign.business, saved.id))).toBeNull();
  expect(await effects(owner)).toEqual({ clients: 1, appointments: 1, audit: 1, outbox: 1 });
  const offset = "2026-06-01T13:15:00.000000+00:00";
  const rawSaved = await book(owner, command(owner, { startRaw: offset, notes: "漢é".repeat(5000) }));
  expect(rawSaved.startsAt).toBe(offset);
  expect(rawSaved.startMs).toBe(parseInstantMs(offset)!);
  expect(rawSaved.endMs).toBe(parseInstantMs(offset)! + 30 * minutes);
  expect(rawSaved.notes).toHaveLength(10000);
});

test("new clients use the shared codec; existing AI client is reused without edits", async () => {
  const owner = await readyOwner();
  for (const [index, phone, canonical] of [[0, clientInput.phone, "+5491134567890"], [1, "+541134567890", "+541134567890"], [2, "+442079460018", "+442079460018"]] as const) {
    const saved = await book(owner, { ...command(owner), clientId: undefined, newClient: { ...clientInput, phone }, startRaw: `2026-06-01T10:${index * 15 === 0 ? "00" : index * 15}:00-03:00`, notes: null }, { origin: "ai", now });
    expect(saved.client).toMatchObject({ firstName: "New", lastName: "Client", phone: canonical });
    expect(saved.origin).toBe("ai");
  }
  const reused = await book(owner, command(owner, { startRaw: "2026-06-01T11:00:00-03:00" }), { origin: "ai", now });
  expect(reused.client).toEqual({ id: owner.client, firstName: "Current", lastName: "Name", phone: "+5491123456789" });
});

test("invalid command/clock/origin and foreign or missing IDs have no effects", async () => {
  const owner = await readyOwner(), foreign = await readyOwner();
  for (const extra of [{ serviceId: "bad" }, { resourceId: "bad" }, { clientId: "bad" }, { startRaw: "2026-06-01T10:00:00" },
    { startRaw: "2026-06-01T10:00:00.0001-03:00" }, { notes: 4 }, { clientId: undefined },
    { newClient: clientInput }, { clientId: undefined, newClient: { ...clientInput, phone: "bad" } }])
    await rejected(owner, command(owner, extra), "INVALID_INPUT");
  await rejected(owner, command(owner), "INVALID_INPUT", { origin: "web" as "manual", now });
  await rejected(owner, command(owner), "INVALID_INPUT", { origin: "ai", now: "bad" });
  for (const extra of [{ serviceId: foreign.service }, { resourceId: foreign.resource }, { clientId: foreign.client },
    { serviceId: randomUUID() }, { resourceId: randomUUID() }, { clientId: randomUUID() }])
    await rejected(owner, command(owner, extra), "UNKNOWN_OWNED_ID");
  await rejected(owner, { ...command(owner), clientId: undefined, newClient: { ...clientInput, phone: "+5491123456789" } }, "CLIENT_CONFLICT");
});

test("server eligibility and whole-interval IANA availability guard new-client writes", async () => {
  const owner = await readyOwner();
  const input = { ...command(owner), clientId: undefined, newClient: clientInput };
  await database.sql`update services set status='suspended' where id=${owner.service}`;
  await rejected(owner, input, "INELIGIBLE_CATALOG");
  await database.sql`update services set status='active' where id=${owner.service}`;
  await database.sql`update resources set status='suspended' where id=${owner.resource}`;
  await rejected(owner, input, "INELIGIBLE_CATALOG");
  await database.sql`update resources set status='active' where id=${owner.resource}`;
  await database.sql`delete from resource_services where resource_id=${owner.resource}`;
  await rejected(owner, input, "INELIGIBLE_CATALOG");
  await database.sql`insert into resource_services values(${owner.business},${owner.resource},${owner.service})`;
  await database.sql`delete from business_calendars where business_id=${owner.business}`;
  await rejected(owner, input, "UNAVAILABLE");
  await database.sql`insert into business_calendars values(${owner.business},'{}')`;
  await rejected(owner, input, "UNAVAILABLE");
  await database.sql`update business_calendars set weekly_schedule='{"1":[{"startMinute":600,"endMinute":610},{"startMinute":611,"endMinute":630}]}' where business_id=${owner.business}`;
  await rejected(owner, input, "UNAVAILABLE");
  await database.sql`update business_calendars set weekly_schedule=${database.sql.json(full)} where business_id=${owner.business}`;
  for (const hours of [{}, { 1: [{ startMinute: 600, endMinute: 610 }, { startMinute: 611, endMinute: 630 }] }]) {
    await database.sql`update resources set weekly_schedule=${database.sql.json(hours)} where id=${owner.resource}`;
    await rejected(owner, input, "UNAVAILABLE");
  }
  await database.sql`update resources set weekly_schedule=${database.sql.json(full)} where id=${owner.resource}`;
  await rejected(owner, { ...input, startRaw: "2026-06-01T10:01:00-03:00" }, "UNAVAILABLE");
  await rejected(owner, input, "UNAVAILABLE", { origin: "manual", now: "2026-06-01T09:00:00.001-03:00" });
  for (const closure of [{ kind: "date", date: "2026-06-01" }, { kind: "interval", start: "2026-06-01T10:14:00-03:00", end: "2026-06-01T10:16:00-03:00" }] as const) {
    const id = randomUUID();
    await database.sql`insert into business_calendar_closures(id,business_id,kind,closed_date,start_raw,end_raw,start_ms,end_ms)
      values(${id},${owner.business},${closure.kind},${"date" in closure ? closure.date : null},${"start" in closure ? closure.start : null},${"end" in closure ? closure.end : null},${"start" in closure ? parseInstantMs(closure.start)! : null},${"end" in closure ? parseInstantMs(closure.end)! : null})`;
    await rejected(owner, input, "UNAVAILABLE");
    await database.sql`delete from business_calendar_closures where id=${id}`;
  }
  await database.sql`update resources set weekly_schedule='{"1":[{"startMinute":600,"endMinute":605},{"startMinute":605,"endMinute":615}]}' where id=${owner.resource}`;
  expect((await book(owner, input)).state).toBe("confirmed");
});

test("overnight week wrap and distant future have no invented horizon", async () => {
  const owner = await readyOwner();
  await database.sql`update resources set weekly_schedule='{"6":[{"startMinute":1380,"endMinute":60}]}' where id=${owner.resource}`;
  expect((await book(owner, command(owner, { startRaw: "2026-06-07T00:00:00-03:00" }))).state).toBe("confirmed");
  await database.sql`update resources set weekly_schedule=${database.sql.json(full)} where id=${owner.resource}`;
  expect((await book(owner, command(owner, { startRaw: "9999-12-30T10:00:00-03:00" }))).startMs).toBe(parseInstantMs("9999-12-30T10:00:00-03:00")!);
  await rejected(owner, command(owner, { startRaw: "9999-12-31T23:59:59-23:59" }), "UNAVAILABLE");
});

test("actual UoW rolls back a new client on appointment, audit and outbox insert failures", async () => {
  const owner = await readyOwner();
  for (const table of ["appointments", "audit_events", "outbox_events"]) {
    await database.sql.unsafe(`create function appointment_test_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end $$`);
    await database.sql.unsafe(`create trigger appointment_test_failure before insert on ${table} for each row execute function appointment_test_failure()`);
    try {
      await rejected(owner, { ...command(owner), clientId: undefined, newClient: clientInput }, "P0001");
    } finally {
      await database.sql.unsafe(`drop trigger appointment_test_failure on ${table}`);
      await database.sql`drop function appointment_test_failure()`;
    }
  }
});

test("concurrent repository bookings serialize capacity without orphan clients", async () => {
  const owner = await readyOwner();
  const result = await Promise.allSettled(["11 4567 8901", "11 5678 9012"].map(phone => book(owner, { ...command(owner), clientId: undefined, newClient: { ...clientInput, phone } })));
  expect(result.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(result.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "BUSY" } });
  expect(await effects(owner)).toEqual({ clients: 2, appointments: 1, audit: 1, outbox: 1 });
  const adjacent = await Promise.all(["10:15", "10:30"].map(time => book(owner, command(owner, { startRaw: `2026-06-01T${time}:00-03:00` }))));
  expect(adjacent).toHaveLength(2);
  expect(await Promise.all([owner.resource, owner.alternate].map(resourceId => book(owner, command(owner, { resourceId, startRaw: "2026-06-01T11:00:00-03:00" }))))).toHaveLength(2);
  for (const state of ["done", "cancelled", "no_show"]) await insert(row(owner, { state, start_ms: start + 120 * minutes, end_ms: start + 135 * minutes }));
  await insert(row(owner, { state: "confirmed", resource_id: owner.alternate, start_ms: start + 120 * minutes, end_ms: start + 135 * minutes }));
  // Historical astronomical-year-zero epochs must never be converted into external ISO instants.
  await insert(row(owner, { state: "confirmed", start_ms: -62135683140000, end_ms: -62135683140000 + 15 * minutes }));
  expect((await book(owner, command(owner, { startRaw: "2026-06-01T12:00:00-03:00" }))).state).toBe("confirmed");
});

test("creation rejects raw pools/mismatched tenants and acquires lock before any lookup", async () => {
  const owner = await readyOwner(), foreign = await readyOwner();
  await expect(new PostgresRepositories(runtime).createAppointment(owner.business, command(owner), { origin: "manual", now })).rejects.toThrow("requires a transaction");
  await expect(new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.createAppointment(foreign.business, command(foreign), { origin: "manual", now }))).rejects.toThrow("matching tenant");
  await new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
    const original = repo.acquireBusinessCalendarLock.bind(repo);
    let locked = false;
    repo.acquireBusinessCalendarLock = async scope => { await original(scope); locked = true; };
    for (const method of ["getResource", "getBusinessCalendar", "listBusinessClosures", "getClientById"] as const) {
      const lookup = repo[method].bind(repo) as (...args: string[]) => Promise<unknown>;
      Object.assign(repo, { [method]: (...args: string[]) => { expect(locked).toBe(true); return lookup(...args); } });
    }
    expect((await repo.createAppointment(owner.business.toUpperCase(), command(owner), { origin: "manual", now })).state).toBe("confirmed");
  });
});

test("held shared business lock blocks creation before catalog/client/calendar reads", async () => {
  const owner = await readyOwner();
  let release!: () => void, held!: () => void;
  const ready = new Promise<void>(resolve => { held = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = database.sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"business-calendar:" + owner.business},0))`;
    held();
    await gate;
  });
  await ready;
  let lookedUp = false;
  const pending = new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
    const lookup = repo.getResource.bind(repo);
    repo.getResource = (...args) => { lookedUp = true; return lookup(...args); };
    return repo.createAppointment(owner.business, command(owner), { origin: "manual", now });
  });
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const [activity] = await database.sql`select exists(select 1 from pg_stat_activity
        where usename='appointment_test' and wait_event='advisory') waiting`;
      waiting = activity!.waiting;
      if (!waiting) await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect(lookedUp).toBe(false);
  } finally { release(); await holder; }
  expect((await pending).state).toBe("confirmed");
  expect(lookedUp).toBe(true);
});

test("native exclusion fallback rolls back new client if a raw writer bypasses the business lock", async () => {
  const owner = await readyOwner();
  await code(new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
    const create = repo.createClient.bind(repo);
    repo.createClient = async (...args) => {
      // This privileged SQL fixture races after the repository precheck, without advisory locking.
      await insert(row(owner, { state: "confirmed" }));
      return create(...args);
    };
    return repo.createAppointment(owner.business, { ...command(owner), clientId: undefined, newClient: clientInput }, { origin: "manual", now });
  }), "BUSY");
  expect(await effects(owner)).toEqual({ clients: 1, appointments: 1, audit: 0, outbox: 0 });
});

const change = (owner: Owner, id: string, input: unknown = command(owner), trusted: AppointmentChangeContext = { now }) => {
  const key = randomUUID();
  return new TenantUnitOfWork(new RolePool(runtime, "agendia_runtime")).execute(context(owner), {
    audit: { eventType: "appointment.changed", outcome: "success", eventHash: createHash("sha256").update(key).digest("hex") },
    outbox: { topic: "appointment.changed", stableKey: key, payload: { businessId: owner.business } },
  }, repo => repo.changeAppointment(owner.business, id, input, trusted));
};
const physical = async (id: string) => (await database.sql`select * from appointments where id=${id}`)[0]!;
const changeRejected = async (owner: Owner, id: string, input: unknown, expected: string, trusted: AppointmentChangeContext = { now }) => {
  const before = await physical(id), counts = await effects(owner);
  await code(change(owner, id, input, trusted), expected);
  expect(await physical(id)).toEqual(before);
  expect(await effects(owner)).toEqual(counts);
};

test("structural changes retain agreed same-service terms and capture only changed catalog identities", async () => {
  const owner = await readyOwner();
  const saved = await book(owner, command(owner, { notes: "original" }), { origin: "ai", now });
  const birth = await physical(saved.id);
  await database.sql`update services set name='Renamed service',price_ars=900,duration_minutes=30 where id=${owner.service}`;
  await database.sql`update resources set name='Renamed resource' where id=${owner.resource}`;
  const moved = await change(owner, saved.id, command(owner, { startRaw: "2026-06-01T11:00:00-03:00", notes: "ignored", clientId: randomUUID(), state: "done", origin: "manual", priceArs: 0, durationMinutes: 45 }));
  expect(moved.terms).toEqual(saved.terms);
  expect(moved.endMs).toBe(moved.startMs + 15 * minutes);
  expect(moved.client).toEqual(saved.client);
  expect(moved.origin).toBe("ai");
  expect(moved.notes).toBe("original");
  const reassigned = await change(owner, saved.id, command(owner, { resourceId: owner.alternate, startRaw: moved.startsAt }));
  expect(reassigned.terms).toEqual({ ...saved.terms, resourceId: owner.alternate, resourceName: owner.alternate });
  const serviceId = randomUUID();
  await database.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${serviceId},${owner.business},'New terms',30,55)`;
  await database.sql`insert into resource_services values(${owner.business},${owner.alternate},${serviceId})`;
  await database.sql`update resources set name='Another rename' where id=${owner.alternate}`;
  const switched = await change(owner, saved.id, command(owner, { serviceId, resourceId: owner.alternate, startRaw: moved.startsAt }));
  expect(switched.terms).toEqual({ serviceId, serviceName: "New terms", durationMinutes: 30, priceArs: 55, resourceId: owner.alternate, resourceName: owner.alternate });
  expect(switched.endMs).toBe(switched.startMs + 30 * minutes);
  expect((await physical(saved.id)).created_at).toEqual(birth.created_at);
});

test("semantic no-op canonicalizes IDs/epochs without touching raw terms or timestamps", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  const before = await physical(saved.id);
  await database.sql`update services set name='Changed',price_ars=800,status='suspended' where id=${owner.service}`;
  await database.sql`update resources set name='Changed',status='suspended',weekly_schedule='{}' where id=${owner.resource}`;
  const result = await change(owner, saved.id.toUpperCase(), command(owner, { serviceId: owner.service.toUpperCase(), resourceId: owner.resource.toUpperCase(), startRaw: "2026-06-01T13:00:00.000000Z", customerResourcePreference: owner.alternate }), { now: "2026-06-01T10:00:00-03:00" });
  expect(result).toEqual(saved);
  expect(await physical(saved.id)).toEqual(before);
});

test("current-start lock, lead time and invalid/final input preserve original data", async () => {
  const owner = await readyOwner(), saved = await book(owner), foreign = await readyOwner();
  for (const clock of ["2026-06-01T10:00:00-03:00", "2026-06-01T10:00:00.001-03:00"])
    await changeRejected(owner, saved.id, command(owner, { resourceId: owner.alternate }), "STARTED_STRUCTURE_LOCKED", { now: clock });
  expect((await change(owner, saved.id, command(owner, { resourceId: owner.alternate }), { now: "2026-06-01T09:59:59.999-03:00" })).terms.resourceId).toBe(owner.alternate);
  for (const extra of [{ serviceId: "bad" }, { resourceId: "bad" }, { startRaw: "bad" }])
    await changeRejected(owner, saved.id, command(owner, extra), "INVALID_INPUT");
  await code(change(owner, "bad", command(owner)), "INVALID_INPUT");
  await changeRejected(owner, saved.id, command(owner), "INVALID_INPUT", { now: "bad" });
  for (const extra of [{ serviceId: foreign.service }, { resourceId: foreign.resource }, { serviceId: randomUUID() }, { resourceId: randomUUID() }])
    await changeRejected(owner, saved.id, command(owner, extra), "UNKNOWN_OWNED_ID");
  await changeRejected(foreign, saved.id, command(foreign), "UNKNOWN_OWNED_ID");
  await changeRejected(owner, saved.id, command(owner, { startRaw: "2026-06-01T10:30:00-03:00" }), "LEAD_TIME", { now: "2026-06-01T09:30:00.001-03:00" });
  // Clock must remain before CURRENT start; exact one-hour new start is accepted.
  expect((await change(owner, saved.id, command(owner, { startRaw: "2026-06-01T10:30:00-03:00" }), { now: "2026-06-01T09:30:00-03:00" })).startMs).toBe(start + 30 * minutes);
  for (const state of ["done", "cancelled", "no_show"]) {
    await database.sql`update appointments set state=${state} where id=${saved.id}`;
    await changeRejected(owner, saved.id, command(owner), "STATE_LOCKED");
  }
});

test("actual changes use whole agreed interval, current eligibility, closures and selected-resource capacity", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  const input = command(owner, { resourceId: owner.alternate });
  await database.sql`update resources set weekly_schedule='{"1":[{"startMinute":600,"endMinute":610},{"startMinute":611,"endMinute":630}]}' where id=${owner.alternate}`;
  await changeRejected(owner, saved.id, input, "UNAVAILABLE");
  await database.sql`update resources set weekly_schedule=${database.sql.json(full)},status='suspended' where id=${owner.alternate}`;
  await changeRejected(owner, saved.id, input, "INELIGIBLE_CATALOG");
  await database.sql`update resources set status='active' where id=${owner.alternate}`;
  await database.sql`delete from resource_services where resource_id=${owner.alternate}`;
  await changeRejected(owner, saved.id, input, "INELIGIBLE_CATALOG");
  await database.sql`insert into resource_services values(${owner.business},${owner.alternate},${owner.service})`;
  await database.sql`update services set status='suspended' where id=${owner.service}`;
  await changeRejected(owner, saved.id, input, "INELIGIBLE_CATALOG");
  await database.sql`update services set status='active' where id=${owner.service}`;
  await changeRejected(owner, saved.id, command(owner, { startRaw: "2026-06-01T11:01:00-03:00" }), "UNAVAILABLE");
  const closure = randomUUID();
  await database.sql`insert into business_calendar_closures(id,business_id,kind,closed_date) values(${closure},${owner.business},'date','2026-06-01')`;
  await changeRejected(owner, saved.id, input, "UNAVAILABLE");
  await database.sql`delete from business_calendar_closures where id=${closure}`;
  await database.sql`insert into business_calendar_closures(id,business_id,kind,start_raw,end_raw,start_ms,end_ms)
    values(${closure},${owner.business},'interval','2026-06-01T10:14:00-03:00','2026-06-01T10:16:00-03:00',${start + 14 * minutes},${start + 16 * minutes})`;
  await changeRejected(owner, saved.id, input, "UNAVAILABLE");
  await database.sql`delete from business_calendar_closures where id=${closure}`;
  await database.sql`update resources set weekly_schedule='{}' where id=${owner.alternate}`;
  await changeRejected(owner, saved.id, input, "UNAVAILABLE");
  await database.sql`update resources set weekly_schedule=${database.sql.json(full)} where id=${owner.alternate}`;
  await insert(row(owner, { state: "confirmed", start_ms: -62135683140000, end_ms: -62135683140000 + 15 * minutes }));
  const busy = await insert(row(owner, { state: "confirmed", resource_id: owner.alternate }));
  await changeRejected(owner, saved.id, input, "BUSY");
  await database.sql`update appointments set state='done' where id=${busy.id}`;
  expect((await change(owner, saved.id, input)).terms.resourceId).toBe(owner.alternate);
  expect((await change(owner, saved.id, command(owner))).terms.resourceId).toBe(owner.resource);
});

test("trusted explicit customer expressions create/update preference; assignment and body fields do not", async () => {
  const owner = await readyOwner(), foreign = await readyOwner();
  await database.sql`update resources set status='suspended',weekly_schedule='{}' where id=${owner.alternate}`;
  const saved = await book(owner, command(owner, { customerResourcePreference: foreign.resource }), {
    origin: "manual", now, customerResourceExpression: { kind: "chosen", resourceId: owner.alternate.toUpperCase() },
  });
  expect(saved.customerResourcePreference).toBe(owner.alternate);
  await database.sql`update resources set status='active',weekly_schedule=${database.sql.json(full)} where id=${owner.alternate}`;
  expect((await change(owner, saved.id, command(owner, { resourceId: owner.alternate }))).customerResourcePreference).toBe(owner.alternate);
  const chosen = await change(owner, saved.id, command(owner, { resourceId: owner.resource }), { now, customerResourceExpression: { kind: "chosen", resourceId: owner.resource.toUpperCase() } });
  expect(chosen.customerResourcePreference).toBe(owner.resource);
  expect((await change(owner, saved.id, command(owner, { resourceId: owner.alternate, customerResourcePreference: foreign.resource }))).customerResourcePreference).toBe(owner.resource);
  expect((await change(owner, saved.id, command(owner), { now, customerResourceExpression: { kind: "none" } })).customerResourcePreference).toBeNull();
  for (const expression of [{ kind: "chosen", resourceId: foreign.resource }, { kind: "chosen", resourceId: randomUUID() }]) {
    await changeRejected(owner, saved.id, command(owner), "UNKNOWN_OWNED_ID", { now, customerResourceExpression: expression as { kind: "chosen"; resourceId: string } });
    await rejected(owner, command(owner, { startRaw: "2026-06-01T11:00:00-03:00" }), "UNKNOWN_OWNED_ID", { origin: "manual", now, customerResourceExpression: expression } as AppointmentCreationContext);
  }
  for (const expression of [{ kind: "unknown" }, { kind: "chosen", resourceId: "bad" }]) {
    await changeRejected(owner, saved.id, command(owner), "INVALID_INPUT", { now, customerResourceExpression: expression } as AppointmentChangeContext);
    await rejected(owner, command(owner, { startRaw: "2026-06-01T11:00:00-03:00" }), "INVALID_INPUT", { origin: "manual", now, customerResourceExpression: expression } as AppointmentCreationContext);
  }
  const none = await book(owner, command(owner, { startRaw: "2026-06-01T11:00:00-03:00" }), { origin: "ai", now, customerResourceExpression: { kind: "none" } });
  expect(none.customerResourcePreference).toBeNull();
  await changeRejected(owner, saved.id, command(owner), "STARTED_STRUCTURE_LOCKED", { now: "2026-06-01T10:00:00-03:00", customerResourceExpression: { kind: "chosen", resourceId: owner.alternate } });
  expect((await change(owner, saved.id, command(owner), { now: "2026-06-01T10:00:00-03:00" })).customerResourcePreference).toBeNull();
});

test("upcoming preference-only metadata remains editable with suspended catalogs and cleared hours", async () => {
  const owner = await readyOwner();
  const saved = await book(owner, command(owner, { notes: "Keep notes" }), { origin: "ai", now });
  const before = await physical(saved.id);
  // Fixture drift characterizes existing bookings, not future T09 catalog mutation guards.
  await database.sql`update services set status='suspended' where id=${owner.service}`;
  await database.sql`update resources set status='suspended',weekly_schedule='{}' where id=${owner.resource}`;
  await database.sql`update business_calendars set weekly_schedule='{}' where business_id=${owner.business}`;
  const clock = "2026-06-01T09:30:00-03:00";
  const stableFields = (row: Record<string, unknown>) => {
    const { customer_resource_preference_id: _preference, updated_at: _updated, ...stable } = row;
    return stable;
  };
  const chosen = await change(owner, saved.id, command(owner), {
    now: clock, customerResourceExpression: { kind: "chosen", resourceId: owner.alternate },
  });
  expect(chosen).toEqual({ ...saved, customerResourcePreference: owner.alternate });
  const chosenRow = await physical(saved.id);
  expect(stableFields(chosenRow)).toEqual(stableFields(before));
  expect((await change(owner, saved.id, command(owner), { now: clock })).customerResourcePreference).toBe(owner.alternate);
  expect(await physical(saved.id)).toEqual(chosenRow);
  const cleared = await change(owner, saved.id, command(owner), {
    now: clock, customerResourceExpression: { kind: "none" },
  });
  expect(cleared).toEqual(saved);
  const clearedRow = await physical(saved.id);
  expect(stableFields(clearedRow)).toEqual(stableFields(before));
  expect((await change(owner, saved.id, command(owner), { now: clock })).customerResourcePreference).toBeNull();
  expect(await physical(saved.id)).toEqual(clearedRow);
});

test("structural UPDATE and caller audit/outbox failures roll back original snapshot/preference", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  for (const table of ["appointments", "audit_events", "outbox_events"]) {
    await database.sql.unsafe(`create function appointment_change_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end $$`);
    await database.sql.unsafe(`create trigger appointment_change_failure before ${table === "appointments" ? "update" : "insert"} on ${table} for each row execute function appointment_change_failure()`);
    try { await changeRejected(owner, saved.id, command(owner, { resourceId: owner.alternate }), "P0001", { now, customerResourceExpression: { kind: "chosen", resourceId: owner.alternate } }); }
    finally {
      await database.sql.unsafe(`drop trigger appointment_change_failure on ${table}`);
      await database.sql`drop function appointment_change_failure()`;
    }
  }
});

test("concurrent edit versus creation arbitrates selected capacity and preserves immutable identity", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  const results = await Promise.allSettled([
    change(owner, saved.id, command(owner, { startRaw: "2026-06-01T11:00:00-03:00" })),
    book(owner, command(owner, { startRaw: "2026-06-01T11:00:00-03:00", clientId: undefined, newClient: clientInput })),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "BUSY" } });
  const current = await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.getAppointment(owner.business, saved.id));
  expect(current!.client).toEqual(saved.client);
  expect(current!.origin).toBe(saved.origin);
});

test("change locks before owned reads and rejects raw pools and mismatched tenant transactions", async () => {
  const owner = await readyOwner(), saved = await book(owner), foreign = await readyOwner();
  await expect(new PostgresRepositories(runtime).changeAppointment(owner.business, saved.id, command(owner), { now })).rejects.toThrow("requires a transaction");
  await expect(new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.changeAppointment(foreign.business, saved.id, command(owner), { now }))).rejects.toThrow("matching tenant");
  await new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
    const lock = repo.acquireBusinessCalendarLock.bind(repo);
    let locked = false;
    repo.acquireBusinessCalendarLock = async scope => { await lock(scope); locked = true; };
    for (const method of ["getAppointment", "getResource", "getBusinessCalendar", "listBusinessClosures"] as const) {
      const read = repo[method].bind(repo) as (...args: string[]) => Promise<unknown>;
      Object.assign(repo, { [method]: (...args: string[]) => { expect(locked).toBe(true); return read(...args); } });
    }
    expect((await repo.changeAppointment(owner.business.toUpperCase(), saved.id, command(owner, { resourceId: owner.alternate }), { now })).terms.resourceId).toBe(owner.alternate);
  });
});

test("invalid saved terms fail with a typed error instead of authorizing a refresh", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  const before = await physical(saved.id);
  await code(new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
    const read = repo.getAppointment.bind(repo);
    repo.getAppointment = async (...args) => {
      const current = await read(...args);
      return current ? { ...current, terms: { ...current.terms, priceArs: NaN } } : null;
    };
    return repo.changeAppointment(owner.business, saved.id, command(owner), { now });
  }), "INVALID_INPUT");
  expect(await physical(saved.id)).toEqual(before);
});

test("conditional update never reopens an appointment finalized by a raw writer after lookup", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  const original = await physical(saved.id);
  await code(new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
    const read = repo.listBusinessClosures.bind(repo);
    repo.listBusinessClosures = async businessId => {
      const closures = await read(businessId);
      await database.sql`update appointments set state='cancelled' where id=${saved.id}`;
      return closures;
    };
    return repo.changeAppointment(owner.business, saved.id, command(owner, { resourceId: owner.alternate }), { now });
  }), "STATE_LOCKED");
  expect(await physical(saved.id)).toEqual({ ...original, state: "cancelled" });
});

test("native UPDATE exclusion fallback rolls back the planned change and trigger fixture", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  await database.sql.unsafe(`create function appointment_capacity_race() returns trigger language plpgsql security definer as $$
    begin
      insert into appointments(business_id,client_id,service_id,resource_id,service_label,resource_label,price_ars,
        duration_minutes,start_raw,start_ms,end_ms,state,origin)
      values(new.business_id,new.client_id,new.service_id,new.resource_id,new.service_label,new.resource_label,new.price_ars,
        new.duration_minutes,new.start_raw,new.start_ms,new.end_ms,'confirmed','manual');
      return new;
    end $$`);
  await database.sql`create trigger appointment_capacity_race before update on appointments for each row execute function appointment_capacity_race()`;
  try { await changeRejected(owner, saved.id, command(owner, { startRaw: "2026-06-01T11:00:00-03:00" }), "BUSY"); }
  finally {
    await database.sql`drop trigger appointment_capacity_race on appointments`;
    await database.sql`drop function appointment_capacity_race()`;
  }
});

const actionFacts: AppointmentActionContext = { actor: "businessAdmin", channel: "manual", confirmed: true, now: "2026-06-01T10:00:00-03:00" };
const action = (owner: Owner, id: string, kind: "notes" | "state", input: unknown, trusted = actionFacts) => {
  const key = randomUUID();
  return new TenantUnitOfWork(new RolePool(runtime, "agendia_runtime")).execute(context(owner), {
    audit: { eventType: `appointment.${kind}`, outcome: "success", eventHash: createHash("sha256").update(key).digest("hex") },
    outbox: { topic: `appointment.${kind}`, stableKey: key, payload: { businessId: owner.business } },
  }, repo => kind === "notes" ? repo.setAppointmentNotes(owner.business, id, input, trusted)
    : repo.transitionAppointment(owner.business, id, input, trusted));
};
const actionRejected = async (owner: Owner, id: string, kind: "notes" | "state", input: unknown, expected: string, trusted = actionFacts) => {
  const before = await physical(id), counts = await effects(owner);
  await code(action(owner, id, kind, input, trusted), expected);
  expect(await physical(id)).toEqual(before);
  expect(await effects(owner)).toEqual(counts);
};
const history = (owner: Owner, filters: unknown = {}) => new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.listAppointments(owner.business, filters));

test("started confirmed notes preserve untrimmed text and all unrelated fields without catalog guards", async () => {
  const owner = await readyOwner(), saved = await book(owner, command(owner, { notes: "original" }), {
    origin: "ai", now, customerResourceExpression: { kind: "chosen", resourceId: owner.alternate },
  });
  const before = await physical(saved.id);
  await database.sql`insert into business_calendar_closures(business_id,kind,closed_date) values(${owner.business},'date','2026-06-01')`;
  await database.sql`update services set status='suspended' where id=${owner.service}`;
  await database.sql`update resources set status='suspended',weekly_schedule='{}' where id=${owner.resource}`;
  const notes = "  漢é\n".repeat(3000);
  const edited = await action(owner, saved.id, "notes", { notes, state: "done", origin: "manual", clientId: randomUUID(), priceArs: 0, actor: "ai", channel: "ai" });
  expect(edited).toEqual({ ...saved, notes });
  const physicalEdited = await physical(saved.id);
  expect(physicalEdited).toEqual({ ...before, notes, updated_at: physicalEdited.updated_at });
  await action(owner, saved.id, "notes", { notes });
  expect(await physical(saved.id)).toEqual(physicalEdited);
  expect((await action(owner, saved.id, "notes", { notes: null })).notes).toBeNull();
  for (const invalid of [{}, { notes: 3 }, { notes: "nul\u0000text" }])
    await actionRejected(owner, saved.id, "notes", invalid, "INVALID_INPUT");
});

test("final transition matrix uses trusted action facts, literal confirmation and exact attendance time", async () => {
  const owner = await readyOwner(), saved = await book(owner, command(owner, { notes: "retained" }), {
    origin: "ai", now, customerResourceExpression: { kind: "chosen", resourceId: owner.alternate },
  });
  await actionRejected(owner, saved.id, "state", "done", "BEFORE_START", { ...actionFacts, now: "2026-06-01T09:59:59.999-03:00" });
  for (const facts of [{ ...actionFacts, actor: "customer" }, { ...actionFacts, actor: "platformAdmin" }, { ...actionFacts, actor: "ai", channel: "ai" }])
    await actionRejected(owner, saved.id, "state", "no_show", "ATTENDANCE_FORBIDDEN", facts as AppointmentActionContext);
  await actionRejected(owner, saved.id, "state", "cancelled", "CONFIRMATION_REQUIRED", { ...actionFacts, confirmed: false });
  for (const facts of [{ ...actionFacts, actor: "unknown" }, { ...actionFacts, channel: "web" }, { ...actionFacts, now: "bad" }, { ...actionFacts, confirmed: "true" }])
    await actionRejected(owner, saved.id, "state", "cancelled", "INVALID_INPUT", facts as AppointmentActionContext);
  await actionRejected(owner, saved.id, "state", "unknown", "INVALID_INPUT");
  await actionRejected(owner, saved.id, "state", { state: "cancelled", confirmed: true, actor: "ai" }, "INVALID_INPUT");
  await actionRejected(owner, saved.id, "state", "confirmed", "NOT_TRANSITION");
  const before = await physical(saved.id);
  const done = await action(owner, saved.id, "state", "done");
  expect(done).toEqual({ ...saved, state: "done" });
  const after = await physical(saved.id);
  expect(after).toEqual({ ...before, state: "done", updated_at: after.updated_at });
  for (const target of ["done", "cancelled", "confirmed"])
    await actionRejected(owner, saved.id, "state", target, "NOT_TRANSITION");
  await actionRejected(owner, saved.id, "notes", { notes: "forbidden" }, "NOTES_LOCKED");
  await changeRejected(owner, saved.id, command(owner), "STATE_LOCKED");
  const second = await book(owner, command(owner, { startRaw: "2026-06-01T11:00:00-03:00" }));
  expect((await action(owner, second.id, "state", "no_show", { ...actionFacts, now: "2026-06-01T11:00:00.001-03:00" })).state).toBe("no_show");
  await actionRejected(owner, second.id, "notes", { notes: null }, "NOTES_LOCKED");
});

test("explicit AI cancellation of past confirmed booking ignores creation origin and disabled catalog; frees capacity", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  await database.sql`update services set status='suspended' where id=${owner.service}`;
  await database.sql`update resources set status='suspended',weekly_schedule='{}' where id=${owner.resource}`;
  expect((await action(owner, saved.id, "state", "cancelled", { actor: "ai", channel: "ai", now: "2026-06-02T10:00:00-03:00" })).state).toBe("cancelled");
  await actionRejected(owner, saved.id, "notes", { notes: "locked" }, "NOTES_LOCKED");
  await insert(row(owner, { state: "confirmed" }));
  await code(insert(row(owner, { state: "confirmed" })), "23P01");
  const manual = await insert(row(owner, { start_ms: start + 60 * minutes, end_ms: start + 75 * minutes, state: "confirmed" }));
  expect((await action(owner, manual.id, "state", "cancelled", { ...actionFacts, now: "2026-06-03T10:00:00-03:00" })).state).toBe("cancelled");
});

test("notes/state UPDATE and caller audit/outbox failures roll back the actual UoW", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  for (const kind of ["notes", "state"] as const) for (const table of ["appointments", "audit_events", "outbox_events"]) {
    await database.sql.unsafe(`create function appointment_action_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end $$`);
    await database.sql.unsafe(`create trigger appointment_action_failure before ${table === "appointments" ? "update" : "insert"} on ${table} for each row execute function appointment_action_failure()`);
    try { await actionRejected(owner, saved.id, kind, kind === "notes" ? { notes: "edited" } : "done", "P0001"); }
    finally {
      await database.sql.unsafe(`drop trigger appointment_action_failure on ${table}`);
      await database.sql`drop function appointment_action_failure()`;
    }
  }
});

test("notes/final mutations lock before lookup and deny foreign IDs or mismatched/nontransaction scope", async () => {
  const owner = await readyOwner(), saved = await book(owner), foreign = await readyOwner();
  for (const method of ["setAppointmentNotes", "transitionAppointment"] as const) {
    const input = method === "setAppointmentNotes" ? { notes: "edited" } : "cancelled";
    await expect(new PostgresRepositories(runtime)[method](owner.business, saved.id, input, actionFacts)).rejects.toThrow("requires a transaction");
    await expect(new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo[method](foreign.business, saved.id, input, actionFacts))).rejects.toThrow("matching tenant");
    await code(new RolePool(runtime, "agendia_runtime").run(context(foreign), repo => repo[method](foreign.business, saved.id, input, actionFacts)), "UNKNOWN_OWNED_ID");
    await code(action(owner, "bad", method === "setAppointmentNotes" ? "notes" : "state", input), "INVALID_INPUT");
  }
  await new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
    const lock = repo.acquireBusinessCalendarLock.bind(repo), read = repo.getAppointment.bind(repo);
    let locked = false;
    repo.acquireBusinessCalendarLock = async scope => { await lock(scope); locked = true; };
    repo.getAppointment = (...args) => { expect(locked).toBe(true); return read(...args); };
    await repo.setAppointmentNotes(owner.business.toUpperCase(), saved.id.toUpperCase(), { notes: "owned" }, actionFacts);
    locked = false;
    await repo.transitionAppointment(owner.business, saved.id, "cancelled", actionFacts);
  });
});

test("concurrent notes/final actions serialize; conditional raw finalization never edits final notes or reopens", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  const results = await Promise.allSettled([action(owner, saved.id, "notes", { notes: "racing" }), action(owner, saved.id, "state", "done")]);
  expect(results[1]!.status).toBe("fulfilled");
  if (results[0]!.status === "rejected") expect(results[0]!.reason).toMatchObject({ code: "NOTES_LOCKED" });
  expect((await physical(saved.id)).state).toBe("done");
  for (const kind of ["notes", "state"] as const) {
    const next = await book(owner, command(owner, { startRaw: kind === "notes" ? "2026-06-01T11:00:00-03:00" : "2026-06-01T12:00:00-03:00" }));
    const before = await physical(next.id);
    await code(new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
      const read = repo.getAppointment.bind(repo);
      repo.getAppointment = async (...args) => {
        const current = await read(...args);
        await database.sql`update appointments set state='cancelled' where id=${next.id}`;
        return current;
      };
      return kind === "notes" ? repo.setAppointmentNotes(owner.business, next.id, { notes: "stale" }, actionFacts)
        : repo.transitionAppointment(owner.business, next.id, "done", { ...actionFacts, now: "2026-06-01T12:00:00-03:00" });
    }), "STATE_LOCKED");
    expect(await physical(next.id)).toEqual({ ...before, state: "cancelled" });
  }
});

test("business/client history shares current client projection, frozen terms, every state and exact start filters", async () => {
  const owner = await readyOwner(), foreign = await readyOwner();
  const saved = await book(owner, command(owner, { notes: "history" }));
  await action(owner, saved.id, "state", "cancelled");
  const sameStart = await insert(row(owner, { state: "done" }));
  const third = await insert(row(owner, { state: "no_show", start_ms: start + 15 * minutes, end_ms: start + 30 * minutes }));
  await insert(row(owner, { state: "confirmed", start_ms: -62135683140000, end_ms: -62135683140000 + 15 * minutes }));
  await database.sql`update clients set first_name='Latest',last_name='Names',phone='+5491198765432' where id=${owner.client}`;
  await database.sql`update services set name='Latest service',price_ars=999,duration_minutes=30 where id=${owner.service}`;
  await database.sql`update resources set name='Latest resource' where id=${owner.resource}`;
  const all = await history(owner);
  expect(all).toHaveLength(4);
  expect(all.every(item => item.client.id === owner.client && item.client.firstName === "Latest" && item.client.phone === "+5491198765432")).toBe(true);
  expect(all.find(item => item.id === saved.id)).toMatchObject({ state: "cancelled", notes: "history", terms: saved.terms });
  expect(() => JSON.stringify(all)).not.toThrow();
  const bounded = await history(owner, { clientId: owner.client.toUpperCase(), from: "2026-06-01T13:00:00.000Z", to: "2026-06-01T10:15:00-03:00" });
  expect(bounded.map(item => item.id)).toEqual([saved.id, sameStart.id].sort());
  expect((await history(owner, { from: "2026-06-01T10:15:00-03:00" })).map(item => item.id)).toEqual([third.id]);
  expect(await history(owner, { clientId: foreign.client })).toHaveLength(0);
  expect(await history(owner, { clientId: randomUUID() })).toHaveLength(0);
  expect(await history(foreign)).toHaveLength(0);
  for (const filters of [{ clientId: "bad" }, { from: "bad" }, { from: "2026-06-02T00:00:00Z", to: "2026-06-01T00:00:00Z" }, { from: "2026-06-01T00:00:00Z", to: "2026-06-01T00:00:00Z" }])
    await code(history(owner, filters), "INVALID_INPUT");
  await code(new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.listAppointments("bad")), "INVALID_INPUT");
  expect(await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.listAppointments(foreign.business))).toHaveLength(0);
  await database.sql`insert into appointments(business_id,client_id,service_id,resource_id,service_label,resource_label,
    price_ars,duration_minutes,start_raw,start_ms,end_ms,state,origin)
    select ${owner.business}::uuid,${owner.client}::uuid,${owner.service}::uuid,${owner.resource}::uuid,'Frozen','Frozen',12,15,
      '2026-06-01T10:00:00-03:00',${start}::bigint + n*60000,${start}::bigint + (n+15)*60000,'done','manual'
    from generate_series(1,110) n`;
  expect(await history(owner, { clientId: owner.client })).toHaveLength(114);
});

const serviceEdit = { name: "Edited terms", durationMinutes: 30, priceArs: 80 };
const clientEdit = { firstName: "Edited", lastName: "Identity", phone: "+5491198765432" };
const catalogMutations = (owner: Owner, closure: string): Array<(repo: PostgresRepositories, business?: string) => Promise<unknown>> => [
  (repo: PostgresRepositories, business = owner.business) => repo.createClient(business, { ...clientEdit, phone: "+5491187654321" }),
  (repo: PostgresRepositories, business = owner.business) => repo.updateClient(business, owner.client, clientEdit),
  (repo: PostgresRepositories, business = owner.business) => repo.createService(business, { ...serviceEdit, name: "Another service" }),
  (repo: PostgresRepositories, business = owner.business) => repo.updateService(business, owner.service, serviceEdit),
  (repo: PostgresRepositories, business = owner.business) => repo.setServiceStatus(business, owner.service, "suspended"),
  (repo: PostgresRepositories, business = owner.business) => repo.createBusinessClosure(business, { kind: "date", date: "2026-06-02" }),
  (repo: PostgresRepositories, business = owner.business) => repo.updateBusinessClosure(business, closure, { kind: "date", date: "2026-06-03" }),
  (repo: PostgresRepositories, business = owner.business) => repo.deleteBusinessClosure(business, closure),
];
const waitForAdvisory = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [activity] = await database.sql`select exists(select 1 from pg_stat_activity
      where usename='appointment_test' and wait_event='advisory') waiting`;
    if (activity!.waiting) return;
  }
  throw new Error("Expected an observed advisory-lock waiter");
};
const orderedCatalogRace = async <T, U>(owner: Owner, first: (repo: PostgresRepositories) => Promise<T>, second: (repo: PostgresRepositories) => Promise<U>) => {
  let release!: () => void, entered!: () => void, failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { entered = resolve; failed = reject; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pool = new RolePool(runtime, "agendia_runtime");
  const winner = pool.run(context(owner), async repo => { const result = await first(repo); entered(); await gate; return result; });
  void winner.catch(failed);
  await ready;
  const loser = pool.run(context(owner), second).then(result => ({ result }), error => ({ error }));
  try { await waitForAdvisory(); } finally { release(); }
  return [await winner, await loser] as const;
};

test("every client/service/closure mutation rejects raw pools and mismatched scope before writing", async () => {
  const owner = await readyOwner(), foreign = await readyOwner();
  const closure = (await insertClosure(owner)).id;
  const before = await effects(owner);
  for (const mutate of catalogMutations(owner, closure)) {
    await expect(mutate(new PostgresRepositories(runtime))).rejects.toThrow("requires a transaction");
    await expect(new RolePool(runtime, "agendia_runtime").run(context(owner), repo => mutate(repo, foreign.business))).rejects.toThrow("matching tenant context");
  }
  expect(await effects(owner)).toEqual(before);
  expect((await database.sql`select first_name,phone from clients where id=${owner.client}`)[0]).toEqual({ first_name: "Current", phone: "+5491123456789" });
  expect((await database.sql`select name,status from services where id=${owner.service}`)[0]).toEqual({ name: "Current service", status: "active" });
});
const insertClosure = async (owner: Owner) => (await database.sql<{ id: string }[]>`insert into business_calendar_closures(business_id,kind,closed_date)
  values(${owner.business},'date','2026-06-02') returning id`)[0]!;

test("direct supported client/service/closure mutations wait at the first shared lock", async () => {
  const owner = await readyOwner(), closure = await insertClosure(owner);
  for (const mutate of catalogMutations(owner, closure.id)) {
    const [_, outcome] = await orderedCatalogRace(owner,
      async repo => { await repo.acquireBusinessCalendarLock(context(owner)); }, repo => mutate(repo));
    expect(outcome).toHaveProperty("result");
  }
});

test("service/client edits first make booking capture coherent new terms and current identity", async () => {
  const owner = await readyOwner();
  const [_, outcome] = await orderedCatalogRace(owner, async repo => {
    await repo.updateService(owner.business, owner.service, serviceEdit);
    await repo.updateClient(owner.business, owner.client, clientEdit);
  }, repo => repo.createAppointment(owner.business, command(owner), { origin: "manual", now }));
  if (!("result" in outcome)) throw outcome.error;
  expect(outcome.result.terms).toMatchObject({ serviceName: serviceEdit.name, priceArs: 80, durationMinutes: 30 });
  expect(outcome.result.client).toEqual({ id: owner.client, ...clientEdit });
  expect(outcome.result.endMs).toBe(start + 30 * minutes);
});

test("booking first preserves old snapshot while later client edits remain current by stable ID", async () => {
  const owner = await readyOwner();
  const [saved, outcome] = await orderedCatalogRace(owner,
    repo => repo.createAppointment(owner.business, command(owner), { origin: "manual", now }), async repo => {
      await repo.updateService(owner.business, owner.service, serviceEdit);
      await repo.updateClient(owner.business, owner.client, clientEdit);
      await repo.setServiceStatus(owner.business, owner.service, "suspended");
    });
  expect(outcome).toHaveProperty("result");
  const [current] = await history(owner);
  expect(current!.terms).toEqual(saved.terms);
  expect(current!.state).toBe("confirmed");
  expect(current!.client).toEqual({ id: owner.client, ...clientEdit });
});

test("suspension first rejects the waiting new booking without creating a client", async () => {
  const owner = await readyOwner(), before = await effects(owner);
  const [_, outcome] = await orderedCatalogRace(owner, repo => repo.setServiceStatus(owner.business, owner.service, "suspended"),
    repo => repo.createAppointment(owner.business, { ...command(owner), clientId: undefined, newClient: clientInput }, { origin: "ai", now }));
  expect(outcome).toMatchObject({ error: { code: "INELIGIBLE_CATALOG" } });
  expect(await effects(owner)).toEqual(before);
});

test("shared catalog/closure/booking UoW rolls back mutation and audit/outbox failures together", async () => {
  const owner = await readyOwner(), saved = await book(owner);
  const snapshot = async () => (await database.sql`select
    (select jsonb_agg(c) from clients c where business_id=${owner.business}) clients,
    (select jsonb_agg(s) from services s where business_id=${owner.business}) services,
    (select jsonb_agg(c) from business_calendar_closures c where business_id=${owner.business}) closures,
    (select jsonb_agg(a) from appointments a where business_id=${owner.business}) appointments`)[0]!;
  const before = await snapshot(), counts = await effects(owner);
  for (const table of ["services", "appointments", "audit_events", "outbox_events"]) {
    await database.sql.unsafe(`create function catalog_booking_failure() returns trigger language plpgsql as $$ begin raise exception 'forced catalog booking failure'; end $$`);
    await database.sql.unsafe(`create trigger catalog_booking_failure before ${table === "services" ? "update" : "insert"} on ${table} for each row execute function catalog_booking_failure()`);
    try {
      await code(new TenantUnitOfWork(new RolePool(runtime, "agendia_runtime")).execute(context(owner), {
        audit: { eventType: "catalog.updated", outcome: "success", eventHash: "a".repeat(64) },
        outbox: { topic: "catalog.updated", stableKey: randomUUID(), payload: {} },
      }, async repo => {
        await repo.updateClient(owner.business, owner.client, clientEdit);
        await repo.createBusinessClosure(owner.business, { kind: "date", date: "2026-06-02" });
        await repo.updateService(owner.business, owner.service, serviceEdit);
        return repo.createAppointment(owner.business, command(owner, { startRaw: "2026-06-01T11:00:00-03:00" }), { origin: "manual", now });
      }), "P0001");
      expect(await snapshot()).toEqual(before);
      expect(await effects(owner)).toEqual(counts);
    } finally {
      await database.sql.unsafe(`drop trigger catalog_booking_failure on ${table}`);
      await database.sql`drop function catalog_booking_failure()`;
    }
  }
  expect((await physical(saved.id)).state).toBe("confirmed");
  const [jobs] = await database.sql`select count(*)::int count from outbox_events where business_id=${owner.business} and (topic like 'ai.%' or topic like 'whatsapp.%')`;
  expect(jobs!.count).toBe(0);
});

const futureStart = "2099-06-01T10:00:00-03:00";
const futureFixture = async (duration = 45, startRaw = futureStart) => {
  const owner = await readyOwner();
  await database.sql`update services set duration_minutes=${duration} where id=${owner.service}`;
  const saved = await book(owner, command(owner, { startRaw }), { origin: "manual", now: "2099-01-01T00:00:00Z" });
  return { owner, saved };
};
const resourceBody = (owner: Owner, extra: Record<string, unknown> = {}) => ({ name: owner.resource, serviceIds: [owner.service], weeklySchedule: full, ...extra });
const resourceEdit = (owner: Owner, input = resourceBody(owner)) => {
  const key = randomUUID();
  return new TenantUnitOfWork(new RolePool(runtime, "agendia_runtime")).execute(context(owner), {
    audit: { eventType: "resource.updated", outcome: "success", eventHash: createHash("sha256").update(key).digest("hex") },
    outbox: { topic: "resource.updated", stableKey: key, payload: {} },
  }, repo => repo.updateResource(owner.business, owner.resource, input as Parameters<PostgresRepositories["updateResource"]>[2]));
};
const resourceSnapshot = async (owner: Owner) => (await database.sql`select
  (select jsonb_agg(r order by id) from resources r where business_id=${owner.business}) resources,
  (select jsonb_agg(rs order by resource_id,service_id) from resource_services rs where business_id=${owner.business}) assignments,
  (select jsonb_agg(ap order by id) from appointments ap where business_id=${owner.business}) appointments`)[0]!;
const resourceRejected = async (owner: Owner, input: ReturnType<typeof resourceBody>, expected = "FUTURE_APPOINTMENT_CONFLICT") => {
  const before = await resourceSnapshot(owner), counts = await effects(owner);
  await code(resourceEdit(owner, input), expected);
  expect(await resourceSnapshot(owner)).toEqual(before);
  expect(await effects(owner)).toEqual(counts);
};

test("resource future guard covers all states and agreed duration, not changed catalog terms", async () => {
  const { owner, saved } = await futureFixture();
  expect((await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.setResourceStatus(owner.business, owner.resource, "suspended")))!.status).toBe("suspended");
  await database.sql`update services set duration_minutes=30,status='suspended' where id=${owner.service}`;
  await database.sql`update resources set status='suspended' where id=${owner.resource}`;
  for (const state of ["confirmed", "done", "cancelled", "no_show"]) {
    await database.sql`update appointments set state=${state} where id=${saved.id}`;
    await resourceRejected(owner, resourceBody(owner, { weeklySchedule: {} }));
    await resourceRejected(owner, resourceBody(owner, { serviceIds: [] }));
  }
  const day = new Date(saved.startMs - 3 * 60 * minutes).getUTCDay();
  await resourceRejected(owner, resourceBody(owner, { weeklySchedule: { [day]: [{ startMinute: 600, endMinute: 630 }] } }));
  const retained = await resourceEdit(owner, resourceBody(owner, { weeklySchedule: { [day]: [{ startMinute: 600, endMinute: 645 }] }, name: "Renamed", description: "Allowed metadata" }));
  expect(retained!.status).toBe("suspended");
  expect((await physical(saved.id)).duration_minutes).toBe(45);
  const shorter = await futureFixture(30);
  await database.sql`update services set duration_minutes=45,status='suspended' where id=${shorter.owner.service}`;
  expect(await resourceEdit(shorter.owner, resourceBody(shorter.owner, { weeklySchedule: { [day]: [{ startMinute: 600, endMinute: 630 }] } }))).not.toBeNull();
});

test("resource guard checks every future interval rather than only the earliest booking", async () => {
  const { owner, saved } = await futureFixture(30);
  await book(owner, command(owner, { startRaw: "2099-06-01T11:00:00-03:00" }), { origin: "ai", now: "2099-01-01T00:00:00Z" });
  const day = new Date(saved.startMs - 3 * 60 * minutes).getUTCDay();
  await resourceRejected(owner, resourceBody(owner, { weeklySchedule: { [day]: [{ startMinute: 600, endMinute: 660 }] } }));
  expect(await resourceEdit(owner, resourceBody(owner, { weeklySchedule: { [day]: [{ startMinute: 600, endMinute: 690 }] } }))).not.toBeNull();
});

test("whole overnight/week-wrap and pause intervals are guarded; equivalent unions and unrelated assignments remain editable", async () => {
  // 2099-06-06 is Saturday; a 45-minute booking crosses into Sunday.
  const { owner, saved } = await futureFixture(45, "2099-06-06T23:45:00-03:00");
  const overnight = { 6: [{ startMinute: 1425, endMinute: 30 }] };
  expect(await resourceEdit(owner, resourceBody(owner, { weeklySchedule: overnight }))).not.toBeNull();
  await resourceRejected(owner, resourceBody(owner, { weeklySchedule: { 6: [{ startMinute: 1425, endMinute: 15 }] } }));
  await resourceRejected(owner, resourceBody(owner, { weeklySchedule: { 6: [{ startMinute: 1425, endMinute: 1440 }], 0: [{ startMinute: 1, endMinute: 30 }] } }));
  const service = await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.createService(owner.business, { name: "Unbooked", durationMinutes: 15, priceArs: 0 }));
  expect(await resourceEdit(owner, resourceBody(owner, { weeklySchedule: overnight, serviceIds: [owner.service, service.id] }))).not.toBeNull();
  expect(await resourceEdit(owner, resourceBody(owner, { weeklySchedule: { 6: [{ startMinute: 1425, endMinute: 1440 }], 0: [{ startMinute: 0, endMinute: 30 }] } }))).not.toBeNull();
  const before = await physical(saved.id);
  expect(await resourceEdit(owner, resourceBody(owner, { weeklySchedule: overnight, name: "Only rename", description: "No new eligibility" }))).not.toBeNull();
  expect(await physical(saved.id)).toEqual(before);
});

test("future guard isolates resource/business and past rows; hostile raw/epoch mismatch cannot pass", async () => {
  const { owner, saved } = await futureFixture();
  const other = await readyOwner();
  expect(await resourceEdit(other, resourceBody(other, { weeklySchedule: {}, serviceIds: [] }))).not.toBeNull();
  expect(await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.updateResource(owner.business, owner.alternate, { name: owner.alternate, weeklySchedule: {}, serviceIds: [] }))).not.toBeNull();
  await database.sql`update appointments set start_raw='2099-06-01T11:00:00-03:00' where id=${saved.id}`;
  await resourceRejected(owner, resourceBody(owner, { weeklySchedule: { 1: [{ startMinute: 600, endMinute: 720 }] } }));
  // Metadata-only updates do not reinterpret or repair historical records.
  expect(await resourceEdit(owner, resourceBody(owner, { name: "Metadata only" }))).not.toBeNull();
  await database.sql`update appointments set start_raw='2000-01-01T10:00:00-03:00',start_ms=${parseInstantMs("2000-01-01T10:00:00-03:00")!},
    end_ms=${parseInstantMs("2000-01-01T10:00:00-03:00")! + 45 * minutes} where id=${saved.id}`;
  expect(await resourceEdit(owner, resourceBody(owner, { weeklySchedule: {}, serviceIds: [] }))).not.toBeNull();
});

test("booking versus incompatible resource hours/removal shares early lock in either ordering", async () => {
  for (const extra of [{ weeklySchedule: {} }, { serviceIds: [] }]) for (const bookingFirst of [true, false]) {
    const owner = await readyOwner(), input = resourceBody(owner, extra);
    const booking = (repo: PostgresRepositories) => repo.createAppointment(owner.business, { ...command(owner), startRaw: futureStart, clientId: undefined, newClient: clientInput }, { origin: "manual", now: "2099-01-01T00:00:00Z" });
    const edit = (repo: PostgresRepositories) => repo.updateResource(owner.business, owner.resource, input as Parameters<PostgresRepositories["updateResource"]>[2]);
    const race = bookingFirst ? await orderedCatalogRace(owner, booking, edit) : await orderedCatalogRace(owner, edit, booking);
    expect(race[1]).toMatchObject({ error: { code: bookingFirst ? "FUTURE_APPOINTMENT_CONFLICT" : "serviceIds" in extra ? "INELIGIBLE_CATALOG" : "UNAVAILABLE" } });
    const counts = await effects(owner);
    expect(counts.clients).toBe(bookingFirst ? 2 : 1);
    expect(counts.appointments).toBe(bookingFirst ? 1 : 0);
  }
});

test("future-safe resource UPDATE and audit/outbox failures retain resource, assignments and bookings", async () => {
  const { owner } = await futureFixture();
  for (const table of ["resources", "audit_events", "outbox_events"]) {
    await database.sql.unsafe(`create function future_resource_failure() returns trigger language plpgsql as $$ begin raise exception 'forced resource failure'; end $$`);
    await database.sql.unsafe(`create trigger future_resource_failure before ${table === "resources" ? "update" : "insert"} on ${table} for each row execute function future_resource_failure()`);
    try { await resourceRejected(owner, resourceBody(owner, { name: "Not persisted", description: "Not persisted" }), "P0001"); }
    finally {
      await database.sql.unsafe(`drop trigger future_resource_failure on ${table}`);
      await database.sql`drop function future_resource_failure()`;
    }
  }
});

const calendarWork = <T>(owner: Owner, work: (repo: PostgresRepositories) => Promise<T>) => {
  const key = randomUUID();
  return new TenantUnitOfWork(new RolePool(runtime, "agendia_runtime")).execute(context(owner), {
    audit: { eventType: "calendar.changed", outcome: "success", eventHash: createHash("sha256").update(key).digest("hex") },
    outbox: { topic: "calendar.changed", stableKey: key, payload: {} },
  }, work);
};
const calendarSnapshot = async (owner: Owner) => ({ ...await resourceSnapshot(owner),
  calendar: (await database.sql`select * from business_calendars where business_id=${owner.business}`),
  closures: (await database.sql`select * from business_calendar_closures where business_id=${owner.business} order by id`),
});
const calendarRejected = async (owner: Owner, work: (repo: PostgresRepositories) => Promise<unknown>, expected = "FUTURE_APPOINTMENT_CONFLICT") => {
  const before = await calendarSnapshot(owner), counts = await effects(owner);
  await code(calendarWork(owner, work), expected);
  expect(await calendarSnapshot(owner)).toEqual(before);
  expect(await effects(owner)).toEqual(counts);
};

test("calendar weekly guard protects saved future Confirmed intervals independently of legacy resource hours", async () => {
  const { owner, saved } = await futureFixture();
  // Privileged legacy fixture isolates the appointment guard from configured-resource containment.
  await database.sql`update resources set weekly_schedule='{}',status='suspended' where business_id=${owner.business}`;
  await database.sql`update services set duration_minutes=15,status='suspended' where id=${owner.service}`;
  await calendarRejected(owner, repo => repo.saveBusinessCalendar(owner.business, {}));
  const day = new Date(saved.startMs - 3 * 60 * minutes).getUTCDay();
  await calendarRejected(owner, repo => repo.saveBusinessCalendar(owner.business, { [day]: [{ startMinute: 600, endMinute: 630 }] }));
  expect(await calendarWork(owner, repo => repo.saveBusinessCalendar(owner.business, { [day]: [{ startMinute: 600, endMinute: 645 }] }))).toHaveProperty("weeklySchedule");
  await database.sql`update appointments set state='cancelled' where id=${saved.id}`;
  expect(await calendarWork(owner, repo => repo.saveBusinessCalendar(owner.business, {}))).toEqual({ weeklySchedule: {} });
  await database.sql`update appointments set state='confirmed',start_raw='2000-01-01T10:00:00-03:00',start_ms=${parseInstantMs("2000-01-01T10:00:00-03:00")!},end_ms=${parseInstantMs("2000-01-01T10:00:00-03:00")! + 45 * minutes} where id=${saved.id}`;
  expect(await calendarWork(owner, repo => repo.saveBusinessCalendar(owner.business, {}))).toEqual({ weeklySchedule: {} });
});

test("global closure create/update checks saved physical intervals only and permits adjacency, foreign scopes and deletion", async () => {
  const { owner, saved } = await futureFixture(45, "2099-06-01T23:45:00-03:00");
  await database.sql`update resources set weekly_schedule='{}',status='suspended' where business_id=${owner.business}`;
  await database.sql`update business_calendars set weekly_schedule='{}' where business_id=${owner.business}`;
  await database.sql`update services set duration_minutes=15,status='suspended' where id=${owner.service}`;
  await calendarRejected(owner, repo => repo.createBusinessClosure(owner.business, { kind: "date", date: "2099-06-02" }));
  await calendarRejected(owner, repo => repo.createBusinessClosure(owner.business, { kind: "interval", start: "2099-06-02T03:15:00Z", end: "2099-06-02T03:45:00Z" }));
  const unrelated = await calendarWork(owner, repo => repo.createBusinessClosure(owner.business, { kind: "date", date: "2099-06-03" }));
  await calendarRejected(owner, repo => repo.updateBusinessClosure(owner.business, unrelated.id, { kind: "date", date: "2099-06-02" }));
  await calendarRejected(owner, repo => repo.updateBusinessClosure(owner.business, unrelated.id, { kind: "interval", start: "2099-06-02T03:29:59.999Z", end: "2099-06-02T04:00:00Z" }));
  for (const [start, end] of [["2099-06-02T02:00:00Z", "2099-06-02T02:45:00Z"], ["2099-06-02T03:30:00Z", "2099-06-02T04:00:00Z"]])
    expect(await calendarWork(owner, repo => repo.createBusinessClosure(owner.business, { kind: "interval", start: start!, end: end! }))).toHaveProperty("id");
  const foreign = await readyOwner();
  const foreignClosure = await calendarWork(foreign, repo => repo.createBusinessClosure(foreign.business, { kind: "date", date: "2099-06-02" }));
  for (const id of [foreignClosure.id, randomUUID()])
    expect(await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.updateBusinessClosure(owner.business, id, { kind: "date", date: "2099-06-02" }))).toBeNull();
  expect(await calendarWork(owner, repo => repo.deleteBusinessClosure(owner.business, unrelated.id))).toBe(true);
  await database.sql`update appointments set start_raw='2099-06-01T22:45:00-03:00' where id=${saved.id}`;
  await calendarRejected(owner, repo => repo.createBusinessClosure(owner.business, { kind: "date", date: "2099-06-02" }));
  await database.sql`update appointments set state='cancelled' where id=${saved.id}`;
  expect(await calendarWork(owner, repo => repo.createBusinessClosure(owner.business, { kind: "date", date: "2099-06-02" }))).toHaveProperty("id");
});

test("calendar and date/interval closures serialize with booking in both orderings", async () => {
  for (const kind of ["weekly", "date", "interval"] as const) for (const bookingFirst of [true, false]) {
    const owner = await readyOwner();
    const booking = (repo: PostgresRepositories) => repo.createAppointment(owner.business, { ...command(owner), startRaw: futureStart, clientId: undefined, newClient: clientInput }, { origin: "manual", now: "2099-01-01T00:00:00Z" });
    const guard = async (repo: PostgresRepositories) => {
      if (kind === "weekly") {
        // Legacy/off fixture makes future-booking guard observable, not HOURS_CONFLICT.
        await database.sql`update resources set weekly_schedule='{}' where business_id=${owner.business}`;
        return repo.saveBusinessCalendar(owner.business, {});
      }
      return repo.createBusinessClosure(owner.business, kind === "date" ? { kind, date: "2099-06-01" }
        : { kind, start: "2099-06-01T10:00:00-03:00", end: "2099-06-01T10:15:00-03:00" });
    };
    const race = bookingFirst ? await orderedCatalogRace(owner, booking, guard) : await orderedCatalogRace(owner, guard, booking);
    expect(race[1]).toMatchObject({ error: { code: bookingFirst ? "FUTURE_APPOINTMENT_CONFLICT" : "UNAVAILABLE" } });
    expect((await effects(owner)).clients).toBe(bookingFirst ? 2 : 1);
    expect((await effects(owner)).appointments).toBe(bookingFirst ? 1 : 0);
  }
});

test("calendar and closure valid writes roll back on mutation, audit and outbox failures", async () => {
  const { owner } = await futureFixture();
  const closure = await calendarWork(owner, repo => repo.createBusinessClosure(owner.business, { kind: "date", date: "2099-06-03" }));
  for (const kind of ["weekly", "closure"] as const) for (const table of [kind === "weekly" ? "business_calendars" : "business_calendar_closures", "audit_events", "outbox_events"]) {
    await database.sql.unsafe(`create function calendar_booking_failure() returns trigger language plpgsql as $$ begin raise exception 'forced calendar booking failure'; end $$`);
    await database.sql.unsafe(`create trigger calendar_booking_failure before insert or update on ${table} for each row execute function calendar_booking_failure()`);
    try {
      await calendarRejected(owner, repo => kind === "weekly" ? repo.saveBusinessCalendar(owner.business, full)
        : repo.createBusinessClosure(owner.business, { kind: "date", date: "2099-06-03" }), "P0001");
      if (kind === "closure") await calendarRejected(owner, repo => repo.updateBusinessClosure(owner.business, closure.id, { kind: "date", date: "2099-06-04" }), "P0001");
    } finally {
      await database.sql.unsafe(`drop trigger calendar_booking_failure on ${table}`);
      await database.sql`drop function calendar_booking_failure()`;
    }
  }
});

const retire = (owner: Owner, kind: "service" | "resource", id = kind === "service" ? owner.service : owner.resource) => calendarWork(owner,
  repo => kind === "service" ? repo.deleteService(owner.business, id) : repo.deleteResource(owner.business, id));
const retirementSnapshot = async (owner: Owner) => ({ ...await calendarSnapshot(owner),
  services: await database.sql`select * from services where business_id=${owner.business} order by id`,
});
const pastFixture = async () => {
  const owner = await readyOwner();
  const saved = await book(owner, command(owner, { startRaw: "2000-01-01T10:00:00-03:00", notes: "History" }), {
    origin: "ai", now: "1999-01-01T00:00:00Z", customerResourceExpression: { kind: "chosen", resourceId: owner.alternate },
  });
  return { owner, saved };
};

test("tombstone migration adds nullable metadata without widening physical privileges", async () => {
  expect((await database.sql`select deleted_at from services where id=${a.service}`)[0]!.deleted_at).toBeNull();
  expect((await database.sql`select deleted_at from resources where id=${a.resource}`)[0]!.deleted_at).toBeNull();
  for (const table of ["services", "resources"]) {
    const [permissions] = await database.sql`select has_table_privilege('agendia_runtime',${table},'DELETE') deletion,
      has_table_privilege('agendia_runtime',${table},'TRUNCATE') truncation`;
    expect(permissions).toEqual({ deletion: false, truncation: false });
  }
});

test("retired names are reusable with new IDs, while past Confirmed history and true no-op remain unchanged", async () => {
  const { owner, saved } = await pastFixture();
  const before = await physical(saved.id);
  expect(await retire(owner, "service")).toBe(true);
  expect(await retire(owner, "resource")).toBe(true);
  const replacement = await new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => ({
    service: await repo.createService(owner.business, { name: "Current service", durationMinutes: 30, priceArs: 900 }),
    resource: await repo.createResource(owner.business, { name: owner.resource, serviceIds: [], weeklySchedule: full }),
  }));
  expect(replacement.service.id).not.toBe(owner.service);
  expect(replacement.resource.id).not.toBe(owner.resource);
  await database.sql`update clients set first_name='Latest',phone='+5491198765432' where id=${owner.client}`;
  const noop = await change(owner, saved.id, command(owner, { serviceId: owner.service.toUpperCase(), resourceId: owner.resource.toUpperCase(), startRaw: "2000-01-01T13:00:00.000Z" }), { now });
  expect(noop.terms).toEqual(saved.terms);
  expect(noop.customerResourcePreference).toBe(owner.alternate);
  expect(noop.client).toMatchObject({ id: owner.client, firstName: "Latest", phone: "+5491198765432" });
  expect(await physical(saved.id)).toEqual(before);
  expect((await history(owner))[0]!.terms).toEqual(saved.terms);
  await changeRejected(owner, saved.id, command(owner, { startRaw: "2099-06-01T10:00:00-03:00" }), "UNKNOWN_OWNED_ID");
  await changeRejected(owner, saved.id, command(owner), "INVALID_INPUT", { now: "bad" });
  await changeRejected(owner, saved.id, command(owner), "STARTED_STRUCTURE_LOCKED", { now, customerResourceExpression: { kind: "none" } });
  await rejected(owner, command(owner, { startRaw: futureStart }), "UNKNOWN_OWNED_ID", { origin: "manual", now: "2099-01-01T00:00:00Z" });
  await database.sql`update appointments set state='done' where id=${saved.id}`;
  await changeRejected(owner, saved.id, command(owner, { startRaw: "2000-01-01T13:00:00Z" }), "STATE_LOCKED");
});

test("retirement blocks actual future appointments in every state and preserves all records/effects", async () => {
  const { owner, saved } = await futureFixture();
  for (const state of ["confirmed", "done", "cancelled", "no_show"]) {
    await database.sql`update appointments set state=${state} where id=${saved.id}`;
    for (const kind of ["service", "resource"] as const) {
      const before = await retirementSnapshot(owner), counts = await effects(owner);
      await code(retire(owner, kind), "FUTURE_APPOINTMENT_CONFLICT");
      expect(await retirementSnapshot(owner)).toEqual(before);
      expect(await effects(owner)).toEqual(counts);
    }
  }
});

test("currently started Confirmed records do not block retirement and their physical history remains intact", async () => {
  const { owner, saved } = await pastFixture();
  const epoch = Date.now(), raw = new Date(epoch).toISOString();
  await database.sql`update appointments set start_raw=${raw},start_ms=${epoch},end_ms=${epoch + 15 * minutes} where id=${saved.id}`;
  const before = await physical(saved.id);
  expect(await retire(owner, "service")).toBe(true);
  expect(await retire(owner, "resource")).toBe(true);
  expect(await physical(saved.id)).toEqual(before);
});

test("preferred-only resource retirement retains historical preference and hides every live lookup/write path", async () => {
  const { owner, saved } = await futureFixture();
  await change(owner, saved.id, command(owner, { startRaw: futureStart }), { now: "2099-01-01T00:00:00Z", customerResourceExpression: { kind: "chosen", resourceId: owner.alternate } });
  expect(await retire(owner, "resource", owner.alternate)).toBe(true);
  const replacement = await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.createResource(owner.business, { name: owner.alternate, serviceIds: [owner.service], weeklySchedule: full }));
  expect((await history(owner))[0]!.customerResourcePreference).toBe(owner.alternate);
  expect(replacement.id).not.toBe(owner.alternate);
  await changeRejected(owner, saved.id, command(owner, { startRaw: futureStart }), "UNKNOWN_OWNED_ID", {
    now: "2099-01-01T00:00:00Z", customerResourceExpression: { kind: "chosen", resourceId: owner.alternate },
  });
  await new RolePool(runtime, "agendia_runtime").run(context(owner), async repo => {
    expect(await repo.getResource(owner.business, owner.alternate)).toBeNull();
    expect((await repo.listResources(owner.business)).some(resource => resource.id === owner.alternate)).toBe(false);
    expect(await repo.updateResource(owner.business, owner.alternate, { name: "Resurrect", serviceIds: [], weeklySchedule: {} })).toBeNull();
    expect(await repo.setResourceStatus(owner.business, owner.alternate, "active")).toBeNull();
    expect(await repo.deleteResource(owner.business, owner.alternate)).toBe(false);
  });
  const past = await pastFixture();
  expect(await retire(past.owner, "service")).toBe(true);
  await new RolePool(runtime, "agendia_runtime").run(context(past.owner), async repo => {
    expect((await repo.listServices()).some(service => service.id === past.owner.service)).toBe(false);
    expect(await repo.updateService(past.owner.business, past.owner.service, serviceEdit)).toBeNull();
    expect(await repo.setServiceStatus(past.owner.business, past.owner.service, "active")).toBeNull();
    await code(repo.createResource(past.owner.business, { name: "Deleted assignment", serviceIds: [past.owner.service], weeklySchedule: {} }), "UNKNOWN_SERVICE");
  });
  expect(await retire(past.owner, "resource")).toBe(true);
  await new RolePool(runtime, "agendia_runtime").run(context(past.owner), async repo => {
    await repo.updateResource(past.owner.business, past.owner.alternate, { name: past.owner.alternate, serviceIds: [], weeklySchedule: {} });
    expect(await repo.saveBusinessCalendar(past.owner.business, {})).toEqual({ weeklySchedule: {} });
  });
});

test("partial name indexes preserve Unicode/case/trim, suspended uniqueness, tenant isolation and native races", async () => {
  const { owner } = await pastFixture();
  const long = "漢é".repeat(3200);
  await database.sql`update services set name=${long} where id=${owner.service}`;
  await database.sql`update resources set name=${long} where id=${owner.resource}`;
  expect(await retire(owner, "service")).toBe(true);
  expect(await retire(owner, "resource")).toBe(true);
  const service = await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.createService(owner.business, { name: long, durationMinutes: 15, priceArs: 0 }));
  await database.sql`update services set status='suspended' where id=${service.id}`;
  await code(database.sql`insert into services(business_id,name,duration_minutes,price_ars) values(${owner.business},${" \t" + long.toUpperCase() + "\ufeff"},15,0)`.execute(), "23505");
  await new RolePool(runtime, "agendia_runtime").run(context(owner), repo => repo.createResource(owner.business, { name: long, serviceIds: [], weeklySchedule: {} }));
  await code(database.sql`insert into resources(business_id,name,status,weekly_schedule) values(${owner.business},${long.toUpperCase()},'suspended','{}')`.execute(), "23505");
  const foreign = await readyOwner();
  await database.sql`insert into services(business_id,name,duration_minutes,price_ars) values(${foreign.business},${long},15,0)`;
  const race = await Promise.allSettled([1,2].map(() => database.sql`insert into services(business_id,name,duration_minutes,price_ars) values(${owner.business},'Native live race',15,0)`.execute()));
  expect(race.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(race.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "23505" } });
});

test("retirement versus booking shares the early lock in both orders without orphan clients", async () => {
  for (const kind of ["service", "resource"] as const) for (const bookingFirst of [true, false]) {
    const owner = await readyOwner();
    const booking = (repo: PostgresRepositories) => repo.createAppointment(owner.business, { ...command(owner), startRaw: futureStart, clientId: undefined, newClient: clientInput }, { origin: "manual", now: "2099-01-01T00:00:00Z" });
    const removal = (repo: PostgresRepositories) => kind === "service" ? repo.deleteService(owner.business, owner.service) : repo.deleteResource(owner.business, owner.resource);
    const result = bookingFirst ? await orderedCatalogRace(owner, booking, removal) : await orderedCatalogRace(owner, removal, booking);
    expect(result[1]).toMatchObject({ error: { code: bookingFirst ? "FUTURE_APPOINTMENT_CONFLICT" : "UNKNOWN_OWNED_ID" } });
    expect((await effects(owner)).clients).toBe(bookingFirst ? 2 : 1);
    expect((await effects(owner)).appointments).toBe(bookingFirst ? 1 : 0);
  }
});

test("retirement UPDATE/link DELETE/audit/outbox failure rolls back rows, links, history and name availability", async () => {
  for (const kind of ["service", "resource"] as const) {
    const { owner } = await pastFixture();
    for (const table of [kind === "service" ? "services" : "resources", "resource_services", "audit_events", "outbox_events"]) {
      const operation = table === "resource_services" ? "delete" : table === "audit_events" || table === "outbox_events" ? "insert" : "update";
      await database.sql.unsafe(`create function retire_failure() returns trigger language plpgsql as $$ begin raise exception 'forced retirement failure'; end $$`);
      await database.sql.unsafe(`create trigger retire_failure before ${operation} on ${table} for each row execute function retire_failure()`);
      const before = await retirementSnapshot(owner), counts = await effects(owner);
      try {
        await code(retire(owner, kind), "P0001");
        expect(await retirementSnapshot(owner)).toEqual(before);
        expect(await effects(owner)).toEqual(counts);
      } finally {
        await database.sql.unsafe(`drop trigger retire_failure on ${table}`);
        await database.sql`drop function retire_failure()`;
      }
    }
    await code(kind === "service" ? database.sql`insert into services(business_id,name,duration_minutes,price_ars) values(${owner.business},'Current service',15,0)`.execute()
      : database.sql`insert into resources(business_id,name,weekly_schedule) values(${owner.business},${owner.resource},'{}')`.execute(), "23505");
  }
});
