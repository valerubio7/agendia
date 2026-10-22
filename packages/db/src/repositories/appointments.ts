import { z } from "zod";
import { ClientInputSchema, InstantSchema, AppointmentOriginSchema, captureAppointmentTerms,
  isNewStartAllowed, isResourceEligibleForService, type AppointmentTermsSnapshot,
  type AppointmentState, type AppointmentOrigin, type ClientInput,
  prepareAppointmentChange, resolveCustomerResourcePreference, type CustomerResourcePreferenceExpression,
  canEditAppointmentNotes, canTransitionAppointment, AppointmentStateSchema, AppointmentTermsSnapshotSchema,
  type AppointmentActionContext, CalendarDateSchema, materializeArgentinaDayGrid, parseInstantMs,
  isStructurallyAvailable, type EpochInterval } from "@agendia/domain";
import type { PostgresRepositories } from "../repositories.ts";
import type { RegistryClient } from "./clients.ts";
import type { CatalogService, CatalogResource } from "./catalog.ts";
import { appointmentId, type Db } from "./shared.ts";

const appointmentCommand = z.object({
  serviceId: appointmentId, resourceId: appointmentId, startRaw: InstantSchema,
  notes: z.string().nullable().optional(), clientId: appointmentId.optional(),
  newClient: ClientInputSchema.optional(),
}).refine(input => (input.clientId !== undefined) !== (input.newClient !== undefined));
export type CreateAppointmentInput = {
  serviceId: string; resourceId: string; startRaw: string; notes?: string | null;
} & ({ clientId: string; newClient?: never } | { clientId?: never; newClient: ClientInput });
/** Established by the authenticated caller, not fields of a booking body. */
export type AppointmentChangeContext = { now: string; customerResourceExpression?: CustomerResourcePreferenceExpression };
export type AppointmentCreationContext = AppointmentChangeContext & { origin: AppointmentOrigin };
export type ChangeAppointmentInput = { serviceId: string; resourceId: string; startRaw: string };
export type AppointmentNotesInput = { notes: string | null };
const appointmentAvailabilityCommand = z.object({
  serviceId: appointmentId, date: CalendarDateSchema, resourceId: appointmentId.optional(),
}).strict();
/** Server-owned, after authorization. Business ownership is NOT customer/sender identity proof. */
export type AppointmentAvailabilityContext = { appointmentId?: string; clock?: () => string };
export type AppointmentAvailabilityOption = {
  start: string; startMs: number; endMs: number; resourceId: string; terms: AppointmentTermsSnapshot;
};
export type AppointmentHistoryFilter = { clientId?: string; from?: string; to?: string };
const appointmentActionFacts = z.object({
  actor: z.enum(["businessAdmin", "platformAdmin", "customer", "ai"]), channel: z.enum(["manual", "ai"]),
  now: InstantSchema, confirmed: z.boolean().optional(),
});
const appointmentHistoryFilter = z.object({ clientId: appointmentId.optional(), from: InstantSchema.optional(), to: InstantSchema.optional() })
  .refine(filter => filter.from === undefined || filter.to === undefined || parseInstantMs(filter.from)! < parseInstantMs(filter.to)!);
