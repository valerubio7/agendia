import { z } from "zod";
import {
  AppointmentTermsSnapshotSchema,
  type AppointmentCatalogResource,
  type AppointmentCatalogService,
  type AppointmentLifecycleFacts,
  type AppointmentTermsSnapshot,
} from "./lifecycle.ts";
import { parseInstantMs } from "../business-calendar/values.ts";
import { isNewStartAllowed, isStructurallyAvailable, type AvailabilityInput } from "./availability.ts";
import { ResourceInputSchema, isResourceEligibleForService } from "../resources.ts";

export interface AppointmentChangeFacts extends AppointmentLifecycleFacts {
  readonly terms: AppointmentTermsSnapshot;
  readonly customerResourcePreference: string | null;
}
export interface AppointmentChangeCandidate {
  readonly startsAt: string;
  readonly service: AppointmentCatalogService & { readonly status: "active" | "suspended" };
  readonly resource: AppointmentCatalogResource & {
    readonly status: "active" | "suspended";
    readonly serviceIds: readonly string[];
  };
}

/**
 * Verified caller supplies selected-resource hours, global closures and only Confirmed
 * selected-resource busy intervals, with authorized self-exclusion. No fetching or auth.
 */
export interface AppointmentChangeContext extends Omit<AvailabilityInput, "start" | "durationMinutes"> {
  readonly now: string;
}
export type AppointmentChangeError =
  | "state_locked"
  | "invalid_change_input"
  | "started_structure_locked"
  | "ineligible_catalog"
  | "structural_unavailable"
  | "lead_time";
export type AppointmentChangeResult =
  | { readonly ok: false; readonly error: AppointmentChangeError }
  | {
    readonly ok: true;
    readonly changed: boolean;
    readonly startsAt: string;
    readonly terms: AppointmentTermsSnapshot;
    readonly customerResourcePreference: string | null;
  };

function rejectAppointmentChange(error: AppointmentChangeError): Extract<AppointmentChangeResult, { ok: false }> {
  return Object.freeze({ ok: false, error });
}

/**
 * Plan an otherwise-authorized atomic structural edit from validated SERVER catalog facts.
 * Caller establishes tenant/client ownership, memberships, provenance and authorization.
 * No standalone terms overrides, notes policy, preference permission or transport behavior.
 * A semantic no-op retains raw start and saved terms; it authorizes no other operation.
 */
export function prepareAppointmentChange(
  current: AppointmentChangeFacts,
  candidate: AppointmentChangeCandidate,
  context: AppointmentChangeContext,
): AppointmentChangeResult {
  if (current.state !== "confirmed") return rejectAppointmentChange("state_locked");
  const start = parseInstantMs(current.startsAt);
  const proposedStart = parseInstantMs(candidate.startsAt);
  const now = parseInstantMs(context.now);
  const saved = AppointmentTermsSnapshotSchema.safeParse(current.terms);
  const catalog = AppointmentTermsSnapshotSchema.safeParse({
    serviceId: candidate.service.id, serviceName: candidate.service.name,
    resourceId: candidate.resource.id, resourceName: candidate.resource.name,
    durationMinutes: candidate.service.durationMinutes, priceArs: candidate.service.priceArs,
  });
  if (start === undefined || proposedStart === undefined || now === undefined || !saved.success || !catalog.success) {
    return rejectAppointmentChange("invalid_change_input");
  }
  const serviceChanged = saved.data.serviceId !== catalog.data.serviceId;
  const resourceChanged = saved.data.resourceId !== catalog.data.resourceId;
  const startChanged = start !== proposedStart;
  const changed = serviceChanged || resourceChanged || startChanged;
  if (changed && now >= start) return rejectAppointmentChange("started_structure_locked");
  const terms = AppointmentTermsSnapshotSchema.parse({
    ...saved.data,
    ...(serviceChanged ? {
      serviceId: catalog.data.serviceId, serviceName: catalog.data.serviceName,
      durationMinutes: catalog.data.durationMinutes, priceArs: catalog.data.priceArs,
    } : {}),
    ...(resourceChanged ? {
      resourceId: catalog.data.resourceId, resourceName: catalog.data.resourceName,
    } : {}),
  });
  const startsAt = startChanged ? candidate.startsAt : current.startsAt;
  if (changed) {
    const assignments = ResourceInputSchema.shape.serviceIds.safeParse(candidate.resource.serviceIds);
    if (!assignments.success) return rejectAppointmentChange("invalid_change_input");
    if (!isResourceEligibleForService(
      { status: candidate.resource.status, serviceIds: assignments.data },
      { status: candidate.service.status, id: terms.serviceId },
    )) return rejectAppointmentChange("ineligible_catalog");
    const availability: AvailabilityInput = { ...context, start: startsAt, durationMinutes: terms.durationMinutes };
    if (!isStructurallyAvailable(availability)) return rejectAppointmentChange("structural_unavailable");
    if (startChanged && !isNewStartAllowed(availability, context.now)) return rejectAppointmentChange("lead_time");
  }
  return Object.freeze({ ok: true, changed, startsAt, terms, customerResourcePreference: current.customerResourcePreference });
}

export type CustomerResourcePreferenceExpression =
  | { readonly kind: "chosen"; readonly resourceId: string }
  | { readonly kind: "none" };
const PreferenceIdSchema = z.uuid().transform((id) => id.toLowerCase());

/**
 * Value transform ONLY within an otherwise-authorized atomic new/upcoming booking mutation.
 * Caller attests an actual explicit customer expression and an owned resolved resource.
 * Absence retains the old value (null for new bookings); admin assignment is not expression.
 * This grants no standalone or after-start preference-edit permission and stores no global
 * preference. It cannot resolve customer text, infer identity, authenticate or load-balance.
 */
export function resolveCustomerResourcePreference(
  previous: string | null,
  expression?: CustomerResourcePreferenceExpression,
): string | null {
  if (expression === undefined) return previous;
  if (expression.kind === "none") return null;
  return PreferenceIdSchema.parse(expression.resourceId);
}
