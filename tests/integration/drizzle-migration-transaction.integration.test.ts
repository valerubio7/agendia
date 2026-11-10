import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import postgres, { type Sql } from "postgres";
import { startTestPostgres, type TestPostgres } from "../support/postgres.ts";

let database: TestPostgres;
let nextDatabase = 0;
beforeAll(async () => { database = await startTestPostgres(); }, 120_000);
afterAll(async () => { await database?.stop(); });

const base = "create table proof (value text primary key, pid integer not null);\n--> statement-breakpoint\ninsert into proof values ('base', pg_backend_pid());";
const next = "insert into proof values ('next', pg_backend_pid());";
const failure = "create table pending_ddl (id integer);\n--> statement-breakpoint\nselect deliberately_missing_function();";
const lock = "select pg_advisory_lock(hashtext('agendia:production-setup'))";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(sources: string[], run: (url: string, folder: string, observer: Sql) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "agendia-drizzle-proof-"));
  const name = `migration_proof_${++nextDatabase}`;
  await database.sql`create database ${database.sql(name)}`;
  const url = new URL(database.container.getConnectionUri());
  url.pathname = `/${name}`;
  const observer = postgres(url.toString(), { max: 1 });
  try {
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({
      version: "7", dialect: "postgresql", entries: sources.map((_, idx) => ({
        idx, version: "7", when: 1000 + idx, tag: `000${idx}_proof`, breakpoints: true,
      })),
    }));
    await Promise.all(sources.map((source, idx) => writeFile(join(folder, `000${idx}_proof.sql`), source)));
    await run(url.toString(), folder, observer);
  } finally {
    await observer.end();
    await rm(folder, { recursive: true, force: true });
  }
}

type History = { name: string; checksum: string };
type Ledger = { hash: string; created_at: string };