const appointmentChangeCommand = z.object({ serviceId: appointmentId, resourceId: appointmentId, startRaw: InstantSchema });
const customerExpression = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chosen"), resourceId: appointmentId }), z.object({ kind: z.literal("none") }),
]);
const appointmentChangeFacts = z.object({ now: InstantSchema, customerResourceExpression: customerExpression.optional() });
export type StoredAppointment = {
  id: string; client: RegistryClient; startsAt: string; startMs: number; endMs: number;
  terms: AppointmentTermsSnapshot; state: AppointmentState; origin: AppointmentOrigin;
  notes: string | null; customerResourcePreference: string | null;
};
type AppointmentRow = {
  id: string; clientId: string; firstName: string; lastName: string; phone: string;
  startsAt: string; startMs: string | number; endMs: string | number;
  serviceId: string; serviceName: string; resourceId: string; resourceName: string;
  durationMinutes: number; priceArs: number; state: AppointmentState; origin: AppointmentOrigin;
  notes: string | null; customerResourcePreference: string | null;
};
const appointmentDto = (row: AppointmentRow): StoredAppointment => ({
  id: row.id, client: { id: row.clientId, firstName: row.firstName, lastName: row.lastName, phone: row.phone },
  startsAt: row.startsAt, startMs: Number(row.startMs), endMs: Number(row.endMs),
  terms: { serviceId: row.serviceId, serviceName: row.serviceName, resourceId: row.resourceId,
    resourceName: row.resourceName, durationMinutes: row.durationMinutes, priceArs: row.priceArs },
  state: row.state, origin: row.origin, notes: row.notes, customerResourcePreference: row.customerResourcePreference,
});
export class AppointmentError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "UNKNOWN_OWNED_ID" | "INELIGIBLE_CATALOG" | "UNAVAILABLE" | "BUSY" | "CLIENT_CONFLICT"
    | "STATE_LOCKED" | "STARTED_STRUCTURE_LOCKED" | "LEAD_TIME" | "NOTES_LOCKED" | "NOT_TRANSITION"
    | "INVALID_ACTION_CONTEXT" | "ATTENDANCE_FORBIDDEN" | "INVALID_ATTENDANCE_TIME" | "BEFORE_START" | "CONFIRMATION_REQUIRED") {
    super(code);
  }
}

/** Shared owned projection for detail and untruncated history; never converts epochs to ISO. */
function appointmentRows(db: Db, businessId: string, filters: { id?: string; clientId?: string; fromMs?: number; toMs?: number } = {}) {
  return db<AppointmentRow[]>`select ap.id,ap.client_id "clientId",
      c.first_name "firstName",c.last_name "lastName",c.phone,
      ap.start_raw "startsAt",ap.start_ms "startMs",ap.end_ms "endMs",
      ap.service_id "serviceId",ap.service_label "serviceName",ap.resource_id "resourceId",ap.resource_label "resourceName",
      ap.duration_minutes "durationMinutes",ap.price_ars::float8 "priceArs",ap.state,ap.origin,ap.notes,
      ap.customer_resource_preference_id "customerResourcePreference"
      from appointments ap join clients c on (c.business_id,c.id)=(ap.business_id,ap.client_id)
      where ap.business_id=${businessId}
        and (${filters.id ?? null}::uuid is null or ap.id=${filters.id ?? null}::uuid)
        and (${filters.clientId ?? null}::uuid is null or ap.client_id=${filters.clientId ?? null}::uuid)
        and (${filters.fromMs ?? null}::bigint is null or ap.start_ms>=${filters.fromMs ?? null}::bigint)
        and (${filters.toMs ?? null}::bigint is null or ap.start_ms<${filters.toMs ?? null}::bigint)
      order by ap.start_ms,ap.id`;
}
/** Read-only owned projection: current client identity, frozen catalog terms. */
export async function getAppointment(db: Db, businessId: string, id: string): Promise<StoredAppointment | null> {
  const [row] = await appointmentRows(db, businessId, { id });
  return row ? appointmentDto(row) : null;
}
/** All states, exact half-open START bounds. Caller materializes local dates for UI. */
export async function listAppointments(db: Db, businessId: string, input: unknown = {}): Promise<StoredAppointment[]> {
  const scope = appointmentId.safeParse(businessId), filters = appointmentHistoryFilter.safeParse(input);
  if (!scope.success || !filters.success) throw new AppointmentError("INVALID_INPUT");
  const value = filters.data;
  return (await appointmentRows(db, scope.data, { ...(value.clientId ? { clientId: value.clientId } : {}),
    ...(value.from ? { fromMs: parseInstantMs(value.from)! } : {}), ...(value.to ? { toMs: parseInstantMs(value.to)! } : {}),
  })).map(appointmentDto);
}
async function appointmentAction(repo: PostgresRepositories, businessId: string, id: string, trusted: AppointmentActionContext) {
  const ownedId = appointmentId.safeParse(id), facts = appointmentActionFacts.safeParse(trusted);
  if (!ownedId.success || !facts.success) throw new AppointmentError("INVALID_INPUT");
  const current = await repo.getAppointment(businessId, ownedId.data);
  if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
  return { current, facts: facts.data };
}
/** Caller establishes action facts; only notes change, including on started Confirmed bookings. */
export async function setAppointmentNotes(db: Db, repo: PostgresRepositories, businessId: string, id: string, input: unknown, trusted: AppointmentActionContext): Promise<StoredAppointment> {
  await repo.acquireBusinessCalendarLock({ businessId });
  const parsed = z.object({ notes: z.string().refine(text => !text.includes("\u0000")).nullable() }).safeParse(input);
  if (!parsed.success) throw new AppointmentError("INVALID_INPUT");
  const { current } = await appointmentAction(repo, businessId, id, trusted);
  if (!canEditAppointmentNotes(current.state).ok) throw new AppointmentError("NOTES_LOCKED");
  if (current.notes === parsed.data.notes) return current;
  const updated = await db`update appointments set notes=${parsed.data.notes},updated_at=now()
      where business_id=${businessId} and id=${current.id} and state='confirmed' returning id`;
  if (!updated.length) throw new AppointmentError("STATE_LOCKED");
  return { ...current, notes: parsed.data.notes };
}
/** No automatic states/reopening. Creation origin does not establish this action's channel. */
export async function transitionAppointment(db: Db, repo: PostgresRepositories, businessId: string, id: string, target: unknown, trusted: AppointmentActionContext): Promise<StoredAppointment> {
  await repo.acquireBusinessCalendarLock({ businessId });
  const parsed = AppointmentStateSchema.safeParse(target);
  if (!parsed.success) throw new AppointmentError("INVALID_INPUT");
  const { current, facts } = await appointmentAction(repo, businessId, id, trusted);
  const policy = canTransitionAppointment(current, parsed.data, facts);
  if (!policy.ok) {
    const errors = { notes_locked: "NOTES_LOCKED", not_transition: "NOT_TRANSITION", invalid_action_context: "INVALID_ACTION_CONTEXT",
      attendance_forbidden: "ATTENDANCE_FORBIDDEN", invalid_attendance_time: "INVALID_ATTENDANCE_TIME",
      before_start: "BEFORE_START", confirmation_required: "CONFIRMATION_REQUIRED" } as const;
    throw new AppointmentError(errors[policy.error]);
  }
  const updated = await db`update appointments set state=${parsed.data},updated_at=now()
      where business_id=${businessId} and id=${current.id} and state='confirmed' returning id`;
  if (!updated.length) throw new AppointmentError("STATE_LOCKED");
  return { ...current, state: parsed.data };
}
/** Caller UoW owns client + appointment + audit/outbox rollback; no messaging effects here.
 * Shared business lock precedes every lookup. SQL GiST remains the raw-writer backstop.
 * Only trusted explicit customer expression sets preference; absence defaults to null.
 */
