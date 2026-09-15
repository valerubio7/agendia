import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { ReleaseManifest } from "@agendia/release-manifest";
import {
	preflightEnvironment,
	type IsolationManifest,
	type RuntimeConfig,
} from "@agendia/runtime-config";
import { runMigrate } from "../../scripts/migrate.ts";
import {
	applyPostgresMigrations,
	startTestPostgres,
	type TestPostgres,
} from "../support/postgres.ts";
import {
	runGovernedMigrations,
	schemaFingerprint,
	type MigrationEvidence,
} from "../../scripts/support/postgres-migrations.ts";

const migrations = join(import.meta.dir, "../../packages/db/migrations");
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const manifest: ReleaseManifest = {
	schemaVersion: 1,
	artifactKind: "universal-image",
	commit: "a".repeat(40),
	releaseDigest: digest("1"),
	platform: "linux/amd64",
	images: Object.fromEntries(
		["web", "api", "whatsapp-manager", "message-worker"].map((name) => [
			name,
			`ghcr.io/agendia/agendia@${digest("1")}`,
		]),
	) as ReleaseManifest["images"],
	database: {
		compatibility: "expand-compatible",
		previousReleaseDigest: digest("2"),
		minimumLedger: "0022_service_heartbeats.sql",
	},
};
const evidence: MigrationEvidence = {
	backup: {
		schemaVersion: 1,
		operation: "backup",
		environment: "staging",
		releaseDigest: digest("1"),
		finishedAt: new Date().toISOString(),
		result: "pass" as const,
	},
	host: {
		maintenanceWindow: false,
		appsStopped: false,
		workersStopped: false,
		stagingStopped: true,
		automationPaused: true,
	},
	previousReleaseDigest: digest("2"),
};
const temporaryDirectories: string[] = [];

function copiedMigrations(mutator: (directory: string) => void) {
	const directory = mkdtempSync(join(tmpdir(), "agendia-governed-migrations-"));
	temporaryDirectories.push(directory);
	cpSync(migrations, directory, { recursive: true });
	mutator(directory);
	return directory;
}

