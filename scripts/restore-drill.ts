import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import postgres, { type Sql } from "postgres";
import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import {
	InMemoryAuthRecordRepository,
	InMemoryKms,
	BaileysAuthStore,
} from "@agendia/whatsapp-baileys";
import { openLinkCode, sealLinkCode } from "@agendia/db";
import {
	validateBackupEvidence,
	type BackupEvidence,
} from "./backup-production.ts";
import { postgresImage } from "./support/locked-images.ts";
import { schemaFingerprint } from "./support/postgres-migrations.ts";

const digest = /^sha256:[a-f0-9]{64}$/;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const restoreName = /^agendia-restore-\d{8}-[a-z0-9][a-z0-9-]{0,63}$/;
const forbiddenResource =
	/agendia-(?:prod|stg)|\/srv\/agendia\/(?:production|staging)/i;
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
const labels = (project: string) =>
	({
		"com.agendia.environment": "restore",
		"com.agendia.project": project,
		"com.agendia.managed": "true",
	}) as const;
const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";
const connectionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const connectionB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const linkToken = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const releaseDigest = `sha256:${"0".repeat(64)}`;
const kekKeys = {
	"kek-v1": Buffer.alloc(32, 1),
	"kek-v2": Buffer.alloc(32, 2),
};
const qrMaterial = { version: "qr-v1", key: Buffer.alloc(32, 3) } as const;

