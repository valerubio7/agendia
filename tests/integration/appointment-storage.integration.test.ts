import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { parseInstantMs, type WeeklySchedule } from "@agendia/domain";
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
