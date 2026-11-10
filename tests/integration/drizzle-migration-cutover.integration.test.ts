import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { tableCatalog } from "../support/drizzle-schema-parity.ts";
import { startTestPostgres, type TestPostgres } from "../support/postgres.ts";

const folder = fileURLToPath(new URL("../../packages/db/migrations/", import.meta.url));
const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as {
  version: string; dialect: string; entries: { idx: number; tag: string; sha256: string; when: number }[];
};
async function cli(db: TestPostgres, production = false) {
  const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL(
    `../../scripts/db/${production ? "provision-production-db" : "db-migrate"}.ts`, import.meta.url)), ...(production ? ["migrate"] : [])], {
    env: { DATABASE_URL: db.container.getConnectionUri() }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
const success = (production = false) => ({ stdout: production ? "Production database setup completed\n" : "Pending database migrations applied.\n", stderr: "", code: 0 });
const expectedHistory = journal.entries.map((entry, idx) => ({ id: idx + 1, hash: entry.sha256, created_at: String(entry.when) }));

async function catalog(db: TestPostgres) {
  const inventory = [...await db.sql`select relname,relkind::text,relrowsecurity,relforcerowsecurity,relacl::text
    from pg_class where relnamespace='public'::regnamespace and relkind in ('r','v')
    and relname <> 'agendia_production_migrations' order by relname`];
  return {
    inventory,
    tables: await Promise.all(inventory.map(row => tableCatalog(db.sql, "public", row.relname))),
    routines: [...await db.sql`select proname,pg_get_function_identity_arguments(oid) args,
      pg_get_functiondef(oid) definition,pg_get_userbyid(proowner) owner,proacl::text
      from pg_proc where pronamespace='public'::regnamespace and prokind='f' order by proname,args`],
    triggers: [...await db.sql`select c.relname,t.tgname,pg_get_triggerdef(t.oid) definition from pg_trigger t
      join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by c.relname,t.tgname`],
    roles: [...await db.sql`select rolname,rolcanlogin,rolsuper,rolcreaterole,rolbypassrls from pg_roles where rolname like 'agendia_%' order by rolname`],
  };
}
let expectedCatalog: Awaited<ReturnType<typeof catalog>>;

test("actual development CLI executes all historical SQL through the stock Drizzle ledger", async () => {
  const db = await startTestPostgres();
  try {
    expect(await cli(db)).toEqual(success());
    expect([...await db.sql`select * from drizzle.__drizzle_migrations order by id`]).toEqual(expectedHistory);
    expect((await db.sql`select to_regclass('public.agendia_production_migrations') legacy`)[0]!.legacy).toBeNull();
    expectedCatalog = await catalog(db);
    const counter = [...await db.sql`select * from drizzle.__drizzle_migrations_id_seq`];
    expect(await cli(db, true)).toEqual(success(true));
    expect([...await db.sql`select * from drizzle.__drizzle_migrations order by id`]).toEqual(expectedHistory);
    expect([...await db.sql`select * from drizzle.__drizzle_migrations_id_seq`]).toEqual(counter);
    expect(await catalog(db)).toEqual(expectedCatalog);
  } finally { await db.stop(); }
}, 30_000);

for (const entry of journal.entries) {
  test(`actual legacy prefix through ${entry.tag} adopts without replay and executes the real suffix`, async () => {
    const db = await startTestPostgres();
    const subset = await mkdtemp(join(tmpdir(), "agendia-legacy-prefix-"));
    const client = new Client({ connectionString: db.container.getConnectionUri() });
    try {
      await mkdir(join(subset, "meta"));
      const entries = journal.entries.slice(0, entry.idx + 1);
      await writeFile(join(subset, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const source of entries) await writeFile(join(subset, `${source.tag}.sql`), readFileSync(join(folder, `${source.tag}.sql`)));
      await client.connect();
      // Only fixture preparation uses another stock ledger; SQL is never applied directly.
      await migrate(drizzle(client), { migrationsFolder: subset, migrationsSchema: "fixture_execution" });
      await db.sql`create table public.agendia_production_migrations
        (name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
      for (const source of entries) await db.sql`insert into public.agendia_production_migrations(name,checksum) values(${source.tag + ".sql"},${source.sha256})`;
      const id = crypto.randomUUID(), other = crypto.randomUUID();
      await db.sql`insert into businesses(id,name) values(${id},'Legacy'),(${other},'Other')`;
      await db.sql`insert into business_profiles(business_id,display_name) values(${id},'Retained'),(${other},'Hidden')`;
      await db.sql`insert into services(business_id,name,duration_minutes,price_ars) values(${id},'Legacy service',15,1234)`;
      const records = async () => ({
        businesses: [...await db.sql`select id,name,status from businesses order by id`],
        profiles: [...await db.sql`select * from business_profiles order by business_id`],
        services: [...await db.sql`select id,business_id,name,duration_minutes,price_ars,normalized_name,status from services order by id`],
        throttle: [...await db.sql`select * from login_throttle_global`],
      });
      const before = await records();
      const legacy = [...await db.sql`select * from public.agendia_production_migrations order by name`];
      expect(await cli(db)).toEqual(success());
      expect(await records()).toEqual(before);
      expect([...await db.sql`select * from drizzle.__drizzle_migrations order by id`]).toEqual(expectedHistory);
      expect([...await db.sql`select * from public.agendia_production_migrations order by name`]).toEqual(legacy);
      expect(await catalog(db)).toEqual(expectedCatalog);
      await db.sql.begin(async tx => {
        await tx`set local role agendia_runtime`;
        await tx`select set_config('app.tenant_id',${id},true)`;
        expect([...await tx`select business_id from business_profiles`]).toEqual([{ business_id: id }]);
        await expect(tx`update business_profiles set business_id=${other} where business_id=${id}`.execute()).rejects.toMatchObject({ code: "42501" });
        throw new Error("rollback security probe");
      }).catch(error => { if (error.message !== "rollback security probe") throw error; });
      const counter = [...await db.sql`select * from drizzle.__drizzle_migrations_id_seq`];
      expect(await cli(db, true)).toEqual(success(true));
      expect(await records()).toEqual(before);
      expect([...await db.sql`select * from public.agendia_production_migrations order by name`]).toEqual(legacy);
      expect([...await db.sql`select * from drizzle.__drizzle_migrations order by id`]).toEqual(expectedHistory);
      expect([...await db.sql`select * from drizzle.__drizzle_migrations_id_seq`]).toEqual(counter);
    } finally {
      await client.end(); await db.stop(); await rm(subset, { recursive: true, force: true });
    }
  }, 30_000);
}

test("actual CLIs reject corrupt, gapped, unknown and missing histories without any stored changes", async () => {
  const db = await startTestPostgres();
  try {
    expect(await cli(db)).toEqual(success());
    await db.sql`insert into businesses(id,name) values(${crypto.randomUUID()},'Preserved')`;
    await db.sql`create table public.agendia_production_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())`;
    const snapshot = async () => ({
      catalog: await catalog(db), rows: [...await db.sql`select * from businesses`],
      legacy: [...await db.sql`select * from public.agendia_production_migrations order by name`],
      ledger: [...await db.sql`select * from drizzle.__drizzle_migrations order by id`],
      counter: [...await db.sql`select * from drizzle.__drizzle_migrations_id_seq`],
      throttle: [...await db.sql`select * from login_throttle_global`],
    });
    const cases = [
      { sql: "update drizzle.__drizzle_migrations set hash='wrong' where id=1", message: "Drizzle history is not an unchanged chronological prefix" },
      { sql: "update drizzle.__drizzle_migrations set created_at=created_at+1 where id=1", message: "Drizzle history is not an unchanged chronological prefix" },
      { sql: "delete from drizzle.__drizzle_migrations where id=2", message: "Drizzle history is not an unchanged chronological prefix" },
      { sql: "insert into drizzle.__drizzle_migrations(hash,created_at) values('unknown',1800000000000)", message: "Drizzle history is not an unchanged chronological prefix" },
      { sql: "update drizzle.__drizzle_migrations set created_at=1700000000000 where id=2", message: "Drizzle history is not an unchanged chronological prefix" },
      { sql: "delete from drizzle.__drizzle_migrations", message: "Migration history is required for an initialized database" },
      { sql: `insert into public.agendia_production_migrations(name,checksum) values ${journal.entries.map(entry => `('${entry.tag}.sql','${entry.sha256}')`).join(",")}; delete from drizzle.__drizzle_migrations where id>1`, message: "Conflicting migration histories" },
      { sql: `insert into public.agendia_production_migrations(name,checksum) values('unknown.sql','wrong')`, message: "Applied migration is missing from migration files" },
      { sql: `insert into public.agendia_production_migrations(name,checksum) values('${journal.entries[0]!.tag}.sql','wrong')`, message: "Applied migration changed" },
      { sql: `insert into public.agendia_production_migrations(name,checksum) values('${journal.entries[1]!.tag}.sql','${journal.entries[1]!.sha256}')`, message: "Legacy history is not an unchanged chronological prefix" },
    ];
    for (const scenario of cases) {
      await db.sql.unsafe(scenario.sql);
      const before = await snapshot();
      for (const production of [false, true]) expect(await cli(db, production)).toEqual({ code: 1, stdout: "", stderr: scenario.message + "\n" });
      expect(await snapshot()).toEqual(before);
      // Restore only the deliberately corrupted fixture history, never the acceptance runner.
      await db.sql`delete from public.agendia_production_migrations`;
      await db.sql`delete from drizzle.__drizzle_migrations`;
      for (const row of expectedHistory) await db.sql`insert into drizzle.__drizzle_migrations(id,hash,created_at) values(${row.id},${row.hash},${row.created_at})`;
    }
  } finally { await db.stop(); }
}, 30_000);