export interface RestoreEvidence {
	schemaVersion: 1;
	operation: "restore-drill";
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
export interface RestorePlan {
	project: string;
	volume: string;
	labels: Record<string, string>;
	restoreCommand: ["pg_restore", "--exit-on-error", "--no-owner", "--no-acl"];
	compatibility: "expand-compatible" | "contract-maintenance";
	backup: BackupEvidence;
	manifest: {
		releaseDigest: string;
		schemaFingerprint: string;
		minimumLedger: string;
		aggregates: {
			tenants: number;
			tenantRecords: number;
			authRecords: number;
			pendingJobs: number;
		};
		historicalKekVersions: string[];
		qrKeyVersion: string;
		compatibility: "expand-compatible" | "contract-maintenance";
	};
}
export interface RestoreDrillReport {
	schemaFingerprintVerified: boolean;
	minimumLedgerVerified: boolean;
	rlsVerified: boolean;
	pendingJobsVerified: boolean;
	authCiphertextsMatchBackup: boolean;
	historicalKekVersions: string[];
	qrKeyOpened: boolean;
	labeledTeardownVerified: boolean;
	evidencePersistedAfterTeardown: boolean;
	evidence: RestoreEvidence;
}
export interface RestoreDatabaseVerification {
	schemaFingerprint: string;
	minimumLedger: string;
	aggregates: RestorePlan["manifest"]["aggregates"];
	rlsOwnAuthRecords: number;
	crossTenantAuthRecords: number;
	ciphertextsMatchBackup: boolean;
}
export interface RestoreDrillAdapter {
	/** Reports material that is actually available to this adapter, never caller claims. */
	preflightKeyMaterial(): Promise<{
		kekVersions: string[];
		qrKey: { version: string; available: boolean };
	}>;
	createTarget(
		input: Pick<RestorePlan, "project" | "volume" | "labels">,
	): Promise<{
		project: string;
		volume: string;
		labels: Record<string, string>;
	}>;
	stageSnapshot(input: { snapshotId: string }): Promise<void>;
	restore(input: {
		command: RestorePlan["restoreCommand"];
	}): Promise<{ exitCode: number }>;
	verifyDatabase(): Promise<RestoreDatabaseVerification>;
	verifyCrypto(input: {
		requiredKekVersions: string[];
		qrKeyVersion: string;
	}): Promise<{ verifiedKekVersions: string[]; qrKeyOpened: boolean }>;
	teardown(
		input: Pick<RestorePlan, "project" | "volume" | "labels">,
	): Promise<void>;
	writeEvidence(evidence: RestoreEvidence): Promise<void>;
}

function fail(code: string): never {
	throw new Error(code);
}
function exact(
	value: unknown,
	keys: readonly string[],
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
function ids(value: unknown, code: string) {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every((v) => typeof v === "string" && identifier.test(v)) ||
		new Set(value).size !== value.length
	)
		fail(code);
	return value as string[];
}
function same(left: string[], right: string[]) {
	return (
		left.length === right.length &&
		[...left].sort().every((value, index) => value === [...right].sort()[index])
	);
}
function timestamp(value: unknown, code: string) {
	const parsed = typeof value === "string" ? Date.parse(value) : NaN;
	if (!Number.isFinite(parsed)) fail(code);
	return parsed;
}
function restoreBackup(value: unknown): BackupEvidence {
	try {
		const backup = validateBackupEvidence(
			value,
			new Date(
				timestamp(
					exact(value, evidenceKeys, "restore.backup_evidence_invalid")
						.finishedAt,
					"restore.backup_evidence_invalid",
				),
			),
		);
		if (backup.rpoHours > 24) fail("restore.backup_evidence_invalid");
		return backup;
	} catch {
		return fail("restore.backup_evidence_invalid");
	}
}
function manifest(value: unknown) {
	const item = exact(
		value,
		[
			"schemaVersion",
			"releaseDigest",
			"schemaFingerprint",
			"minimumLedger",
			"aggregates",
			"compatibility",
			"historicalKekVersions",
			"qrKeyVersion",
		],
		"restore.manifest_invalid",
	);
	if (
		item.schemaVersion !== 1 ||
		typeof item.releaseDigest !== "string" ||
		!digest.test(item.releaseDigest) ||
		typeof item.schemaFingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(item.schemaFingerprint) ||
		typeof item.minimumLedger !== "string" ||
		!identifier.test(item.minimumLedger) ||
		(item.compatibility !== "expand-compatible" &&
			item.compatibility !== "contract-maintenance") ||
		typeof item.qrKeyVersion !== "string" ||
		!identifier.test(item.qrKeyVersion)
	)
		fail("restore.manifest_invalid");
	const aggregates = exact(
		item.aggregates,
		["tenants", "tenantRecords", "authRecords", "pendingJobs"],
		"restore.manifest_invalid",
	);
	if (
		Object.values(aggregates).some(
			(value) => !Number.isSafeInteger(value) || (value as number) < 0,
		)
	)
		fail("restore.manifest_invalid");
	return {
		...item,
		aggregates: aggregates as RestorePlan["manifest"]["aggregates"],
		historicalKekVersions: ids(
			item.historicalKekVersions,
			"restore.manifest_invalid",
		),
	} as RestorePlan["manifest"];
}
function resources(value: unknown) {
	const input = exact(
		value,
		["sourceVolume", "mounts"],
		"restore.resource_invalid",
	);
	if (
		typeof input.sourceVolume !== "string" ||
		forbiddenResource.test(input.sourceVolume) ||
		!Array.isArray(input.mounts) ||
		input.mounts.some(
			(mount) => typeof mount !== "string" || forbiddenResource.test(mount),
		)
	)
		fail("restore.resource_invalid");
}
export function planRestoreDrill(
	value: unknown,
	_now = new Date(),
): RestorePlan {
	const input = exact(
		value,
		["backupEvidence", "manifest", "keyBundle", "resources", "restoreId"],
		"restore.input_invalid",
	);
	const backup = restoreBackup(input.backupEvidence),
		release = manifest(input.manifest);
	resources(input.resources);
	if (
		typeof input.restoreId !== "string" ||
		!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.restoreId)
	)
		fail("restore.resource_invalid");
	const project = `agendia-restore-${_now.toISOString().slice(0, 10).replaceAll("-", "")}-${input.restoreId}`;
	if (!restoreName.test(project)) fail("restore.resource_invalid");
	const bundle = exact(
		input.keyBundle,
		["kekVersions", "qrKeyVersion", "qrKeyAvailable"],
		"restore.key_bundle_invalid",
	);
	const kekVersions = ids(bundle.kekVersions, "restore.key_bundle_invalid");
	if (
		bundle.qrKeyAvailable !== true ||
		bundle.qrKeyVersion !== release.qrKeyVersion ||
		backup.releaseDigest !== release.releaseDigest ||
		!same(backup.historicalKekVersions, release.historicalKekVersions) ||
		!same(kekVersions, release.historicalKekVersions)
	)
		fail("restore.key_bundle_invalid");
	return {
		project,
		volume: `${project}-postgres`,
		labels: labels(project) as Record<string, string>,
		restoreCommand: ["pg_restore", "--exit-on-error", "--no-owner", "--no-acl"],
		compatibility: release.compatibility,
		backup,
		manifest: release,
	};
}
export function validateRestoreEvidence(
	value: unknown,
	now = new Date(),
): RestoreEvidence {
	const item = exact(value, evidenceKeys, "restore.evidence_invalid");
	if (
		item.schemaVersion !== 1 ||
		item.operation !== "restore-drill" ||
		item.environment !== "production" ||
		typeof item.releaseDigest !== "string" ||
		!digest.test(item.releaseDigest) ||
		typeof item.snapshotId !== "string" ||
		!identifier.test(item.snapshotId) ||
		item.database !== "verified" ||
		item.qrKeyAvailable !== true ||
		item.result !== "pass" ||
		typeof item.durationMinutes !== "number" ||
		!Number.isFinite(item.durationMinutes) ||
		item.durationMinutes < 0 ||
		item.durationMinutes > 360 ||
		typeof item.rpoHours !== "number" ||
		!Number.isFinite(item.rpoHours) ||
		item.rpoHours < 0 ||
		item.rpoHours > 24
	)
		fail("restore.evidence_invalid");
	const recovered = timestamp(item.recoveredAsOf, "restore.evidence_invalid"),
		started = timestamp(item.startedAt, "restore.evidence_invalid"),
		finished = timestamp(item.finishedAt, "restore.evidence_invalid");
	if (
		recovered > finished ||
		started > finished ||
		finished > now.getTime() ||
		item.durationMinutes !== (finished - started) / 60000
	)
		fail("restore.evidence_invalid");
	return {
		...item,
		historicalKekVersions: ids(
			item.historicalKekVersions,
			"restore.evidence_invalid",
		),
	} as RestoreEvidence;
}
function exactTarget(
	plan: RestorePlan,
	observed: { project: string; volume: string; labels: Record<string, string> },
) {
	if (
		observed.project !== plan.project ||
		observed.volume !== plan.volume ||
		JSON.stringify(observed.labels) !== JSON.stringify(plan.labels)
	)
		fail("restore.target_invalid");
}
function verifiedDatabase(
	value: RestoreDatabaseVerification,
	plan: RestorePlan,
) {
	const expectedAuthRecords = plan.manifest.aggregates.authRecords;
	if (
		value.schemaFingerprint !== plan.manifest.schemaFingerprint ||
		value.minimumLedger !== plan.manifest.minimumLedger ||
		JSON.stringify(value.aggregates) !==
			JSON.stringify(plan.manifest.aggregates) ||
		!Number.isSafeInteger(value.rlsOwnAuthRecords) ||
		value.crossTenantAuthRecords !== 0 ||
		(expectedAuthRecords === 0
			? value.rlsOwnAuthRecords !== 0
			: value.rlsOwnAuthRecords < 1 ||
				value.rlsOwnAuthRecords > expectedAuthRecords) ||
		value.ciphertextsMatchBackup !== true
	)
		fail("restore.database_verification_failed");
}
/** Executes the only restore path; PASS evidence is written only after an exact target teardown. */
export async function executeRestoreDrill(
	plan: RestorePlan,
	adapter: RestoreDrillAdapter,
	clock: () => Date = () => new Date(),
): Promise<
	Omit<
		RestoreDrillReport,
		"labeledTeardownVerified" | "evidencePersistedAfterTeardown"
	>
