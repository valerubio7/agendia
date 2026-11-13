import { expect, test } from "bun:test";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { runRestoreAwareSetup } from "../../scripts/db/restore-aware-setup.ts";

const business = "10000000-0000-4000-8000-000000000001";

function migratorUrl(container: { getConnectionUri(): string }): string {
  const url = new URL(container.getConnectionUri());
  url.username = "agendia_migrator";
  url.password = "migrator-password";
  return url.toString();
}

test("a healthy start preserves work and a restored database repairs itself before consumers start", async () => {
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
    // First start on an empty database: migrations only, never a repair.
    expect((await runRestoreAwareSetup(migratorUrl(container))).repaired).toBe(false);
    await migrator`insert into businesses(id,name) values (${business}, 'Synthetic business')`;
    const [connection] = await migrator<{ id: string }[]>`
      insert into whatsapp_connections(business_id) values (${business}) returning id`;
    const [conversation] = await migrator<{ id: string }[]>`
      insert into conversations(business_id,connection_id,remote_jid)
      values (${business}, ${connection!.id}, 'synthetic@s.whatsapp.net') returning id`;
    await migrator`
      insert into outbox_events(business_id,topic,stable_key,payload)
      values (${business},'synthetic','pending','{}')`;
    await migrator`
      insert into outbound_commands(business_id,conversation_id,connection_id,text,state)
      values (${business}, ${conversation!.id}, ${connection!.id}, 'pending', 'pending')`;
    await migrator.begin(async (transaction) => {
      await transaction`set local role agendia_worker`;
      await transaction.unsafe(`
        create table pgboss.job (id uuid not null, name text not null) partition by list (name);
        create table pgboss.job_common partition of pgboss.job for values in ('common');
        insert into pgboss.job(id,name) values (gen_random_uuid(),'common');
      `);
    });
    // A normal restart keeps legitimate queued work.
    expect((await runRestoreAwareSetup(migratorUrl(container))).repaired).toBe(false);
    const [keptOutbox] = await migrator<{ count: number }[]>`
      select count(*)::int count from outbox_events where published_at is null`;
    const [keptCommand] = await migrator<{ state: string }[]>`
      select state from outbound_commands where text='pending'`;
    const [keptJobs] = await migrator<{ count: number }[]>`select count(*)::int count from pgboss.job`;
    expect({ outbox: keptOutbox?.count, command: keptCommand?.state, jobs: keptJobs?.count })
      .toEqual({ outbox: 1, command: "pending", jobs: 1 });

    // Dokploy's native backup and restore: no owners, no ACLs.
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
    const [lost] = await migrator<{ runtime_select: boolean; worker_publish: boolean }[]>`
      select has_table_privilege('agendia_runtime','public.businesses','SELECT') runtime_select,
        has_column_privilege('agendia_worker_runtime','public.outbox_events','published_at','UPDATE') worker_publish`;
    expect(lost).toEqual({ runtime_select: false, worker_publish: false });

    // The deployment's setup step detects and repairs the restore before
    // the API and workers can start.
    const repaired = await runRestoreAwareSetup(migratorUrl(container));
    expect(repaired.repaired).toBe(true);
    if (!repaired.repaired) throw new Error("restore was not detected");
    expect(repaired.result.ownersRepaired).toBeGreaterThan(0);
    expect(repaired.result.grantsRepaired).toBeGreaterThan(0);
    expect(repaired.result.outboxCancelled).toBe(1);
    expect(repaired.result.commandsCancelled).toBe(1);
    expect(repaired.result.jobsCancelled).toBe(1);
    const [granted] = await migrator<{ runtime_select: boolean; worker_publish: boolean }[]>`
      select has_table_privilege('agendia_runtime','public.businesses','SELECT') runtime_select,
        has_column_privilege('agendia_worker_runtime','public.outbox_events','published_at','UPDATE') worker_publish`;
    expect(granted).toEqual({ runtime_select: true, worker_publish: true });
    const [cancelled] = await migrator<{ state: string; failure_code: string }[]>`
      select state, failure_code from outbound_commands where text='pending'`;
    expect(cancelled).toEqual({ state: "failed", failure_code: "restore_cancelled" });
    expect((await migrator<{ count: number }[]>`select count(*)::int count from pgboss.job`)[0]?.count).toBe(0);

    // A second start is a no-op; the repair is not repeated.
    expect((await runRestoreAwareSetup(migratorUrl(container))).repaired).toBe(false);
  } finally {
    await migrator.end().catch(() => {});
    await admin.end().catch(() => {});
    await container.stop();
  }
}, 180_000);

test("setup CLI rejects a missing database URL without printing database details", async () => {
  const child = Bun.spawn([
    process.execPath, "--no-env-file",
    new URL("../../scripts/db/restore-aware-setup.ts", import.meta.url).pathname,
  ], { env: {}, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stdout, stderr }).toEqual({
    code: 1, stdout: "", stderr: "DATABASE_URL is required\n",
  });
});
