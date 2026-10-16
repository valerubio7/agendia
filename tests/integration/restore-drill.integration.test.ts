import { expect, test } from "bun:test";
import { runRestoreDrill } from "../../scripts/restore-drill.ts";

test("restores an isolated PostgreSQL backup with tenant counts, RLS, jobs and encrypted Baileys auth", async () => {
  const report = await runRestoreDrill();
  expect(report.tenantMessageCounts).toEqual({
    "11111111-1111-4111-8111-111111111111": 1,
    "22222222-2222-4222-8222-222222222222": 1,
  });
  expect(report.tenantAVisibleAuthRecords).toBe(1);
  expect(report.crossTenantAuthRecords).toBe(0);
  expect(report.pendingJobs).toBe(1);
  expect(report.restoredAuthRecords).toBe(2);
  expect(report.authCiphertextsMatchBackup).toBe(true);
  expect(report.nonemptyInstructionsMatchBackup).toBe(true);
  expect(report.operationalMetadataMatchesBackup).toBe(true);
  expect(report.historicalKekVersions).toEqual(["kek-v1", "kek-v2"]);
  expect(report.plaintextCredentialFound).toBe(false);
  expect(report.throttleStateMatchesBackup).toBe(true);
  expect(report.restoredThrottle.global).toEqual([
    { singleton: true, attempts: 87, resets_at: "2099-01-01T00:01:00.000Z" },
  ]);
  expect(report.restoredThrottle.accounts).toEqual([
    { account_hash: "a".repeat(64), attempts: 20, resets_at: "2099-01-01T00:15:00.000Z" },
    { account_hash: "b".repeat(64), attempts: 7, resets_at: "2099-01-02T00:15:00.000Z" },
  ]);
}, 120_000);

test("restores a pre-throttle backup with a usable default global admission budget", async () => {
  const report = await runRestoreDrill({ legacyBackup: true });
  expect(report.restoredThrottle.global).toHaveLength(1);
  expect(report.restoredThrottle.global[0]).toMatchObject({ singleton: true, attempts: 0 });
  expect(Date.parse(report.restoredThrottle.global[0]!.resets_at)).toBeLessThanOrEqual(Date.now());
  expect(report.restoredThrottle.accounts).toEqual([]);
  expect(report.legacyThrottleAdmissionAllowed).toBe(true);
  expect(report.authCiphertextsMatchBackup).toBe(true);
  expect(report.restoredAuthRecords).toBe(2);
  expect(report.tenantAVisibleAuthRecords).toBe(1);
  expect(report.crossTenantAuthRecords).toBe(0);
  expect(report.nonemptyInstructionsMatchBackup).toBe(true);
  expect(report.operationalMetadataMatchesBackup).toBe(true);
  expect(report.plaintextCredentialFound).toBe(false);
}, 120_000);