describe("governed migrations", () => {
	let database: TestPostgres;
	beforeAll(async () => {
		database = await startTestPostgres();
	});
	afterAll(async () => {
		await database.stop();
		for (const directory of temporaryDirectories)
			rmSync(directory, { recursive: true, force: true });
	});

	test("RED: rejects missing backup evidence, incompatible rollback, and changed historical SQL", async () => {
		const { backup: _backup, ...withoutBackup } = evidence;
		await expect(
			runGovernedMigrations({
				sql: database.sql,
				migrationDirectory: migrations,
				manifest,
				evidence: withoutBackup,
			}),
		).rejects.toThrow("migration.backup_evidence_invalid");
		await expect(
			runGovernedMigrations({
				sql: database.sql,
				migrationDirectory: migrations,
				manifest,
				evidence: { ...evidence, previousReleaseDigest: digest("3") },
			}),
		).rejects.toThrow("migration.previous_digest_mismatch");
		await expect(
			runGovernedMigrations({
				sql: database.sql,
				migrationDirectory: migrations,
				manifest: {
					...manifest,
					database: { ...manifest.database, minimumLedger: "9999_missing.sql" },
				},
				evidence,
			}),
		).rejects.toThrow("migration.minimum_ledger_missing");
		await runGovernedMigrations({
			sql: database.sql,
			migrationDirectory: migrations,
			manifest,
			evidence,
		});
		const changed = copiedMigrations((directory) =>
			writeFileSync(
				join(directory, "0001_events.sql"),
				"-- changed historical SQL\n",
			),
		);
		await expect(
			runGovernedMigrations({
				sql: database.sql,
				migrationDirectory: changed,
				manifest,
				evidence,
			}),
		).rejects.toThrow("migration.checksum_mismatch");
	}, 120_000);

	test("TRIANGULATE: governs empty genesis, retry, marker mismatch, and unmarked catalog rejection under the migration lock", async () => {
		const clean = await startTestPostgres();
		const environmentId = randomUUID();
		const secretSetId = randomUUID();
		const expected = {
			environment: "staging" as const,
			environmentId,
			secretSetId,
			releaseDigest: manifest.releaseDigest,
		};
		try {
			const options = {
				sql: clean.sql,
				migrationDirectory: migrations,
				manifest,
				evidence,
				genesis: { ...expected, expected },
			};
			await expect(runGovernedMigrations(options)).resolves.toMatchObject({
				execution: "migrated",
			});
			expect(
				Array.from(
					await clean.sql`select environment, environment_id as "environmentId", secret_set_id as "secretSetId" from agendia_environment`,
				),
			).toEqual([{ environment: "staging", environmentId, secretSetId }]);
			await expect(runGovernedMigrations(options)).resolves.toMatchObject({
				applied: [],
			});
			const upgrade: ReleaseManifest = {
				...manifest,
				releaseDigest: digest("3"),
				images: Object.fromEntries(
					Object.keys(manifest.images).map((name) => [
						name,
						`ghcr.io/agendia/agendia@${digest("3")}`,
					]),
				) as ReleaseManifest["images"],
				database: {
					...manifest.database,
					previousReleaseDigest: manifest.releaseDigest,
				},
			};
			const upgradeGenesis = {
				...expected,
				releaseDigest: upgrade.releaseDigest,
				expected: { ...expected, releaseDigest: upgrade.releaseDigest },
			};
			await expect(
				runGovernedMigrations({
					...options,
					manifest: upgrade,
					evidence: {
						...evidence,
						backup: {
							...evidence.backup!,
							releaseDigest: upgrade.releaseDigest,
						},
						previousReleaseDigest: manifest.releaseDigest,
					},
					genesis: upgradeGenesis,
				}),
			).resolves.toMatchObject({ applied: [] });
			await clean.sql`delete from agendia_environment`;
			await expect(
				runGovernedMigrations({
					...options,
					manifest: upgrade,
					evidence: {
						...evidence,
						backup: {
							...evidence.backup!,
							releaseDigest: upgrade.releaseDigest,
						},
						previousReleaseDigest: manifest.releaseDigest,
					},
					genesis: upgradeGenesis,
				}),
			).rejects.toThrow("migration.genesis_release_digest_mismatch");
			await expect(runGovernedMigrations(options)).resolves.toMatchObject({
				applied: [],
			});
			await clean.sql`delete from agendia_schema_migrations where filename = (select max(filename) from agendia_schema_migrations)`;
			const [partialLedger] = await clean.sql<
				{ count: string }[]
			>`select count(*)::text as count from agendia_schema_migrations`;
			const mismatched = { ...expected, secretSetId: randomUUID() };
			await expect(
				runGovernedMigrations({
					...options,
					genesis: { ...mismatched, expected: mismatched },
				}),
			).rejects.toThrow("migration.genesis_marker_mismatch");
			expect(
				(
					await clean.sql<
						{ count: string }[]
					>`select count(*)::text as count from agendia_schema_migrations`
				)[0]?.count,
			).toBe(partialLedger?.count);
			await clean.sql`delete from agendia_environment`;
			await clean.sql`update agendia_schema_migrations set release_digest = ${digest("3")} where filename = (select min(filename) from agendia_schema_migrations)`;
			await expect(runGovernedMigrations(options)).rejects.toThrow(
				"migration.genesis_release_digest_mismatch",
			);
			const unmarked = await startTestPostgres();
			try {
				await applyPostgresMigrations(unmarked.sql, migrations);
				await expect(
					runGovernedMigrations({ ...options, sql: unmarked.sql }),
				).rejects.toThrow("migration.genesis_catalog_invalid");
			} finally {
				await unmarked.stop();
			}
		} finally {
			await clean.stop();
		}
	}, 120_000);

	test("TRIANGULATE: migrate stops before governed work on marker mismatch and rejects future backup evidence", async () => {
		const environmentId = randomUUID();
		const secretSetId = randomUUID();
		const config: RuntimeConfig = {
			process: "migrate",
			environment: "staging",
			environmentId,
			secretSetId,
			releaseDigest: manifest.releaseDigest,
			databaseUrl: "postgresql://agendia_stg_migrator@postgres/agendia_stg",
		};
		const isolationManifest: IsolationManifest = {
			schemaVersion: 1,
			environments: {
				staging: {
					environmentId,
					secretSetId,
					database: {
						host: "postgres",
						name: "agendia_stg",
						loginPrefix: "agendia_stg_",
					},
					criticalSecretHashes: {
						databasePassword: "a".repeat(64),
						providerKey: "b".repeat(64),
						tunnelCredential: "c".repeat(64),
						baileysKek: "d".repeat(64),
						linkOrQrKey: "e".repeat(64),
					},
					whatsapp: { identity: "+15550000001", allowlist: ["+15550000002"] },
				},
				production: {
					environmentId: randomUUID(),
					secretSetId: randomUUID(),
					database: {
						host: "postgres",
						name: "agendia_prod",
						loginPrefix: "agendia_prod_",
					},
					criticalSecretHashes: {
						databasePassword: "f".repeat(64),
						providerKey: "0".repeat(64),
						tunnelCredential: "1".repeat(64),
						baileysKek: "2".repeat(64),
						linkOrQrKey: "3".repeat(64),
					},
					whatsapp: { identity: "+15550000003", allowlist: ["+15550000004"] },
				},
			},
		};
		let governedWorkReached = false;
		await expect(
			runMigrate({
				config,
				manifest,
				evidence,
				migrationDirectory: migrations,
				preflight: (releaseConfig) =>
					preflightEnvironment({
						config: releaseConfig,
						manifest: isolationManifest,
						queryMarker: async () => [
							{
								environment: "staging",
								environmentId: randomUUID(),
								secretSetId,
							},
						],
					}),
				runGoverned: async () => {
					governedWorkReached = true;
					throw new Error("governed work must not run");
				},
			}),
		).rejects.toMatchObject({ code: "environment.marker_mismatch" });
		expect(governedWorkReached).toBeFalse();
		await expect(
			runGovernedMigrations({
				sql: database.sql,
				migrationDirectory: migrations,
				manifest,
				evidence: {
					...evidence,
					backup: {
						...evidence.backup!,
						finishedAt: "2030-01-01T00:00:00.000Z",
					},
				},
				now: new Date("2029-01-01T00:00:00.000Z"),
			}),
		).rejects.toThrow("migration.backup_evidence_invalid");
	});

	test("RED: rejects finite advisory-lock contention", async () => {
		const lock = postgres(database.container.getConnectionUri(), { max: 1 });
		try {
			await lock`select pg_advisory_lock(hashtextextended('agendia:migrations', 0))`;
			await expect(
				runGovernedMigrations({
					sql: database.sql,
					migrationDirectory: migrations,
					manifest,
					evidence,
				}),
			).rejects.toThrow("migration.lock_unavailable");
		} finally {
			await lock`select pg_advisory_unlock(hashtextextended('agendia:migrations', 0))`;
			await lock.end();
		}
	});

	test("TRIANGULATE: distinguishes clean execution from an existing-schema baseline and requires maintenance evidence", async () => {
		const clean = await startTestPostgres();
		const existing = await startTestPostgres();
		try {
			const migrated = await runGovernedMigrations({
				sql: clean.sql,
				migrationDirectory: migrations,
				manifest,
				evidence,
			});
			expect(migrated.execution).toBe("migrated");
			await applyPostgresMigrations(existing.sql, migrations);
			await expect(
				runGovernedMigrations({
					sql: existing.sql,
					migrationDirectory: migrations,
					manifest,
					evidence,
				}),
			).rejects.toThrow("migration.unledgered_drift");
			const cleanSchemaFingerprint = await schemaFingerprint(clean.sql);
			expect(await schemaFingerprint(existing.sql)).toBe(
				cleanSchemaFingerprint,
			);
			const baseline = await runGovernedMigrations({
				sql: existing.sql,
				migrationDirectory: migrations,
				manifest,
				evidence: { ...evidence, cleanSchemaFingerprint },
			});
			expect(baseline.execution).toBe("baseline");
			const maintenance = {
				...manifest,
				database: {
					...manifest.database,
					compatibility: "contract-maintenance" as const,
				},
			};
			await expect(
				runGovernedMigrations({
					sql: clean.sql,
					migrationDirectory: migrations,
					manifest: maintenance,
					evidence,
				}),
			).rejects.toThrow("migration.maintenance_evidence_invalid");
			const maintenanceResult = await runGovernedMigrations({
				sql: clean.sql,
				migrationDirectory: migrations,
				manifest: maintenance,
				evidence: {
					...evidence,
					host: {
						...evidence.host,
						maintenanceWindow: true,
						appsStopped: true,
						workersStopped: true,
					},
				},
			});
			expect(maintenanceResult.rollback).toBe("not-promised");
		} finally {
			await clean.stop();
			await existing.stop();
		}
	}, 120_000);
});
