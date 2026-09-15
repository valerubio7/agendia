import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import {
	loadRuntimeConfig,
	preflightReleaseEnvironment,
	preflightStaticEnvironment,
	type IsolationManifest,
	type RuntimeConfig,
} from "@agendia/runtime-config";
import {
	runGovernedMigrations,
	type GovernedMigrationOptions,
	type MigrationEvidence,
} from "./support/postgres-migrations.ts";

function readJson(
	name:
		| "AGENDIA_RELEASE_MANIFEST_FILE"
		| "AGENDIA_MIGRATION_EVIDENCE_FILE"
		| "AGENDIA_ISOLATION_MANIFEST_FILE",
) {
	const path = process.env[name];
	if (!path) throw new Error(`${name} is required`);
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`${name} is invalid`);
	}
}

export interface MigrateOptions {
	config: RuntimeConfig;
	migrationDirectory: string;
	manifest: unknown;
	evidence: MigrationEvidence;
	preflight?: (config: RuntimeConfig) => Promise<void>;
	completePreflight?: (config: RuntimeConfig) => Promise<void>;
	genesis?: GovernedMigrationOptions["genesis"];
	runGoverned?: (
		options: GovernedMigrationOptions,
	) => ReturnType<typeof runGovernedMigrations>;
}

export async function runMigrate({
	config,
	migrationDirectory,
	manifest,
	evidence,
	preflight = preflightReleaseEnvironment,
	completePreflight,
	genesis,
	runGoverned = runGovernedMigrations,
}: MigrateOptions) {
	await preflight(config);
	const sql = postgres(config.databaseUrl, { max: 1 });
	try {
		const result = await runGoverned({
			sql,
			migrationDirectory,
			manifest,
			evidence,
			environment: config.environment,
			releaseDigest: config.releaseDigest,
			...(genesis ? { genesis } : {}),
		});
		await completePreflight?.(config);
		return result;
	} finally {
		await sql.end({ timeout: 1 });
	}
}

if (import.meta.main) {
	const config = loadRuntimeConfig("migrate");
	const isolationManifest = readJson(
		"AGENDIA_ISOLATION_MANIFEST_FILE",
	) as IsolationManifest;
	const result = await runMigrate({
		config,
		migrationDirectory:
			process.env.AGENDIA_MIGRATIONS_DIRECTORY ??
			join(import.meta.dir, "../migrations"),
		manifest: readJson("AGENDIA_RELEASE_MANIFEST_FILE"),
		evidence: readJson("AGENDIA_MIGRATION_EVIDENCE_FILE") as MigrationEvidence,
		preflight: async (releaseConfig) =>
			preflightStaticEnvironment({
				config: releaseConfig,
				manifest: isolationManifest,
			}),
		completePreflight: async (releaseConfig) =>
			preflightReleaseEnvironment(releaseConfig),
		genesis:
			config.environment === "staging" || config.environment === "production"
				? {
						environment: config.environment,
						environmentId: config.environmentId,
						secretSetId: config.secretSetId,
						releaseDigest: config.releaseDigest,
						expected: config,
					}
				: undefined,
	});
	console.log(JSON.stringify(result));
}
