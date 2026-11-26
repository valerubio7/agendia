import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rmdir } from "node:fs/promises";
import { hash as passwordHash, Algorithm } from "@node-rs/argon2";
import { createRuntimePools } from "@agendia/db";
import { buildApi } from "../../apps/api/src/app.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrateDatabase, migrateDevelopmentDatabase } from "../../scripts/db/db-migrate.ts";
import { capabilities, logins, provisionLogins } from "../../scripts/db/provision-production-db.ts";
import { startTestPostgres, type TestPostgres } from "../support/postgres.ts";

let db: TestPostgres;
beforeAll(async () => { db = await startTestPostgres(); }, 120_000);
afterAll(async () => { await db?.stop(); });
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

// Each case gets a new database inside the isolated container, never the developer URL.
async function fixture(files: Record<string, string>) {
  const name = `migration_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.sql.unsafe(`create database "${name}"`);
  const url = new URL(db.container.getConnectionUri());
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1 });
  const run = () => migrateDevelopmentDatabase(url.toString(), {
    connect: (connection) => postgres(connection, { max: 1 }),
    list: () => Object.keys(files), read: (file) => files[file]!,
  });
  const snapshot = async () => ({
    objects: await sql`select c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname`,
    rows: await sql`select * from businesses order by id`,
    history: (await sql`select to_regclass('public.agendia_production_migrations') ledger`)[0]!.ledger
      ? await sql`select * from public.agendia_production_migrations order by name` : null,
  });
  return { sql, run, snapshot, url: url.toString() };
}
const base = "create table businesses(id integer primary key, counter integer not null); insert into businesses values(1,0)";

test("fresh production database migrates capabilities before provisioning logins", async () => {
  const fresh = await startTestPostgres();
  const credentials = {
    API_DB_PASSWORD: "test-api-password", ADMIN_DB_PASSWORD: "test-admin-password",
    WORKER_DB_PASSWORD: "test-worker-password", MANAGER_DB_PASSWORD: "test-manager-password",
  };
  try {
    const roles = () => fresh.sql`select rolname from pg_roles where rolname = any(${[...capabilities]}) order by rolname`;
    expect(await roles()).toHaveLength(0);
    await expect(provisionLogins(fresh.sql, credentials)).rejects.toThrow();
    expect(await fresh.sql`select rolname from pg_roles where rolname = any(${logins.map(login => login.name)})`).toHaveLength(0);
    await migrateDatabase(fresh.sql);
    expect((await roles()).map(role => role.rolname)).toEqual([...capabilities].sort());
    await provisionLogins(fresh.sql, credentials);
    for (const login of logins) {
      const memberships = await fresh.sql`select r.rolname from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles l on l.oid=m.member where l.rolname=${login.name} order by r.rolname`;
      expect(memberships.map(role => role.rolname)).toEqual([...login.roles].sort());
      const url = new URL(fresh.container.getConnectionUri());
      url.username = login.name;
      url.password = credentials[login.password];
      const connection = postgres(url.toString(), { max: 1 });
      try { expect((await connection`select current_user as name`)[0]!.name).toBe(login.name); }
      finally { await connection.end(); }
    }
  } finally { await fresh.stop(); }
}, 120_000);

test("duration upgrade preserves legacy rows and widens both constraints", async () => {
  const files: Record<string, string> = {};
  for (const name of ["0000_base.sql", "0001_remove_admin_ai_guidance.sql", "0002_agent_silent_completion.sql", "0003_session_idle_ttl.sql", "0004_registration.sql"])
    files[name] = await Bun.file(new URL(`../../packages/db/migrations/${name}`, import.meta.url)).text();
  const f = await fixture(files);
  try {
    await f.run();
    const id = crypto.randomUUID();
    await f.sql`insert into businesses(id,name) values(${id},'Legacy')`;
    const [client] = await f.sql`insert into clients(business_id,first_name,last_name,phone) values(${id},'A','B','+123456789') returning id`;
    const [resource] = await f.sql`insert into resources(business_id,name,weekly_schedule) values(${id},'Room','{}') returning id`;
    for (const duration of [15, 45]) {
      const [service] = await f.sql`insert into services(business_id,name,duration_minutes,price_ars) values(${id},${`Legacy ${duration}`},${duration},0) returning id`;
      await f.sql`insert into appointments(business_id,client_id,service_id,resource_id,service_label,resource_label,price_ars,duration_minutes,start_raw,start_ms,end_ms,state,origin)
        values(${id},${client!.id},${service!.id},${resource!.id},'Legacy','Room',0,${duration},'1970-01-01T00:00:00Z',0,${duration * 60000},'done','manual')`;
    }
    const services = [...await f.sql`select * from services order by id`];
    const appointments = [...await f.sql`select * from appointments order by id`];
    const history = [...await f.sql`select * from public.agendia_production_migrations order by name`];
    files["0005_service_duration_five_minutes.sql"] = await Bun.file(new URL("../../packages/db/migrations/0005_service_duration_five_minutes.sql", import.meta.url)).text();
    await f.run();
    expect([...await f.sql`select * from services order by id`]).toEqual(services);
    expect([...await f.sql`select * from appointments order by id`]).toEqual(appointments);
    expect([...await f.sql`select * from public.agendia_production_migrations where name <> '0005_service_duration_five_minutes.sql' order by name`]).toEqual(history);
    for (const duration of [5, 10, 15, 20, 45]) {
      await f.sql`update services set duration_minutes=${duration} where id=${services[0]!.id}`;
      await f.sql`update appointments set duration_minutes=${duration},end_ms=${duration * 60000} where id=${appointments[0]!.id}`;
    }
    for (const duration of [0, -5, 1, 16]) {
      await expect(f.sql`update services set duration_minutes=${duration} where id=${services[0]!.id}`.execute()).rejects.toMatchObject({ code: '23514' });
      await expect(f.sql`update appointments set duration_minutes=${duration},end_ms=${duration * 60000} where id=${appointments[0]!.id}`.execute()).rejects.toMatchObject({ code: '23514' });
    }
    await expect(f.sql`update appointments set duration_minutes=20,end_ms=1 where id=${appointments[0]!.id}`.execute()).rejects.toMatchObject({ code: '23514' });
    await f.run();
  } finally { await f.sql.end(); }
});

test("client-name upgrade preserves archived rows, appointment relations, and keyed history", async () => {
  const directory = new URL("../../packages/db/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
  const files: Record<string, string> = {};
  for (const name of migrations.filter(name => name < "0009"))
    files[name] = await Bun.file(new URL(name, directory)).text();
  const f = await fixture(files);
  const pools = createRuntimePools(f.url);
  const origin = "https://panel.agendia.test", app = buildApi({ pools, expectedOrigin: origin });
  try {
    await f.run();
    const [business, archived, actor, archivedActor, client, archivedClient, serviceId, resourceId, appointmentId] =
      Array.from({ length: 9 }, () => crypto.randomUUID()) as [string, string, string, string, string, string, string, string, string];
    const email = "name-upgrade@example.test", password = "isolated fixture password";
    const phc = await passwordHash(password, { algorithm: Algorithm.Argon2id });
    await f.sql`insert into businesses(id,name,status) values (${business},'Unchanged Business','active'),(${archived},'Archived Business','suspended')`;
    await f.sql`insert into auth_identities(id,normalized_email,password_phc,role,business_id) values
      (${actor},${email},${phc},'business_user',${business}),(${archivedActor},'archived@example.test',${phc},'business_user',${archived})`;
    const phone = "+5491123456789";
    await f.sql`insert into clients(id,business_id,first_name,last_name,phone) values
      (${client},${business},${" \tMaría\u00a0 José  "},${"\ufeffde\u2003  la Peña\n"},${phone}),
      (${archivedClient},${archived},' Archived  ',' Client ',${phone})`;
    await f.sql`insert into resources(id,business_id,name,weekly_schedule) values(${resourceId},${business},'Room','{}')`;
    await f.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${serviceId},${business},'Service',15,0)`;
    const startRaw = "2099-06-01T10:00:00-03:00", startMs = Date.parse(startRaw), endMs = startMs + 15 * 60000;
    await f.sql`insert into appointments(id,business_id,client_id,service_id,resource_id,service_label,resource_label,price_ars,duration_minutes,start_raw,start_ms,end_ms,state,origin)
      values(${appointmentId},${business},${client},${serviceId},${resourceId},'Service','Room',0,15,${startRaw},${startMs},${endMs},'confirmed','manual')`;
    // Seed the original canonical fingerprints, including a create without newClient that remains replayable.
    const terms = { durationMinutes: 15, priceArs: 0, resourceId, resourceName: "Room", serviceId, serviceName: "Service" };
    const payload = { confirmed: true, date: "2099-06-01", expectedTerms: terms, resourceId, serviceId, startRaw };
    const newClient = { firstName: "Snapshot", lastName: "de  Peña", phone };
    const keyed = { key: crypto.randomUUID(), fingerprint: hash(JSON.stringify({ kind: "create", payload: {
      confirmed: payload.confirmed, date: payload.date, expectedTerms: terms, newClient, resourceId, serviceId, startRaw,
    }, target: null })) };
    const existing = { key: crypto.randomUUID(), fingerprint: hash(JSON.stringify({ kind: "create", payload: { clientId: client, ...payload }, target: null })) };
    const archivedKey = crypto.randomUUID();
    const body = { id: appointmentId, client: { id: client, ...newClient }, startsAt: startRaw, startMs, endMs, terms,
      state: "confirmed", origin: "manual", notes: null, customerResourcePreference: null };
    for (const [tenant, owner, key, fingerprint] of [
      [business, actor, keyed.key, keyed.fingerprint], [business, actor, existing.key, existing.fingerprint],
      [archived, archivedActor, archivedKey, keyed.fingerprint],
    ] as const) {
      await f.sql`insert into appointment_operation_receipts(business_id,actor_id,operation_key,kind,fingerprint,state,result)
        values (${tenant},${owner},${key},'create',${fingerprint},'completed',${f.sql.json({ status: 201, body })})`;
    }
    // Retained legacy rows under a tombstone must migrate even though normal writes are blocked.
    await f.sql.begin(async tx => {
      await tx`set local role agendia_business_purge`;
      await tx`update businesses set deleted_at=now() where id=${archived}`;
    });
    const businessRows = [...await f.sql`select * from businesses order by id`];
    const appointments = [...await f.sql`select * from appointments`];
    for (const name of migrations.filter(name => name.startsWith("0009")))
      files[name] = await Bun.file(new URL(name, directory)).text();
    await f.run();
    await f.run(); // Repeating the upgrade cannot normalize or rewrite the new schema again.
    const clientRows = await f.sql`select * from clients`;
    expect(clientRows).toHaveLength(2);
    expect(clientRows.find(row => row.id === client)).toEqual({ id: client, business_id: business, name: "María José de la Peña", phone });
    expect(clientRows.find(row => row.id === archivedClient)).toEqual({ id: archivedClient, business_id: archived, name: "Archived Client", phone });
    expect([...await f.sql`select * from appointments`]).toEqual(appointments);
    expect([...await f.sql`select * from businesses order by id`]).toEqual(businessRows);
    const receiptRows = () => f.sql`select operation_key,fingerprint,result from appointment_operation_receipts order by operation_key`;
    const rows = await receiptRows();
    const migrated = { ...body, client: { id: client, name: "Snapshot de Peña", phone } };
    for (const [key, fingerprint] of [[keyed.key, keyed.fingerprint], [existing.key, existing.fingerprint], [archivedKey, keyed.fingerprint]]) {
      expect(rows.find(row => row.operation_key === key)).toEqual({ operation_key: key, fingerprint, result: { status: 201, body: migrated } });
    }
    await expect(f.sql`update clients set name='blocked' where id=${archivedClient}`.execute()).rejects.toThrow("business is deleted");
    await expect(f.sql`update appointment_operation_receipts set result=result where operation_key=${archivedKey}`.execute()).rejects.toThrow("business is deleted");
    const login = await app.inject({ method: "POST", url: "/auth/login", headers: { origin }, payload: { email, password } });
    expect(login.statusCode).toBe(200);
    const cookie = ([login.headers["set-cookie"]].flat()[0] as string).split(";")[0]!;
    const headers = { cookie, origin, "x-csrf-token": login.json().csrfToken };
    const receipt = await app.inject({ method: "GET", url: `/me/appointment-operations/${keyed.key}`, headers });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toEqual({ key: keyed.key, businessId: business, identityId: actor, state: "completed", kind: "create", target: null,
      httpStatus: 201, appointment: migrated, error: null });
    const counts = () => f.sql`select (select count(*) from clients) clients, (select count(*) from appointments) appointments,
      (select count(*) from audit_events where event_type like 'appointment.%') audit,
      (select count(*) from outbox_events where topic like 'appointment.%') outbox`;
    const before = await counts();
    const replay = (key: string, fields: object) => app.inject({ method: "POST", url: "/me/appointments",
      headers: { ...headers, "x-appointment-operation-key": key }, payload: { ...payload, ...fields } });
    const unchanged = await replay(existing.key, { clientId: client });
    expect(unchanged.statusCode).toBe(201);
    expect(unchanged.json()).toEqual(migrated);
    const conflict = await replay(keyed.key, { newClient: { name: "Snapshot de Peña", phone } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: "CONFLICT", message: "Operation key payload differs" });
    expect(await counts()).toEqual(before);
    expect(await receiptRows()).toEqual(rows);
  } finally { await app.close(); await pools.end(); await f.sql.end(); }
}, 30_000);

