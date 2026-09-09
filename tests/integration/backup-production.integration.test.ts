import { describe, expect, test } from "bun:test";
import {
	type BackupAdapter,
	runProductionBackup,
} from "../../scripts/backup-production.ts";
import { postgresImage } from "../../scripts/support/locked-images.ts";

const digest = `sha256:${"b".repeat(64)}`;
const config = {
	environment: "production" as const,
	repository: "s3:https://backup.example.invalid/agendia/production",
	offHostConfirmed: true as const,
	resticPasswordFile: "/etc/agendia/backup/restic-password",
	backupRoleFile: "/etc/agendia/backup/database-url",
	ageRecipient: `age1${"a".repeat(58)}`,
	releaseDigest: digest,
	historicalKeys: { kekVersions: ["kek-v1", "kek-v2"], qrKeyVersion: "qr-v2" },
};
const clock = (() => {
	let calls = 0;
	return () =>
		new Date(`2025-01-01T00:${String(calls++ * 10).padStart(2, "0")}:00.000Z`);
})();

function fake(overrides: Partial<BackupAdapter> = {}) {
	const calls: string[] = [];
	const staging = "/tmp/agendia-test-repository/staging";
	const paths = [
		`${staging}/database.dump`,
		`${staging}/keys.tar.age`,
		`${staging}/release-schema.json`,
		`${staging}/pre-snapshot-evidence.json`,
	];
	const adapter: BackupAdapter = {
		preflight: async () => ({
			stagingStopped: true,
			capacityWithinBaseline: true,
			loadWithinBaseline: true,
			currentReleaseDigest: digest,
			conflicts: {
				backup: false,
				prune: false,
				migration: false,
				restore: false,
				hostMaintenance: false,
			},
		}),
		createStagingDirectory: async () => staging,
		dumpPostgres: async (input) => {
			calls.push(`dump:${input.image}`);
			return {
				recoveredAsOf: "2025-01-01T00:00:00.000Z",
				schemaFingerprint: "a".repeat(64),
				minimumLedger: "0022_service_heartbeats.sql",
				databaseVerified: true,
			};
		},
		createKeyInventory: async (input) => {
			calls.push(
				`inventory:${input.requiredKekVersions.join(",")}:${input.requiredQrKeyVersion}`,
			);
			return {
				reference: "inventory-1",
				kekVersions: ["kek-v1", "kek-v2"],
				qrKeyVersion: "qr-v2",
				qrKeyAvailable: true,
			};
		},
		encryptKeyBundle: async (input) => {
			calls.push(`encrypt:${input.inventoryReference}`);
		},
		writeReleaseSchemaManifest: async (input) => {
			calls.push(`manifest:${input.database.schemaFingerprint}`);
		},
		writePreSnapshotEvidence: async (input) => {
			calls.push(`pre:${input.database.minimumLedger}`);
		},
		backup: async (input) => {
			calls.push(`backup:${input.paths.length}`);
			return { operationId: "backup-operation-1" };
		},
		findSnapshot: async (input) => ({
			operationId: input.operationId,
			repository: input.repository,
			paths: input.paths,
			releaseDigest: input.releaseDigest,
			tags: input.tags,
			id: "snapshot-1",
			successful: true,
			finishedAt: "2025-01-01T00:10:00.000Z",
		}),
		checkMetadata: async (input) => {
			calls.push(`check:${JSON.stringify(input)}`);
		},
		writeFinalEvidence: async () => {
			calls.push("evidence");
		},
		removeStagingDirectory: async () => {
			calls.push("cleanup");
		},
		...overrides,
	};
	return { adapter, calls };
}