// Test-only candidate: dedicated, non-reconnecting session; no runtime cutover.
async function coordinate(url: string, folder: string, hooks: {
  locked?: (client: Client, pid: number) => Promise<void>;
  beforeStock?: (client: Client, pid: number, stopped: Promise<void>) => Promise<void>;
  afterLoss?: (client: Client) => Promise<void>;
  query?: (query: string) => void;
} = {}) {
  let lost = false;
  let finishing = false;
  let held = false;
  let committed = false;
  let stockStarted = false;
  const closed = signal();
  const client = new Client({
    connectionString: url,
    application_name: "agendia-stock-migration-proof",
  });
  // pg reports idle errors via events and active-query errors via query rejection.
  client.on("error", () => { lost = true; });
  client.on("end", () => {
    if (!finishing) lost = true;
    closed.resolve();
  });
  let shutdown: Promise<void> | undefined;
  function stop() {
    finishing = true;
    return shutdown ??= client.end();
  }
  try {
    await client.connect();
    const { rows: [{ pid } = { pid: 0 }] } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    hooks.query?.(lock);
    await client.query(lock);
    held = true;
    await hooks.locked?.(client, pid);
    if (lost) throw new Error("Session lost before transaction");
    // Stock BEGIN nests without a savepoint; stock COMMIT ends this outer transaction.
    await client.query("BEGIN");
    const migrations = readMigrationFiles({ migrationsFolder: folder });
    const { rows: [{ legacy, ledger } = { legacy: null, ledger: null }] } = await client.query<{
      legacy: string | null; ledger: string | null;
    }>(`select to_regclass('public.agendia_production_migrations') as legacy,
        to_regclass('drizzle.__drizzle_migrations') as ledger`);
    const applied = legacy ? (await client.query<History>(
      "select name, checksum from public.agendia_production_migrations order by name")).rows : [];
    const recorded = ledger ? (await client.query<Ledger>(
      "select hash, created_at from drizzle.__drizzle_migrations order by created_at")).rows : [];
    for (const [idx, row] of applied.entries()) {
      const migration = migrations[idx];
      if (!migration || row.name !== `000${idx}_proof.sql` || row.checksum !== migration.hash)
        throw new Error("Legacy history is not an unchanged chronological prefix");
    }
    for (const [idx, row] of recorded.entries()) {
      const migration = migrations[idx];
      if (!migration || row.hash !== migration.hash || Number(row.created_at) !== migration.folderMillis)
        throw new Error("Drizzle history is not an unchanged chronological prefix");
    }
    if (recorded.length && recorded.length < applied.length)
      throw new Error("Conflicting ledgers");
    if (!recorded.length && applied.length) {
      // Exact stock ledger shape; no public bootstrap-only API exists for adoption.
      await client.query("create schema if not exists drizzle");
      await client.query(`create table if not exists drizzle.__drizzle_migrations
        (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      for (const migration of migrations.slice(0, applied.length)) {
        await client.query("insert into drizzle.__drizzle_migrations(hash, created_at) values ($1, $2)",
          [migration.hash, migration.folderMillis]);
      }
    }
    await hooks.beforeStock?.(client, pid, closed.promise);
    if (lost) throw new Error("Session lost before stock migrator");
    stockStarted = true;
    await migrate(drizzle(client), { migrationsFolder: folder });
    committed = true; // The stock migrator owns COMMIT; no required writes follow it.
    if (lost) throw new Error("Session lost at commit");
  } catch (cause) {
    if (!committed && !lost) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackCause) {
        lost = true;
        cause = new AggregateError([cause, rollbackCause], "Rollback could not be confirmed");
      }
    }
    if (lost) {
      await stop();
      await hooks.afterLoss?.(client);
      // A lost COMMIT acknowledgement is not proof of rollback; never auto-retry.
      throw new Error(stockStarted
        ? "Session lost during stock migration; durable outcome requires reconciliation"
        : "Session lost before stock migration; transaction aborted", { cause });
    }
    throw cause;
  } finally {
    try {
      if (held && !lost) await client.query("select pg_advisory_unlock(hashtext('agendia:production-setup'))");
    } finally {
      await stop();
    }
  }
}

async function legacyPrefix(observer: Sql, folder: string) {
  const [migration] = readMigrationFiles({ migrationsFolder: folder });
  if (!migration) throw new Error("Missing fixture migration");
  await observer.unsafe(base);
  await observer`create table public.agendia_production_migrations
    (name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
  await observer`insert into public.agendia_production_migrations(name, checksum)
    values ('0000_proof.sql', ${migration.hash})`;
}

async function state(observer: Sql) {
  const [relations] = await observer`select to_regclass('public.proof') as proof,
    to_regclass('public.pending_ddl') as pending,
    to_regclass('drizzle.__drizzle_migrations') as ledger,
    to_regclass('drizzle.__drizzle_migrations_id_seq') as counter,
    to_regnamespace('drizzle') as schema`;
  return relations;
}

async function expectHistory(observer: Sql, folder: string) {
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  expect([...(await observer`select id, hash, created_at from drizzle.__drizzle_migrations order by id`)])
    .toEqual(migrations.map((migration, idx) => ({ id: idx + 1, hash: migration.hash, created_at: String(migration.folderMillis) })));
}

async function expectReleased(observer: Sql) {
  expect([...(await observer`select pg_try_advisory_lock(hashtext('agendia:production-setup')) as acquired`)])
    .toEqual([{ acquired: true }]);
  await observer`select pg_advisory_unlock(hashtext('agendia:production-setup'))`;
  expect(await observer`select pid from pg_stat_activity where application_name = 'agendia-stock-migration-proof'`)
    .toHaveLength(0);
}

test("reserved runtime is not the complete root client required by the public Drizzle constructor", async () => {
  await fixture([base], async url => {
    const root = postgres(url, { max: 1 });
    const reserved = await root.reserve();
    try {
      expect(typeof root.begin).toBe("function");
      expect(root.options).toBeDefined();
      expect("begin" in reserved).toBe(false);
      expect("options" in reserved).toBe(false);
    } finally { reserved.release(); await root.end(); }
  });
});

test("fresh stock execution and idempotent rerun keep one backend and complete hash history", async () => {
  await fixture([base, next], async (url, folder, observer) => {
    let pid = 0;
    await coordinate(url, folder, { locked: async (_client, backend) => { pid = backend; } });
    const rows = [...(await observer`select * from proof order by value`)];
    expect(rows).toEqual([{ value: "base", pid }, { value: "next", pid }]);
    await expectHistory(observer, folder);
    const counter = [...(await observer`select last_value, is_called from drizzle.__drizzle_migrations_id_seq`)];
    await coordinate(url, folder);
    expect([...(await observer`select * from proof order by value`)]).toEqual(rows);
    await expectHistory(observer, folder);
    expect([...(await observer`select last_value, is_called from drizzle.__drizzle_migrations_id_seq`)]).toEqual(counter);
    await expectReleased(observer);
  });
});

test("chronological legacy adoption seeds stock hashes without replay and freezes legacy evidence", async () => {
  await fixture([base, next], async (url, folder, observer) => {
    await legacyPrefix(observer, folder);
    const legacy = [...(await observer`select * from public.agendia_production_migrations`)];
    const original = [...(await observer`select * from proof`)];
    await coordinate(url, folder);
    expect([...(await observer`select * from proof where value = 'base'`)]).toEqual(original);
    expect(await observer`select * from proof`).toHaveLength(2);
    await expectHistory(observer, folder);
    await coordinate(url, folder);
    expect([...(await observer`select * from public.agendia_production_migrations`)]).toEqual(legacy);
    expect(await observer`select * from proof`).toHaveLength(2);
    await expectHistory(observer, folder);
    await expectReleased(observer);
  });
});

for (const adopt of [false, true]) {
  test(`later migration failure rolls back bootstrap, adoption and DDL (legacy=${adopt})`, async () => {
    await fixture([base, next, failure], async (url, folder, observer) => {
      if (adopt) await legacyPrefix(observer, folder);
      const before = await state(observer);
      const rows = adopt ? [...(await observer`select * from proof`)] : [];
      const legacy = adopt ? [...(await observer`select * from public.agendia_production_migrations`)] : [];
      await expect(coordinate(url, folder)).rejects.toThrow("deliberately_missing_function");
      expect(await state(observer)).toEqual(before);
      if (adopt) {
        expect([...(await observer`select * from proof`)]).toEqual(rows);
        expect([...(await observer`select * from public.agendia_production_migrations`)]).toEqual(legacy);
      }
      await expectReleased(observer);
    });
  });
}

test("invalid prefix and conflicting Drizzle hash reject without changing rows, ledgers or counter", async () => {
  await fixture([base, next], async (url, folder, observer) => {
    await legacyPrefix(observer, folder);
    await observer`update public.agendia_production_migrations set name = '0001_proof.sql'`;
    const badLegacy = [...(await observer`select * from public.agendia_production_migrations`)];
    const before = await state(observer);
    const rows = [...(await observer`select * from proof`)];
    await expect(coordinate(url, folder)).rejects.toThrow("Legacy history is not an unchanged chronological prefix");
    expect(await state(observer)).toEqual(before);
    expect([...(await observer`select * from proof`)]).toEqual(rows);
    expect([...(await observer`select * from public.agendia_production_migrations`)]).toEqual(badLegacy);
    await observer`update public.agendia_production_migrations set name = '0000_proof.sql'`;
    await coordinate(url, folder);
    await observer`update drizzle.__drizzle_migrations set hash = 'conflict' where id = 1`;
    const ledger = [...(await observer`select * from drizzle.__drizzle_migrations order by id`)];
    const counter = [...(await observer`select * from drizzle.__drizzle_migrations_id_seq`)];
    const complete = [...(await observer`select * from proof order by value`)];
    await expect(coordinate(url, folder)).rejects.toThrow("Drizzle history is not an unchanged chronological prefix");
    expect([...(await observer`select * from drizzle.__drizzle_migrations order by id`)]).toEqual(ledger);
    expect([...(await observer`select * from drizzle.__drizzle_migrations_id_seq`)]).toEqual(counter);
    expect([...(await observer`select * from proof order by value`)]).toEqual(complete);
    await expectReleased(observer);
  });
});

test("concurrent coordinators serialize on the provisioning key before reading or adopting history", async () => {
  await fixture([base, next], async (url, folder, observer) => {
    const firstLocked = signal();
    const secondTrying = signal();
    const release = signal();
    let firstCommitted = false;
    const first = coordinate(url, folder, { locked: async () => {
      firstLocked.resolve();
      await release.promise;
    } }).then(() => { firstCommitted = true; });
    await firstLocked.promise;
    // This xact-lock is the existing provisioning API's lock form, not another key.
    expect([...(await observer`select pg_try_advisory_xact_lock(hashtext('agendia:production-setup')) as acquired`)])
      .toEqual([{ acquired: false }]);
    const second = coordinate(url, folder, {
      query: query => { if (query === lock) secondTrying.resolve(); },
      locked: async client => {
        expect((await client.query("select * from proof")).rows).toHaveLength(2);
      },
    });
    await secondTrying.promise;
    release.resolve();
    await Promise.all([first, second]);
    expect(firstCommitted).toBe(true);
    expect(await observer`select * from proof`).toHaveLength(2);
    expect(await observer`select distinct pid from proof`).toHaveLength(1);
    await expectHistory(observer, folder);
    await expectReleased(observer);
  });
});

test("disconnect after adoption but before stock entry aborts and permanently shuts down the dedicated client", async () => {
  await fixture([base, next], async (url, folder, observer) => {
    await legacyPrefix(observer, folder);
    const before = await state(observer);
    const rows = [...(await observer`select * from proof`)];
    const legacy = [...(await observer`select * from public.agendia_production_migrations`)];
    let checkedDeadClient = false;
    await expect(coordinate(url, folder, { beforeStock: async (client, pid, stopped) => {
      expect([...(await observer`select pg_terminate_backend(${pid}) as terminated`)])
        .toEqual([{ terminated: true }]);
      await stopped;
      await expect(client.query("select 'unlocked replacement'"))
        .rejects.toThrow("Client has encountered a connection error and is not queryable");
      checkedDeadClient = true;
    } })).rejects.toThrow("Session lost before stock migration; transaction aborted");
    expect(checkedDeadClient).toBe(true);
    expect(await state(observer)).toEqual(before);
    expect([...(await observer`select * from proof`)]).toEqual(rows);
    expect([...(await observer`select * from public.agendia_production_migrations`)]).toEqual(legacy);
    await expectReleased(observer);
  });
});

test("disconnect inside a real stock migration fails closed; reconciliation observes all-or-none state", async () => {
  const disconnect = "create table pending_ddl (id integer);\n--> statement-breakpoint\nselect pg_terminate_backend(pg_backend_pid());\n--> statement-breakpoint\ninsert into proof values ('must-not-continue', pg_backend_pid());";
  await fixture([base, disconnect], async (url, folder, observer) => {
    let checkedDeadClient = false;
    await expect(coordinate(url, folder, { afterLoss: async client => {
      await expect(client.query("select 'unlocked replacement'"))
        .rejects.toThrow("Client has encountered a connection error and is not queryable");
      checkedDeadClient = true;
    } })).rejects.toThrow("Session lost during stock migration; durable outcome requires reconciliation");
    expect(checkedDeadClient).toBe(true);
    // This injection is before COMMIT. It does not prove what a commit-time disconnect returns.
    expect(await state(observer)).toEqual({ proof: null, pending: null, ledger: null, counter: null, schema: null });
    expect([...(await observer`select to_regclass('public.agendia_production_migrations') as legacy`)])
      .toEqual([{ legacy: null }]);
    await expectReleased(observer);
    // Explicit reconciliation with a valid fixture is proven by the fresh/rerun test above;
    // retrying this intentionally self-terminating migration would only kill another session.
  });
});