// Exercise both real CLI entrypoints and module-relative SQL discovery in isolation.
test("production CLI migrates from another cwd and development CLI repeats without mutation", async () => {
  const name = `cli_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.sql.unsafe(`create database "${name}"`);
  const url = new URL(db.container.getConnectionUri());
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1 });
  const cwd = await mkdtemp(join(tmpdir(), "agendia-migration-cli-"));
  async function cli(file: string, args: string[]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "run", fileURLToPath(new URL(`../../scripts/db/${file}`, import.meta.url)), ...args], {
      cwd, env: { DATABASE_URL: url.toString() }, stdout: "pipe", stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(), child.exited, new Response(child.stdout).text(),
    ]);
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 });
  }
  try {
    await cli("provision-production-db.ts", ["migrate"]);
    const history = await sql`select * from public.agendia_production_migrations order by name`;
    expect(history.length).toBeGreaterThan(0);
    await cli("db-migrate.ts", []);
    expect([...(await sql`select * from public.agendia_production_migrations order by name`)]).toEqual([...history]);
  } finally {
    await sql.end();
    await rmdir(cwd);
  }
}, 30_000);

test("fresh SQL is ordered, repeat is unchanged, then only pending SQL is applied", async () => {
  const files = { "02.sql": "update businesses set counter=counter+1", "01.sql": base, "notes.md": "invalid sql" };
  const f = await fixture(files);
  try {
    await f.run();
    expect((await f.sql`select counter from businesses`)[0]!.counter).toBe(1);
    expect((await f.sql`select name,checksum from public.agendia_production_migrations order by name`).map(r => [r.name,r.checksum]))
      .toEqual([["01.sql",hash(base)],["02.sql",hash(files["02.sql"])]]);
    const before = await f.snapshot();
    await f.run();
    expect(await f.snapshot()).toEqual(before);
    Object.assign(files, { "03.sql": "update businesses set counter=counter+10" });
    await f.run();
    expect((await f.sql`select counter from businesses`)[0]!.counter).toBe(11);
    expect(await f.sql`select name from public.agendia_production_migrations`).toHaveLength(3);
  } finally { await f.sql.end(); }
});

for (const kind of ["changed", "unknown", "missing ledger", "empty ledger"] as const) {
  test(`${kind} rejects before changing schema, data, counters or history`, async () => {
    const files: Record<string,string> = { "01.sql": base };
    const f = await fixture(files);
    try {
      await f.sql.unsafe(base);
      if (kind !== "missing ledger") {
        await f.sql`create table public.agendia_production_migrations(name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
        if (kind !== "empty ledger") await f.sql`insert into public.agendia_production_migrations(name,checksum) values(${kind === "unknown" ? "unknown.sql" : "01.sql"},${kind === "changed" ? "wrong" : hash(base)})`;
      }
      // Sorts BEFORE the changed applied file, catching execute-then-validate implementations.
      files["00.sql"] = "create table should_not_exist(id integer); update businesses set counter=counter+100";
      const before = await f.snapshot();
      await expect(f.run()).rejects.toThrow(kind === "changed" ? "Applied migration changed"
        : kind === "unknown" ? "Applied migration is missing from migration files"
        : "Migration history is required for an initialized database");
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.sql.end(); }
  });
}

