import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
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
  const folder = await mkdtemp(join(tmpdir(), "agendia-migration-fixture-"));
  await mkdir(join(folder, "meta"));
  const run = async () => {
    const names = Object.keys(files).filter(name => name.endsWith(".sql")).sort();
    await Promise.all(names.map(name => writeFile(join(folder, name), files[name]!)));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({
      version: "7", dialect: "postgresql", entries: names.map((name, idx) => ({
        idx, version: "7", when: 1700000000000 + idx, tag: name.slice(0, -4),
        breakpoints: true, sha256: hash(files[name]!),
      })),
    }));
    await migrateDevelopmentDatabase(url.toString(), {
      connect: connection => new Client({ connectionString: connection }), migrationsFolder: folder,
    });
  };
  const close = async () => { await sql.end(); await rm(folder, { recursive: true, force: true }); };
  const snapshot = async () => ({
    objects: await sql`select c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname`,
    rows: await sql`select * from businesses order by id`,
    history: (await sql`select to_regclass('public.agendia_production_migrations') ledger`)[0]!.ledger
      ? [...await sql`select * from public.agendia_production_migrations order by name`] : null,
    drizzle: (await sql`select to_regclass('drizzle.__drizzle_migrations') ledger`)[0]!.ledger
      ? [...await sql`select * from drizzle.__drizzle_migrations order by id`] : null,
  });
  return { sql, run, snapshot, close };
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
    await migrateDatabase(fresh.container.getConnectionUri());
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
    const history = [...await f.sql`select * from drizzle.__drizzle_migrations order by id`];
    files["0005_service_duration_five_minutes.sql"] = await Bun.file(new URL("../../packages/db/migrations/0005_service_duration_five_minutes.sql", import.meta.url)).text();
    await f.run();
    expect([...await f.sql`select * from services order by id`]).toEqual(services);
    expect([...await f.sql`select * from appointments order by id`]).toEqual(appointments);
    expect([...await f.sql`select * from drizzle.__drizzle_migrations where id <= 5 order by id`]).toEqual(history);
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
  } finally { await f.close(); }
});

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
    const [stderr, code, stdout] = await Promise.all([
      new Response(child.stderr).text(), child.exited, new Response(child.stdout).text(),
    ]);
    expect({ stderr, code, stdout }).toEqual({ stderr: "", code: 0,
      stdout: file === "db-migrate.ts" ? "Pending database migrations applied.\n" : "Production database setup completed\n" });
  }
  try {
    await cli("provision-production-db.ts", ["migrate"]);
    const history = await sql`select * from drizzle.__drizzle_migrations order by id`;
    expect(history.length).toBeGreaterThan(0);
    await cli("db-migrate.ts", []);
    expect([...(await sql`select * from drizzle.__drizzle_migrations order by id`)]).toEqual([...history]);
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
    expect((await f.sql`select hash from drizzle.__drizzle_migrations order by id`).map(r => r.hash))
      .toEqual([hash(base),hash(files["02.sql"])]);
    const before = await f.snapshot();
    await f.run();
    expect(await f.snapshot()).toEqual(before);
    Object.assign(files, { "03.sql": "update businesses set counter=counter+10" });
    await f.run();
    expect((await f.sql`select counter from businesses`)[0]!.counter).toBe(11);
    expect(await f.sql`select id from drizzle.__drizzle_migrations`).toHaveLength(3);
  } finally { await f.close(); }
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
    } finally { await f.close(); }
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
  } finally { await f.close(); }
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
    expect(await f.sql`select name from public.agendia_production_migrations`).toHaveLength(1);
    expect(await f.sql`select id from drizzle.__drizzle_migrations`).toHaveLength(2);
  } finally { await f.close(); }
});
