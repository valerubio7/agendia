import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateReleaseManifest } from "@agendia/release-manifest";
import { runMigrate } from "../../scripts/migrate.ts";
import {
	validateStagingMigrationRiskAcceptance,
	validateStagingMigrationHistory,
} from "../../scripts/support/staging-migration-risk-acceptance.ts";

const digest = (value: string) => `sha256:${value.repeat(64)}`;
const now = new Date("2026-10-01T00:00:00Z");
const image = `ghcr.io/agendia/agendia@${digest("1")}`;
const manifest = validateReleaseManifest({
	schemaVersion: 1,
	artifactKind: "universal-image",
	commit: "a".repeat(40),
	releaseDigest: digest("1"),
	platform: "linux/amd64",
	images: {
		web: image,
		api: image,
		"whatsapp-manager": image,
		"message-worker": image,
	},
	database: {
		compatibility: "expand-compatible",
		minimumLedger: "0022_service_heartbeats.sql",
		previousReleaseDigest: digest("0"),
	},
});
const identity = {
	environment: "staging" as const,
	environmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	secretSetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	releaseDigest: digest("1"),
};
const directory = join(import.meta.dir, "../../packages/db/migrations");
const files = readdirSync(directory)
	.filter((name) => name.endsWith(".sql"))
	.sort()
	.map((filename) => ({
		filename,
		sha256: createHash("sha256")
			.update(readFileSync(join(directory, filename)))
			.digest("hex"),
	}));
const history = files
	.slice(0, 24)
	.map((file) => ({ ...file, releaseDigest: digest("2") }));
const record = {
	schemaVersion: 1,
	operation: "staging-existing-state-upgrade",
	environment: "staging",
	backupStatus: "unverified",
	rollback: "not-promised",
	authorizationActor: "staging operator",
	riskAcknowledgement:
		"I accept data loss and unavailable rollback without a verified backup or restore",
	authorizedAt: now.toISOString(),
	expiresAt: "2026-10-04T00:00:00Z",
	commit: manifest.commit,
	releaseDigest: manifest.releaseDigest,
	image,
	environmentId: identity.environmentId,
	secretSetId: identity.secretSetId,
	previousReleaseDigest: digest("2"),
	previousImage: `ghcr.io/agendia/agendia@${digest("2")}`,
	migration: files[24],
	history,
};
const validate = (
	value: unknown,
	environment: string | undefined = "staging",
) =>
	validateStagingMigrationRiskAcceptance(
		value,
		manifest,
		identity,
		environment,
		now,
	);

describe("staging migration risk acceptance", () => {
	test("admits only exact packaged history and 0024, independently of the genesis sentinel", () => {
		const accepted = validate(record);
		expect(accepted.backupStatus).toBe("unverified");
		validateStagingMigrationHistory(accepted, files, history);
	});
	test("rejects strict record, identity, expiry and predecessor violations", () => {
		for (const patch of [
			{ environment: "production" },
			{ unknown: true },
			{ backupStatus: "pass" },
			{ authorizationActor: null },
			{ commit: "0".repeat(40) },
			{ commit: "b".repeat(40) },
			{ releaseDigest: digest("3") },
			{ image: `ghcr.io/agendia/agendia@${digest("3")}` },
			{ environmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
			{ secretSetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
			{ authorizedAt: "2026-10-02T00:00:00Z" },
			{ expiresAt: now.toISOString() },
			{ expiresAt: "2026-10-05T00:00:00Z" },
			{ expiresAt: null },
			{ previousReleaseDigest: digest("0") },
			{ previousImage: image },
			{ migration: { ...files[24], unknown: true } },
			{ history: [...history.slice(0, 23), { ...history[23], unknown: true }] },
		])
			expect(() => validate({ ...record, ...patch })).toThrow();
		expect(() => validate(record, "production")).toThrow();
		expect(() =>
			validateStagingMigrationRiskAcceptance(
				record,
				manifest,
				identity,
				undefined,
				now,
			),
		).toThrow();
		expect(() =>
			validateStagingMigrationRiskAcceptance(
				record,
				manifest,
				undefined,
				"staging",
				now,
			),
		).toThrow();
	});
	test("packaged entrypoint rejects production acceptance before preflight or database activity", async () => {
		let preflightCalled = false;
		await expect(
			runMigrate({
				config: {
					...identity,
					process: "migrate",
					environment: "production",
					databaseUrl: "not-a-database-url",
				},
				migrationDirectory: directory,
				manifest,
				evidence: {
					stagingRiskAcceptance: record,
					previousReleaseDigest: digest("2"),
					host: {
						maintenanceWindow: true,
						appsStopped: true,
						workersStopped: true,
						stagingStopped: true,
						automationPaused: true,
					},
				},
				preflight: async () => {
					preflightCalled = true;
				},
			}),
		).rejects.toThrow("migration.staging_acceptance_identity_invalid");
		expect(preflightCalled).toBe(false);
	});
	test("rejects changed checksums, extra pending, unknown history and already applied 0024", () => {
		const accepted = validate(record);
		for (const altered of [
			[...files, { filename: "0025_unknown.sql", sha256: "a".repeat(64) }],
			files.map((file, index) =>
				index === 0 || index === 24
					? { ...file, sha256: "b".repeat(64) }
					: file,
			),
		])
			expect(() =>
				validateStagingMigrationHistory(accepted, altered, history),
			).toThrow();
		for (const ledger of [
			[],
			[...history, { ...files[24]!, releaseDigest: digest("1") }],
			history.map((entry, index) =>
				index === 0 ? { ...entry, filename: "0000_unknown.sql" } : entry,
			),
			history.map((entry, index) =>
				index === 23 ? { ...entry, releaseDigest: digest("3") } : entry,
			),
		])
			expect(() =>
				validateStagingMigrationHistory(accepted, files, ledger),
			).toThrow();
	});
});
