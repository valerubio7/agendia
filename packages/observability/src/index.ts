import { createHmac } from "node:crypto";

export const packageName = "@agendia/observability" as const;

const SENSITIVE_FIELD = /(authorization|api[-_]?key|cookie|credential|jid|message|pass(word)?|prompt|qr|secret|session|token|raw[_-]?text)/i;
const TENANT_LABEL = /^(business|tenant)[_-]?id$/i;

function hmac(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function redactSensitive(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => {
    if (SENSITIVE_FIELD.test(key)) return [key, "[REDACTED]"];
    if (Array.isArray(value)) return [key, value.map((item) => item !== null && typeof item === "object" ? redactSensitive(item as Record<string, unknown>) : item)];
    if (value !== null && typeof value === "object") return [key, redactSensitive(value as Record<string, unknown>)];
    return [key, value];
  }));
}

export const CRITICAL_AUDIT_EVENTS = Object.freeze([
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "business.created",
  "business.suspended",
  "business.active",
  "business_profile.updated",
  "assistant.updated",
  "assistant.activated",
  "assistant.deactivated",
  "whatsapp.link_started",
  "whatsapp.connected",
  "whatsapp.connection_failed",
  "whatsapp.send_failed",
  "ai.failed",
] as const);

export interface AuditInput {
  businessId: string | null;
  type: string;
  outcome: "success" | "failure" | "denied";
  source: string;
  actorId?: string;
  requestId?: string;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export interface ChainedAuditEvent extends AuditInput {
  sequence: number;
  previousHash: string;
  eventHash: string;
  metadata: Record<string, unknown>;
}

function auditPayload(event: Omit<ChainedAuditEvent, "eventHash">): string {
  return canonical(event);
}

export function verifyAuditChain(events: readonly ChainedAuditEvent[], key: string): boolean {
  let previousHash = "GENESIS";
  let sequence = 1;
  for (const event of events) {
    if (event.sequence !== sequence || event.previousHash !== previousHash) return false;
    const { eventHash, ...unsigned } = event;
    if (hmac(auditPayload(unsigned), key) !== eventHash) return false;
    previousHash = eventHash;
    sequence += 1;
  }
  return true;
}

export class AppendOnlyAuditLedger {
  private readonly streams = new Map<string, ChainedAuditEvent[]>();

  constructor(private readonly key: string) {
    if (key.length < 16) throw new Error("Audit HMAC key is too short");
  }

  append(input: AuditInput): ChainedAuditEvent {
    const stream = input.businessId ?? "platform";
    const current = this.streams.get(stream) ?? [];
    const unsigned: Omit<ChainedAuditEvent, "eventHash"> = {
      ...input,
      metadata: redactSensitive(input.metadata ?? {}),
      sequence: current.length + 1,
      previousHash: current.at(-1)?.eventHash ?? "GENESIS",
    };
    const event: ChainedAuditEvent = {
      ...unsigned,
      eventHash: hmac(auditPayload(unsigned), this.key),
    };
    current.push(event);
    this.streams.set(stream, current);
    return structuredClone(event);
  }

  readForTenant(businessId: string | null): ChainedAuditEvent[] {
    return structuredClone(this.streams.get(businessId ?? "platform") ?? []);
  }

  verify(businessId?: string | null): boolean {
    if (businessId !== undefined) return verifyAuditChain(this.readForTenant(businessId), this.key);
    return [...this.streams.values()].every((events) => verifyAuditChain(events, this.key));
  }
}

export interface SafeLog {
  timestamp: string;
  level: "info" | "warning" | "error";
  component: string;
  code: string;
  correlationId: string;
  tenantRef: string;
  details: Record<string, unknown>;
}

export interface MetricPoint {
  name: string;
  value: number;
  labels: Record<string, string>;
}

export interface TraceRecord {
  name: string;
  correlationId: string;
  attributes: Record<string, string>;
}

export interface Alert {
  code: "queue.stalled" | "manager.heartbeat_missing" | "backup.overdue";
  severity: "warning" | "critical";
}

export class SafeTelemetry {
  readonly logs: SafeLog[] = [];
  readonly metrics: MetricPoint[] = [];
  readonly traces: TraceRecord[] = [];
  readonly alerts: Alert[] = [];
  private readonly lastActivity = new Map<string, string>();

