import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	provisionRoles,
	roleNamesForEnvironment,
} from "../../scripts/support/database-role-provisioning.ts";
import { startTestPostgres, type TestPostgres } from "../support/index.ts";

const directory = join(import.meta.dir, "../../packages/db/migrations");
const migrationName = "0024_runtime_marker_grants.sql";
const migration = readFileSync(join(directory, migrationName), "utf8");
const previousNames = readdirSync(directory)
	.filter((name) => name.endsWith(".sql") && name < migrationName)
	.sort();
const checksum = (name: string) =>
	createHash("sha256")
		.update(readFileSync(join(directory, name)))
		.digest("hex");
const previousChecksums = previousNames.map(checksum);
const capabilities = [
	"agendia_runtime",
	"agendia_admin_runtime",
	"agendia_whatsapp_runtime",
	"agendia_worker_runtime",
];
const marker = {
	singleton: true,
	environment: "staging",
	environment_id: "11111111-1111-4111-8111-111111111111",
	secret_set_id: "22222222-2222-4222-8222-222222222222",
};
let database: TestPostgres;
const queryAs = (role: string, statement: string) =>
	database.sql.begin(async (transaction) => {
		await transaction.unsafe(`set local role "${role}"`);
		return [
			...(await transaction.unsafe<Record<string, unknown>[]>(statement)),
		];
	});
const denied = async (role: string, statement: string) => {
	await expect(queryAs(role, statement)).rejects.toMatchObject({
		code: "42501",
	});
};

beforeAll(async () => {
	database = await startTestPostgres({ username: "postgres" });
	for (const name of previousNames)
		await database.sql.unsafe(readFileSync(join(directory, name), "utf8"));
	for (const environment of ["staging", "production"] as const) {
		const roles = roleNamesForEnvironment(environment);
		await provisionRoles(database.sql, {
			environment,
			databaseName: database.container.getDatabase(),
			manageDatabaseOwnership: false,
			credentials: Object.fromEntries(
				Object.values(roles).map((name, index) => [
					name,
					`test-marker-password-${index}`,
				]),
			),
		});
	}
	await database.sql`insert into public.agendia_environment ${database.sql(marker)}`;
}, 120_000);
afterAll(async () => {
	await database?.stop();
});

test("repairs marker reads under actual capability roles without widening authority", async () => {
	for (const role of capabilities) {
		const grants = await database.sql<{ can_read: boolean }[]>`
			select has_table_privilege(${role}, 'public.agendia_environment', 'SELECT') as can_read
		`;
		expect(grants[0]?.can_read).toBeFalse();
		await denied(role, "select * from public.agendia_environment");
	}

	await database.sql.unsafe(migration);
	await database.sql.unsafe(migration);
	for (const role of capabilities) {
		expect(
			await queryAs(role, "select * from public.agendia_environment"),
		).toEqual([marker]);
		for (const statement of [
			"insert into public.agendia_environment select * from public.agendia_environment",
			"update public.agendia_environment set environment = 'production'",
			"delete from public.agendia_environment",
			"create table public.marker_ddl_denied (id int)",
			"create table pgboss.marker_ddl_denied (id int)",
		])
			await denied(role, statement);
	}
	const attributes = await database.sql<
		{
			rolsuper: boolean;
			rolbypassrls: boolean;
			rolcreaterole: boolean;
			rolcreatedb: boolean;
			rolcanlogin: boolean;
		}[]
	>`
		select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
		from pg_roles where rolname = any(${database.sql.array(capabilities)})
	`;
	expect(attributes).toHaveLength(4);
	for (const role of attributes)
		expect(role).toEqual({
			rolsuper: false,
			rolbypassrls: false,
			rolcreaterole: false,
			rolcreatedb: false,
			rolcanlogin: false,
		});
});

test("grants only the exact deployed queue schema owner, skipping dev and other owners", async () => {
	const staging = roleNamesForEnvironment("staging");
	const production = roleNamesForEnvironment("production");
	// Remove the grant from the production owner exercised by the preceding test.
	await database.sql.unsafe(
		`revoke select on public.agendia_environment from "${production.queueOwner}"`,
	);
	for (const owner of ["postgres", staging.migrator]) {
		await database.sql.unsafe(`alter schema pgboss owner to "${owner}"`);
		await database.sql.unsafe(migration);
		for (const role of [
			staging.queueOwner,
			production.queueOwner,
			staging.migrator,
		])
			await denied(role, "select * from public.agendia_environment");
	}
	for (const owner of [staging.queueOwner, production.queueOwner]) {
		await denied(owner, "select * from public.agendia_environment");
		await database.sql.unsafe(`alter schema pgboss owner to "${owner}"`);
		await database.sql.unsafe(migration);
		await database.sql.unsafe(migration);
		expect(
			await queryAs(owner, "select * from public.agendia_environment"),
		).toEqual([marker]);
		await denied(owner, "delete from public.agendia_environment");
	}
	for (const role of [
		staging.migrator,
		staging.queuePublisher,
		"agendia_queue_publisher_runtime",
		"agendia_pgboss_consumer_runtime",
	])
		await denied(role, "select * from public.agendia_environment");
	const publicGrants = await database.sql`
		select privilege_type from information_schema.table_privileges
		where table_schema = 'public' and table_name = 'agendia_environment'
		and grantee = 'PUBLIC'
	`;
	expect(publicGrants).toHaveLength(0);
	expect([
		...(await database.sql`select * from public.agendia_environment`),
	]).toEqual([marker]);
	expect(previousNames.map(checksum)).toEqual(previousChecksums);
});
