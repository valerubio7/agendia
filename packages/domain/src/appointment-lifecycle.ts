import { z } from "zod";
import { parseInstantMs, type Instant } from "./calendar-values.ts";
import { ServiceInputSchema, type ServiceInput } from "./service-catalog.ts";
import type { ResourceInput } from "./resource-catalog.ts";

export const AppointmentStateSchema = z.enum(["confirmed", "done", "cancelled", "no_show"]);
export const AppointmentOriginSchema = z.enum(["manual", "ai"]);
export type AppointmentState = z.infer<typeof AppointmentStateSchema>;
export type AppointmentOrigin = z.infer<typeof AppointmentOriginSchema>;

export type AppointmentPolicyError =
  | "notes_locked"
  | "not_transition"
  | "invalid_action_context"
  | "attendance_forbidden"
  | "invalid_attendance_time"
  | "before_start"
  | "confirmation_required";
export type AppointmentPolicyResult = { ok: true } | { ok: false; error: AppointmentPolicyError };

export interface AppointmentLifecycleFacts {
  readonly state: AppointmentState;
  readonly origin: AppointmentOrigin;
  /** Same explicit-offset, exact-millisecond contract as the shared InstantSchema. */
  readonly startsAt: Instant;
}

/**
 * Trusted action facts from a verified caller, separate from the creation origin.
 * The caller establishes business/client/sender ownership and authorization.
 * An AI cancellation invocation represents a clear cancellation request, not inferred intent.
 * These policies neither authenticate these facts nor send messages or persist changes.
 */
export interface AppointmentActionContext {
  readonly actor: "businessAdmin" | "platformAdmin" | "customer" | "ai";
  readonly channel: "manual" | "ai";
  /** Only literal boolean true acknowledges a manual final-state action. */
  readonly confirmed?: unknown;
  /** Injected clock; attendance fails closed on invalid exact instants. */
  readonly now: Instant;
}

/** Notes only: this grants no permission to change schedule, service or resource. */
export function canEditAppointmentNotes(state: AppointmentState): AppointmentPolicyResult {
  return state === "confirmed" ? { ok: true } : { ok: false, error: "notes_locked" };
}

/**
 * Authorize an explicit state transition only; no automatic elapsed-time transition,
 * reopening or reapplication. Creation origin does not determine actor or channel.
 */
export function canTransitionAppointment(
  appointment: AppointmentLifecycleFacts,
  target: AppointmentState,
  context: AppointmentActionContext,
): AppointmentPolicyResult {
  if (appointment.state !== "confirmed"
    || (target !== "cancelled" && target !== "done" && target !== "no_show")) {
    return { ok: false, error: "not_transition" };
  }
  if ((context.channel !== "manual" && context.channel !== "ai")
    || (context.actor !== "businessAdmin" && context.actor !== "platformAdmin"
      && context.actor !== "customer" && context.actor !== "ai")) {
    return { ok: false, error: "invalid_action_context" };
  }
  if (target === "done" || target === "no_show") {
    if (context.actor !== "businessAdmin" || context.channel !== "manual") {
      return { ok: false, error: "attendance_forbidden" };
    }
    const start = parseInstantMs(appointment.startsAt);
    const now = parseInstantMs(context.now);
    if (start === undefined || now === undefined) {
      return { ok: false, error: "invalid_attendance_time" };
    }
    if (now < start) return { ok: false, error: "before_start" };
  }
  if (context.channel === "manual" && context.confirmed !== true) {
    return { ok: false, error: "confirmation_required" };
  }
  return { ok: true };
}

const CatalogIdSchema = z.uuid().transform((id) => id.toLowerCase());

/** Agreed initial catalog terms only; no client identity or appointment-specific overrides. */
export const AppointmentTermsSnapshotSchema = z.object({
  serviceId: CatalogIdSchema,
  serviceName: ServiceInputSchema.shape.name,
  resourceId: CatalogIdSchema,
  resourceName: ServiceInputSchema.shape.name,
  durationMinutes: ServiceInputSchema.shape.durationMinutes,
  priceArs: ServiceInputSchema.shape.priceArs,
}).readonly();
export type AppointmentTermsSnapshot = z.infer<typeof AppointmentTermsSnapshotSchema>;

export type AppointmentCatalogService = Readonly<Pick<ServiceInput, "name" | "durationMinutes" | "priceArs"> & { id: string }>;
export type AppointmentCatalogResource = Readonly<Pick<ResourceInput, "name"> & { id: string }>;

/**
 * Capture from validated current SERVER catalog records, never client-provided terms.
 * The caller establishes tenant ownership, resource eligibility and authorization;
 * this helper cannot establish provenance. Returns a detached frozen initial snapshot
 * without mutating catalog records. Retention/reassignment rules belong to later edits.
 */
export function captureAppointmentTerms<
  Service extends AppointmentCatalogService,
  Resource extends AppointmentCatalogResource,
>(service: Service, resource: Resource): AppointmentTermsSnapshot {
  return AppointmentTermsSnapshotSchema.parse({
    serviceId: service.id,
    serviceName: service.name,
    resourceId: resource.id,
    resourceName: resource.name,
    durationMinutes: service.durationMinutes,
    priceArs: service.priceArs,
  });
}
