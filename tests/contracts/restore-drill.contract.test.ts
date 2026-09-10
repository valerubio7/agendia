import { expect, test } from "bun:test";
import {
	executeRestoreDrill,
	planRestoreDrill,
	validateRestoreEvidence,
	type RestoreDrillAdapter,
} from "../../scripts/restore-drill.ts";

const digest = `sha256:${"a".repeat(64)}`;
const now = new Date("2025-01-02T00:00:00.000Z");
const backup = (overrides: Record<string, unknown> = {}) => ({
	schemaVersion: 1,
	operation: "backup",
	environment: "production",
	releaseDigest: digest,
	snapshotId: "snapshot-20240101",
	recoveredAsOf: "2024-01-01T00:00:00.000Z",
	startedAt: "2024-01-01T00:01:00.000Z",
	finishedAt: "2024-01-01T00:15:00.000Z",
	durationMinutes: 14,
	rpoHours: 0.25,
	database: "verified",
	historicalKekVersions: ["kek-v1", "kek-v2"],
	qrKeyAvailable: true,
	result: "pass",
	...overrides,
});
const input = (overrides: Record<string, unknown> = {}) => ({
	backupEvidence: backup(),
	manifest: {
		schemaVersion: 1,
		releaseDigest: digest,
		schemaFingerprint: "b".repeat(64),
		minimumLedger: "0022_service_heartbeats.sql",
		aggregates: {
			tenants: 2,
			tenantRecords: 2,
			authRecords: 2,
			pendingJobs: 1,
		},
		compatibility: "expand-compatible",
		historicalKekVersions: ["kek-v1", "kek-v2"],
		qrKeyVersion: "qr-v1",
	},
	keyBundle: {
		kekVersions: ["kek-v1", "kek-v2"],
		qrKeyVersion: "qr-v1",
		qrKeyAvailable: true,
	},
	resources: { sourceVolume: "production-postgres", mounts: [] },
	restoreId: "a1b2",
	...overrides,
});

function adapter(overrides: Partial<RestoreDrillAdapter> = {}) {
	const calls: string[] = [];
	const project = "agendia-restore-20250102-a1b2";
	const labels = {
		"com.agendia.environment": "restore",
		"com.agendia.project": project,
		"com.agendia.managed": "true",
	};
	return {
		calls,
		adapter: {
			preflightKeyMaterial: async () => ({
				kekVersions: ["kek-v1", "kek-v2"],
				qrKey: { version: "qr-v1", available: true },
			}),
			createTarget: async () => {
				calls.push("create");
				return { project, volume: `${project}-postgres`, labels };
			},
			stageSnapshot: async () => {
				calls.push("stage");
			},
			restore: async () => {
				calls.push("restore");
				return { exitCode: 0 };
			},
			verifyDatabase: async () => ({
				schemaFingerprint: "b".repeat(64),
				minimumLedger: "0022_service_heartbeats.sql",
				aggregates: {
					tenants: 2,
					tenantRecords: 2,
					authRecords: 2,
					pendingJobs: 1,
				},
				rlsOwnAuthRecords: 1,
				crossTenantAuthRecords: 0,
				ciphertextsMatchBackup: true,
			}),
			verifyCrypto: async () => ({
				verifiedKekVersions: ["kek-v1", "kek-v2"],
				qrKeyOpened: true,
			}),
			teardown: async () => {
				calls.push("teardown");
			},
			writeEvidence: async () => {
				calls.push("evidence");
			},
			...overrides,
		} satisfies RestoreDrillAdapter,
	};
}

