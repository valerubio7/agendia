import { describe, expect, test } from "bun:test";
import {
  AppendOnlyAuditLedger,
  OperationalKillSwitch,
  SafeTelemetry,
  verifyAuditChain,
} from "../../packages/observability/src/index.ts";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

describe("verifiable safe observability", () => {
  test("chains append-only tenant audit events with HMAC and detects tampering", () => {
    const ledger = new AppendOnlyAuditLedger("external-hmac-key");
    ledger.append({ businessId: tenantA, type: "ai.failed", outcome: "failure", source: "message-worker", occurredAt: "2026-03-01T10:00:00.000Z" });
    ledger.append({ businessId: tenantA, type: "whatsapp.send_failed", outcome: "failure", source: "whatsapp-manager", occurredAt: "2026-03-01T10:01:00.000Z" });
    expect(ledger.readForTenant(tenantA).map(({ sequence, previousHash }) => ({ sequence, previousHash }))).toEqual([
      { sequence: 1, previousHash: "GENESIS" },
      { sequence: 2, previousHash: ledger.readForTenant(tenantA)[0]!.eventHash },
    ]);
    expect(ledger.readForTenant(tenantB)).toHaveLength(0);
    expect(ledger.verify()).toBe(true);

    const tampered = ledger.readForTenant(tenantA).map((event) => ({ ...event }));
    tampered[1]!.outcome = "success";
    expect(verifyAuditChain(tampered, "external-hmac-key")).toBe(false);
  });

  test("redacts secrets and content while emitting pseudonymous structured logs and low-cardinality metrics", () => {
    const telemetry = new SafeTelemetry("telemetry-hmac-key");
    telemetry.recordFailure({
      component: "ai-provider",
      code: "ai.timeout",
      businessId: tenantA,
      correlationId: "req-1",
      details: { apiKey: "sk-live", prompt: "private chat", remoteJid: "549111@s.whatsapp.net", retryable: false },
      occurredAt: "2026-03-01T10:02:00.000Z",
    });
    expect(telemetry.logs[0]).toEqual({
      timestamp: "2026-03-01T10:02:00.000Z",
      level: "error",
      component: "ai-provider",
      code: "ai.timeout",
      correlationId: "req-1",
      tenantRef: expect.stringMatching(/^tenant_[a-f0-9]{12}$/),
      details: { apiKey: "[REDACTED]", prompt: "[REDACTED]", remoteJid: "[REDACTED]", retryable: false },
    });
    expect(telemetry.metrics[0]).toEqual({ name: "provider_failures_total", value: 1, labels: { component: "ai-provider", code: "ai.timeout" } });
    expect(telemetry.lastTechnicalActivity(tenantA)).toBe("2026-03-01T10:02:00.000Z");
    expect(telemetry.traces[0]?.attributes).toEqual({ component: "ai-provider", code: "ai.timeout", outcome: "failure" });
    for (const boundary of ["http", "job", "db", "provider"] as const) {
      telemetry.recordSpan({ boundary, operation: "request", correlationId: `trace-${boundary}`, outcome: "success" });
    }
    expect(telemetry.traces.slice(1).map((trace) => trace.name)).toEqual([
      "http.request",
      "job.request",
      "db.request",
      "provider.request",
    ]);
    expect(() => telemetry.recordMetric("unsafe", 1, { businessId: tenantA })).toThrow("Tenant identifiers are forbidden");
  });

  test("raises operational signals without cardinal tenant labels and supports incident containment", () => {
    const telemetry = new SafeTelemetry("telemetry-hmac-key");
    telemetry.observeQueue({ depth: 40, oldestJobAgeSeconds: 180, managerHeartbeatAgeSeconds: 75, backupAgeHours: 30 });
    expect(telemetry.alerts.map((alert) => alert.code)).toEqual([
      "queue.stalled",
      "manager.heartbeat_missing",
      "backup.overdue",
    ]);
    expect(JSON.stringify(telemetry.metrics)).not.toContain(tenantA);

    const killSwitch = new OperationalKillSwitch();
    expect(killSwitch.automationAllowed(true, true)).toBe(true);
    killSwitch.disable("incident-42");
    expect(killSwitch.automationAllowed(true, true)).toBe(false);
    killSwitch.enable();
    expect(killSwitch.automationAllowed(true, false)).toBe(false);
  });
});
