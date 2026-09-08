import { PgBoss } from "pg-boss";
import type { Sql } from "postgres";

const queues = ["ai-generate", "conversation-summary"] as const;
const pgBossSchemaVersion = 38;

export function expectedPgBossVersion() {
	return pgBossSchemaVersion;
}

async function grantToRuntimeLogins(
	sql: Sql,
	capability: string,
	privileges: string,
	target: string,
) {
	await sql.unsafe(`
		do $$ declare login_name name; begin
			for login_name in
				select login.rolname from pg_auth_members membership
				join pg_roles capability on capability.oid = membership.roleid
				join pg_roles login on login.oid = membership.member
				where capability.rolname = '${capability}'
			loop
				execute format('grant ${privileges} on ${target} to %I', login_name);
			end loop;
		end $$
	`);
}

export async function initializeQueues(
	input: { sql: Sql; connectionString: string },
	options: { schema: "pgboss" } = { schema: "pgboss" },
) {
	const { sql, connectionString } = input;
	const boss = new PgBoss({
		connectionString,
		schema: options.schema,
		createSchema: false,
		migrate: true,
	});
	await boss.start();
	try {
		for (const queue of queues) await boss.createQueue(queue);
		const version = await boss.schemaVersion();
		if (version !== pgBossSchemaVersion)
			throw new Error("pg-boss schema version is not expected");
	} finally {
		await boss.stop();
	}

	await sql.unsafe(`
    create table if not exists pgboss.agendia_queue_initialization (
      singleton boolean primary key default true check (singleton),
      pg_boss_version integer not null,
      initialized_at timestamptz not null default now()
    )
  `);
	await sql.unsafe(`
    insert into pgboss.agendia_queue_initialization (singleton, pg_boss_version)
    values (true, ${pgBossSchemaVersion})
    on conflict (singleton) do update set pg_boss_version = excluded.pg_boss_version
  `);
	await sql.unsafe("revoke all on schema pgboss from public");
	const publisher = "agendia_queue_publisher_runtime";
	const consumer = "agendia_pgboss_consumer_runtime";
	await sql.unsafe(
		`revoke all on all tables in schema pgboss from ${publisher}, ${consumer}`,
	);
	await sql.unsafe(
		`revoke all on all sequences in schema pgboss from ${publisher}, ${consumer}`,
	);
	await sql.unsafe(
		`revoke all on all functions in schema pgboss from ${publisher}, ${consumer}`,
	);
	await sql.unsafe(`grant usage on schema pgboss to ${publisher}, ${consumer}`);
	// pg-boss sends by selecting the initialized queue and inserting a job. Consumers
	// only claim and complete those jobs; neither runtime role receives queue lifecycle DDL.
	await sql.unsafe(
		`grant select on pgboss.queue, pgboss.version to ${publisher}, ${consumer}`,
	);
	await sql.unsafe(
		`grant insert on pgboss.job, pgboss.job_common to ${publisher}`,
	);
	await sql.unsafe(
		`grant select (id) on pgboss.job, pgboss.job_common to ${publisher}`,
	);
	await sql.unsafe(
		`grant select, update on pgboss.job, pgboss.job_common to ${consumer}`,
	);
	await grantToRuntimeLogins(
		sql,
		publisher,
		"select",
		"pgboss.queue, pgboss.version",
	);
	await grantToRuntimeLogins(
		sql,
		publisher,
		"insert",
		"pgboss.job, pgboss.job_common",
	);
	await grantToRuntimeLogins(
		sql,
		publisher,
		"select (id)",
		"pgboss.job, pgboss.job_common",
	);
	await grantToRuntimeLogins(
		sql,
		consumer,
		"select",
		"pgboss.queue, pgboss.version",
	);
	await grantToRuntimeLogins(
		sql,
		consumer,
		"select, update",
		"pgboss.job, pgboss.job_common",
	);
	await sql.unsafe(
		`revoke create on schema pgboss from ${publisher}, ${consumer}, agendia_worker_runtime`,
	);
	return { queues: [...queues], pgBossVersion: pgBossSchemaVersion };
}