test("batch failure rolls back new SQL and history, preserving previous data and counters", async () => {
  const files: Record<string,string> = { "01.sql": base };
  const f = await fixture(files);
  try {
    await f.run();
    const before = await f.snapshot();
    files["02.sql"] = "create table should_not_exist(id integer); update businesses set counter=counter+100";
    files["03.sql"] = "select definitely_not_a_function()";
    await expect(f.run()).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
  } finally { await f.sql.end(); }
});

test("existing production ledger with original source SHA256 remains compatible", async () => {
  const files = { "01.sql": base, "02.sql": "update businesses set counter=counter+1" };
  const f = await fixture(files);
  try {
    await f.sql.unsafe(base);
    await f.sql`create table public.agendia_production_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())`;
    await f.sql`insert into public.agendia_production_migrations(name,checksum) values('01.sql',${hash(base)})`;
    const original = await f.sql`select * from public.agendia_production_migrations`;
    await f.run();
    expect([...(await f.sql`select * from public.agendia_production_migrations where name='01.sql'`)]).toEqual([...original]);
    expect((await f.sql`select counter from businesses`)[0]!.counter).toBe(1);
    expect(await f.sql`select name from public.agendia_production_migrations`).toHaveLength(2);
  } finally { await f.sql.end(); }
});