test("RED: derives an isolated restore target and validates every source artifact before target creation", async () => {
	const plan = planRestoreDrill(input(), now);
	expect(plan.project).toBe("agendia-restore-20250102-a1b2");
	expect(plan.volume).toBe("agendia-restore-20250102-a1b2-postgres");
	expect(plan.restoreCommand).toEqual([
		"pg_restore",
		"--exit-on-error",
		"--no-owner",
		"--no-acl",
	]);
	for (const invalid of [
		input({
			keyBundle: {
				kekVersions: ["kek-v1"],
				qrKeyVersion: "qr-v1",
				qrKeyAvailable: true,
			},
		}),
		input({
			keyBundle: {
				kekVersions: ["kek-v1", "kek-v2"],
				qrKeyVersion: "qr-v1",
				qrKeyAvailable: false,
			},
		}),
		input({ resources: { sourceVolume: "agendia-stg-postgres", mounts: [] } }),
		input({
			resources: {
				sourceVolume: "safe",
				mounts: ["/srv/agendia/production/postgres"],
			},
		}),
	])
		expect(() => planRestoreDrill(invalid, now)).toThrow();
	const fake = adapter();
	await expect(
		executeRestoreDrill(plan, fake.adapter, () => now),
	).resolves.toMatchObject({
		schemaFingerprintVerified: true,
		minimumLedgerVerified: true,
		rlsVerified: true,
		pendingJobsVerified: true,
	});
	expect(fake.calls).toEqual([
		"create",
		"stage",
		"restore",
		"teardown",
		"evidence",
	]);
});

test("TRIANGULATE: fails closed for bad observed resources and every post-create failure, tearing down exactly once without PASS evidence", async () => {
	const plan = planRestoreDrill(
		input({
			manifest: { ...input().manifest, compatibility: "contract-maintenance" },
		}),
		now,
	);
	for (const overrides of [
		{
			createTarget: async () => ({
				project: plan.project,
				volume: "wrong",
				labels: plan.labels,
			}),
		},
		{ restore: async () => ({ exitCode: 1 }) },
		{
			verifyDatabase: async () => ({
				schemaFingerprint: "0".repeat(64),
				minimumLedger: plan.manifest.minimumLedger,
				aggregates: plan.manifest.aggregates,
				rlsOwnAuthRecords: 1,
				crossTenantAuthRecords: 0,
				ciphertextsMatchBackup: true,
			}),
		},
		{
			verifyCrypto: async () => ({
				verifiedKekVersions: ["kek-v1"],
				qrKeyOpened: false,
			}),
		},
	] satisfies Partial<RestoreDrillAdapter>[]) {
		const fake = adapter(overrides);
		await expect(
			executeRestoreDrill(plan, fake.adapter, () => now),
		).rejects.toThrow();
		expect(fake.calls.filter((call) => call === "teardown")).toHaveLength(1);
		expect(fake.calls).not.toContain("evidence");
	}
	const teardownFails = adapter({
		teardown: async () => {
			throw new Error("no");
		},
	});
	await expect(
		executeRestoreDrill(plan, teardownFails.adapter, () => now),
	).rejects.toThrow("restore.teardown_failed");
	expect(teardownFails.calls).not.toContain("evidence");
});

test("validates exactly the redacted fourteen-field restore evidence", () => {
	const evidence = validateRestoreEvidence(
		{
			...backup(),
			operation: "restore-drill",
			finishedAt: "2025-01-01T00:30:00.000Z",
			startedAt: "2025-01-01T00:00:00.000Z",
			durationMinutes: 30,
			rpoHours: 0.25,
		},
		new Date("2025-01-01T01:00:00.000Z"),
	);
	expect(Object.keys(evidence)).toHaveLength(14);
	expect(() =>
		validateRestoreEvidence({ ...evidence, plaintext: "forbidden" }, now),
	).toThrow("restore.evidence_invalid");
});

test("RED: rejects unavailable adapter key material before target allocation and never emits PASS", async () => {
	const plan = planRestoreDrill(input(), now);
	const fake = adapter({
		preflightKeyMaterial: async () => ({
			kekVersions: ["kek-v1"],
			qrKey: { version: "qr-v1", available: true },
		}),
	} as unknown as Partial<RestoreDrillAdapter>);
	await expect(
		executeRestoreDrill(plan, fake.adapter, () => now),
	).rejects.toThrow("restore.key_material_invalid");
	expect(fake.calls).toEqual([]);
});

