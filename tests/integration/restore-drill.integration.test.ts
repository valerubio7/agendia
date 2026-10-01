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
  expect(report.historicalKekVersions).toEqual(["kek-v1", "kek-v2"]);
  expect(report.plaintextCredentialFound).toBe(false);
}, 120_000);
