import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import {
	provisionRoles,
	roleNamesForEnvironment,
} from "../../scripts/support/database-role-provisioning.ts";
import {
	initializeQueues,
	expectedPgBossVersion,
} from "../../scripts/support/queue-initialization.ts";
import {
	applyPostgresMigrations,
	startTestPostgres,
	type TestPostgres,
} from "../support/index.ts";

let database: TestPostgres;
let credentials: Record<string, string>;
let queueOwner: Sql | undefined;

const queryAs = (role: string, statement: string) =>
	database.sql.begin(async (transaction) => {
		await transaction.unsafe(`set local role "${role}"`);
		return transaction.unsafe(statement);
	});
const connectionUrlFor = (login: string) => {
	const url = new URL(database.container.getConnectionUri());
	url.username = login;
	url.password = credentials[login]!;
	return url.toString();
};

beforeAll(async () => {
	database = await startTestPostgres();
	await applyPostgresMigrations(
		database.sql,
		join(import.meta.dir, "../../packages/db/migrations"),
	);
	credentials = Object.fromEntries(
		Object.values(roleNamesForEnvironment("production")).map((name, index) => [
			name,
			`test-role-password-${index}`,
		]),
	);
}, 120_000);
afterAll(async () => {
	await queueOwner?.end();
	await database?.stop();
});

describe("environment-scoped database roles and queue initialization", () => {
	test("provisions distinct production credentials idempotently without runtime DDL or cross-capability membership", async () => {
		const input = {
			environment: "production" as const,
			databaseName: "postgres",
			credentials,
			manageDatabaseOwnership: false,
		};
		await provisionRoles(database.sql, input);
		await provisionRoles(database.sql, input);

		const roles = roleNamesForEnvironment("production");
		expect(new Set(Object.values(credentials)).size).toBe(
			Object.keys(credentials).length,
		);
		expect(
			await database.sql<{ rolname: string }[]>`
        select rolname from pg_roles where rolname = any(${database.sql.array(Object.values(roles) as string[])})
      `,
		).toHaveLength(8);
		expect(
			(
				await database.sql<{ rolcreaterole: boolean }[]>`
        select rolcreaterole from pg_roles where rolname = ${roles.migrator}
      `
			)[0]?.rolcreaterole,
		).toBeFalse();

		for (const runtime of [
			roles.api,
			roles.manager,
			roles.queuePublisher,
			roles.worker,
		]) {
			await expect(
				queryAs(runtime, "create table public.runtime_ddl_denied (id int)"),
			).rejects.toThrow(/permission denied/i);
			await expect(
				queryAs(runtime, "create table pgboss.runtime_ddl_denied (id int)"),
			).rejects.toThrow(/permission denied/i);
		}
		await expect(
			queryAs(roles.manager, "select 1 from pgboss.job limit 1"),
		).rejects.toThrow(/permission denied|does not exist/i);
		await expect(
			queryAs(roles.queuePublisher, "select * from businesses limit 1"),
		).rejects.toThrow(/permission denied/i);
		await expect(
			queryAs(roles.worker, "select * from whatsapp_auth_records limit 1"),
		).rejects.toThrow(/permission denied/i);
	}, 30_000);

	test("initializes the two queues once under the one-shot owner and prevents implicit runtime pg-boss DDL", async () => {
		const roles = roleNamesForEnvironment("production");
		const connectionString = connectionUrlFor(roles.queueOwner);
		queueOwner = postgres(connectionString, { max: 1 });
		const input = { sql: queueOwner, connectionString };
		const first = await initializeQueues(input, { schema: "pgboss" });
		const second = await initializeQueues(input, { schema: "pgboss" });
		expect(first.queues).toEqual(["ai-generate", "conversation-summary"]);
		expect(second).toEqual(first);
		expect(first.pgBossVersion).toBe(expectedPgBossVersion());
		const recordedVersion = await queueOwner<{ pg_boss_version: number }[]>`
      select pg_boss_version from pgboss.agendia_queue_initialization
    `;
		expect(recordedVersion[0]?.pg_boss_version).toBe(expectedPgBossVersion());

		const queues = await database.sql.begin(async (transaction) => {
			await transaction.unsafe(`set local role "${roles.worker}"`);
			return transaction<{ count: number }[]>`
        select count(*)::int as count from pgboss.queue
        where name in ('ai-generate', 'conversation-summary')
      `;
		});
		expect(queues[0]?.count).toBe(2);
		await expect(
			queryAs(roles.worker, "create table pgboss.implicit_ddl_denied (id int)"),
		).rejects.toThrow(/permission denied/i);
		await expect(
			queryAs(
				roles.queuePublisher,
				"create table pgboss.implicit_ddl_denied (id int)",
			),
		).rejects.toThrow(/permission denied/i);
	}, 30_000);

	test("probes publisher enqueue and consumer fetch/complete without cross-capability or DDL grants", async () => {
		const roles = roleNamesForEnvironment("production");
		const publisher = postgres(connectionUrlFor(roles.queuePublisher), {
			max: 1,
		});
		const consumer = postgres(connectionUrlFor(roles.worker), { max: 1 });
		try {
			const publisherIdentity = await publisher<
				{ current_user: string; can_insert: boolean }[]
			>`select current_user, has_table_privilege(current_user, 'pgboss.job', 'insert') as can_insert`;
			expect(publisherIdentity[0]).toEqual({
				current_user: roles.queuePublisher,
				can_insert: true,
			});
			const queued = await publisher<{ id: string }[]>`
				insert into pgboss.job (name, data) values ('ai-generate', '{"source":"publisher"}') returning id
			`;
			expect(queued[0]?.id).toBeString();
			const publisherCapabilities = await publisher<
				{ can_fetch: boolean }[]
			>`select has_table_privilege(current_user, 'pgboss.job', 'update') as can_fetch`;
			expect(publisherCapabilities[0]?.can_fetch).toBeFalse();
			const consumerCapabilities = await consumer<
				{ can_enqueue: boolean }[]
			>`select has_table_privilege(current_user, 'pgboss.job', 'insert') as can_enqueue`;
			expect(consumerCapabilities[0]?.can_enqueue).toBeFalse();
			const fetched = await consumer<{ id: string }[]>`
				update pgboss.job set state = 'active', started_on = now() where id = ${queued[0]!.id} returning id
			`;
			expect(fetched).toHaveLength(1);
			const completed = await consumer<{ id: string }[]>`
				update pgboss.job set state = 'completed', completed_on = now() where id = ${queued[0]!.id} returning id
			`;
			expect(completed).toHaveLength(1);
		} finally {
			await publisher.end();
			await consumer.end();
		}
	}, 30_000);

	test("provisions both prod/stg naming schemes and separates manager publisher from worker consumer capabilities", async () => {
		const production = roleNamesForEnvironment("production");
		const staging = roleNamesForEnvironment("staging");
		const stagingCredentials = Object.fromEntries(
			Object.values(staging).map((name, index) => [
				name,
				`staging-role-password-${index}`,
			]),
		);
		await provisionRoles(database.sql, {
			environment: "staging",
			databaseName: "postgres",
			credentials: stagingCredentials,
			manageDatabaseOwnership: false,
		});
		expect(production.api).toBe("agendia_prod_api_login");
		expect(staging.worker).toBe("agendia_stg_worker_login");
		expect(production.manager).not.toBe(production.queuePublisher);
		expect(production.queuePublisher).not.toBe(production.worker);
		expect(
			await database.sql<{ rolname: string }[]>`
        select rolname from pg_roles where rolname = ${staging.queuePublisher}
      `,
		).toHaveLength(1);
	});
});
