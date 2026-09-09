import { describe, expect, test } from "bun:test";
import {
	backupMaintenanceBoundaries,
	backupSchedule,
	planProductionBackup,
	runBackupMaintenance,
	validateBackupConfig,
	validateBackupEvidence,
} from "../../scripts/backup-production.ts";

const digest = `sha256:${"a".repeat(64)}`;
const recipient = `age1${"a".repeat(58)}`;
const config = () => ({
	environment: "production",
	repository: "sftp:backup@backup.example.invalid:/agendia-production",
	offHostConfirmed: true,
	resticPasswordFile: "/etc/agendia/backup/restic-password",
	backupRoleFile: "/etc/agendia/backup/database-url",
	ageRecipient: recipient,
	releaseDigest: digest,
	historicalKeys: {
		kekVersions: ["kek-2024", "kek-2025"],
		qrKeyVersion: "qr-2025",
	},
});
const evidence = () => ({
	schemaVersion: 1,
	operation: "backup",
	environment: "production",
	releaseDigest: digest,
	snapshotId: "snapshot-123",
	recoveredAsOf: "2025-01-01T00:00:00.000Z",
	startedAt: "2025-01-01T00:00:00.000Z",
	finishedAt: "2025-01-01T00:15:00.000Z",
	durationMinutes: 15,
	rpoHours: 0.25,
	database: "verified",
	historicalKekVersions: ["kek-2024", "kek-2025"],
	qrKeyAvailable: true,
	result: "pass",
});

