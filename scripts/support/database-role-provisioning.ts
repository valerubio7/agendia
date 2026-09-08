import type { Sql } from "postgres";

export type DeploymentEnvironment = "production" | "staging";
type RoleKey =
	| "clusterAdmin"
	| "migrator"
	| "api"
	| "manager"
	| "queuePublisher"
	| "worker"
	| "queueOwner"
	| "backup";

export type EnvironmentRoleNames = Record<RoleKey, string>;
export type RoleProvisioningInput = {
	environment: DeploymentEnvironment;
	databaseName: string;
	credentials: Record<string, string>;
	/** Test harnesses keep a persistent connection to their disposable database. */
	manageDatabaseOwnership?: boolean;
};

const identifier = /^[a-z][a-z0-9_]*$/;
const assertIdentifier = (value: string) => {
	if (!identifier.test(value)) throw new Error("Unsafe PostgreSQL identifier");
	return `"${value}"`;
};
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function roleNamesForEnvironment(
	environment: DeploymentEnvironment,
): EnvironmentRoleNames {
	const suffix = environment === "production" ? "prod" : "stg";
	return {
		clusterAdmin: `${suffix}_cluster_admin`,
		migrator: `agendia_${suffix}_migrator`,
		api: `agendia_${suffix}_api_login`,
		manager: `agendia_${suffix}_manager_login`,
		queuePublisher: `agendia_${suffix}_queue_publisher_login`,
		worker: `agendia_${suffix}_worker_login`,
		queueOwner: `agendia_${suffix}_queue_owner`,
		backup: `agendia_${suffix}_backup`,
	};
}

async function ensureRole(sql: Sql, name: string, attributes: string) {
	const quoted = assertIdentifier(name);
	await sql.unsafe(
		`do $$ begin create role ${quoted} ${attributes}; exception when duplicate_object then null; end $$`,
	);
	await sql.unsafe(`alter role ${quoted} ${attributes}`);
}

async function grantMembership(sql: Sql, member: string, capability: string) {
	await sql.unsafe(
		`grant ${assertIdentifier(capability)} to ${assertIdentifier(member)}`,
	);
}

/** Provisions only isolated login identities; application migrations never administer roles. */
export async function provisionRoles(sql: Sql, input: RoleProvisioningInput) {
	const roles = roleNamesForEnvironment(input.environment);
	const allNames = Object.values(roles);
	for (const name of allNames) {
		if (!input.credentials[name] || input.credentials[name]!.length < 12)
			throw new Error(`Missing or weak credential for ${name}`);
	}
	const database = assertIdentifier(input.databaseName);

	for (const capability of [
		"agendia_runtime",
		"agendia_admin_runtime",
		"agendia_whatsapp_runtime",
		"agendia_worker_runtime",
		"agendia_queue_publisher_runtime",
		"agendia_pgboss_consumer_runtime",
	])
		await ensureRole(
			sql,
			capability,
			"nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls",
		);

	await ensureRole(
		sql,
		roles.clusterAdmin,
		"login nosuperuser createdb createrole inherit nobypassrls",
	);
	await ensureRole(
		sql,
		roles.migrator,
		"login nosuperuser nocreatedb nocreaterole inherit nobypassrls",
	);
	await ensureRole(
		sql,
		roles.api,
		"login nosuperuser nocreatedb nocreaterole inherit nobypassrls",
	);
	await ensureRole(
		sql,
		roles.manager,
		"login nosuperuser nocreatedb nocreaterole inherit nobypassrls",
	);
	await ensureRole(
		sql,
		roles.queuePublisher,
		"login nosuperuser nocreatedb nocreaterole inherit nobypassrls",
	);
	await ensureRole(
		sql,
		roles.worker,
		"login nosuperuser nocreatedb nocreaterole inherit nobypassrls",
	);
	await ensureRole(
		sql,
		roles.queueOwner,
		"login nosuperuser nocreatedb nocreaterole inherit nobypassrls",
	);
	await ensureRole(
		sql,
		roles.backup,
		"login nosuperuser nocreatedb nocreaterole inherit bypassrls",
	);

	for (const name of allNames)
		await sql.unsafe(
			`alter role ${assertIdentifier(name)} password ${quoteLiteral(input.credentials[name]!)}`,
		);

	await grantMembership(sql, roles.api, "agendia_runtime");
	await grantMembership(sql, roles.api, "agendia_admin_runtime");
	await grantMembership(sql, roles.manager, "agendia_whatsapp_runtime");
	await grantMembership(
		sql,
		roles.queuePublisher,
		"agendia_queue_publisher_runtime",
	);
	await grantMembership(sql, roles.worker, "agendia_worker_runtime");
	await grantMembership(sql, roles.worker, "agendia_pgboss_consumer_runtime");
	await sql.unsafe(
		`grant connect on database ${database} to ${assertIdentifier(roles.backup)}`,
	);
	await sql.unsafe(
		`grant pg_read_all_data to ${assertIdentifier(roles.backup)}`,
	);
	if (input.manageDatabaseOwnership !== false)
		await sql.unsafe(
			`alter database ${database} owner to ${assertIdentifier(roles.migrator)}`,
		);
	await sql.unsafe(
		`alter schema public owner to ${assertIdentifier(roles.migrator)}`,
	);
	await sql.unsafe(
		`alter schema pgboss owner to ${assertIdentifier(roles.queueOwner)}`,
	);
	await sql.unsafe(
		`revoke create on schema public, pgboss from public, agendia_runtime, agendia_admin_runtime, agendia_whatsapp_runtime, agendia_worker_runtime, agendia_queue_publisher_runtime, agendia_pgboss_consumer_runtime`,
	);
	return roles;
}