> {
	const started = clock();
	let created = false;
	let failure: unknown;
	let database: RestoreDatabaseVerification | undefined;
	let crypto:
		| { verifiedKekVersions: string[]; qrKeyOpened: boolean }
		| undefined;
	try {
		const keyMaterial = await adapter.preflightKeyMaterial();
		if (
			!same(keyMaterial.kekVersions, plan.manifest.historicalKekVersions) ||
			keyMaterial.qrKey.version !== plan.manifest.qrKeyVersion ||
			keyMaterial.qrKey.available !== true
		)
			fail("restore.key_material_invalid");
		const target = await adapter.createTarget(plan);
		created = true;
		exactTarget(plan, target);
		await adapter.stageSnapshot({ snapshotId: plan.backup.snapshotId });
		if (
			(await adapter.restore({ command: plan.restoreCommand })).exitCode !== 0
		)
			fail("restore.pg_restore_failed");
		database = await adapter.verifyDatabase();
		verifiedDatabase(database, plan);
		crypto = await adapter.verifyCrypto({
			requiredKekVersions: plan.manifest.historicalKekVersions,
			qrKeyVersion: plan.manifest.qrKeyVersion,
		});
		if (
			!same(crypto.verifiedKekVersions, plan.manifest.historicalKekVersions) ||
			!crypto.qrKeyOpened
		)
			fail("restore.crypto_verification_failed");
	} catch (error) {
		failure = error;
	}
	if (created)
		try {
			await adapter.teardown(plan);
		} catch {
			throw new Error("restore.teardown_failed");
		}
	if (failure) throw failure;
	if (!database || !crypto) fail("restore.evidence_invalid");
	const finished = clock();
	const evidence = validateRestoreEvidence(
		{
			schemaVersion: 1,
			operation: "restore-drill",
			environment: "production",
			releaseDigest: plan.manifest.releaseDigest,
			snapshotId: plan.backup.snapshotId,
			recoveredAsOf: plan.backup.recoveredAsOf,
			startedAt: started.toISOString(),
			finishedAt: finished.toISOString(),
			durationMinutes: (finished.getTime() - started.getTime()) / 60000,
			rpoHours: plan.backup.rpoHours,
			database: "verified",
			historicalKekVersions: crypto.verifiedKekVersions,
			qrKeyAvailable: true,
			result: "pass",
		},
		finished,
	);
	const report = {
		schemaFingerprintVerified: true,
		minimumLedgerVerified: true,
		rlsVerified: true,
		pendingJobsVerified: true,
		authCiphertextsMatchBackup: database.ciphertextsMatchBackup,
		historicalKekVersions: crypto.verifiedKekVersions,
		qrKeyOpened: crypto.qrKeyOpened,
		evidence,
	};
	await adapter.writeEvidence(evidence);
	return report;
}