export async function createAppointment(db: Db, repo: PostgresRepositories, businessId: string, input: unknown, trusted: AppointmentCreationContext): Promise<StoredAppointment> {
  await repo.acquireBusinessCalendarLock({ businessId });
  businessId = businessId.toLowerCase();
  const parsed = appointmentCommand.safeParse(input);
  const facts = appointmentChangeFacts.extend({ origin: AppointmentOriginSchema }).safeParse(trusted);
  if (!parsed.success || !facts.success) throw new AppointmentError("INVALID_INPUT");
  const value = parsed.data;
  const [service] = await db<CatalogService[]>`select id,name,description,duration_minutes "durationMinutes",
      price_ars::float8 "priceArs",status from services where business_id=${businessId} and id=${value.serviceId} and deleted_at is null`;
  const resource = await repo.getResource(businessId, value.resourceId);
  const client = value.clientId ? await repo.getClientById(value.clientId) : null;
  if (!service || !resource || (value.clientId && !client)) throw new AppointmentError("UNKNOWN_OWNED_ID");
  if (!isResourceEligibleForService(resource, service))
    throw new AppointmentError("INELIGIBLE_CATALOG");
  const preference = await appointmentPreference(repo, businessId, null, facts.data.customerResourceExpression);
  const terms = captureAppointmentTerms(service, resource);
  const startMs = parseInstantMs(value.startRaw)!;
  const endMs = startMs + terms.durationMinutes * 60000;
  const calendar = await repo.getBusinessCalendar(businessId);
  const closures = await repo.listBusinessClosures(businessId);
  if (!Number.isSafeInteger(endMs) || endMs <= startMs || endMs > 253402387139999
    || !isNewStartAllowed({ start: value.startRaw, durationMinutes: terms.durationMinutes,
      businessHours: calendar.weeklySchedule ?? {}, resourceHours: resource.weeklySchedule,
      closedDates: closures.flatMap(closure => closure.kind === "date" ? [closure.date] : []),
      closedIntervals: closures.flatMap(closure => closure.kind === "interval" ? [{ start: closure.start, end: closure.end }] : []),
    }, facts.data.now)) throw new AppointmentError("UNAVAILABLE");
  // Compare exact epochs directly; irrelevant historical UTC year-zero busy rows
  // cannot be round-tripped through an external positive-year Instant string.
  const busy = await db`select id from appointments where business_id=${businessId}
      and resource_id=${resource.id} and state='confirmed' and start_ms<${endMs} and end_ms>${startMs} limit 1`;
  if (busy.length) throw new AppointmentError("BUSY");
  try {
    const selectedClient = client ?? await repo.createClient(businessId, value.newClient!);
    const [saved] = await db<{ id: string }[]>`insert into appointments
        (business_id,client_id,service_id,resource_id,service_label,resource_label,price_ars,duration_minutes,
         start_raw,start_ms,end_ms,state,origin,notes,customer_resource_preference_id)
        values(${businessId},${selectedClient.id},${terms.serviceId},${terms.resourceId},${terms.serviceName},${terms.resourceName},
          ${terms.priceArs},${terms.durationMinutes},${value.startRaw},${startMs},${endMs},'confirmed',${facts.data.origin},${value.notes ?? null},${preference}) returning id`;
    return (await repo.getAppointment(businessId, saved!.id))!;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "23P01") throw new AppointmentError("BUSY");
    if (code === "23505") throw new AppointmentError("CLIENT_CONFLICT");
    throw error;
  }
}
/** Business-scoped advisory read, in one tenant transaction under the shared calendar lock.
 * Caller must bind the real sender/customer before supplying reschedule context (T14/T15).
 * No reservation or effects: create/change must revalidate after this transaction releases.
 */
