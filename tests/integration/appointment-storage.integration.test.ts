import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { parseInstantMs } from "@agendia/domain";
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