async function migrate(sql: Sql) {
	for (const name of readdirSync(
		join(import.meta.dir, "../packages/db/migrations"),
	)
		.filter((file) => file.endsWith(".sql"))
		.sort())
		await sql.unsafe(
			readFileSync(
				join(import.meta.dir, "../packages/db/migrations", name),
				"utf8",
			),
		);
}
async function populateLedger(sql: Sql) {
	await sql.unsafe(
		"create table if not exists agendia_schema_migrations (filename text primary key, sha256 text not null, applied_at timestamptz not null default now(), release_digest text not null, execution text not null)",
	);
	for (const filename of readdirSync(
		join(import.meta.dir, "../packages/db/migrations"),
	)
		.filter((file) => file.endsWith(".sql"))
		.sort()) {
		const sha256 = createHash("sha256")
			.update(
				readFileSync(
					join(import.meta.dir, "../packages/db/migrations", filename),
				),
			)
			.digest("hex");
		await sql`insert into agendia_schema_migrations (filename,sha256,release_digest,execution) values (${filename},${sha256},${releaseDigest},'migrated') on conflict (filename) do update set sha256=excluded.sha256`;
	}
}
async function seed(sql: Sql) {
	await sql`insert into businesses (id,name) values (${tenantA},'restore-a'),(${tenantB},'restore-b')`;
	await sql`insert into tenant_records (business_id,value) values (${tenantA},'a'),(${tenantB},'b')`;
	const repository = new InMemoryAuthRecordRepository();
	const kms = new InMemoryKms(kekKeys, "kek-v1");
	const store = new BaileysAuthStore(repository, kms);
	await store.write(tenantA, connectionA, "creds", { controlled: true }, 0);
	kms.currentVersion = "kek-v2";
	await store.write(tenantB, connectionB, "creds", { controlled: true }, 0);
	for (const [id, connection] of repository.connections)
		await sql`insert into whatsapp_connections (id,business_id,state,wrapped_dek,wrapped_dek_nonce,wrapped_dek_tag,kek_version) values (${id},${connection.businessId},'CONNECTED',${connection.ciphertext},${connection.iv},${connection.tag},${connection.kekVersion})`;
	for (const record of repository.records.values())
		await sql`insert into whatsapp_auth_records (business_id,connection_id,record_name,version,nonce,ciphertext,auth_tag) values (${record.businessId},${record.connectionId},${record.name},${record.version},${record.iv},${record.ciphertext},${record.tag})`;
	const link = sealLinkCode(
		qrMaterial.key,
		tenantA,
		connectionA,
		linkToken,
		"controlled-qr",
	);
	await sql`insert into whatsapp_link_codes (connection_id,business_id,token,ciphertext,nonce,auth_tag,expires_at) values (${link.connectionId},${link.businessId},${link.token},${link.ciphertext},${link.nonce},${link.tag},now()+interval '1 hour')`;
	await sql`insert into outbox_events (business_id,topic,stable_key,payload) values (${tenantA},'ai.generate','restore-job',${sql.json({ controlled: true })})`;
}
async function auth(sql: Sql) {
	return sql<
		{ ciphertext: Buffer }[]
	>`select ciphertext from whatsapp_auth_records order by ciphertext`;
}
async function aggregates(
	sql: Sql,
): Promise<RestorePlan["manifest"]["aggregates"]> {
	const [result] = await sql<
		{
			tenants: string;
			tenant_records: string;
			auth_records: string;
			pending_jobs: string;
		}[]
	>`select
		(select count(*)::text from businesses) tenants,
		(select count(*)::text from tenant_records) tenant_records,
		(select count(*)::text from whatsapp_auth_records) auth_records,
		(select count(*)::text from outbox_events where published_at is null) pending_jobs`;
	return {
		tenants: Number(result?.tenants ?? 0),
		tenantRecords: Number(result?.tenant_records ?? 0),
		authRecords: Number(result?.auth_records ?? 0),
		pendingJobs: Number(result?.pending_jobs ?? 0),
	};
}
async function dump(container: StartedPostgreSqlContainer) {
	const result = await container.exec([
		"sh",
		"-lc",
		'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --data-only --exclude-table-data=agendia_schema_migrations --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" > /tmp/agendia.dump',
	]);
	if (result.exitCode) fail("restore.pg_dump_failed");
	const stream = await container.copyArchiveFromContainer("/tmp/agendia.dump");
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}
async function restore(container: StartedPostgreSqlContainer, archive: Buffer) {
	await container.copyArchiveToContainer(Readable.from(archive), "/tmp");
	const result = await container.exec([
		"pg_restore",
		"--exit-on-error",
		"--no-owner",
		"--no-acl",
		"--username",
		"test",
		"--dbname",
		"test",
		"/tmp/agendia.dump",
	]);
	return { exitCode: result.exitCode };
}
class TestcontainersRestoreDrillAdapter implements RestoreDrillAdapter {
	private target: StartedPostgreSqlContainer | undefined;
	private targetSql: Sql | undefined;
	private staged: Buffer | undefined;
	private tornDown = false;
	private teardownStarted = false;
	private labelsVerified = false;
	private allocatedStorage: string | undefined;
	private validatedStorage: string | undefined;
	private targetStorageRoot: string | undefined;
	constructor(
		private readonly snapshot: Buffer,
		private readonly expectedSnapshotId: string,
		private readonly sourceAuth: { ciphertext: Buffer }[],
		private readonly expectedFingerprint: string,
		private readonly expectedLedger: string[],
		private readonly expectedMinimumLedger: string,
		private readonly evidenceSink: RestoreEvidence[],
	) {}
	async preflightKeyMaterial() {
		return {
			kekVersions: Object.keys(kekKeys),
			qrKey: {
				version: qrMaterial.version,
				available: qrMaterial.key.length === 32,
			},
		};
	}
	private async cleanupAllocatedTarget() {
		let cleanupFailed = false;
		try {
			await this.targetSql?.end();
		} catch {
			cleanupFailed = true;
		} finally {
			this.targetSql = undefined;
			try {
				const emptied = await this.target?.exec(
					[
						"sh",
						"-lc",
						"rm -rf /var/lib/postgresql/data/* /var/lib/postgresql/data/.[!.]*",
					],
					{ user: "0" },
				);
				if (emptied && emptied.exitCode !== 0) cleanupFailed = true;
			} catch {
				cleanupFailed = true;
			} finally {
				try {
					await this.target?.stop({ removeVolumes: true });
				} catch {
					cleanupFailed = true;
				} finally {
					this.target = undefined;
					try {
						for (let attempt = 0; attempt < 5; attempt++)
							try {
								if (this.validatedStorage ?? this.allocatedStorage)
									rmdirSync(this.validatedStorage ?? this.allocatedStorage!);
								if (this.targetStorageRoot) rmdirSync(this.targetStorageRoot);
								break;
							} catch (error) {
								if (attempt === 4) throw error;
								await new Promise((resolve) => setTimeout(resolve, 100));
							}
					} catch {
						cleanupFailed = true;
					}
					this.allocatedStorage = undefined;
					this.validatedStorage = undefined;
					this.targetStorageRoot = undefined;
				}
			}
		}
		return cleanupFailed;
	}
	async createTarget(plan: Pick<RestorePlan, "project" | "volume" | "labels">) {
		if (
			plan.volume !== `${plan.project}-postgres` ||
			forbiddenResource.test(plan.volume)
		)
			fail("restore.target_invalid");
		const storageRoot = mkdtempSync(join(tmpdir(), "agendia-restore-storage-"));
		chmodSync(storageRoot, 0o700);
		const storage = join(storageRoot, plan.volume);
		mkdirSync(storage, { mode: 0o700 });
		this.allocatedStorage = storage;
		this.targetStorageRoot = storageRoot;
		try {
			const container = new PostgreSqlContainer(postgresImage)
				.withName(plan.project)
				.withLabels(plan.labels)
				.withBindMounts([
					{ source: storage, target: "/var/lib/postgresql/data", mode: "rw" },
				]);
			this.target = await container.start();
			const runtime = await getContainerRuntimeClient();
			// SAFETY: Docker inspect mount metadata is runtime JSON not exposed by Testcontainers' public type.
			const inspected = (await runtime.container.inspect(
				runtime.container.getById(this.target.getId()),
			)) as unknown as {
				Mounts?: {
					Type?: string;
					Source?: string;
					Destination?: string;
					RW?: boolean;
				}[];
			};
			const mounted = inspected.Mounts?.some(
				(mount) =>
					mount.Type === "bind" &&
					mount.Source === storage &&
					mount.Destination === "/var/lib/postgresql/data" &&
					mount.RW === true,
			);
			if (!mounted || forbiddenResource.test(storage))
				fail("restore.target_invalid");
			this.validatedStorage = storage;
			this.targetSql = postgres(this.target.getConnectionUri());
			await migrate(this.targetSql);
			await populateLedger(this.targetSql);
			await this.targetSql`delete from operational_controls`;
			this.labelsVerified =
				this.target.getName().replace(/^\//, "") === plan.project &&
				Object.entries(plan.labels).every(
					([key, value]) => this.target?.getLabels()[key] === value,
				);
			if (!this.labelsVerified) fail("restore.target_invalid");
			return {
				project: plan.project,
				volume: plan.volume,
				labels: plan.labels,
			};
		} catch (error) {
			await this.cleanupAllocatedTarget();
			throw error;
		}
	}
	async stageSnapshot(input: { snapshotId: string }) {
		if (input.snapshotId !== this.expectedSnapshotId)
			fail("restore.snapshot_invalid");
		this.staged = this.snapshot;
	}
	async restore(input: { command: RestorePlan["restoreCommand"] }) {
		if (
			JSON.stringify(input.command) !==
				JSON.stringify([
					"pg_restore",
					"--exit-on-error",
					"--no-owner",
					"--no-acl",
				]) ||
			!this.target ||
			!this.staged
		)
			return { exitCode: 1 };
		return restore(this.target, this.staged);
	}
	async verifyDatabase() {
		const sql = this.targetSql;
		if (!sql) fail("restore.target_invalid");
		const actualAggregates = await aggregates(sql);
		const visible = await sql.begin(async (tx) => {
			await tx.unsafe("set local role agendia_whatsapp_runtime");
			await tx`select set_config('app.tenant_id',${tenantA},true)`;
			return tx<
				{ business_id: string }[]
			>`select business_id::text from whatsapp_auth_records`;
		});
		const restored = await auth(sql);
		const ledger = await sql<
			{ filename: string }[]
		>`select filename from agendia_schema_migrations order by filename`;
		return {
			schemaFingerprint: await schemaFingerprint(sql),
			minimumLedger: same(
				ledger.map((row) => row.filename),
				this.expectedLedger,
			)
				? this.expectedMinimumLedger
				: "ledger-invalid",
			aggregates: actualAggregates,
			rlsOwnAuthRecords: visible.length,
			crossTenantAuthRecords: visible.filter(
				(row) => row.business_id !== tenantA,
			).length,
			pendingJobs: actualAggregates.pendingJobs,
			ciphertextsMatchBackup:
				JSON.stringify(
					restored.map((row) => row.ciphertext.toString("hex")),
				) ===
					JSON.stringify(
						this.sourceAuth.map((row) => row.ciphertext.toString("hex")),
					) && (await schemaFingerprint(sql)) === this.expectedFingerprint,
		};
	}
	async verifyCrypto(input: {
		requiredKekVersions: string[];
		qrKeyVersion: string;
	}) {
		const sql = this.targetSql;
		if (
			!sql ||
			!same(input.requiredKekVersions, Object.keys(kekKeys)) ||
			input.qrKeyVersion !== "qr-v1"
		)
			fail("restore.crypto_verification_failed");
		const connections = await sql<
			{
				id: string;
				business_id: string;
				wrapped_dek: Buffer;
				wrapped_dek_nonce: Buffer;
				wrapped_dek_tag: Buffer;
				kek_version: string;
			}[]
		>`select id::text,business_id::text,wrapped_dek,wrapped_dek_nonce,wrapped_dek_tag,kek_version from whatsapp_connections order by kek_version`;
		const records = await sql<
			{
				business_id: string;
				connection_id: string;
				record_name: string;
				version: number;
				ciphertext: Buffer;
				nonce: Buffer;
				auth_tag: Buffer;
			}[]
		>`select business_id::text,connection_id::text,record_name,version,ciphertext,nonce,auth_tag from whatsapp_auth_records order by connection_id`;
		const repository = new InMemoryAuthRecordRepository();
		for (const row of connections)
			repository.connections.set(row.id, {
				businessId: row.business_id,
				ciphertext: row.wrapped_dek,
				iv: row.wrapped_dek_nonce,
				tag: row.wrapped_dek_tag,
				kekVersion: row.kek_version,
			});
		for (const row of records)
			repository.records.set(`${row.connection_id}:${row.record_name}`, {
				businessId: row.business_id,
				connectionId: row.connection_id,
				name: row.record_name,
				version: row.version,
				ciphertext: row.ciphertext,
				iv: row.nonce,
				tag: row.auth_tag,
			});
		const store = new BaileysAuthStore(
			repository,
			new InMemoryKms(kekKeys, "kek-v2"),
		);
		for (const row of connections) {
			const sample = await store.read(row.business_id, row.id, "creds");
			if (
				!(
					sample &&
					typeof sample === "object" &&
					(sample as { controlled?: unknown }).controlled === true
				)
			)
				fail("restore.crypto_verification_failed");
		}
		const [link] = await sql<
			{
				business_id: string;
				connection_id: string;
				token: string;
				ciphertext: Buffer;
				nonce: Buffer;
				auth_tag: Buffer;
			}[]
		>`select business_id::text,connection_id::text,token::text,ciphertext,nonce,auth_tag from whatsapp_link_codes`;
		if (
			!link ||
			openLinkCode(qrMaterial.key, {
				businessId: link.business_id,
				connectionId: link.connection_id,
				token: link.token,
				ciphertext: link.ciphertext,
				nonce: link.nonce,
				tag: link.auth_tag,
			}) !== "controlled-qr"
		)
			fail("restore.crypto_verification_failed");
		return {
			verifiedKekVersions: connections.map((row) => row.kek_version),
			qrKeyOpened: true,
		};
	}
	async teardown(plan: Pick<RestorePlan, "project" | "volume" | "labels">) {
		if (
			this.teardownStarted ||
			this.tornDown ||
			!this.target ||
			!this.labelsVerified ||
			!this.validatedStorage ||
			plan.volume !== `${plan.project}-postgres` ||
			this.target.getName().replace(/^\//, "") !== plan.project
		)
			fail("restore.target_invalid");
		this.teardownStarted = true;
		const cleanupFailed = await this.cleanupAllocatedTarget();
		this.tornDown = !cleanupFailed;
		if (cleanupFailed) fail("restore.teardown_failed");
	}
	async writeEvidence(evidence: RestoreEvidence) {
		if (!this.tornDown || !this.labelsVerified)
			fail("restore.evidence_before_teardown");
		this.evidenceSink.push(evidence);
	}
	get teardownVerified() {
		return this.tornDown && this.labelsVerified;
	}
}
/** Repository-only Testcontainers drill; it has no restic, age, credentials, host mounts, or external restore capability. */
export interface LocalRestoreDrillOptions {
	compatibility?: "expand-compatible" | "contract-maintenance";
	recoveredAsOf?: string;
	clock?: () => Date;
}
export async function runRestoreDrill(
	options: LocalRestoreDrillOptions = {},
): Promise<RestoreDrillReport> {
	let source: StartedPostgreSqlContainer | undefined;
	let sourceSql: Sql | undefined;
	try {
		source = await new PostgreSqlContainer(postgresImage).start();
		sourceSql = postgres(source.getConnectionUri());
		await migrate(sourceSql);
		await populateLedger(sourceSql);
		await seed(sourceSql);
		const sourceAuth = await auth(sourceSql);
		const sourceFingerprint = await schemaFingerprint(sourceSql);
		const sourceAggregates = await aggregates(sourceSql);
		const ledger = (
			await sourceSql<
				{ filename: string }[]
			>`select filename from agendia_schema_migrations order by filename`
		).map((row) => row.filename);
		const bytes = await dump(source);
		const dumpSha256 = createHash("sha256").update(bytes).digest("hex");
		const derivedSnapshotId = `snapshot-${dumpSha256}`;
		const derivedReleaseDigest = `sha256:${dumpSha256}`;
		const fixtureClock = options.clock?.() ?? new Date();
		const recoveredAsOf = options.recoveredAsOf ?? fixtureClock.toISOString();
		const recoveredAt = Date.parse(recoveredAsOf);
		if (!Number.isFinite(recoveredAt) || recoveredAt > fixtureClock.getTime())
			fail("restore.backup_evidence_invalid");
		const compatibility = options.compatibility ?? "expand-compatible";
		const historicalKekVersions = Object.keys(kekKeys);
		const backupEvidence = {
			schemaVersion: 1,
			operation: "backup",
			environment: "production",
			releaseDigest: derivedReleaseDigest,
			snapshotId: derivedSnapshotId,
			recoveredAsOf,
			startedAt: new Date(fixtureClock.getTime() - 14 * 60_000).toISOString(),
			finishedAt: fixtureClock.toISOString(),
			durationMinutes: 14,
			rpoHours: (fixtureClock.getTime() - recoveredAt) / 3_600_000,
			database: "verified",
			historicalKekVersions,
			qrKeyAvailable: qrMaterial.key.length === 32,
			result: "pass",
		};
		const plan = planRestoreDrill({
			backupEvidence,
			manifest: {
				schemaVersion: 1,
				releaseDigest: derivedReleaseDigest,
				schemaFingerprint: sourceFingerprint,
				minimumLedger:
					ledger.at(-1) ?? fail("restore.database_verification_failed"),
				aggregates: sourceAggregates,
				compatibility,
				historicalKekVersions,
				qrKeyVersion: qrMaterial.version,
			},
			keyBundle: {
				kekVersions: historicalKekVersions,
				qrKeyVersion: qrMaterial.version,
				qrKeyAvailable: qrMaterial.key.length === 32,
			},
			resources: { sourceVolume: "restore-source-fixture", mounts: [] },
			restoreId: "local",
		});
		const sink: RestoreEvidence[] = [];
		const adapter = new TestcontainersRestoreDrillAdapter(
			bytes,
			derivedSnapshotId,
			sourceAuth,
			sourceFingerprint,
			ledger,
			ledger.at(-1) ?? fail("restore.database_verification_failed"),
			sink,
		);
		const report = await executeRestoreDrill(plan, adapter, options.clock);
		if (
			sink.length !== 1 ||
			sink[0] !== report.evidence ||
			!adapter.teardownVerified
		)
			fail("restore.evidence_invalid");
		return {
			...report,
			labeledTeardownVerified: adapter.teardownVerified,
			evidencePersistedAfterTeardown: sink.length === 1,
		};
	} finally {
		await sourceSql?.end();
		await source?.stop();
	}
}
if (import.meta.main) {
	const report = await runRestoreDrill();
	console.log(
		JSON.stringify({
			operation: report.evidence.operation,
			result: report.evidence.result,
		}),
	);
}