export async function listAppointmentAvailability(db: Db, repo: PostgresRepositories, businessId: string, input: unknown,
  trusted: AppointmentAvailabilityContext = {}): Promise<AppointmentAvailabilityOption[]> {
  await repo.acquireBusinessCalendarLock({ businessId });
  businessId = businessId.toLowerCase();
  const parsed = appointmentAvailabilityCommand.safeParse(input);
  const ownedId = trusted.appointmentId === undefined ? undefined : appointmentId.safeParse(trusted.appointmentId);
  if (!parsed.success || (ownedId && !ownedId.success) || (trusted.clock !== undefined && typeof trusted.clock !== "function"))
    throw new AppointmentError("INVALID_INPUT");
  const clock = InstantSchema.safeParse((trusted.clock ?? (() => new Date().toISOString()))());
  if (!clock.success) throw new AppointmentError("INVALID_INPUT");
  const now = clock.data;
  const current = ownedId?.success ? await repo.getAppointment(businessId, ownedId.data) : null;
  if (ownedId && !current) throw new AppointmentError("UNKNOWN_OWNED_ID");
  if (current) {
    if (current.state !== "confirmed") throw new AppointmentError("STATE_LOCKED");
    const saved = AppointmentTermsSnapshotSchema.safeParse(current.terms);
    if (!saved.success || parseInstantMs(current.startsAt) !== current.startMs
      || !Number.isSafeInteger(current.endMs) || current.endMs <= current.startMs
      || current.endMs > 253402387139999 || current.endMs !== current.startMs + saved.data.durationMinutes * 60000)
      throw new AppointmentError("INVALID_INPUT");
    if (parseInstantMs(now)! >= current.startMs) throw new AppointmentError("STARTED_STRUCTURE_LOCKED");
  }
  const value = parsed.data;
  const [service] = await db<CatalogService[]>`select id,name,description,duration_minutes "durationMinutes",
      price_ars::float8 "priceArs",status from services where business_id=${businessId} and id=${value.serviceId} and deleted_at is null`;
  const resources = value.resourceId
    ? [await repo.getResource(businessId, value.resourceId)] : await repo.listResources(businessId);
  if (!service || resources.some(resource => !resource)) throw new AppointmentError("UNKNOWN_OWNED_ID");
  const eligible = resources.filter((resource): resource is CatalogResource =>
    resource !== null && isResourceEligibleForService(resource, service));
  if (!eligible.length) return [];
  const calendar = await repo.getBusinessCalendar(businessId), closures = await repo.listBusinessClosures(businessId);
  const choices: AppointmentAvailabilityOption[] = [];
  for (const point of materializeArgentinaDayGrid(value.date)) {
    for (const resource of eligible) {
      const facts = { now, businessHours: calendar.weeklySchedule ?? {}, resourceHours: resource.weeklySchedule,
        closedDates: closures.flatMap(closure => closure.kind === "date" ? [closure.date] : []),
        closedIntervals: closures.flatMap(closure => closure.kind === "interval" ? [{ start: closure.start, end: closure.end }] : []),
      };
      const plan = current ? prepareAppointmentChange(current, { startsAt: point.start, service, resource }, facts) : null;
      if (plan && !plan.ok) continue;
      const terms = plan?.ok ? plan.terms : captureAppointmentTerms(service, resource);
      const startRaw = plan?.ok ? plan.startsAt : point.start;
      const endMs = point.startMs + terms.durationMinutes * 60000;
      const interval = { ...facts, start: startRaw, durationMinutes: terms.durationMinutes };
      // Even a planner no-op must be a live, structurally available alternative here.
      if (!Number.isSafeInteger(endMs) || point.startMs < -62135683140000 || endMs <= point.startMs || endMs > 253402387139999
        || !isStructurallyAvailable(interval)
        || ((!current || point.startMs !== current.startMs) && !isNewStartAllowed(interval, now))) continue;
      choices.push({ start: startRaw, startMs: point.startMs, endMs, resourceId: resource.id, terms });
    }
  }
  if (!choices.length) return choices;
  // Bound actual planned intervals: unchanged-service reschedules retain saved duration,
  // and the last candidate may end after midnight (or near the supported epoch limit).
  const earliestStart = choices.reduce((earliest, choice) => Math.min(earliest, choice.startMs), Infinity);
  const latestEnd = choices.reduce((latest, choice) => Math.max(latest, choice.endMs), -Infinity);
  // Numeric occupancy only: raw busy strings need not be coherent or positive-year ISO.
  const busy = await db<{ resourceId: string; startMs: string; endMs: string }[]>`
      select resource_id "resourceId",start_ms "startMs",end_ms "endMs" from appointments
      where business_id=${businessId} and state='confirmed' and resource_id in ${db(eligible.map(resource => resource.id))}
        and (${current?.id ?? null}::uuid is null or id<>${current?.id ?? null}::uuid)
        and start_ms<${latestEnd} and end_ms>${earliestStart}`;
  const busyByResource = new Map<string, EpochInterval[]>();
  for (const row of busy) {
    const intervals = busyByResource.get(row.resourceId) ?? [];
    intervals.push({ startMs: Number(row.startMs), endMs: Number(row.endMs) });
    busyByResource.set(row.resourceId, intervals);
  }
  return choices.filter(choice => !busyByResource.get(choice.resourceId)?.some(interval =>
    interval.startMs < choice.endMs && interval.endMs > choice.startMs));
}
async function appointmentPreference(repo: PostgresRepositories, businessId: string, previous: string | null, expression?: CustomerResourcePreferenceExpression) {
  const preference = resolveCustomerResourcePreference(previous, expression);
  if (expression?.kind === "chosen" && !(await repo.getResource(businessId, preference!)))
    throw new AppointmentError("UNKNOWN_OWNED_ID");
  return preference;
}
/** Otherwise-authorized structural changes or explicit upcoming customer-preference metadata.
 * Preference-only changes do not require active catalogs/hours or promise availability;
 * they never change schedule, agreed terms, assigned resource, client, notes, state or origin.
 * Caller establishes explicit customer expression and any transport confirmation.
 * The existing T07 planner owns identity/epoch no-op, agreed-term and time policy.
 */