describe("backup production ephemeral adapter integration", () => {
	test("RED: binds trusted dump/inventory/snapshot values and cleans before PASS evidence", async () => {
		const { adapter, calls } = fake();
		const evidence = await runProductionBackup(config, adapter, clock);
		expect(calls).toEqual([
			`dump:${postgresImage}`,
			"inventory:kek-v1,kek-v2:qr-v2",
			"encrypt:inventory-1",
			`manifest:${"a".repeat(64)}`,
			"pre:0022_service_heartbeats.sql",
			"backup:4",
			`check:${JSON.stringify({
				repository: config.repository,
				passwordFile: config.resticPasswordFile,
				snapshotId: "snapshot-1",
				operationId: "backup-operation-1",
				releaseDigest: digest,
			})}`,
			"cleanup",
			"evidence",
		]);
		expect(evidence).toMatchObject({
			recoveredAsOf: "2025-01-01T00:00:00.000Z",
			database: "verified",
			historicalKekVersions: ["kek-v1", "kek-v2"],
			durationMinutes: 20,
		});
	});

	test("RED: rejects caller-claimed releases, invalid dump timelines, and metadata checks outside this operation", async () => {
		for (const currentReleaseDigest of [
			undefined,
			`sha256:${"c".repeat(64)}`,
		]) {
			const broken = fake({
				preflight: async () => ({
					stagingStopped: true,
					capacityWithinBaseline: true,
					loadWithinBaseline: true,
					currentReleaseDigest: currentReleaseDigest as string,
					conflicts: {
						backup: false,
						prune: false,
						migration: false,
						restore: false,
						hostMaintenance: false,
					},
				}),
			});
			await expect(
				runProductionBackup(config, broken.adapter, clock),
			).rejects.toThrow();
			expect(broken.calls).not.toContain("cleanup");
		}
		for (const overrides of [
			{
				dumpPostgres: async () => ({
					recoveredAsOf: "2024-12-31T23:59:00.000Z",
					schemaFingerprint: "a".repeat(64),
					minimumLedger: "0022_service_heartbeats.sql",
					databaseVerified: true as const,
				}),
			},
			{
				dumpPostgres: async () => ({
					recoveredAsOf: "2025-01-01T00:11:00.000Z",
					schemaFingerprint: "a".repeat(64),
					minimumLedger: "0022_service_heartbeats.sql",
					databaseVerified: true as const,
				}),
			},
		] satisfies Array<Partial<BackupAdapter>>) {
			const broken = fake(overrides);
			let clockCall = 0;
			const timelineClock = () =>
				new Date(
					`2025-01-01T00:${String(clockCall++ * 10).padStart(2, "0")}:00.000Z`,
				);
			await expect(
				runProductionBackup(config, broken.adapter, timelineClock),
			).rejects.toThrow("backup.timeline_invalid");
			expect(broken.calls).not.toContain("evidence");
		}
	});

	test("RED: rejects malformed repositories before any adapter call and trusted current-host aliases after preflight", async () => {
		for (const repository of [
			"s3:https://localhost/agendia/production",
			"s3:https://127.0.0.1/agendia/production",
			"/srv/agendia/backup",
		]) {
			const broken = fake({
				preflight: async () => {
					broken.calls.push("preflight");
					return {
						stagingStopped: true,
						capacityWithinBaseline: true,
						loadWithinBaseline: true,
						currentReleaseDigest: digest,
						conflicts: {
							backup: false,
							prune: false,
							migration: false,
							restore: false,
							hostMaintenance: false,
						},
					};
				},
			});
			await expect(
				runProductionBackup({ ...config, repository }, broken.adapter),
			).rejects.toThrow("backup.repository_invalid");
			expect(broken.calls).toEqual([]);
		}
		const alias = fake({
			preflight: async () => {
				alias.calls.push("preflight");
				return {
					stagingStopped: true,
					capacityWithinBaseline: true,
					loadWithinBaseline: true,
					currentHostnames: ["backup.example.invalid"],
					currentReleaseDigest: digest,
					conflicts: {
						backup: false,
						prune: false,
						migration: false,
						restore: false,
						hostMaintenance: false,
					},
				};
			},
		});
		await expect(runProductionBackup(config, alias.adapter)).rejects.toThrow(
			"backup.repository_invalid",
		);
		expect(alias.calls).toEqual(["preflight"]);
	});

	test("TRIANGULATE: rejects unsafe inventory, unrelated snapshots, and cleanup failure without PASS evidence", async () => {
		const cases: Array<Partial<BackupAdapter>> = [
			{
				createKeyInventory: async () => ({
					reference: "inventory-1",
					kekVersions: ["kek-v1"],
					qrKeyVersion: "qr-v2",
					qrKeyAvailable: true as const,
				}),
			},
			{
				findSnapshot: async () => ({
					operationId: "other-operation",
					repository: "s3:https://backup.example.invalid/other",
					paths: [],
					releaseDigest: digest,
					tags: [],
					id: "latest",
					successful: true,
					finishedAt: "2025-01-01T00:10:00.000Z",
				}),
			},
			{
				removeStagingDirectory: async () => {
					throw new Error("cleanup");
				},
			},
		];
		for (const overrides of cases) {
			const broken = fake(overrides);
			await expect(
				runProductionBackup(
					config,
					broken.adapter,
					() => new Date("2025-01-01T00:00:00.000Z"),
				),
			).rejects.toThrow();
			expect(broken.calls).not.toContain("evidence");
		}
	});
});
