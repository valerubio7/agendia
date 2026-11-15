import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { migrateDatabase } from "../../scripts/db/db-migrate.ts";
import { REFERENCE_PREFIX, repairRestoredDatabase } from "../../scripts/db/repair-restored-db.ts";

const migrations = join(import.meta.dir, "../../packages/db/migrations");
const business = "10000000-0000-4000-8000-000000000001";

function migratorUrl(container: { getConnectionUri(): string }): string {
  const url = new URL(container.getConnectionUri());
  url.username = "agendia_migrator";
  url.password = "migrator-password";
  return url.toString();
}

test("repairing a Dokploy restore rebuilds owners, privileges and pending work", async () => {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const admin = postgres(container.getConnectionUri(), { max: 1 });
  let migrator = postgres(migratorUrl(container), { max: 1 });
  try {
    await admin.unsafe(`
      create role agendia_migrator login superuser bypassrls password 'migrator-password';
      create role agendia_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      create role agendia_admin_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      create role agendia_whatsapp_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      create role agendia_worker_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      create role agendia_business_purge nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      create role agendia_api login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password 'api' in role agendia_runtime;
      create role agendia_admin login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password 'admin' in role agendia_admin_runtime;
      create role agendia_worker login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password 'worker' in role agendia_worker_runtime;
      create role agendia_manager login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password 'manager' in role agendia_whatsapp_runtime, agendia_worker_runtime;
    `);
    // The backup represents a database older than the current migrations.
    const old = readdirSync(migrations).filter((name) => name.endsWith(".sql") && name < "0006").sort();
    await migrateDatabase(migrator, {
      list: () => old,
      read: (name) => readFileSync(join(migrations, name), "utf8"),
    });
    await migrator`insert into businesses(id,name) values (${business}, 'Synthetic business')`;
    const [connection] = await migrator<{ id: string }[]>`
      insert into whatsapp_connections(business_id) values (${business}) returning id`;
    const [conversation] = await migrator<{ id: string }[]>`
      insert into conversations(business_id,connection_id,remote_jid)
      values (${business}, ${connection!.id}, 'synthetic@s.whatsapp.net') returning id`;
    await migrator`
      insert into outbox_events(business_id,topic,stable_key,payload)
      values (${business},'synthetic','unpublished','{}'), (${business},'synthetic','published','{}')`;
    await migrator`update outbox_events set published_at=now() where stable_key='published'`;
    for (const state of ["pending", "processing", "generated", "sending", "sent", "failed"])
      await migrator`
        insert into outbound_commands(business_id,conversation_id,connection_id,text,state)
        values (${business}, ${conversation!.id}, ${connection!.id}, ${state}, ${state})`;
    // pg-boss owns its schema objects at runtime, so they are absent from migrations.
    await migrator.begin(async (transaction) => {
      await transaction`set local role agendia_worker`;
      await transaction.unsafe(`
        create table pgboss.job (id uuid not null, name text not null) partition by list (name);
        create table pgboss.job_common partition of pgboss.job for values in ('common');
        create index job_common_i1 on pgboss.job_common (name);
        create index job_dep_parent_idx on pgboss.job (name);
        create type pgboss.job_state as enum ('created','retry');
        create function pgboss.create_queue(queue_name text) returns void language sql as 'select';
        insert into pgboss.job(id,name) values (gen_random_uuid(),'common');
      `);
    });
    await migrator.end();
    const dump = await container.exec([
      "pg_dump", "-Fc", "--no-acl", "--no-owner", "-U", "test", "-d", "test", "-f", "/tmp/agendia.dump",
    ]);
    expect(dump.exitCode).toBe(0);
    const restore = await container.exec([
      "pg_restore", "-U", "test", "-d", "test", "-O", "--clean", "--if-exists", "/tmp/agendia.dump",
    ]);
    expect(restore.exitCode).toBe(0);
    migrator = postgres(migratorUrl(container), { max: 1 });
    // The job runs the migrator before the repair.
    await migrateDatabase(migrator);
    // Neither a prefix match nor an abandoned reference belongs to this run.
    const unrelated = [`${REFERENCE_PREFIX}keep`, "agendiaXrepairXreferenceXkeep"];
    for (const name of unrelated) await admin.unsafe(`create database "${name}"`);
    const result = await repairRestoredDatabase(migratorUrl(container));
    expect((await admin<{ datname: string }[]>`
      select datname from pg_database where datname = any(${unrelated}) order by datname`
    ).map((row) => row.datname)).toEqual([...unrelated].sort());
    expect(result.referenceDatabase.startsWith(REFERENCE_PREFIX)).toBe(true);
    expect(result.ownersRepaired).toBeGreaterThan(0);
    expect(result.grantsRepaired).toBeGreaterThan(0);
    expect(result.outboxCancelled).toBe(1);
    expect(result.commandsCancelled).toBe(4);
    expect(result.jobsCancelled).toBe(1);
    const [owners] = await migrator<{ table_owner: string; routine_owner: string }[]>`
      select
        (select pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname='businesses') table_owner,
        (select pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='public' and p.proname='delete_business') routine_owner`;
    expect(owners).toEqual({ table_owner: "agendia_migrator", routine_owner: "agendia_business_purge" });
    const [privileges] = await migrator<{ runtime_select: boolean; runtime_update: boolean; admin_update: boolean }[]>`
      select has_table_privilege('agendia_runtime','public.businesses','SELECT') runtime_select,
        has_table_privilege('agendia_runtime','public.businesses','UPDATE') runtime_update,
        has_table_privilege('agendia_admin_runtime','public.businesses','UPDATE') admin_update`;
    expect(privileges).toEqual({ runtime_select: true, runtime_update: false, admin_update: true });
    const [columnPrivileges] = await migrator<{
      reply_update: boolean; conversation_update: boolean; jid_update: boolean;
      outbox_update: boolean; link_update: boolean; runtime_outbox_update: boolean;
    }[]>`
      select has_column_privilege('agendia_worker_runtime','public.conversations','reply_due_at','UPDATE') reply_update,
        has_table_privilege('agendia_worker_runtime','public.conversations','UPDATE') conversation_update,
        has_column_privilege('agendia_worker_runtime','public.conversations','remote_jid','UPDATE') jid_update,
        has_column_privilege('agendia_worker_runtime','public.outbox_events','published_at','UPDATE') outbox_update,
        has_column_privilege('agendia_whatsapp_runtime','public.outbox_events','link_admitted_at','UPDATE') link_update,
        has_column_privilege('agendia_runtime','public.outbox_events','published_at','UPDATE') runtime_outbox_update`;
    expect(columnPrivileges).toEqual({
      reply_update: true, conversation_update: false, jid_update: false,
      outbox_update: true, link_update: true, runtime_outbox_update: false,
    });
    const pgbossOwners = await migrator<{ owner: string }[]>`
      select distinct pg_get_userbyid(c.relowner) owner from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='pgboss'`;
    expect(pgbossOwners.map((row) => row.owner)).toEqual(["agendia_worker"]);
    const [pgbossSchema] = await migrator<{ worker_create: boolean; worker_usage: boolean }[]>`
      select has_schema_privilege('agendia_worker','pgboss','CREATE') worker_create,
        has_schema_privilege('agendia_worker','pgboss','USAGE') worker_usage`;
    expect(pgbossSchema).toEqual({ worker_create: true, worker_usage: true });
    const [outbox] = await migrator<{ count: number }[]>`
      select count(*)::int count from public.outbox_events where published_at is null`;
    expect(outbox?.count).toBe(0);
    const [cancelled] = await migrator<{ count: number }[]>`
      select count(*)::int count from public.outbound_commands
      where state='failed' and failure_code='restore_cancelled'`;
    expect(cancelled?.count).toBe(3);
    const [unknown] = await migrator<{ count: number }[]>`
      select count(*)::int count from public.outbound_commands
      where state='delivery_unknown' and failure_code='restore_cancelled'`;
    expect(unknown?.count).toBe(1);
    const [pending] = await migrator<{ count: number }[]>`
      select count(*)::int count from public.outbound_commands
      where state in ('pending','processing','generated','sending')`;
    expect(pending?.count).toBe(0);
    const [jobs] = await migrator<{ count: number }[]>`select count(*)::int count from pgboss.job`;
    expect(jobs?.count).toBe(0);
    const again = await repairRestoredDatabase(migratorUrl(container));
    expect(again.referenceDatabase.startsWith(REFERENCE_PREFIX)).toBe(true);
    expect(again.ownersRepaired).toBe(0);
    expect(again.grantsRepaired).toBe(0);
    expect(again.outboxCancelled).toBe(0);
    expect(again.commandsCancelled).toBe(0);
    expect(again.jobsCancelled).toBe(0);
    const [leftovers] = await migrator<{ count: number }[]>`
      select count(*)::int count from pg_database where datname = ${again.referenceDatabase}`;
    expect(leftovers?.count).toBe(0);
    await migrator`create table public.rogue_table(id int)`;
    await expect(repairRestoredDatabase(migratorUrl(container))).rejects.toThrow("unexpected relation");
    const [afterFailure] = await migrator<{ count: number }[]>`
      select count(*)::int count from pg_database where starts_with(datname, ${REFERENCE_PREFIX})
        and datname <> ${unrelated[0]!}`;
    expect(afterFailure?.count).toBe(0);
    expect((await admin`select datname from pg_database where datname = any(${unrelated})`).length).toBe(2);
  } finally {
    await migrator.end().catch(() => {});
    await admin.end().catch(() => {});
    await container.stop();
  }
}, 180_000);

test("repair CLI rejects a missing database URL without printing database details", async () => {
  const child = Bun.spawn([
    process.execPath, "--no-env-file",
    new URL("../../scripts/db/repair-restored-db.ts", import.meta.url).pathname,
  ], { env: {}, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stdout, stderr }).toEqual({
    code: 1, stdout: "", stderr: "Restore repair failed: DATABASE_URL is required\n",
  });
});