  constructor(private readonly pseudonymKey: string) {
    if (pseudonymKey.length < 16) throw new Error("Telemetry pseudonym key is too short");
  }

  recordFailure(input: {
    component: "http" | "job" | "db" | "ai-provider" | "whatsapp-provider";
    code: string;
    businessId: string;
    correlationId: string;
    details?: Record<string, unknown>;
    occurredAt: string;
  }): void {
    const labels = this.safeLabels({ component: input.component, code: input.code });
    this.logs.push({
      timestamp: input.occurredAt,
      level: "error",
      component: input.component,
      code: input.code,
      correlationId: input.correlationId,
      tenantRef: `tenant_${hmac(input.businessId, this.pseudonymKey).slice(0, 12)}`,
      details: redactSensitive(input.details ?? {}),
    });
    this.metrics.push({ name: "provider_failures_total", value: 1, labels });
    this.traces.push({
      name: `${input.component}.failure`,
      correlationId: input.correlationId,
      attributes: { ...labels, outcome: "failure" },
    });
    this.lastActivity.set(input.businessId, input.occurredAt);
  }

  recordSpan(input: {
    boundary: "http" | "job" | "db" | "provider";
    operation: string;
    correlationId: string;
    outcome: "success" | "failure";
  }): void {
    this.traces.push({
      name: `${input.boundary}.${input.operation}`,
      correlationId: input.correlationId,
      attributes: { boundary: input.boundary, outcome: input.outcome },
    });
  }

  recordMetric(name: string, value: number, labels: Record<string, string>): void {
    this.metrics.push({ name, value, labels: this.safeLabels(labels) });
  }

  lastTechnicalActivity(businessId: string): string | null {
    return this.lastActivity.get(businessId) ?? null;
  }

  observeQueue(input: {
    depth: number;
    oldestJobAgeSeconds: number;
    managerHeartbeatAgeSeconds: number;
    backupAgeHours: number;
  }): void {
    this.recordMetric("queue_depth", input.depth, { component: "message-worker" });
    this.recordMetric("queue_oldest_job_age_seconds", input.oldestJobAgeSeconds, { component: "message-worker" });
    this.recordMetric("manager_heartbeat_age_seconds", input.managerHeartbeatAgeSeconds, { component: "whatsapp-manager" });
    this.recordMetric("backup_age_hours", input.backupAgeHours, { component: "postgres" });
    if (input.oldestJobAgeSeconds >= 120) this.alerts.push({ code: "queue.stalled", severity: "critical" });
    if (input.managerHeartbeatAgeSeconds >= 60) this.alerts.push({ code: "manager.heartbeat_missing", severity: "critical" });
    if (input.backupAgeHours >= 24) this.alerts.push({ code: "backup.overdue", severity: "warning" });
  }

  private safeLabels(labels: Record<string, string>): Record<string, string> {
    if (Object.keys(labels).some((key) => TENANT_LABEL.test(key))) {
      throw new Error("Tenant identifiers are forbidden in metric labels");
    }
    return { ...labels };
  }
}

export class OperationalKillSwitch {
  private disabledReason: string | null = null;

  disable(reason: string): void {
    if (!reason.trim()) throw new Error("Kill switch requires an incident reason");
    this.disabledReason = reason;
  }

  enable(): void {
    this.disabledReason = null;
  }

  status(): { enabled: boolean; reason: string | null } {
    return { enabled: this.disabledReason === null, reason: this.disabledReason };
  }

  automationAllowed(businessActive: boolean, assistantActive: boolean): boolean {
    return this.disabledReason === null && businessActive && assistantActive;
  }
}
