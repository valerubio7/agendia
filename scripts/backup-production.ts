import { postgresImage } from "./support/locked-images.ts";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const ageRecipientPattern = /^age1[ac-hj-np-z02-9]{58}$/;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const maxAgeMs = 24 * 60 * 60 * 1000;
const evidenceKeys = [
	"schemaVersion",
	"operation",
	"environment",
	"releaseDigest",
	"snapshotId",
	"recoveredAsOf",
	"startedAt",
	"finishedAt",
	"durationMinutes",
	"rpoHours",
	"database",
	"historicalKekVersions",
	"qrKeyAvailable",
	"result",
];

export interface BackupConfig {
	environment: "production";
	repository: string;
	offHostConfirmed: true;
	resticPasswordFile: string;
	backupRoleFile: string;
	ageRecipient: string;
	releaseDigest: string;
	historicalKeys: { kekVersions: string[]; qrKeyVersion: string };
}
export interface BackupEvidence {
	schemaVersion: 1;
	operation: "backup";
	environment: "production";
	releaseDigest: string;
	snapshotId: string;
	recoveredAsOf: string;
	startedAt: string;
	finishedAt: string;
	durationMinutes: number;
	rpoHours: number;
	database: "verified";
	historicalKekVersions: string[];
	qrKeyAvailable: true;
	result: "pass";
}
export interface BackupGates {
	stagingStopped: boolean;
	capacityWithinBaseline: boolean;
	loadWithinBaseline: boolean;
	currentHostnames?: string[];
	currentReleaseDigest: string;
	conflicts: {
		backup: boolean;
		prune: boolean;
		migration: boolean;
		restore: boolean;
		hostMaintenance: boolean;
	};
}
export interface DatabaseVerification {
	recoveredAsOf: string;
	schemaFingerprint: string;
	minimumLedger: string;
	databaseVerified: true;
}
export interface KeyInventory {
	reference: string;
	kekVersions: string[];
	qrKeyVersion: string;
	qrKeyAvailable: true;
}
export interface BackupSnapshot {
	operationId: string;
	repository: string;
	paths: string[];
	releaseDigest: string;
	tags: string[];
	id: string;
	successful: boolean;
	finishedAt: string;
}
export type Clock = () => Date;
export interface BackupAdapter {
	preflight(): Promise<BackupGates>;
	createStagingDirectory(mode: 0o700): Promise<string>;
	dumpPostgres(input: {
		image: typeof postgresImage;
		format: "custom";
		noOwner: true;
		noAcl: true;
		serializableDeferrable: true;
		backupRoleFile: string;
		destination: string;
	}): Promise<DatabaseVerification>;
	createKeyInventory(input: {
		requiredKekVersions: string[];
		requiredQrKeyVersion: string;
	}): Promise<KeyInventory>;
	encryptKeyBundle(input: {
		recipient: string;
		destination: string;
		inventoryReference: string;
	}): Promise<void>;
	writeReleaseSchemaManifest(input: {
		releaseDigest: string;
		destination: string;
		database: Pick<DatabaseVerification, "schemaFingerprint" | "minimumLedger">;
	}): Promise<void>;
	writePreSnapshotEvidence(input: {
		releaseDigest: string;
		destination: string;
		database: DatabaseVerification;
		inventory: Pick<
			KeyInventory,
			"kekVersions" | "qrKeyVersion" | "qrKeyAvailable"
		>;
	}): Promise<void>;
	backup(input: {
		repository: string;
		passwordFile: string;
		paths: string[];
		releaseDigest: string;
		tags: string[];
	}): Promise<{ operationId: string }>;
	findSnapshot(input: {
		operationId: string;
		repository: string;
		paths: string[];
		releaseDigest: string;
		tags: string[];
	}): Promise<BackupSnapshot>;
	checkMetadata(input: {
		repository: string;
		passwordFile: string;
		snapshotId: string;
		operationId: string;
		releaseDigest: string;
	}): Promise<void>;
	writeFinalEvidence(evidence: BackupEvidence): Promise<void>;
	removeStagingDirectory(path: string): Promise<void>;
}
export interface MaintenanceRepositoryContext {
	repository: string;
	passwordFile: string;
}
export interface MaintenanceAdapter {
	checkMetadata(input: MaintenanceRepositoryContext): Promise<void>;
	checkDataSubset(
		input: MaintenanceRepositoryContext & { subset: "5%" },
	): Promise<void>;
	forget(
		input: MaintenanceRepositoryContext & {
			retention: { daily: 7; weekly: 5; monthly: 12 };
		},
	): Promise<void>;
	prune(input: MaintenanceRepositoryContext): Promise<void>;
	fullRead(input: MaintenanceRepositoryContext): Promise<void>;
}
export interface MaintenanceContext extends MaintenanceRepositoryContext {
	scheduledAt: Date;
	lowLoad: boolean;
	stagingStopped: boolean;
	noConflict: boolean;
	recoveryMachine: boolean;
	approvedWindow: boolean;
	offHostConfirmed: true;
	currentHostnames: string[];
}
function fail(code: string): never {
	throw new Error(code);
}
function exact(
	value: unknown,
	keys: string[],
	code: string,
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
	)
		fail(code);
	return value as Record<string, unknown>;
}
function absoluteFile(value: unknown, code: string) {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value.includes("\n") ||
		/(?:secret|password|key)=/i.test(value)
	)
		fail(code);
	return value;
}
function identifiers(value: unknown, required = true) {
	if (
		!Array.isArray(value) ||
		(required && value.length === 0) ||
		!value.every(
			(entry) => typeof entry === "string" && identifierPattern.test(entry),
		) ||
		new Set(value).size !== value.length
	)
		fail("backup.evidence_invalid");
	return value as string[];
}
function sameSet(left: string[], right: string[]) {
	return (
		left.length === right.length &&
		[...left].sort().every((value, index) => value === [...right].sort()[index])
	);
}
function trustedHostnames(value: unknown) {
	if (
		!Array.isArray(value) ||
		!value.every(
			(entry) =>
				typeof entry === "string" &&
				entry.length > 0 &&
				!/[\s/?#@]/.test(entry),
		)
	)
		fail("backup.repository_invalid");
	return value;
}
function validRepository(value: unknown, currentHostnames: string[] = []) {
	if (typeof value !== "string" || /\s|[?#]/.test(value))
		fail("backup.repository_invalid");
	const match =
		value.match(/^sftp:([a-zA-Z0-9._-]+)@([^:/]+):(\/[^\s]+)$/) ??
		value.match(/^s3:(https:\/\/[^/]+\/[^\s]+|\/\/[^/]+\/[^\s]+)$/);
	if (!match) fail("backup.repository_invalid");
	const rawLocator = value.startsWith("sftp:") ? match[2] : match[1];
	if (!rawLocator) fail("backup.repository_invalid");
	const locator = value.startsWith("sftp:")
		? `https://${rawLocator}`
		: rawLocator.startsWith("https://")
			? rawLocator
			: `https:${rawLocator}`;
	let parsed: URL;
	try {
		parsed = new URL(locator);
	} catch {
		fail("backup.repository_invalid");
	}
	const host = parsed.hostname;
	if (
		!host ||
		parsed.username ||
		parsed.password ||
		/^(localhost|127\.|::1$|\[::1\]$)/i.test(host) ||
		currentHostnames.some((entry) => entry.toLowerCase() === host.toLowerCase())
	)
		fail("backup.repository_invalid");
	return value;
}
export function validateBackupConfig(
	value: unknown,
	currentHostnames: string[] = [],
): BackupConfig {
	const input = exact(
		value,
		[
			"environment",
			"repository",
			"offHostConfirmed",
			"resticPasswordFile",
			"backupRoleFile",
			"ageRecipient",
			"releaseDigest",
			"historicalKeys",
		],
		"backup.config_invalid",
	);
	if (input.environment !== "production") fail("backup.environment_invalid");
	if (input.offHostConfirmed !== true) fail("backup.off_host_unconfirmed");
	const historical = exact(
		input.historicalKeys,
		["kekVersions", "qrKeyVersion"],
		"backup.key_inventory_invalid",
	);
	if (
		typeof historical.qrKeyVersion !== "string" ||
		!identifierPattern.test(historical.qrKeyVersion)
	)
		fail("backup.key_inventory_invalid");
	if (
		typeof input.ageRecipient !== "string" ||
		!ageRecipientPattern.test(input.ageRecipient)
	)
		fail("backup.age_recipient_invalid");
	if (
		typeof input.releaseDigest !== "string" ||
		!digestPattern.test(input.releaseDigest)
	)
		fail("backup.release_digest_invalid");
	return {
		environment: "production",
		repository: validRepository(input.repository, currentHostnames),
		offHostConfirmed: true,
		resticPasswordFile: absoluteFile(
			input.resticPasswordFile,
			"backup.restic_password_invalid",
		),
		backupRoleFile: absoluteFile(
			input.backupRoleFile,
			"backup.backup_role_invalid",
		),
		ageRecipient: input.ageRecipient,
		releaseDigest: input.releaseDigest,
		historicalKeys: {
			kekVersions: identifiers(historical.kekVersions),
			qrKeyVersion: historical.qrKeyVersion,
		},
	};
}
function time(value: unknown) {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(parsed)) fail("backup.evidence_invalid");
	return parsed;
}
export function validateBackupEvidence(
	value: unknown,
	now = new Date(),
): BackupEvidence {
	const input = exact(value, evidenceKeys, "backup.evidence_invalid");
	if (
		input.schemaVersion !== 1 ||
		input.operation !== "backup" ||
		input.environment !== "production" ||
		typeof input.releaseDigest !== "string" ||
		!digestPattern.test(input.releaseDigest) ||
		typeof input.snapshotId !== "string" ||
		!identifierPattern.test(input.snapshotId) ||
		input.database !== "verified" ||
		input.qrKeyAvailable !== true ||
		input.result !== "pass" ||
		typeof input.durationMinutes !== "number" ||
		!Number.isFinite(input.durationMinutes) ||
		input.durationMinutes < 0 ||
		typeof input.rpoHours !== "number" ||
		!Number.isFinite(input.rpoHours) ||
		input.rpoHours < 0 ||
		input.rpoHours > 24
	)
		fail("backup.evidence_invalid");
	const recovered = time(input.recoveredAsOf),
		started = time(input.startedAt),
		finished = time(input.finishedAt),
		duration = (finished - started) / 60000;
	if (
		started > finished ||
		recovered > finished ||
		finished > now.getTime() ||
		now.getTime() - recovered > maxAgeMs ||
		input.durationMinutes !== duration ||
		input.rpoHours !== (finished - recovered) / 3600000
	)
		fail("backup.evidence_invalid");
	return {
		...input,
		historicalKekVersions: identifiers(input.historicalKekVersions),
	} as BackupEvidence;
}
export function backupMaintenanceBoundaries(scheduledAt: Date) {
	const day = scheduledAt.getUTCDay();
	const month = scheduledAt.getUTCMonth();
	const date = scheduledAt.getUTCDate();
	const weekly = day === 0;
	return {
		weekly,
		quarterly: [0, 3, 6, 9].includes(month) && date <= 7,
	};
}
export function backupSchedule() {
	return {
		daily: { metadataCheck: true },
		weekly: { readDataSubset: "5%", forget: true, prune: "explicit-gate" },
		quarterly: { fullRead: "recovery-machine-approved-window" },
		retention: { daily: 7, weekly: 5, monthly: 12 },
	} as const;
}
export function planProductionBackup(value: unknown) {
	const config = validateBackupConfig(value);
	return {
		config,
		steps: [
			"dump",
			"key-inventory",
			"encrypt-bundle",
			"manifest",
			"pre-snapshot-evidence",
			"backup",
			"snapshot-verify",
			"final-evidence",
		] as const,
		schedule: backupSchedule(),
	};
}
function assertGates(gates: BackupGates) {
	if (
		typeof gates.currentReleaseDigest !== "string" ||
		!digestPattern.test(gates.currentReleaseDigest)
	)
		fail("backup.current_release_invalid");
	if (
		!gates.stagingStopped ||
		!gates.capacityWithinBaseline ||
		!gates.loadWithinBaseline ||
		Object.values(gates.conflicts).some(Boolean)
	)
		fail("backup.preflight_failed");
}
function validDatabase(result: DatabaseVerification) {
	if (
		!result ||
		result.databaseVerified !== true ||
		!identifierPattern.test(result.minimumLedger) ||
		!/^[a-f0-9]{64}$/.test(result.schemaFingerprint) ||
		!Number.isFinite(time(result.recoveredAsOf))
	)
		fail("backup.database_invalid");
	return result;
}
function validInventory(
	inventory: KeyInventory,
	required: BackupConfig["historicalKeys"],
) {
	if (
		!inventory ||
		!identifierPattern.test(inventory.reference) ||
		inventory.qrKeyAvailable !== true ||
		inventory.qrKeyVersion !== required.qrKeyVersion ||
		!sameSet(inventory.kekVersions, required.kekVersions)
	)
		fail("backup.key_inventory_invalid");
	return inventory;
}
function validSnapshot(
	snapshot: BackupSnapshot,
	expected: Omit<BackupSnapshot, "id" | "successful" | "finishedAt">,
	started: number,
	finished: number,
) {
	if (
		!snapshot ||
		!snapshot.successful ||
		!identifierPattern.test(snapshot.id) ||
		snapshot.operationId !== expected.operationId ||
		snapshot.repository !== expected.repository ||
		snapshot.releaseDigest !== expected.releaseDigest ||
		!sameSet(snapshot.paths, expected.paths) ||
		!sameSet(snapshot.tags, expected.tags)
	)
		fail("backup.snapshot_invalid");
	const completed = time(snapshot.finishedAt);
	if (completed < started || completed > finished)
		fail("backup.snapshot_invalid");
	return snapshot;
}
function assertRecoveryOrdering(
	started: number,
	recoveredAsOf: string,
	snapshotFinishedAt: string,
	beforeCleanup: number,
	finished: number,
) {
	const recovered = time(recoveredAsOf);
	const snapshotFinished = time(snapshotFinishedAt);
	if (
		started > recovered ||
		recovered > snapshotFinished ||
		snapshotFinished > beforeCleanup ||
		beforeCleanup > finished
	)
		fail("backup.timeline_invalid");
}
export async function runProductionBackup(
	value: unknown,
	adapter: BackupAdapter,
	clock: Clock = () => new Date(),
): Promise<BackupEvidence> {
	const initialConfig = validateBackupConfig(value);
	const startedAt = clock();
	const gates = await adapter.preflight();
	assertGates(gates);
	const config = validateBackupConfig(
		initialConfig,
		trustedHostnames(gates.currentHostnames ?? []),
	);
	if (gates.currentReleaseDigest !== config.releaseDigest)
		fail("backup.current_release_mismatch");
	let staging: string | undefined;
	let pendingEvidence: BackupEvidence | undefined;
	let timeline:
		| {
				recoveredAsOf: string;
				snapshotFinishedAt: string;
				beforeCleanup: number;
		  }
		| undefined;
	let operationError: unknown;
	try {
		staging = await adapter.createStagingDirectory(0o700);
		const dump = `${staging}/database.dump`,
			bundle = `${staging}/keys.tar.age`,
			manifest = `${staging}/release-schema.json`,
			preEvidence = `${staging}/pre-snapshot-evidence.json`,
			paths = [dump, bundle, manifest, preEvidence],
			tags = ["agendia-backup", config.releaseDigest];
		const database = validDatabase(
			await adapter.dumpPostgres({
				image: postgresImage,
				format: "custom",
				noOwner: true,
				noAcl: true,
				serializableDeferrable: true,
				backupRoleFile: config.backupRoleFile,
				destination: dump,
			}),
		);
		const inventory = validInventory(
			await adapter.createKeyInventory({
				requiredKekVersions: config.historicalKeys.kekVersions,
				requiredQrKeyVersion: config.historicalKeys.qrKeyVersion,
			}),
			config.historicalKeys,
		);
		await adapter.encryptKeyBundle({
			recipient: config.ageRecipient,
			destination: bundle,
			inventoryReference: inventory.reference,
		});
		await adapter.writeReleaseSchemaManifest({
			releaseDigest: config.releaseDigest,
			destination: manifest,
			database,
		});
		await adapter.writePreSnapshotEvidence({
			releaseDigest: config.releaseDigest,
			destination: preEvidence,
			database,
			inventory,
		});
		const operation = await adapter.backup({
			repository: config.repository,
			passwordFile: config.resticPasswordFile,
			paths,
			releaseDigest: config.releaseDigest,
			tags,
		});
		if (!identifierPattern.test(operation.operationId))
			fail("backup.snapshot_invalid");
		const snapshot = await adapter.findSnapshot({
			operationId: operation.operationId,
			repository: config.repository,
			paths,
			releaseDigest: config.releaseDigest,
			tags,
		});
		const beforeCleanup = clock();
		validSnapshot(
			snapshot,
			{
				operationId: operation.operationId,
				repository: config.repository,
				paths,
				releaseDigest: config.releaseDigest,
				tags,
			},
			startedAt.getTime(),
			beforeCleanup.getTime(),
		);
		await adapter.checkMetadata({
			repository: config.repository,
			passwordFile: config.resticPasswordFile,
			snapshotId: snapshot.id,
			operationId: operation.operationId,
			releaseDigest: config.releaseDigest,
		});
		timeline = {
			recoveredAsOf: database.recoveredAsOf,
			snapshotFinishedAt: snapshot.finishedAt,
			beforeCleanup: beforeCleanup.getTime(),
		};
		pendingEvidence = {
			schemaVersion: 1,
			operation: "backup",
			environment: "production",
			releaseDigest: config.releaseDigest,
			snapshotId: snapshot.id,
			recoveredAsOf: database.recoveredAsOf,
			startedAt: startedAt.toISOString(),
			finishedAt: "",
			durationMinutes: 0,
			rpoHours: 0,
			database: "verified",
			historicalKekVersions: inventory.kekVersions,
			qrKeyAvailable: true,
			result: "pass",
		};
	} catch (error) {
		operationError = error;
	}
	if (staging)
		try {
			await adapter.removeStagingDirectory(staging);
		} catch {
			throw new Error("backup.cleanup_failed");
		}
	if (operationError) throw operationError;
	const finishedAt = clock();
	if (!pendingEvidence || !timeline) fail("backup.evidence_invalid");
	assertRecoveryOrdering(
		startedAt.getTime(),
		timeline.recoveredAsOf,
		timeline.snapshotFinishedAt,
		timeline.beforeCleanup,
		finishedAt.getTime(),
	);
	const evidence = validateBackupEvidence(
		{
			...pendingEvidence,
			finishedAt: finishedAt.toISOString(),
			durationMinutes: (finishedAt.getTime() - startedAt.getTime()) / 60000,
			rpoHours:
				(finishedAt.getTime() - time(pendingEvidence.recoveredAsOf)) / 3600000,
		},
		finishedAt,
	);
	await adapter.writeFinalEvidence(evidence);
	return evidence;
}
export async function runBackupMaintenance(
	context: MaintenanceContext,
	adapter: MaintenanceAdapter,
): Promise<void> {
	if (context.offHostConfirmed !== true) fail("backup.off_host_unconfirmed");
	const repository = validRepository(
		context.repository,
		trustedHostnames(context.currentHostnames),
	);
	const passwordFile = absoluteFile(
		context.passwordFile,
		"backup.restic_password_invalid",
	);
	const repositoryContext = { repository, passwordFile };
	const boundaries = backupMaintenanceBoundaries(context.scheduledAt);
	await adapter.checkMetadata(repositoryContext);
	if (boundaries.weekly) {
		if (context.stagingStopped && context.noConflict)
			await adapter.checkDataSubset({ ...repositoryContext, subset: "5%" });
		await adapter.forget({
			...repositoryContext,
			retention: { daily: 7, weekly: 5, monthly: 12 },
		});
		if (context.lowLoad && context.stagingStopped && context.noConflict)
			await adapter.prune(repositoryContext);
	}
	if (boundaries.quarterly && context.recoveryMachine && context.approvedWindow)
		await adapter.fullRead(repositoryContext);
}
