import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";
import { createRuntimePools, RolePool, tenantContext } from "@agendia/db";
import { InMemoryKms, PostgresBaileysAuthStore } from "@agendia/whatsapp-baileys";
import { applyPostgresMigrations, createRoleLogin, startTestPostgres, testTenantContext, type TestPostgres } from "../support/index.ts";

let database: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
const businessId = randomUUID(), connectionId = randomUUID();
const context = tenantContext(testTenantContext(businessId, "internal_worker"));
const kms = () => new InMemoryKms({ current: Buffer.alloc(32, 7) }, "current");

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("bounded database operation timed out")), 3_000);
    })]);
  } finally { clearTimeout(timer!); }
}

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(database.container.getConnectionUri());
  await database.sql`insert into businesses(id,name) values(${businessId},'Auth concurrency')`;
  await pools.manager.run(context, repo => repo.saveConnection(connectionId, businessId));
}, 120_000);
afterAll(async () => { await pools?.end(); await database?.stop(); });

describe("audit credential and advisory session regressions", () => {
  test("simultaneous first different records remain readable after reload without replacing the envelope", async () => {
    const keyService = kms(), originalWrap = keyService.wrapKey.bind(keyService);
    let wraps = 0, entered!: () => void, unblock!: () => void;
    const firstWrap = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    keyService.wrapKey = async (...args) => {
      wraps++;
      if (wraps === 1) { entered(); await gate; }
      return originalWrap(...args);
    };
    const store = new PostgresBaileysAuthStore(pools.manager, context, keyService);
    const first = store.write(businessId, connectionId, "creds", { registered: true }, 0);
    let second: Promise<unknown> | undefined;
    try {
      await bounded(firstWrap);
      second = store.write(businessId, connectionId, "signal:initial", { key: "second" }, 0);
      // Observe either the old competing initialization or the fixed row-lock wait.
      const deadline = Date.now() + 3_000;
      while (wraps < 2) {
        if (Date.now() >= deadline) throw new Error("competing auth writer did not reach initialization or row lock");
        const [row] = await database.sql`select count(*)::int count from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`;
        if (row!.count > 0) break;
        await Bun.sleep(5);
      }
    } finally { unblock(); }
    await bounded(Promise.all([first, second]));
    const reloaded = new PostgresBaileysAuthStore(pools.manager, context, kms());
    expect(await reloaded.read(businessId, connectionId, "creds")).toEqual({ registered: true });
    expect(await reloaded.read(businessId, connectionId, "signal:initial")).toEqual({ key: "second" });
    expect(wraps).toBe(1);
    const before = await pools.manager.run(context, repo => repo.authEnvelope(connectionId));
    await reloaded.write(businessId, connectionId, "another", { ok: true }, 0);
    expect(await pools.manager.run(context, repo => repo.authEnvelope(connectionId))).toEqual(before);
    await expect(pools.manager.run(context, repo => repo.saveAuthEnvelope(connectionId, before!))).rejects.toThrow("already initialized");
    expect(await pools.manager.run(context, repo => repo.authEnvelope(connectionId))).toEqual(before);
  });

  test("concurrent same-record writers retain optimistic conflicts and tenant scope", async () => {
    const store = new PostgresBaileysAuthStore(pools.manager, context, kms());
    const results = await bounded(Promise.allSettled([
      store.write(businessId, connectionId, "same", { winner: 1 }, 0),
      store.write(businessId, connectionId, "same", { winner: 2 }, 0),
    ]));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason)).toContain("version conflict");
    expect(await store.version(connectionId, "same")).toBe(1);
    await expect(store.read(randomUUID(), connectionId, "same")).rejects.toThrow("authentication record corrupt");
    await expect(store.write(randomUUID(), connectionId, "foreign", {}, 0)).rejects.toThrow();
    await expect(store.write(businessId, randomUUID(), "missing", {}, 0)).rejects.toThrow();
  });

  test("more than ten held leases leave transactions and heartbeats available", async () => {
    const releases: (() => Promise<void>)[] = [];
    let stopping = false;
    try {
      for (let i = 0; i < 12; i++) {
        const pending = pools.manager.reserveAdvisoryLock(`capacity:${i}`).then(async release => {
          if (release) {
            if (stopping) await release();
            else releases.push(release);
          }
          return release;
        });
        expect(await bounded(pending)).not.toBeNull();
        await bounded(pools.manager.run(context, repo => repo.heartbeatWhatsApp(connectionId, "capacity", new Date())));
      }
      expect(releases).toHaveLength(12);
      expect(await bounded(pools.manager.reserveAdvisoryLock("capacity:0"))).toBeNull();
      const [row] = await database.sql`select owner_id from whatsapp_connections where id=${connectionId}`;
      expect(row!.owner_id).toBe("capacity");
    } finally {
      stopping = true;
      await Promise.all(releases.map(release => release()));
    }
  });

  test("worker conversation wait preserves exclusion and release is idempotent", async () => {
    const key = "ai:tenant:conversation";
    const release = (await pools.worker.reserveAdvisoryLock(key))!;
    let acquired = false;
    const waiting = pools.worker.reserveAdvisoryLock(key, true).then(next => { acquired = true; return next; });
    try {
      await Bun.sleep(60);
      expect(acquired).toBe(false);
      await bounded(pools.worker.run(undefined, async () => undefined));
    } finally { await release(); }
    const next = await bounded(waiting);
    expect(next).not.toBeNull();
    await next!();
    await next!();
  });

  test("failed setup/acquisition, unlock errors and shutdown close dedicated clients", async () => {
    const url = new URL(database.container.getConnectionUri());
    url.searchParams.set("application_name", "audit-lock-cleanup");
    const sql = postgres(url.toString());
    const local = new RolePool(sql, "agendia_whatsapp_runtime", url.toString());
    const count = async () => Number((await database.sql`select count(*) count from pg_stat_activity where application_name='audit-lock-cleanup'`)[0]!.count);
    try {
      await expect(local.reserveAdvisoryLock("invalid\0key")).rejects.toThrow();
      expect(await count()).toBe(0);
      const release = (await local.reserveAdvisoryLock("cleanup"))!;
      expect(await local.reserveAdvisoryLock("cleanup")).toBeNull();
      expect(await count()).toBe(1);
      await database.sql`revoke execute on function pg_advisory_unlock(bigint) from public`;
      try { await expect(bounded(release())).rejects.toThrow(/permission denied/); }
      finally { await database.sql`grant execute on function pg_advisory_unlock(bigint) to public`; }
      expect(await count()).toBe(0);
      const disconnectedRelease = (await local.reserveAdvisoryLock("disconnected"))!;
      await database.sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name='audit-lock-cleanup'`;
      await Bun.sleep(25); // Let the driver's close notification reach the reserved client.
      await expect(bounded(disconnectedRelease())).rejects.toThrow("connection closed");
      expect(await count()).toBe(0);
      const shutdownRelease = (await local.reserveAdvisoryLock("shutdown"))!;
      const endStarted = performance.now();
      await bounded(local.end());
      const endFinished = performance.now();
      // Capture the original sample first: diagnostic queries must not turn a shutdown failure green.
      const originalCount = await count();
      const countFinished = performance.now();
      let snapshot: postgres.Row[] | null = null;
      let snapshotError: { name: string; code: string | null } | null = null;
      if (originalCount !== 0) {
        try {
          snapshot = await bounded(database.sql<postgres.Row[]>`
            select a.pid, a.state, a.wait_event_type, a.wait_event,
                   l.mode, l.granted, l.classid, l.objid, l.objsubid
            from pg_stat_activity a
            left join pg_locks l on l.pid = a.pid and l.locktype = 'advisory'
            where a.application_name = 'audit-lock-cleanup'
            order by a.pid, l.classid, l.objid, l.objsubid, l.mode
          `);
        } catch (error) {
          snapshotError = {
            name: error instanceof postgres.PostgresError ? "PostgresError" : "Error",
            code: error instanceof postgres.PostgresError && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null,
          };
        }
      }
      console.error("advisory-shutdown-diagnostic " + JSON.stringify({
        originalCount, endMs: endFinished - endStarted, countMs: countFinished - endFinished,
        snapshot, snapshotError,
      }));
      expect(originalCount).toBe(0);
      await expect(bounded(shutdownRelease())).rejects.toThrow("connection closed");
      await expect(local.reserveAdvisoryLock("after-shutdown")).rejects.toThrow();
    } finally { await sql.end({ timeout: 0 }); await local.end(); }

    const restrictedUrl = new URL(await createRoleLogin(database, "audit_no_manager", "agendia_runtime"));
    restrictedUrl.searchParams.set("application_name", "audit-lock-setup");
    // The runtime login cannot SET ROLE to the manager role.
    const deniedSql = postgres(restrictedUrl.toString());
    const denied = new RolePool(deniedSql, "agendia_whatsapp_runtime", restrictedUrl.toString());
    try {
      await expect(bounded(denied.reserveAdvisoryLock("denied"))).rejects.toThrow(/permission denied/);
      expect(Number((await database.sql`select count(*) count from pg_stat_activity where application_name='audit-lock-setup'`)[0]!.count)).toBe(0);
    } finally { await deniedSql.end({ timeout: 0 }); await denied.end(); }

    const badUrl = new URL(database.container.getConnectionUri());
    badUrl.password = "invalid-test-password";
    const badSql = postgres(badUrl.toString());
    const unavailable = new RolePool(badSql, "agendia_whatsapp_runtime", badUrl.toString());
    try {
      await expect(bounded(unavailable.reserveAdvisoryLock("no-login"))).rejects.toThrow(/password authentication failed/);
    } finally { await badSql.end({ timeout: 0 }); await unavailable.end(); }
  });
});
