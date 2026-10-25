import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrateDevelopmentDatabase } from "../../scripts/db/db-migrate.ts";
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
  return { sql, run, snapshot };
}
const base = "create table businesses(id integer primary key, counter integer not null); insert into businesses values(1,0)";

// Exercise both real CLI entrypoints and module-relative SQL discovery in isolation.
test("production CLI migrates from another cwd and development CLI repeats without mutation", async () => {
  const name = `cli_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.sql.unsafe(`create database "${name}"`);
  const url = new URL(db.container.getConnectionUri());
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1 });
  const cwd = await mkdtemp(join(tmpdir(), "agendia-migration-cli-"));
  async function cli(file: string, args: string[], expected: string) {
    const child = Bun.spawn([process.execPath, "run", fileURLToPath(new URL(`../../scripts/db/${file}`, import.meta.url)), ...args], {
      cwd, env: { ...process.env, DATABASE_URL: url.toString() }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ stdout, stderr, code }).toEqual({ stdout: `${expected}\n`, stderr: "", code: 0 });
  }
  try {
    await cli("provision-production-db.ts", ["migrate"], "Production database setup completed");
    const history = await sql`select * from public.agendia_production_migrations order by name`;
    expect(history.length).toBeGreaterThan(0);
    await cli("db-migrate.ts", [], "Pending database migrations applied.");
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