test("RED: includes successful teardown in RTO before writing PASS evidence", async () => {
	const plan = planRestoreDrill(input(), now);
	let current = now;
	let persistedDuration: number | undefined;
	const fake = adapter({
		teardown: async () => {
			fake.calls.push("teardown");
			current = new Date(current.getTime() + 2 * 60_000);
		},
		writeEvidence: async (evidence) => {
			fake.calls.push("evidence");
			persistedDuration = evidence.durationMinutes;
		},
	});

	const report = await executeRestoreDrill(plan, fake.adapter, () => current);

	expect(report.evidence.durationMinutes).toBe(2);
	expect(persistedDuration).toBe(2);
	expect(fake.calls).toEqual([
		"create",
		"stage",
		"restore",
		"teardown",
		"evidence",
	]);
});

test("TRIANGULATE: rejects an RTO beyond six hours after teardown without PASS evidence", async () => {
	const plan = planRestoreDrill(input(), now);
	let current = now;
	const fake = adapter({
		teardown: async () => {
			fake.calls.push("teardown");
			current = new Date(current.getTime() + 361 * 60_000);
		},
	});

	await expect(
		executeRestoreDrill(plan, fake.adapter, () => current),
	).rejects.toThrow("restore.evidence_invalid");
	expect(fake.calls).toEqual(["create", "stage", "restore", "teardown"]);
});

test("TRIANGULATE: accepts an exact empty production manifest but requires positive RLS proof when auth exists", async () => {
	const emptyPlan = planRestoreDrill(
		input({
			manifest: {
				...input().manifest,
				aggregates: {
					tenants: 0,
					tenantRecords: 0,
					authRecords: 0,
					pendingJobs: 0,
				},
			},
		}),
		now,
	);
	const empty = adapter({
		verifyDatabase: async () => ({
			schemaFingerprint: "b".repeat(64),
			minimumLedger: "0022_service_heartbeats.sql",
			aggregates: emptyPlan.manifest.aggregates,
			rlsOwnAuthRecords: 0,
			crossTenantAuthRecords: 0,
			ciphertextsMatchBackup: true,
		}),
	});
	await expect(
		executeRestoreDrill(emptyPlan, empty.adapter, () => now),
	).resolves.toMatchObject({ rlsVerified: true, pendingJobsVerified: true });
	const emptyCrossTenant = adapter({
		verifyDatabase: async () => ({
			schemaFingerprint: "b".repeat(64),
			minimumLedger: "0022_service_heartbeats.sql",
			aggregates: emptyPlan.manifest.aggregates,
			rlsOwnAuthRecords: 0,
			crossTenantAuthRecords: 1,
			ciphertextsMatchBackup: true,
		}),
	});
	await expect(
		executeRestoreDrill(emptyPlan, emptyCrossTenant.adapter, () => now),
	).rejects.toThrow("restore.database_verification_failed");
	expect(() =>
		planRestoreDrill(
			input({
				manifest: {
					...input().manifest,
					aggregates: {
						tenants: -1,
						tenantRecords: 0,
						authRecords: 0,
						pendingJobs: 0,
					},
				},
			}),
			now,
		),
	).toThrow("restore.manifest_invalid");

	const positivePlan = planRestoreDrill(
		input({
			manifest: {
				...input().manifest,
				aggregates: {
					tenants: 1,
					tenantRecords: 1,
					authRecords: 1,
					pendingJobs: 0,
				},
			},
		}),
		now,
	);
	const absentOwnRecord = adapter({
		verifyDatabase: async () => ({
			schemaFingerprint: "b".repeat(64),
			minimumLedger: "0022_service_heartbeats.sql",
			aggregates: positivePlan.manifest.aggregates,
			rlsOwnAuthRecords: 0,
			crossTenantAuthRecords: 0,
			ciphertextsMatchBackup: true,
		}),
	});
	await expect(
		executeRestoreDrill(positivePlan, absentOwnRecord.adapter, () => now),
	).rejects.toThrow("restore.database_verification_failed");
	expect(absentOwnRecord.calls).toEqual([
		"create",
		"stage",
		"restore",
		"teardown",
	]);
});
