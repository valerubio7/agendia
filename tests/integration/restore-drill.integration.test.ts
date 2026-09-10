import { expect, test } from "bun:test";
import { runRestoreDrill } from "../../scripts/restore-drill.ts";

test("restores a labeled isolated PostgreSQL snapshot through the executor and retains redacted evidence after teardown", async () => {
	const report = await runRestoreDrill();

	expect(report.schemaFingerprintVerified).toBe(true);
	expect(report.minimumLedgerVerified).toBe(true);
	expect(report.rlsVerified).toBe(true);
	expect(report.pendingJobsVerified).toBe(true);
	expect(report.authCiphertextsMatchBackup).toBe(true);
	expect(report.historicalKekVersions).toEqual(["kek-v1", "kek-v2"]);
	expect(report.qrKeyOpened).toBe(true);
	expect(report.labeledTeardownVerified).toBe(true);
	expect(report.evidencePersistedAfterTeardown).toBe(true);
	expect(report.evidence.operation).toBe("restore-drill");
	expect(report.evidence.database).toBe("verified");
	expect(report.evidence.historicalKekVersions).toEqual(["kek-v1", "kek-v2"]);
	expect(JSON.stringify(report)).not.toContain(
		"11111111-1111-4111-8111-111111111111",
	);
	expect(JSON.stringify(report)).not.toContain("controlled-auth-sample");
}, 120_000);

test("triangulates a historical snapshot with contract-maintenance compatibility through the same isolated executor", async () => {
	const report = await runRestoreDrill({
		compatibility: "contract-maintenance",
		recoveredAsOf: "2023-06-15T00:00:00.000Z",
		clock: () => new Date("2023-06-15T00:15:00.000Z"),
	});

	expect(report.schemaFingerprintVerified).toBe(true);
	expect(report.minimumLedgerVerified).toBe(true);
	expect(report.historicalKekVersions).toEqual(["kek-v1", "kek-v2"]);
	expect(report.qrKeyOpened).toBe(true);
	expect(report.labeledTeardownVerified).toBe(true);
	expect(report.evidencePersistedAfterTeardown).toBe(true);
	expect(report.evidence.recoveredAsOf).toBe("2023-06-15T00:00:00.000Z");
	expect(report.evidence.snapshotId).toMatch(/^snapshot-[a-f0-9]{64}$/);
	expect(report.evidence.finishedAt).toBe("2023-06-15T00:15:00.000Z");
}, 120_000);