export async function changeAppointment(db: Db, repo: PostgresRepositories, businessId: string, id: string, input: unknown, trusted: AppointmentChangeContext): Promise<StoredAppointment> {
  await repo.acquireBusinessCalendarLock({ businessId });
  businessId = businessId.toLowerCase();
  const ownedId = appointmentId.safeParse(id), parsed = appointmentChangeCommand.safeParse(input);
  const facts = appointmentChangeFacts.safeParse(trusted);
  if (!ownedId.success || !parsed.success || !facts.success) throw new AppointmentError("INVALID_INPUT");
  id = ownedId.data;
  const current = await repo.getAppointment(businessId, id);
  if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
  if (current.state !== "confirmed") throw new AppointmentError("STATE_LOCKED");
  const savedTerms = AppointmentTermsSnapshotSchema.safeParse(current.terms);
  if (!savedTerms.success || parseInstantMs(current.startsAt) !== current.startMs
    || !Number.isSafeInteger(current.endMs) || current.endMs <= current.startMs
    || current.endMs > 253402387139999 || current.endMs !== current.startMs + savedTerms.data.durationMinutes * 60000)
    throw new AppointmentError("INVALID_INPUT");
  const preference = await appointmentPreference(repo, businessId, current.customerResourcePreference, facts.data.customerResourceExpression);
  const preferenceChanged = preference !== current.customerResourcePreference;
  // A validated stored no-op needs no live catalog lookup or snapshot refresh.
  if (parsed.data.serviceId === savedTerms.data.serviceId && parsed.data.resourceId === savedTerms.data.resourceId
    && parseInstantMs(parsed.data.startRaw) === current.startMs && !preferenceChanged) return current;
  if (preferenceChanged && parseInstantMs(facts.data.now)! >= current.startMs)
    throw new AppointmentError("STARTED_STRUCTURE_LOCKED");
  const [service] = await db<CatalogService[]>`select id,name,description,duration_minutes "durationMinutes",
      price_ars::float8 "priceArs",status from services where business_id=${businessId} and id=${parsed.data.serviceId} and deleted_at is null`;
  const resource = await repo.getResource(businessId, parsed.data.resourceId);
  if (!service || !resource) throw new AppointmentError("UNKNOWN_OWNED_ID");
  const calendar = await repo.getBusinessCalendar(businessId);
  const closures = await repo.listBusinessClosures(businessId);
  const plan = prepareAppointmentChange(current, { startsAt: parsed.data.startRaw, service, resource }, {
    now: facts.data.now, businessHours: calendar.weeklySchedule ?? {}, resourceHours: resource.weeklySchedule,
    closedDates: closures.flatMap(closure => closure.kind === "date" ? [closure.date] : []),
    closedIntervals: closures.flatMap(closure => closure.kind === "interval" ? [{ start: closure.start, end: closure.end }] : []),
  });
  if (!plan.ok) {
    const errors = { state_locked: "STATE_LOCKED", invalid_change_input: "INVALID_INPUT",
      started_structure_locked: "STARTED_STRUCTURE_LOCKED", ineligible_catalog: "INELIGIBLE_CATALOG",
      structural_unavailable: "UNAVAILABLE", lead_time: "LEAD_TIME" } as const;
    throw new AppointmentError(errors[plan.error]);
  }
  if (!plan.changed && !preferenceChanged) return current;
  const startMs = parseInstantMs(plan.startsAt)!, endMs = startMs + plan.terms.durationMinutes * 60000;
  if (!Number.isSafeInteger(endMs) || endMs <= startMs || endMs > 253402387139999)
    throw new AppointmentError("UNAVAILABLE");
  const busy = await db`select id from appointments where business_id=${businessId} and resource_id=${plan.terms.resourceId}
      and state='confirmed' and id<>${id} and start_ms<${endMs} and end_ms>${startMs} limit 1`;
  if (busy.length) throw new AppointmentError("BUSY");
  try {
    const updated = await db`update appointments set service_id=${plan.terms.serviceId},resource_id=${plan.terms.resourceId},
        service_label=${plan.terms.serviceName},resource_label=${plan.terms.resourceName},price_ars=${plan.terms.priceArs},
        duration_minutes=${plan.terms.durationMinutes},start_raw=${plan.startsAt},start_ms=${startMs},end_ms=${endMs},
        customer_resource_preference_id=${preference},updated_at=now()
        where business_id=${businessId} and id=${id} and state='confirmed' returning id`;
    if (!updated.length) throw new AppointmentError("STATE_LOCKED");
    return (await repo.getAppointment(businessId, id))!;
  } catch (error) {
    if ((error as { code?: string }).code === "23P01") throw new AppointmentError("BUSY");
    throw error;
  }
}
