import { z } from "zod";

const SENSITIVE_METADATA =
  /(pass(word)?|secret|token|cookie|authorization|api[-_]?key|qr|credential)/i;
function redactMetadata(
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      SENSITIVE_METADATA.test(key) ? "[REDACTED]" : value,
    ]),
  );
}

export const AuditEventSchema = z.object({
  businessId: z.uuid().nullable(),
  actorId: z.string().min(1).nullable(),
  type: z.string().regex(/^[a-z]+(?:[._][a-z]+)+$/),
  outcome: z.enum(["success", "failure", "denied"]),
  requestId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export function buildAuditEvent(
  input: Omit<AuditEvent, "occurredAt" | "metadata"> & {
    metadata?: Record<string, unknown>;
    occurredAt?: string;
  },
): AuditEvent {
  return AuditEventSchema.parse({
    ...input,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    metadata: redactMetadata(input.metadata),
  });
}

export * from "./http.ts";