describe("backup production correction contracts", () => {
	test("RED: accepts only credential-free real restic SFTP/S3 locators", () => {
		expect(validateBackupConfig(config()).repository).toContain(
			"backup.example.invalid",
		);
		expect(
			validateBackupConfig({
				...config(),
				repository: "s3:https://backup.example.invalid/agendia/production",
			}).repository,
		).toContain("s3:");
		for (const repository of [
			"/srv/backups",
			"file:///backup",
			"rest:http://localhost/repo",
			"sftp:user:password@host:/repo",
			"s3:https://user:password@host/bucket",
			"s3:https://127.0.0.1/bucket",
			"s3:https://host/bucket?token=secret",
		]) {
			expect(() => validateBackupConfig({ ...config(), repository })).toThrow(
				"backup.repository_invalid",
			);
		}
	});

	test("RED: validates finite ordered evidence and exact elapsed duration", () => {
		const now = new Date("2025-01-01T01:00:00.000Z");
		expect(validateBackupEvidence(evidence(), now).durationMinutes).toBe(15);
		for (const invalid of [
			{ ...evidence(), durationMinutes: Number.POSITIVE_INFINITY },
			{ ...evidence(), durationMinutes: 14 },
			{ ...evidence(), startedAt: "2025-01-01T00:16:00.000Z" },
			{ ...evidence(), recoveredAsOf: "2025-01-01T01:01:00.000Z" },
			{ ...evidence(), historicalKekVersions: ["kek-2024", "/etc/key"] },
		])
			expect(() => validateBackupEvidence(invalid, now)).toThrow(
				"backup.evidence_invalid",
			);
	});

	test("RED: derives UTC maintenance boundaries and binds every maintenance action to file-backed repository context", async () => {
		expect(backupSchedule()).toEqual({
			daily: { metadataCheck: true },
			weekly: { readDataSubset: "5%", forget: true, prune: "explicit-gate" },
			quarterly: { fullRead: "recovery-machine-approved-window" },
			retention: { daily: 7, weekly: 5, monthly: 12 },
		});
		const context = {
			repository: config().repository,
			passwordFile: config().resticPasswordFile,
			scheduledAt: new Date("2025-01-05T03:30:00.000Z"),
			lowLoad: true,
			stagingStopped: true,
			noConflict: true,
			recoveryMachine: false,
			approvedWindow: false,
			offHostConfirmed: true as const,
			currentHostnames: ["agendia-host"],
		};
		expect(backupMaintenanceBoundaries(context.scheduledAt)).toEqual({
			weekly: true,
			quarterly: true,
		});
		expect(
			backupMaintenanceBoundaries(new Date("2025-04-02T03:30:00.000Z")),
		).toEqual({ weekly: false, quarterly: true });
		const calls: Array<{ action: string; input: unknown }> = [];
		const adapter = {
			checkMetadata: async (input: unknown) => {
				calls.push({ action: "metadata", input });
			},
			checkDataSubset: async (input: unknown) => {
				calls.push({ action: "subset", input });
			},
			forget: async (input: unknown) => {
				calls.push({ action: "forget", input });
			},
			prune: async (input: unknown) => {
				calls.push({ action: "prune", input });
			},
			fullRead: async (input: unknown) => {
				calls.push({ action: "full", input });
			},
		};
		await runBackupMaintenance(context, adapter);
		expect(calls.map(({ action }) => action)).toEqual([
			"metadata",
			"subset",
			"forget",
			"prune",
		]);
		for (const { input } of calls)
			expect(input).toMatchObject({
				repository: context.repository,
				passwordFile: context.passwordFile,
			});
		const quarterlyOnly: string[] = [];
		await runBackupMaintenance(
			{
				...context,
				scheduledAt: new Date("2025-04-02T03:30:00.000Z"),
				recoveryMachine: true,
				approvedWindow: true,
			},
			{
				...adapter,
				checkMetadata: async () => {
					quarterlyOnly.push("metadata");
				},
				checkDataSubset: async () => {
					quarterlyOnly.push("subset");
				},
				forget: async () => {
					quarterlyOnly.push("forget");
				},
				prune: async () => {
					quarterlyOnly.push("prune");
				},
				fullRead: async () => {
					quarterlyOnly.push("full");
				},
			},
		);
		expect(quarterlyOnly).toEqual(["metadata", "full"]);

		const arbitraryApprovedDay: string[] = [];
		await runBackupMaintenance(
			{
				...context,
				scheduledAt: new Date("2025-05-02T03:30:00.000Z"),
				recoveryMachine: true,
				approvedWindow: true,
			},
			{
				...adapter,
				checkMetadata: async () => {
					arbitraryApprovedDay.push("metadata");
				},
				checkDataSubset: async () => {
					arbitraryApprovedDay.push("subset");
				},
				forget: async () => {
					arbitraryApprovedDay.push("forget");
				},
				prune: async () => {
					arbitraryApprovedDay.push("prune");
				},
				fullRead: async () => {
					arbitraryApprovedDay.push("full");
				},
			},
		);
		expect(arbitraryApprovedDay).toEqual(["metadata"]);
		expect(planProductionBackup(config()).steps).toContain("snapshot-verify");
	});

	test("RED: rejects unconfirmed or current-host maintenance repositories before adapter calls", async () => {
		const calls: string[] = [];
		const adapter = {
			checkMetadata: async () => {
				calls.push("metadata");
			},
			checkDataSubset: async () => {
				calls.push("subset");
			},
			forget: async () => {
				calls.push("forget");
			},
			prune: async () => {
				calls.push("prune");
			},
			fullRead: async () => {
				calls.push("full");
			},
		};
		const context = {
			repository: config().repository,
			passwordFile: config().resticPasswordFile,
			scheduledAt: new Date("2025-01-05T03:30:00.000Z"),
			lowLoad: true,
			stagingStopped: true,
			noConflict: true,
			recoveryMachine: true,
			approvedWindow: true,
			offHostConfirmed: true as const,
			currentHostnames: ["backup.example.invalid"],
		};
		await expect(runBackupMaintenance(context, adapter)).rejects.toThrow(
			"backup.repository_invalid",
		);
		expect(calls).toEqual([]);
		await expect(
			runBackupMaintenance(
				{ ...context, offHostConfirmed: false } as never,
				adapter,
			),
		).rejects.toThrow("backup.off_host_unconfirmed");
		expect(calls).toEqual([]);
	});

	test("TRIANGULATE: gates weekly data reads and pruning independently from scheduled retention", async () => {
		const context = {
			repository: config().repository,
			passwordFile: config().resticPasswordFile,
			scheduledAt: new Date("2025-01-05T03:30:00.000Z"),
			lowLoad: true,
			stagingStopped: false,
			noConflict: true,
			recoveryMachine: false,
			approvedWindow: false,
			offHostConfirmed: true as const,
			currentHostnames: ["agendia-host"],
		};
		for (const { overrides, expected } of [
			{
				overrides: { stagingStopped: false, noConflict: true, lowLoad: true },
				expected: ["metadata", "forget"],
			},
			{
				overrides: { stagingStopped: true, noConflict: false, lowLoad: true },
				expected: ["metadata", "forget"],
			},
			{
				overrides: { stagingStopped: true, noConflict: true, lowLoad: false },
				expected: ["metadata", "subset", "forget"],
			},
		]) {
			const calls: string[] = [];
			await runBackupMaintenance(
				{ ...context, ...overrides },
				{
					checkMetadata: async () => {
						calls.push("metadata");
					},
					checkDataSubset: async () => {
						calls.push("subset");
					},
					forget: async () => {
						calls.push("forget");
					},
					prune: async () => {
						calls.push("prune");
					},
					fullRead: async () => {
						calls.push("full");
					},
				},
			);
			expect(calls).toEqual(expected);
		}
	});
});
