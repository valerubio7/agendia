import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import {
	loadRuntimeConfig,
	preflightReleaseEnvironment,
	type RuntimeConfig,
} from "@agendia/runtime-config";
import {
	runGovernedMigrations,
	type GovernedMigrationOptions,
	type MigrationEvidence,
} from "./support/postgres-migrations.ts";

function readJson(
	name: "AGENDIA_RELEASE_MANIFEST_FILE" | "AGENDIA_MIGRATION_EVIDENCE_FILE",
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
	runGoverned = runGovernedMigrations,
}: MigrateOptions) {
	await preflight(config);
	const sql = postgres(config.databaseUrl, { max: 1 });
	try {
		return await runGoverned({
			sql,
			migrationDirectory,
			manifest,
			evidence,
			environment: config.environment,
			releaseDigest: config.releaseDigest,
		});
	} finally {
		await sql.end({ timeout: 1 });
	}
}

if (import.meta.main) {
	const config = loadRuntimeConfig("migrate");
	const result = await runMigrate({
		config,
		migrationDirectory:
			process.env.AGENDIA_MIGRATIONS_DIRECTORY ??
			join(import.meta.dir, "../migrations"),
		manifest: readJson("AGENDIA_RELEASE_MANIFEST_FILE"),
		evidence: readJson("AGENDIA_MIGRATION_EVIDENCE_FILE") as MigrationEvidence,
	});
	console.log(JSON.stringify(result));
}
