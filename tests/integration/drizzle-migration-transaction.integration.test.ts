import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import postgres, { type Sql } from "postgres";
import { migrateDatabase } from "../../scripts/db/db-migrate.ts";
import { capabilities, provisionLogins } from "../../scripts/db/provision-production-db.ts";
import { startTestPostgres, type TestPostgres } from "../support/postgres.ts";

let database: TestPostgres;
let nextDatabase = 0;
beforeAll(async () => { database = await startTestPostgres(); }, 120_000);
afterAll(async () => { await database?.stop(); });
const base = "create table proof (value text primary key, pid integer not null);\n--> statement-breakpoint\ninsert into proof values ('base', pg_backend_pid());";
const next = "insert into proof values ('next', pg_backend_pid());";
const failure = "create table pending_ddl (id integer);\n--> statement-breakpoint\nselect deliberately_missing_function();";
const hash = (source: string) => createHash("sha256").update(source).digest("hex");

async function fixture(sources: string[], body: (f: {
  url: string; folder: string; observer: Sql; client: Client;
  run: () => Promise<void>; journal: { version: string; dialect: string; entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean; sha256: string }[] };
}) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "agendia-drizzle-transaction-"));
  const name = `migration_transaction_${++nextDatabase}`;
  await database.sql`create database ${database.sql(name)}`;
  const url = new URL(database.container.getConnectionUri());
  url.pathname = `/${name}`;
  const observer = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const client = new Client({ connectionString: url.toString(), application_name: "agendia-db-migrate" });
  try {
    await mkdir(join(folder, "meta"));
    const journal = { version: "7", dialect: "postgresql", entries: sources.map((source, idx) => ({
      idx, version: "7", when: 1700000000000 + idx, tag: `000${idx}_proof`, breakpoints: true, sha256: hash(source),
    })) };
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    await Promise.all(sources.map((source, idx) => writeFile(join(folder, `000${idx}_proof.sql`), source)));
    // Each invocation gets a new dedicated client. The first remains observable for loss tests.
    let first = true;
    const run = () => migrateDatabase(url.toString(), { migrationsFolder: folder, connect: connection => {
      if (first) { first = false; return client; }
      return new Client({ connectionString: connection, application_name: "agendia-db-migrate" });
    } });
    await body({ url: url.toString(), folder, observer, client, run, journal });
  } finally {
    await client.end(); await observer.end(); await rm(folder, { recursive: true, force: true });
  }
}
async function legacy(observer: Sql) {
  await observer.unsafe(base);
  await observer`create table public.agendia_production_migrations
    (name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
  await observer`insert into public.agendia_production_migrations(name,checksum) values('0000_proof.sql',${hash(base)})`;
}
async function snapshot(observer: Sql) {
  const [objects] = await observer`select to_regclass('public.proof') proof,to_regclass('public.pending_ddl') pending,
    to_regclass('drizzle.__drizzle_migrations') ledger,to_regnamespace('drizzle') schema,
    to_regclass('public.agendia_production_migrations') legacy`;
  return {
    objects,
    rows: objects!.proof ? [...await observer`select * from proof order by value`] : null,
    legacy: objects!.legacy ? [...await observer`select * from public.agendia_production_migrations order by name`] : null,
    ledger: objects!.ledger ? [...await observer`select * from drizzle.__drizzle_migrations order by id`] : null,
    counter: objects!.ledger ? [...await observer`select * from drizzle.__drizzle_migrations_id_seq`] : null,
  };
}
async function released(observer: Sql) {
  expect([...(await observer`select pg_try_advisory_lock(hashtext('agendia:production-setup')) acquired`)]).toEqual([{ acquired: true }]);
  await observer`select pg_advisory_unlock(hashtext('agendia:production-setup'))`;
  expect(await observer`select pid from pg_stat_activity where application_name='agendia-db-migrate'`).toHaveLength(0);
}
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected database boundary was not reached");
}

test("public executor keeps one backend, complete stock hashes and idempotent counters", async () => {
  await fixture([base, next], async ({ run, observer, journal }) => {
    await run();
    const before = await snapshot(observer);
    expect(before.rows).toHaveLength(2);
    expect(new Set(before.rows!.map(row => row.pid)).size).toBe(1);
    expect(before.ledger).toEqual(journal.entries.map((entry, idx) => ({ id: idx + 1, hash: entry.sha256, created_at: String(entry.when) })));
    await run();
    expect(await snapshot(observer)).toEqual(before);
    await released(observer);
  });
});
for (const adopt of [false, true]) {
  test(`public executor rolls back pending batch DDL, bootstrap and adoption (legacy=${adopt})`, async () => {
    await fixture([base, next, failure], async ({ observer, run }) => {
      if (adopt) await legacy(observer);
      const before = await snapshot(observer);
      await expect(run()).rejects.toThrow();
      expect(await snapshot(observer)).toEqual(before);
      await released(observer);
    });
  });
}

test("already adopted pending-batch failure preserves records and history (sequences may advance on rollback)", async () => {
  await fixture([base], async ({ observer, run, folder, journal }) => {
    await run();
    const before = await snapshot(observer);
    for (const [idx, source] of [[1, next], [2, failure]] as const) {
      journal.entries.push({ idx, version: "7", when: 1700000000000 + idx, tag: `000${idx}_proof`, breakpoints: true, sha256: hash(source) });
      await writeFile(join(folder, `000${idx}_proof.sql`), source);
    }
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    await expect(run()).rejects.toThrow();
    const after = await snapshot(observer);
    // PostgreSQL sequences are nontransactional; a failed stock insert can consume an ID.
    expect({ ...after, counter: null }).toEqual({ ...before, counter: null });
    const repaired = "insert into proof values('recovered',pg_backend_pid());";
    journal.entries[2]!.sha256 = hash(repaired);
    await writeFile(join(folder, "0002_proof.sql"), repaired);
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    await run();
    const recovered = await snapshot(observer);
    expect(recovered.rows).toHaveLength(3);
    expect(recovered.ledger!.map(row => row.id)).toEqual([1, 3, 4]);
    await run();
    expect(await snapshot(observer)).toEqual(recovered);
    await released(observer);
  });
});

for (const corruption of ["index", "timestamp", "unsafe timestamp", "tag", "hash", "extra file", "missing file", "duplicate timestamp", "duplicate tag", "order"] as const) {
  test(`journal/source ${corruption} rejects before any stored changes`, async () => {
    await fixture([base], async ({ observer, run, folder, journal }) => {
      await legacy(observer);
      const before = await snapshot(observer);
      if (corruption === "index") journal.entries[0]!.idx = 1;
      if (corruption === "timestamp") journal.entries[0]!.when = 0;
      if (corruption === "unsafe timestamp") journal.entries[0]!.when = Number.MAX_SAFE_INTEGER + 1;
      if (corruption === "tag") journal.entries[0]!.tag = "../escape";
      if (corruption === "hash") await writeFile(join(folder, "0000_proof.sql"), base + " select 1;");
      if (corruption === "extra file") await writeFile(join(folder, "extra.sql"), next);
      if (corruption === "missing file") journal.entries[0]!.tag = "missing";
      if (["duplicate timestamp", "duplicate tag", "order"].includes(corruption)) {
        const first = journal.entries[0]!;
        journal.entries.push({ ...first, idx: 1, tag: "0001_proof", when: first.when + 1, sha256: hash(next) });
        await writeFile(join(folder, "0001_proof.sql"), next);
        if (corruption === "duplicate timestamp") journal.entries[1]!.when = first.when;
        if (corruption === "duplicate tag") journal.entries[1]!.tag = first.tag;
        if (corruption === "order") journal.entries.reverse();
      }
      await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
      await expect(run()).rejects.toThrow(corruption === "hash" ? "Migration source does not match journal checksum" : "Migration journal or file set is invalid");
      expect(await snapshot(observer)).toEqual(before);
    });
  });
}

test("two actual runners and actual provisioning contend on the exact same advisory key", async () => {
  await fixture([base, next], async ({ observer, run, url }) => {
    for (const role of capabilities) await observer.unsafe(`do $$ begin create role ${role} nologin; exception when duplicate_object then null; end $$`);
    await observer`select pg_advisory_lock(hashtext('agendia:production-setup'))`;
    const provision = postgres(url, { max: 1, onnotice: () => {} });
    const pending = [run(), run(), provisionLogins(provision, {
      API_DB_PASSWORD: "test-api", ADMIN_DB_PASSWORD: "test-admin", WORKER_DB_PASSWORD: "test-worker", MANAGER_DB_PASSWORD: "test-manager",
    })];
    // Attach rejection handling immediately, even if the observation fails.
    const completed = Promise.allSettled(pending);
    try {
      await waitFor(async () => Number((await observer`select count(*) n from pg_locks where locktype='advisory' and not granted`)[0]!.n) === 3);
      expect((await snapshot(observer)).objects!.proof).toBeNull();
      expect(await observer`select rolname from pg_roles where rolname='agendia_api'`).toHaveLength(0);
    } finally { await observer`select pg_advisory_unlock(hashtext('agendia:production-setup'))`; }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    await provision.end();
    expect((await snapshot(observer)).rows).toHaveLength(2);
    expect(new Set((await snapshot(observer)).rows!.map(row => row.pid)).size).toBe(1);
    await released(observer);
  });
});

test("real disconnect before stock execution cannot reconnect or continue unlocked", async () => {
  await fixture([base, next], async ({ observer, run, url, client }) => {
    await legacy(observer);
    const before = await snapshot(observer);
    const blocker = new Client({ connectionString: url });
    await blocker.connect();
    await blocker.query("begin");
    await blocker.query("lock public.agendia_production_migrations in access exclusive mode");
    const pending = run();
    const outcome = pending.catch(error => error);
    try {
      let pid = 0;
      await waitFor(async () => {
        const rows = await observer`select pid from pg_stat_activity where application_name='agendia-db-migrate' and wait_event_type='Lock'`;
        pid = rows[0]?.pid ?? 0;
        return pid > 0;
      });
      expect([...(await observer`select pg_terminate_backend(${pid}) terminated`)]).toEqual([{ terminated: true }]);
      expect((await outcome).message).toBe("Migration connection lost before stock execution; transaction aborted");
      await expect(client.query("select 'unlocked replacement'" )).rejects.toThrow();
    } finally { await blocker.query("rollback"); await blocker.end(); }
    expect(await snapshot(observer)).toEqual(before);
    await released(observer);
  });
});

test("public client idle-error event is consumed and prevents entry into stock execution", async () => {
  await fixture([base, next], async ({ observer, run, client }) => {
    const before = await snapshot(observer);
    client.once("connect", () => { client.emit("error", new Error("injected idle error with withheld details")); });
    await expect(run()).rejects.toThrow("Migration connection lost before stock execution; transaction aborted");
    await expect(client.query("select 'unlocked replacement'")).rejects.toThrow();
    expect(await snapshot(observer)).toEqual(before);
    await released(observer);
  });
});

test("disconnect at the public adoption/bootstrap boundary rolls back without entering stock", async () => {
  await fixture([base, next], async ({ observer, run, client }) => {
    await legacy(observer);
    await observer`create schema drizzle`;
    const before = await snapshot(observer);
    let closed: Promise<void> | undefined;
    // pg's public NOTICE event exposes the existing-schema boundary before adoption DDL.
    client.once("notice", () => { closed = client.end(); });
    await expect(run()).rejects.toThrow("Migration connection lost before stock execution; transaction aborted");
    await closed;
    await expect(client.query("select 'unlocked replacement'")).rejects.toThrow();
    expect(await snapshot(observer)).toEqual(before);
    await released(observer);
  });
});

test("connect failure never queues a rollback on an unconnected public client", async () => {
  await fixture([base], async ({ observer, folder, url }) => {
    const failed = new Client({ connectionString: url });
    failed.connect = async () => { throw new Error("injected connection failure"); };
    let queries = 0;
    failed.on("connect", () => { queries++; });
    const before = await snapshot(observer);
    await expect(migrateDatabase(url, { migrationsFolder: folder, connect: () => failed })).rejects.toThrow("injected connection failure");
    expect(queries).toBe(0);
    expect(await snapshot(observer)).toEqual(before);
  });
});

test("real disconnect inside stock SQL preserves unknown-outcome diagnosis and rolls back this pre-COMMIT injection", async () => {
  const disconnect = "create table pending_ddl(id integer);\n--> statement-breakpoint\nselect pg_terminate_backend(pg_backend_pid());\n--> statement-breakpoint\ninsert into proof values('must-not-continue',pg_backend_pid());";
  await fixture([base, disconnect], async ({ observer, run, client }) => {
    const before = await snapshot(observer);
    await expect(run()).rejects.toThrow("Migration connection lost; durable outcome requires reconciliation");
    await expect(client.query("select 'unlocked replacement'")).rejects.toThrow();
    expect(await snapshot(observer)).toEqual(before);
    await released(observer);
  });
});

test("stock authority advances while adopted legacy evidence stays frozen", async () => {
  await fixture([base], async ({ observer, run, folder, journal }) => {
    await legacy(observer);
    await run();
    const adopted = await snapshot(observer);
    journal.entries.push({ idx: 1, version: "7", when: 1700000000001,
      tag: "0001_proof", breakpoints: true, sha256: hash(next) });
    await writeFile(join(folder, "0001_proof.sql"), next);
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify(journal));
    await run();
    const advanced = await snapshot(observer);
    expect(advanced.legacy).toEqual(adopted.legacy);
    expect(advanced.rows).toHaveLength(2);
    expect(advanced.ledger!.map(row => row.hash)).toEqual([hash(base), hash(next)]);
    await run();
    expect(await snapshot(observer)).toEqual(advanced);
    await released(observer);
  });
});
