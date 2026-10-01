import { z } from "zod";
import type { ReleaseManifest } from "@agendia/release-manifest";
import type { RuntimeConfig } from "@agendia/runtime-config";

const nonzeroDigest = z
	.string()
	.regex(/^sha256:[a-f0-9]{64}$/)
	.refine((value) => !value.endsWith("0".repeat(64)));
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const image = z
	.string()
	.regex(
		/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)+[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/,
	);
const timestamp = z
	.string()
	.datetime()
	.refine((value) => {
		const parsed = new Date(value);
		return (
			Number.isFinite(parsed.getTime()) &&
			parsed.toISOString().slice(0, 19) === value.slice(0, 19)
		);
	});
const historyEntry = z
	.object({
		filename: z.string().regex(/^\d{4}_[a-z0-9_]+\.sql$/),
		sha256: checksum,
		releaseDigest: nonzeroDigest,
	})
	.strict();

/** An operator risk disposition, not a signature or backup/restore certificate. */
export const stagingMigrationRiskAcceptanceSchema = z
	.object({
		schemaVersion: z.literal(1),
		operation: z.literal("staging-existing-state-upgrade"),
		environment: z.literal("staging"),
		backupStatus: z.literal("unverified"),
		rollback: z.literal("not-promised"),
		authorizationActor: z.string().trim().min(1).max(200),
		riskAcknowledgement: z.literal(
			"I accept data loss and unavailable rollback without a verified backup or restore",
		),
		authorizedAt: timestamp,
		expiresAt: timestamp,
		commit: z
			.string()
			.regex(/^[a-f0-9]{40}$/)
			.refine((value) => value !== "0".repeat(40)),
		releaseDigest: nonzeroDigest,
		image,
		environmentId: z.string().uuid(),
		secretSetId: z.string().uuid(),
		previousReleaseDigest: nonzeroDigest,
		previousImage: image,
		migration: z
			.object({
				filename: z.literal("0024_runtime_marker_grants.sql"),
				sha256: checksum,
			})
			.strict(),
		history: z.array(historyEntry).length(24),
	})
	.strict();
export type StagingMigrationRiskAcceptance = z.infer<
	typeof stagingMigrationRiskAcceptanceSchema
>;
export type MigrationRuntimeIdentity = Pick<
	RuntimeConfig,
	"environment" | "environmentId" | "secretSetId" | "releaseDigest"
>;

export function validateStagingMigrationRiskAcceptance(
	value: unknown,
	manifest: ReleaseManifest,
	expected: MigrationRuntimeIdentity | undefined,
	environment: string | undefined,
	now: Date,
): StagingMigrationRiskAcceptance {
	const record = stagingMigrationRiskAcceptanceSchema.parse(value);
	const authorized = Date.parse(record.authorizedAt);
	const expires = Date.parse(record.expiresAt);
	if (
		!Number.isFinite(now.getTime()) ||
		authorized > now.getTime() ||
		expires <= now.getTime() ||
		expires <= authorized ||
		expires - authorized > 72 * 60 * 60 * 1000
	)
		throw new Error("migration.staging_acceptance_expired");
	if (
		environment !== "staging" ||
		expected?.environment !== "staging" ||
		manifest.artifactKind !== "universal-image" ||
		manifest.database.compatibility !== "expand-compatible" ||
		record.commit !== manifest.commit ||
		record.releaseDigest !== manifest.releaseDigest ||
		record.releaseDigest !== expected.releaseDigest ||
		record.image !== manifest.images.web ||
		!record.image.endsWith(record.releaseDigest) ||
		record.environmentId !== expected.environmentId ||
		record.secretSetId !== expected.secretSetId
	)
		throw new Error("migration.staging_acceptance_identity_invalid");
	if (
		!record.previousImage.endsWith(record.previousReleaseDigest) ||
		record.previousReleaseDigest === record.releaseDigest ||
		(manifest.database.previousReleaseDigest !== `sha256:${"0".repeat(64)}` &&
			manifest.database.previousReleaseDigest !== record.previousReleaseDigest)
	)
		throw new Error("migration.staging_acceptance_previous_invalid");
	return record;
}

export function validateStagingMigrationHistory(
	record: StagingMigrationRiskAcceptance,
	files: readonly { filename: string; sha256: string }[],
	ledger: readonly {
		filename: string;
		sha256: string;
		releaseDigest: string;
	}[],
): void {
	const historical = files.filter(
		(file) => file.filename < record.migration.filename,
	);
	const pending = files.filter(
		(file) => !ledger.some((entry) => entry.filename === file.filename),
	);
	if (
		files.length !== 25 ||
		historical.length !== 24 ||
		ledger.length !== 24 ||
		historical[23]?.filename.slice(0, 5) !== "0023_" ||
		pending.length !== 1 ||
		pending[0]?.filename !== record.migration.filename ||
		pending[0]?.sha256 !== record.migration.sha256
	)
		throw new Error("migration.staging_acceptance_scope_invalid");
	for (let index = 0; index < 24; index++) {
		const file = historical[index];
		const accepted = record.history[index];
		const observed = ledger[index];
		if (
			!file ||
			!accepted ||
			!observed ||
			accepted.filename !== file.filename ||
			observed.filename !== file.filename ||
			accepted.sha256 !== file.sha256 ||
			observed.sha256 !== file.sha256 ||
			observed.releaseDigest !== accepted.releaseDigest
		)
			throw new Error("migration.staging_acceptance_history_invalid");
	}
	if (ledger[23]?.releaseDigest !== record.previousReleaseDigest)
		throw new Error("migration.staging_acceptance_previous_invalid");
}
