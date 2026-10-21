import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import { appointmentId, asDbJson, type Db } from "./repositories/shared.ts";
import * as identity from "./repositories/identity.ts";
import * as business from "./repositories/business.ts";
import * as clients from "./repositories/clients.ts";
import * as catalog from "./repositories/catalog.ts";
import type { ClientRegistryInput, RegistryClient } from "./repositories/clients.ts";
import { ResourceCatalogError, appointmentInterval, type SavedAppointmentInterval,
  type CatalogResource, type ServiceCatalogInput, type CatalogService } from "./repositories/catalog.ts";
export type { ClientRegistryInput, RegistryClient } from "./repositories/clients.ts";
export { ResourceCatalogError } from "./repositories/catalog.ts";
export type { CatalogResource, ServiceCatalogInput, CatalogService } from "./repositories/catalog.ts";
import type { TenantContext } from "./tenant-context.ts";
import { replyDeadline } from "./reply-pacing.ts";
import { ReplyPacingSchema, type ReplyPacing } from "@agendia/domain";
import { validSenderEvidence, emptyAgendaDialogue, type SenderEvidence, type AgendaDialogue } from "../../domain/src/whatsapp/agenda.ts";
import { z } from "zod";
import { ClientInputSchema, InstantSchema, AppointmentOriginSchema, captureAppointmentTerms,
  isNewStartAllowed, isResourceEligibleForService, type AppointmentTermsSnapshot,
  type AppointmentState, type AppointmentOrigin, type ClientInput,
  prepareAppointmentChange, resolveCustomerResourcePreference, type CustomerResourcePreferenceExpression,
  canEditAppointmentNotes, canTransitionAppointment, AppointmentStateSchema, AppointmentTermsSnapshotSchema,
  type AppointmentActionContext } from "@agendia/domain";
import { BusinessClosureInputSchema, CalendarDateSchema, materializeArgentinaDayGrid, parseInstantMs, WeeklyScheduleSchema,
  isResourceScheduleWithinBusiness, isStructurallyAvailable,
  isEpochIntervalWithinWeeklySchedule, isEpochIntervalOpenForClosures, type EpochInterval, type ResourceInput,
  type BusinessClosure, type BusinessClosureInput, type WeeklySchedule } from "@agendia/domain";

type PlatformAiSettingsRow = ReplyPacing & { additionalInstructions: string };
function platformAiSettings(row: PlatformAiSettingsRow | undefined) {
  if (!row) throw new Error("Platform AI instructions singleton missing");
  const { additionalInstructions, ...replyPacing } = row;
  return { additionalInstructions, replyPacing: ReplyPacingSchema.parse(replyPacing) };
}

type ClosureRow = { id: string; kind: string; date: string | null; start: string | null; end: string | null };
const closureDto = (row: ClosureRow): BusinessClosure => ({ id: row.id,
  ...BusinessClosureInputSchema.parse(row.kind === "date"
    ? { kind: row.kind, date: row.date } : { kind: row.kind, start: row.start, end: row.end }),
});
function closureValues(input: BusinessClosureInput) {
  const valid = BusinessClosureInputSchema.parse(input);
  return valid.kind === "date"
    ? { kind: valid.kind, date: valid.date, start: null, end: null, startMs: null, endMs: null }
    : { kind: valid.kind, date: null, start: valid.start, end: valid.end,
      startMs: parseInstantMs(valid.start)!, endMs: parseInstantMs(valid.end)! };
}

export type BusinessCalendar = { weeklySchedule: WeeklySchedule };
/** Acquire inside the tenant UoW BEFORE reads/guards/mutations (also when no row exists).
 * C/T05/T09 must use this same namespace. Hash collisions only serialize businesses;
 * tenant identity remains enforced by context and RLS, never by the hash.
 */
export async function acquireBusinessCalendarLock(tx: TransactionSql, context: Pick<TenantContext, "businessId">) {
  if ("begin" in tx) throw new Error("Calendar lock requires a transaction");
  const businessId = context.businessId.toLowerCase();
  const [scope] = await tx`select current_setting('app.tenant_id',true) tenant`;
  if (scope?.tenant?.toLowerCase() !== businessId) throw new Error("Calendar lock requires matching tenant context");
  await tx`select pg_advisory_xact_lock(hashtextextended(${"business-calendar:" + businessId},0))`;
}

export type SealedLinkCode = {
  businessId: string;
  connectionId: string;
  token: string;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
};
const linkAad = (businessId: string, connectionId: string, token: string) =>
  Buffer.from(`agendia-link:${businessId}:${connectionId}:${token}`);
export function linkCodeKeyFromEnv(env: Record<string, string | undefined>) {
  const encoded = env.WHATSAPP_LINK_CODE_KEY,
    key = encoded && Buffer.from(encoded, "base64");
  if (!key || key.length !== 32)
    throw new Error("WHATSAPP_LINK_CODE_KEY must contain 32 bytes");
  return key;
}
export function sealLinkCode(
  key: Buffer,
  businessId: string,
  connectionId: string,
  token: string,
  value: string,
): SealedLinkCode {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(linkAad(businessId, connectionId, token));
  return {
    businessId,
    connectionId,
    token,
    nonce,
    ciphertext: Buffer.concat([cipher.update(value, "utf8"), cipher.final()]),
    tag: cipher.getAuthTag(),
  };
}
export function openLinkCode(key: Buffer, value: SealedLinkCode) {
  const decipher = createDecipheriv("aes-256-gcm", key, value.nonce);
  decipher.setAAD(linkAad(value.businessId, value.connectionId, value.token));
  decipher.setAuthTag(value.tag);
  return Buffer.concat([
    decipher.update(value.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

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

export type { RuntimeRole } from "./runtime-pools.ts";
export type SafeRuntimeEvent = {
  code: string;
  outcome: "success" | "failure" | "denied";
  source: "api" | "whatsapp-manager";
  actorId?: string;
  requestId: string;
  severity?: "info" | "warning" | "error" | "critical";
};

export type AppointmentOperationRow = {
  kind: "create" | "change" | "notes" | "state"; target: string | null;
  fingerprint: string | null; state: "completed" | "failed" | "cancelled";
  result: { status: number; body: unknown } | null;
};
export class PostgresRepositories {
  constructor(private readonly db: Db) {}
  async lockAppointmentOperation(context: TenantContext, key: string, wait = true): Promise<boolean> {
    if ("begin" in this.db) throw new Error("Operation lock requires a transaction");
    const lock = `appointment-operation:${context.businessId}:${context.actorId}:${key}`;
    if (wait) { await this.db`select pg_advisory_xact_lock(hashtextextended(${lock},0))`; return true; }
    const [row] = await this.db`select pg_try_advisory_xact_lock(hashtextextended(${lock},0)) acquired`;
    return row!.acquired;
  }
  async appointmentOperation(context: TenantContext, key: string): Promise<AppointmentOperationRow | null> {
    const [row] = await this.db<AppointmentOperationRow[]>`select kind,target_id target,fingerprint,state,result
      from appointment_operation_receipts where business_id=${context.businessId} and actor_id=${context.actorId} and operation_key=${key}`;
    return row ?? null;
  }
  async recordAppointmentOperation(context: TenantContext, key: string, row: AppointmentOperationRow) {
    await this.db`insert into appointment_operation_receipts(business_id,actor_id,operation_key,kind,target_id,fingerprint,state,result)
      values(${context.businessId},${context.actorId},${key},${row.kind},${row.target},${row.fingerprint},${row.state},
        ${row.result === null ? null : this.db.json(asDbJson(row.result))})`;
  }
  appointmentOperationSavepoint<T>(work: (repo: PostgresRepositories) => Promise<T>): Promise<T> {
    if ("begin" in this.db) throw new Error("Operation savepoint requires a transaction");
    return (this.db as TransactionSql).savepoint(tx => work(new PostgresRepositories(tx))) as Promise<T>;
  }
  acquireBusinessCalendarLock(context: Pick<TenantContext, "businessId">) {
    if ("begin" in this.db) throw new Error("Calendar lock requires a transaction");
    return acquireBusinessCalendarLock(this.db as TransactionSql, context);
  }
  /** Shared owned projection for detail and untruncated history; never converts epochs to ISO. */
  private appointmentRows(businessId: string, filters: { id?: string; clientId?: string; fromMs?: number; toMs?: number } = {}) {
    return this.db<AppointmentRow[]>`select ap.id,ap.client_id "clientId",
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
  async getAppointment(businessId: string, id: string): Promise<StoredAppointment | null> {
    const [row] = await this.appointmentRows(businessId, { id });
    return row ? appointmentDto(row) : null;
  }
  /** All states, exact half-open START bounds. Caller materializes local dates for UI. */
  async listAppointments(businessId: string, input: unknown = {}): Promise<StoredAppointment[]> {
    const scope = appointmentId.safeParse(businessId), filters = appointmentHistoryFilter.safeParse(input);
    if (!scope.success || !filters.success) throw new AppointmentError("INVALID_INPUT");
    const value = filters.data;
    return (await this.appointmentRows(scope.data, { ...(value.clientId ? { clientId: value.clientId } : {}),
      ...(value.from ? { fromMs: parseInstantMs(value.from)! } : {}), ...(value.to ? { toMs: parseInstantMs(value.to)! } : {}),
    })).map(appointmentDto);
  }
  private async appointmentAction(businessId: string, id: string, trusted: AppointmentActionContext) {
    const ownedId = appointmentId.safeParse(id), facts = appointmentActionFacts.safeParse(trusted);
    if (!ownedId.success || !facts.success) throw new AppointmentError("INVALID_INPUT");
    const current = await this.getAppointment(businessId, ownedId.data);
    if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
    return { current, facts: facts.data };
  }
  /** Caller establishes action facts; only notes change, including on started Confirmed bookings. */
  async setAppointmentNotes(businessId: string, id: string, input: unknown, trusted: AppointmentActionContext): Promise<StoredAppointment> {
    await this.acquireBusinessCalendarLock({ businessId });
    const parsed = z.object({ notes: z.string().refine(text => !text.includes("\u0000")).nullable() }).safeParse(input);
    if (!parsed.success) throw new AppointmentError("INVALID_INPUT");
    const { current } = await this.appointmentAction(businessId, id, trusted);
    if (!canEditAppointmentNotes(current.state).ok) throw new AppointmentError("NOTES_LOCKED");
    if (current.notes === parsed.data.notes) return current;
    const updated = await this.db`update appointments set notes=${parsed.data.notes},updated_at=now()
      where business_id=${businessId} and id=${current.id} and state='confirmed' returning id`;
    if (!updated.length) throw new AppointmentError("STATE_LOCKED");
    return { ...current, notes: parsed.data.notes };
  }
  /** No automatic states/reopening. Creation origin does not establish this action's channel. */
  async transitionAppointment(businessId: string, id: string, target: unknown, trusted: AppointmentActionContext): Promise<StoredAppointment> {
    await this.acquireBusinessCalendarLock({ businessId });
    const parsed = AppointmentStateSchema.safeParse(target);
    if (!parsed.success) throw new AppointmentError("INVALID_INPUT");
    const { current, facts } = await this.appointmentAction(businessId, id, trusted);
    const policy = canTransitionAppointment(current, parsed.data, facts);
    if (!policy.ok) {
      const errors = { notes_locked: "NOTES_LOCKED", not_transition: "NOT_TRANSITION", invalid_action_context: "INVALID_ACTION_CONTEXT",
        attendance_forbidden: "ATTENDANCE_FORBIDDEN", invalid_attendance_time: "INVALID_ATTENDANCE_TIME",
        before_start: "BEFORE_START", confirmation_required: "CONFIRMATION_REQUIRED" } as const;
      throw new AppointmentError(errors[policy.error]);
    }
    const updated = await this.db`update appointments set state=${parsed.data},updated_at=now()
      where business_id=${businessId} and id=${current.id} and state='confirmed' returning id`;
    if (!updated.length) throw new AppointmentError("STATE_LOCKED");
    return { ...current, state: parsed.data };
  }
  /** Caller UoW owns client + appointment + audit/outbox rollback; no messaging effects here.
   * Shared business lock precedes every lookup. SQL GiST remains the raw-writer backstop.
   * Only trusted explicit customer expression sets preference; absence defaults to null.
   */
  async createAppointment(businessId: string, input: unknown, trusted: AppointmentCreationContext): Promise<StoredAppointment> {
    await this.acquireBusinessCalendarLock({ businessId });
    businessId = businessId.toLowerCase();
    const parsed = appointmentCommand.safeParse(input);
    const facts = appointmentChangeFacts.extend({ origin: AppointmentOriginSchema }).safeParse(trusted);
    if (!parsed.success || !facts.success) throw new AppointmentError("INVALID_INPUT");
    const value = parsed.data;
    const [service] = await this.db<CatalogService[]>`select id,name,description,duration_minutes "durationMinutes",
      price_ars::float8 "priceArs",status from services where business_id=${businessId} and id=${value.serviceId} and deleted_at is null`;
    const resource = await this.getResource(businessId, value.resourceId);
    const client = value.clientId ? await this.getClientById(value.clientId) : null;
    if (!service || !resource || (value.clientId && !client)) throw new AppointmentError("UNKNOWN_OWNED_ID");
    if (!isResourceEligibleForService(resource, service))
      throw new AppointmentError("INELIGIBLE_CATALOG");
    const preference = await this.appointmentPreference(businessId, null, facts.data.customerResourceExpression);
    const terms = captureAppointmentTerms(service, resource);
    const startMs = parseInstantMs(value.startRaw)!;
    const endMs = startMs + terms.durationMinutes * 60000;
    const calendar = await this.getBusinessCalendar(businessId);
    const closures = await this.listBusinessClosures(businessId);
    if (!Number.isSafeInteger(endMs) || endMs <= startMs || endMs > 253402387139999
      || !isNewStartAllowed({ start: value.startRaw, durationMinutes: terms.durationMinutes,
        businessHours: calendar.weeklySchedule ?? {}, resourceHours: resource.weeklySchedule,
        closedDates: closures.flatMap(closure => closure.kind === "date" ? [closure.date] : []),
        closedIntervals: closures.flatMap(closure => closure.kind === "interval" ? [{ start: closure.start, end: closure.end }] : []),
      }, facts.data.now)) throw new AppointmentError("UNAVAILABLE");
    // Compare exact epochs directly; irrelevant historical UTC year-zero busy rows
    // cannot be round-tripped through an external positive-year Instant string.
    const busy = await this.db`select id from appointments where business_id=${businessId}
      and resource_id=${resource.id} and state='confirmed' and start_ms<${endMs} and end_ms>${startMs} limit 1`;
    if (busy.length) throw new AppointmentError("BUSY");
    try {
      const selectedClient = client ?? await this.createClient(businessId, value.newClient!);
      const [saved] = await this.db<{ id: string }[]>`insert into appointments
        (business_id,client_id,service_id,resource_id,service_label,resource_label,price_ars,duration_minutes,
         start_raw,start_ms,end_ms,state,origin,notes,customer_resource_preference_id)
        values(${businessId},${selectedClient.id},${terms.serviceId},${terms.resourceId},${terms.serviceName},${terms.resourceName},
          ${terms.priceArs},${terms.durationMinutes},${value.startRaw},${startMs},${endMs},'confirmed',${facts.data.origin},${value.notes ?? null},${preference}) returning id`;
      return (await this.getAppointment(businessId, saved!.id))!;
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
  async listAppointmentAvailability(businessId: string, input: unknown,
    trusted: AppointmentAvailabilityContext = {}): Promise<AppointmentAvailabilityOption[]> {
    await this.acquireBusinessCalendarLock({ businessId });
    businessId = businessId.toLowerCase();
    const parsed = appointmentAvailabilityCommand.safeParse(input);
    const ownedId = trusted.appointmentId === undefined ? undefined : appointmentId.safeParse(trusted.appointmentId);
    if (!parsed.success || (ownedId && !ownedId.success) || (trusted.clock !== undefined && typeof trusted.clock !== "function"))
      throw new AppointmentError("INVALID_INPUT");
    const clock = InstantSchema.safeParse((trusted.clock ?? (() => new Date().toISOString()))());
    if (!clock.success) throw new AppointmentError("INVALID_INPUT");
    const now = clock.data;
    const current = ownedId?.success ? await this.getAppointment(businessId, ownedId.data) : null;
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
    const [service] = await this.db<CatalogService[]>`select id,name,description,duration_minutes "durationMinutes",
      price_ars::float8 "priceArs",status from services where business_id=${businessId} and id=${value.serviceId} and deleted_at is null`;
    const resources = value.resourceId
      ? [await this.getResource(businessId, value.resourceId)] : await this.listResources(businessId);
    if (!service || resources.some(resource => !resource)) throw new AppointmentError("UNKNOWN_OWNED_ID");
    const eligible = resources.filter((resource): resource is CatalogResource =>
      resource !== null && isResourceEligibleForService(resource, service));
    if (!eligible.length) return [];
    const calendar = await this.getBusinessCalendar(businessId), closures = await this.listBusinessClosures(businessId);
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
    const busy = await this.db<{ resourceId: string; startMs: string; endMs: string }[]>`
      select resource_id "resourceId",start_ms "startMs",end_ms "endMs" from appointments
      where business_id=${businessId} and state='confirmed' and resource_id in ${this.db(eligible.map(resource => resource.id))}
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
  private async appointmentPreference(businessId: string, previous: string | null, expression?: CustomerResourcePreferenceExpression) {
    const preference = resolveCustomerResourcePreference(previous, expression);
    if (expression?.kind === "chosen" && !(await this.getResource(businessId, preference!)))
      throw new AppointmentError("UNKNOWN_OWNED_ID");
    return preference;
  }
  /** Otherwise-authorized structural changes or explicit upcoming customer-preference metadata.
   * Preference-only changes do not require active catalogs/hours or promise availability;
   * they never change schedule, agreed terms, assigned resource, client, notes, state or origin.
   * Caller establishes explicit customer expression and any transport confirmation.
   * The existing T07 planner owns identity/epoch no-op, agreed-term and time policy.
   */
  async changeAppointment(businessId: string, id: string, input: unknown, trusted: AppointmentChangeContext): Promise<StoredAppointment> {
    await this.acquireBusinessCalendarLock({ businessId });
    businessId = businessId.toLowerCase();
    const ownedId = appointmentId.safeParse(id), parsed = appointmentChangeCommand.safeParse(input);
    const facts = appointmentChangeFacts.safeParse(trusted);
    if (!ownedId.success || !parsed.success || !facts.success) throw new AppointmentError("INVALID_INPUT");
    id = ownedId.data;
    const current = await this.getAppointment(businessId, id);
    if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
    if (current.state !== "confirmed") throw new AppointmentError("STATE_LOCKED");
    const savedTerms = AppointmentTermsSnapshotSchema.safeParse(current.terms);
    if (!savedTerms.success || parseInstantMs(current.startsAt) !== current.startMs
      || !Number.isSafeInteger(current.endMs) || current.endMs <= current.startMs
      || current.endMs > 253402387139999 || current.endMs !== current.startMs + savedTerms.data.durationMinutes * 60000)
      throw new AppointmentError("INVALID_INPUT");
    const preference = await this.appointmentPreference(businessId, current.customerResourcePreference, facts.data.customerResourceExpression);
    const preferenceChanged = preference !== current.customerResourcePreference;
    // A validated stored no-op needs no live catalog lookup or snapshot refresh.
    if (parsed.data.serviceId === savedTerms.data.serviceId && parsed.data.resourceId === savedTerms.data.resourceId
      && parseInstantMs(parsed.data.startRaw) === current.startMs && !preferenceChanged) return current;
    if (preferenceChanged && parseInstantMs(facts.data.now)! >= current.startMs)
      throw new AppointmentError("STARTED_STRUCTURE_LOCKED");
    const [service] = await this.db<CatalogService[]>`select id,name,description,duration_minutes "durationMinutes",
      price_ars::float8 "priceArs",status from services where business_id=${businessId} and id=${parsed.data.serviceId} and deleted_at is null`;
    const resource = await this.getResource(businessId, parsed.data.resourceId);
    if (!service || !resource) throw new AppointmentError("UNKNOWN_OWNED_ID");
    const calendar = await this.getBusinessCalendar(businessId);
    const closures = await this.listBusinessClosures(businessId);
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
    const busy = await this.db`select id from appointments where business_id=${businessId} and resource_id=${plan.terms.resourceId}
      and state='confirmed' and id<>${id} and start_ms<${endMs} and end_ms>${startMs} limit 1`;
    if (busy.length) throw new AppointmentError("BUSY");
    try {
      const updated = await this.db`update appointments set service_id=${plan.terms.serviceId},resource_id=${plan.terms.resourceId},
        service_label=${plan.terms.serviceName},resource_label=${plan.terms.resourceName},price_ars=${plan.terms.priceArs},
        duration_minutes=${plan.terms.durationMinutes},start_raw=${plan.startsAt},start_ms=${startMs},end_ms=${endMs},
        customer_resource_preference_id=${preference},updated_at=now()
        where business_id=${businessId} and id=${id} and state='confirmed' returning id`;
      if (!updated.length) throw new AppointmentError("STATE_LOCKED");
      return (await this.getAppointment(businessId, id))!;
    } catch (error) {
      if ((error as { code?: string }).code === "23P01") throw new AppointmentError("BUSY");
      throw error;
    }
  }
  async getBusinessCalendar(businessId: string): Promise<{ weeklySchedule: WeeklySchedule | null }> {
    const [row] = await this.db<{ weeklySchedule: WeeklySchedule }[]>`
      select weekly_schedule "weeklySchedule" from business_calendars where business_id=${businessId}`;
    return { weeklySchedule: row ? WeeklyScheduleSchema.parse(row.weeklySchedule) : null };
  }
  /** Called only after the shared early lock; B2 protects Confirmed only, unlike B1 resources. */
  private async futureConfirmedIntervals(businessId: string, nowMs: number): Promise<EpochInterval[]> {
    if (!Number.isSafeInteger(nowMs)) throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
    const rows = await this.db<SavedAppointmentInterval[]>`select start_raw "startRaw",start_ms "startMs",end_ms "endMs",duration_minutes "durationMinutes"
      from appointments where business_id=${businessId} and state='confirmed' and start_ms>${nowMs}`;
    return rows.map(appointmentInterval);
  }
  private async guardClosureAppointments(businessId: string, input: BusinessClosureInput, nowMs: number) {
    if ((await this.futureConfirmedIntervals(businessId, nowMs)).some(interval => !isEpochIntervalOpenForClosures(interval, [input])))
      throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
  }
  /** Transaction required; uses the same early lock as public calendar/closure callers. */
  async saveBusinessCalendar(businessId: string, weeklySchedule: WeeklySchedule): Promise<BusinessCalendar> {
    await this.acquireBusinessCalendarLock({ businessId });
    const nowMs = Date.now();
    const valid = WeeklyScheduleSchema.parse(weeklySchedule);
    const resources = await this.listResources(businessId);
    if (resources.some(resource => !isResourceScheduleWithinBusiness(resource.weeklySchedule, valid)))
      throw new ResourceCatalogError("HOURS_CONFLICT");
    if ((await this.futureConfirmedIntervals(businessId, nowMs)).some(interval => !isEpochIntervalWithinWeeklySchedule(interval, valid)))
      throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
    const [row] = await this.db<BusinessCalendar[]>`
      insert into business_calendars(business_id,weekly_schedule) values(${businessId},${this.db.json(asDbJson(valid))})
      on conflict(business_id) do update set weekly_schedule=excluded.weekly_schedule
      returning weekly_schedule "weeklySchedule"`;
    return row!;
  }
  async listBusinessClosures(businessId: string): Promise<BusinessClosure[]> {
    const rows = await this.db<ClosureRow[]>`select id,kind,closed_date::text date,start_raw start,end_raw "end"
      from business_calendar_closures where business_id=${businessId} order by id`;
    return rows.map(closureDto);
  }
  /** All closure mutations require the shared early calendar lock in the caller's UoW. */
  async createBusinessClosure(businessId: string, input: BusinessClosureInput): Promise<BusinessClosure> {
    await this.acquireBusinessCalendarLock({ businessId });
    const nowMs = Date.now();
    const v = closureValues(input);
    await this.guardClosureAppointments(businessId, input, nowMs);
    const [row] = await this.db<ClosureRow[]>`insert into business_calendar_closures
      (business_id,kind,closed_date,start_raw,end_raw,start_ms,end_ms)
      values(${businessId},${v.kind},${v.date},${v.start},${v.end},${v.startMs},${v.endMs})
      returning id,kind,closed_date::text date,start_raw start,end_raw "end"`;
    return closureDto(row!);
  }
  async updateBusinessClosure(businessId: string, id: string, input: BusinessClosureInput): Promise<BusinessClosure | null> {
    await this.acquireBusinessCalendarLock({ businessId });
    const nowMs = Date.now();
    const [owned] = await this.db`select id from business_calendar_closures where business_id=${businessId} and id=${id}`;
    if (!owned) return null;
    const v = closureValues(input);
    await this.guardClosureAppointments(businessId, input, nowMs);
    const [row] = await this.db<ClosureRow[]>`update business_calendar_closures set kind=${v.kind},closed_date=${v.date},
      start_raw=${v.start},end_raw=${v.end},start_ms=${v.startMs},end_ms=${v.endMs}
      where business_id=${businessId} and id=${id}
      returning id,kind,closed_date::text date,start_raw start,end_raw "end"`;
    return row ? closureDto(row) : null;
  }
  async deleteBusinessClosure(businessId: string, id: string): Promise<boolean> {
    await this.acquireBusinessCalendarLock({ businessId });
    const rows = await this.db`delete from business_calendar_closures where business_id=${businessId} and id=${id} returning id`;
    return rows.length > 0;
  }
  listResources(businessId: string) {
    return catalog.listResources(this.db, businessId);
  }
  async getResource(businessId: string, id: string) {
    return catalog.getResource(this.db, businessId, id);
  }
  /** All mutations require a tenant transaction; assignments and caller audit/outbox share its rollback. */
  async createResource(businessId: string, input: ResourceInput): Promise<CatalogResource> {
    return catalog.createResource(this.db, this, businessId, input);
  }
  async updateResource(businessId: string, id: string, input: ResourceInput): Promise<CatalogResource | null> {
    return catalog.updateResource(this.db, this, businessId, id, input);
  }
  async setResourceStatus(businessId: string, id: string, status: CatalogResource["status"]): Promise<CatalogResource | null> {
    return catalog.setResourceStatus(this.db, this, businessId, id, status);
  }
  listClients(q = "") {
    return clients.listClients(this.db, q);
  }
  async getClientById(id: string) {
    return clients.getClientById(this.db, id);
  }
  // Exact stored identity only: no manual-country/type inference or aliases.
  async findClientByCanonicalPhone(phone: string) {
    return clients.findClientByCanonicalPhone(this.db, phone);
  }
  async createClient(businessId: string, input: ClientRegistryInput) {
    return clients.createClient(this.db, this, businessId, input);
  }
  async updateClient(businessId: string, id: string, input: ClientRegistryInput) {
    return clients.updateClient(this.db, this, businessId, id, input);
  }
  listServices() {
    return catalog.listServices(this.db);
  }
  async createService(businessId: string, input: ServiceCatalogInput) {
    return catalog.createService(this.db, this, businessId, input);
  }
  async updateService(businessId: string, id: string, input: ServiceCatalogInput) {
    return catalog.updateService(this.db, this, businessId, id, input);
  }
  async setServiceStatus(businessId: string, id: string, status: CatalogService["status"]) {
    return catalog.setServiceStatus(this.db, this, businessId, id, status);
  }
  /** Internal retirement only: caller UoW owns tombstone + links + audit/outbox rollback. */
  private async retireCatalogItem(businessId: string, id: string, table: "services" | "resources") {
    return catalog.retireCatalogItem(this.db, this, businessId, id, table);
  }
  deleteService(businessId: string, id: string): Promise<boolean> {
    return this.retireCatalogItem(businessId, id, "services");
  }
  deleteResource(businessId: string, id: string): Promise<boolean> {
    return this.retireCatalogItem(businessId, id, "resources");
  }
  async platformAiInstructions() {
    const [row] = await this.db<PlatformAiSettingsRow[]>`
      select additional_instructions "additionalInstructions", initial_delay_seconds "initialDelaySeconds",
        active_delay_seconds "activeDelaySeconds", inactivity_reset_seconds "inactivityResetSeconds"
      from operational_controls where singleton`;
    return platformAiSettings(row);
  }
  async updatePlatformAiInstructions(additionalInstructions: string, replyPacing?: ReplyPacing) {
    const policy = replyPacing === undefined ? undefined : ReplyPacingSchema.parse(replyPacing);
    // Omitted policy columns are not written, including under concurrent instruction-only saves.
    const values = { additional_instructions: additionalInstructions, ...(policy === undefined ? {} : {
      initial_delay_seconds: policy.initialDelaySeconds,
      active_delay_seconds: policy.activeDelaySeconds,
      inactivity_reset_seconds: policy.inactivityResetSeconds,
    }) };
    const [row] = await this.db<PlatformAiSettingsRow[]>`
      update operational_controls set ${this.db(values)} where singleton
      returning additional_instructions "additionalInstructions", initial_delay_seconds "initialDelaySeconds",
        active_delay_seconds "activeDelaySeconds", inactivity_reset_seconds "inactivityResetSeconds"`;
    return platformAiSettings(row);
  }
  async globalReplyPacing(): Promise<ReplyPacing> {
    const [row] = await this.db<ReplyPacing[]>`
      select initial_delay_seconds "initialDelaySeconds", active_delay_seconds "activeDelaySeconds",
        inactivity_reset_seconds "inactivityResetSeconds" from operational_controls where singleton`;
    if (!row) throw new Error("Global reply pacing singleton missing");
    return ReplyPacingSchema.parse(row);
  }
  saveBusiness(row: { id: string; name: string }) {
    return business.saveBusiness(this.db, row);
  }
  saveIdentity(row: {
    email: string;
    passwordPhc: string;
    businessId: string;
  }) {
    return identity.saveIdentity(this.db, row);
  }
  async findIdentity(email: string) {
    return identity.findIdentity(this.db, email);
  }
  async admitLogin(accountHash: string): Promise<boolean> {
    return identity.admitLogin(this.db, accountHash);
  }
  async authIdentity(email: string) {
    return identity.authIdentity(this.db, email);
  }
  createSession(row: {
    identityId: string;
    tokenHash: string;
    csrfHash: string;
    absolute: Date;
    idle: Date;
  }) {
    return identity.createSession(this.db, row);
  }
  async session(tokenHash: string) {
    return identity.session(this.db, tokenHash);
  }
  touchSession(id: string, idle: Date) {
    return identity.touchSession(this.db, id, idle);
  }
  revokeSession(tokenHash: string) {
    return identity.revokeSession(this.db, tokenHash);
  }
  appendRuntimeAudit(businessId: string | null, event: SafeRuntimeEvent) {
    return this
      .db`select append_runtime_audit(${businessId},${event.code},${event.outcome},${event.source},${event.actorId ?? null},${event.requestId})`;
  }
  async recordRuntimeEvent(businessId: string, event: SafeRuntimeEvent) {
    if (event.severity)
      await this
        .db`insert into technical_events(business_id,component,code,severity,safe_details) values(${businessId},${event.source},${event.code},${event.severity},'{}')`;
    await this.appendRuntimeAudit(businessId, event);
  }
  async createBusinessUser(row: {
    id: string;
    name: string;
    email: string;
    passwordPhc: string;
  }) {
    return business.createBusinessUser(this.db, this, row);
  }
  renameBusiness(id: string, name: string) {
    return business.renameBusiness(this.db, id, name);
  }
  async setBusinessStatus(id: string, status: string) {
    return business.setBusinessStatus(this.db, id, status);
  }
  async replaceBusinessPassword(id: string, passwordPhc: string) {
    return business.replaceBusinessPassword(this.db, id, passwordPhc);
  }
  listBusinesses() {
    return business.listBusinesses(this.db);
  }
  async business(id: string) {
    return business.business(this.db, id);
  }
  saveProfile(businessId: string, displayName: string) {
    return business.saveProfile(this.db, businessId, displayName);
  }
  async profile() {
    return business.profile(this.db);
  }
  saveFullProfile(businessId: string, p: Record<string, string>) {
    return business.saveFullProfile(this.db, businessId, p);
  }
  saveAssistant(businessId: string, active: boolean) {
    return this
      .db`insert into assistant_configs (business_id,active) values (${businessId},${active}) on conflict (business_id) do update set active=excluded.active,revision=assistant_configs.revision+1,updated_at=now()`;
  }
  async assistant() {
    return (
      (
        await this
          .db`select style,business_instructions "businessInstructions",active,revision from assistant_configs limit 1`
      )[0] ?? null
    );
  }
  async saveFullAssistant(
    businessId: string,
    p: Record<string, unknown>,
    expected: number,
  ) {
    return (
      (
        await this
          .db`insert into assistant_configs(business_id,style,business_instructions,active,revision) values(${businessId},${p.style as string},${p.businessInstructions as string},${p.active as boolean},1) on conflict(business_id) do update set style=excluded.style,business_instructions=excluded.business_instructions,active=excluded.active,revision=assistant_configs.revision+1,updated_at=now() where assistant_configs.revision=${expected} returning style,business_instructions "businessInstructions",active,revision`
      )[0] ?? null
    );
  }
  async whatsapp() {
    return (
      (
        await this
          .db`select id,lower(state) status,linked_number "linkedNumber",linked_at "linkedAt",last_connected_at "lastConnectedAt" from whatsapp_connections limit 1`
      )[0] ?? null
    );
  }
  saveConnection(id: string, businessId: string) {
    return this
      .db`insert into whatsapp_connections (id,business_id) values (${id},${businessId}) on conflict(business_id) do nothing`;
  }
  async connection() {
    return (
      (
        await this.db<
          { id: string; sessionPublicId: string; linkCommandId: string | null; linkPending: boolean }[]
        >`select id,session_public_id "sessionPublicId",link_command_id "linkCommandId",link_pending "linkPending" from whatsapp_connections limit 1`
      )[0] ?? null
    );
  }
  replaceLinkCode(id: string, value: SealedLinkCode, expiresAt: Date) {
    return this
      .db`insert into whatsapp_link_codes(connection_id,business_id,token,ciphertext,nonce,auth_tag,expires_at) values(${id},${value.businessId},${value.token},${value.ciphertext},${value.nonce},${value.tag},${expiresAt}) on conflict(connection_id) do update set token=excluded.token,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,expires_at=excluded.expires_at,created_at=now()`;
  }
  async currentLinkCode(now: Date) {
    await this.db`delete from whatsapp_link_codes where expires_at<=${now}`;
    return (
      (
        await this.db<
          {
            businessId: string;
            connectionId: string;
            token: string;
            ciphertext: Buffer;
            nonce: Buffer;
            tag: Buffer;
          }[]
        >`select business_id "businessId",connection_id "connectionId",token,ciphertext,nonce,auth_tag tag from whatsapp_link_codes where expires_at>${now} limit 1`
      )[0] ?? null
    );
  }
  invalidateLinkCode(id: string, token: string) {
    return this
      .db`delete from whatsapp_link_codes where connection_id=${id} and token=${token}`;
  }
  clearLinkCode(id: string) {
    return this.db`delete from whatsapp_link_codes where connection_id=${id}`;
  }
  async clearWhatsAppAuth(id: string) {
    await this.db`delete from whatsapp_auth_records where connection_id=${id}`;
    await this
      .db`update whatsapp_connections set wrapped_dek=null,wrapped_dek_nonce=null,wrapped_dek_tag=null,kek_version=null where id=${id}`;
  }
  async lockAuthConnection(businessId: string, id: string) {
    const rows = await this.db`select id from whatsapp_connections where id=${id} and business_id=${businessId} for update`;
    if (!rows.length) throw new Error("authentication connection unavailable");
  }
  async authEnvelope(id: string) {
    return (
      await this.db<
        {
          businessId: string;
          ciphertext: Buffer;
          iv: Buffer;
          tag: Buffer;
          kekVersion: string;
        }[]
      >`select business_id "businessId",wrapped_dek ciphertext,wrapped_dek_nonce iv,wrapped_dek_tag tag,kek_version "kekVersion" from whatsapp_connections where id=${id} and wrapped_dek is not null`
    )[0];
  }
  async saveAuthEnvelope(
    id: string,
    value: { ciphertext: Buffer; iv: Buffer; tag: Buffer; kekVersion: string },
  ) {
    const rows = await this
      .db`update whatsapp_connections set wrapped_dek=${value.ciphertext},wrapped_dek_nonce=${value.iv},wrapped_dek_tag=${value.tag},kek_version=${value.kekVersion} where id=${id} and wrapped_dek is null returning id`;
    if (!rows.length) throw new Error("authentication envelope already initialized or unavailable");
  }
  async authRecord(id: string, name: string) {
    return (
      await this.db<
        {
          businessId: string;
          connectionId: string;
          name: string;
          version: number;
          ciphertext: Buffer;
          iv: Buffer;
          tag: Buffer;
        }[]
      >`select business_id "businessId",connection_id "connectionId",record_name name,version,ciphertext,nonce iv,auth_tag tag from whatsapp_auth_records where connection_id=${id} and record_name=${name}`
    )[0];
  }
  async saveAuthRecord(value: {
    businessId: string;
    connectionId: string;
    name: string;
    version: number;
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  }) {
    const rows = await this
      .db`insert into whatsapp_auth_records(business_id,connection_id,record_name,version,ciphertext,nonce,auth_tag) values(${value.businessId},${value.connectionId},${value.name},${value.version},${value.ciphertext},${value.iv},${value.tag}) on conflict(business_id,connection_id,record_name) do update set version=excluded.version,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag where whatsapp_auth_records.version=excluded.version-1 returning version`;
    if (!rows.length) throw new Error("authentication record version conflict");
  }
  async claimWhatsAppLink(token: string) {
    return (
      (
        await this.db<
          { command_id: string; business_id: string }[]
        >`select * from claim_whatsapp_link_command(${token})`
      )[0] ?? null
    );
  }
  restorableWhatsApp() {
    return this.db<
      { id: string; business_id: string }[]
    >`select * from restorable_whatsapp_connections()`;
  }
  async admitWhatsAppLink(id: string, commandId: string, claim: string): Promise<boolean> {
    const [connection] = await this.db`select id from whatsapp_connections where id=${id} for update`;
    if (!connection) return false;
    const [command] = await this.db`select o.id,o.link_admitted_at from outbox_events o
      join whatsapp_connections w on w.business_id=o.business_id
      where w.id=${id} and o.id=${commandId} and o.topic='whatsapp.link_requested'
        and o.published_at is null and o.claim_token=${claim}
        and o.claimed_at>now()-interval '30 seconds' for update of o`;
    if (!command) return false;
    if (!command.link_admitted_at) {
      await this.clearLinkCode(id);
      await this.clearWhatsAppAuth(id);
      await this.db`update whatsapp_connections set link_command_id=${commandId},link_pending=true,state='LINKING',version=version+1 where id=${id}`;
      await this.db`update outbox_events set link_admitted_at=now() where id=${commandId}`;
    }
    return true;
  }
  async completeWhatsAppLink(commandId: string, claim: string, ownership: string) {
    return (await this.db<{ completed: boolean }[]>`select complete_whatsapp_link_command(${commandId},${claim},${ownership}) completed`)[0]!.completed;
  }
  async takeOverWhatsApp(id: string, owner: string, token: string, now: Date) {
    // Match claim/finish lock ordering, then fence the old socket before reconciliation.
    await this.db`select id from conversations where connection_id=${id} order by created_at,id for update`;
    await this.db`update whatsapp_connections set owner_id=${owner},ownership_token=${token},heartbeat_at=${now},version=version+1 where id=${id}`;
    const abandoned = await this.db<{ outbound_id: string; business_id: string }[]>`
      update outbound_commands set state='delivery_unknown',failure_code='delivery_unknown',updated_at=now()
      where connection_id=${id} and state='sending' returning outbound_id,business_id`;
    for (const row of abandoned) await this.recordRuntimeEvent(row.business_id, {
      code: 'whatsapp.delivery_unknown', outcome: 'failure', source: 'whatsapp-manager',
      requestId: `outbound:${row.outbound_id}`, severity: 'error',
    });
  }
  async lockWhatsAppOwnership(id: string, token: string): Promise<boolean> {
    const rows = await this.db`select id from whatsapp_connections where id=${id} and ownership_token=${token} for update`;
    return rows.length > 0;
  }
  heartbeatWhatsApp(id: string, owner: string, now: Date, token?: string) {
    return this
      .db`update whatsapp_connections set owner_id=${owner},heartbeat_at=${now},version=version+1 where id=${id} and (${token ?? null}::uuid is null or ownership_token=${token ?? null})`;
  }
  releaseWhatsApp(id: string, owner: string, token: string) {
    return this
      .db`update whatsapp_connections set owner_id=null,ownership_token=null,heartbeat_at=null,version=version+1 where id=${id} and owner_id=${owner} and ownership_token=${token}`;
  }
  setWhatsAppState(id: string, state: string, now: Date, number?: string) {
    return this
      .db`update whatsapp_connections set state=${state},link_pending=case when ${state} in ('CONNECTED','LINK_REQUIRED') then false else link_pending end,linked_number=coalesce(${number ?? null},linked_number),linked_at=case when ${state}='CONNECTED' then coalesce(linked_at,${now}) else linked_at end,last_connected_at=case when ${state}='CONNECTED' then ${now} else last_connected_at end,version=version+1 where id=${id}`;
  }
  /** Serialize collisions across PN and LID within this specific business connection. */
  async bindReceivedSender(businessId: string, connectionId: string, remoteJid: string, evidence: SenderEvidence): Promise<string | null> {
    if (!validSenderEvidence(remoteJid, evidence)) return null;
    await this.db`select pg_advisory_xact_lock(hashtextextended(${`sender:${businessId}:${connectionId}`},0))`;
    const rows = await this.db<{ phone: string; pn_jid: string; lid_jid: string | null }[]>`
      select phone,pn_jid,lid_jid from whatsapp_sender_bindings
      where business_id=${businessId} and connection_id=${connectionId}
        and (phone=${evidence.phone} or pn_jid=${evidence.pnJid} or lid_jid=${evidence.lidJid})`;
    if (rows.some(row => row.phone !== evidence.phone || row.pn_jid !== evidence.pnJid
      || (evidence.lidJid !== null && row.lid_jid !== null && row.lid_jid !== evidence.lidJid))) return null;
    await this.db`insert into whatsapp_sender_bindings(business_id,connection_id,phone,pn_jid,lid_jid)
      values(${businessId},${connectionId},${evidence.phone},${evidence.pnJid},${evidence.lidJid})
      on conflict(business_id,connection_id,phone) do update
      set lid_jid=coalesce(whatsapp_sender_bindings.lid_jid,excluded.lid_jid)`;
    return evidence.phone;
  }
  async agendaSender(messageId: string): Promise<string | null> {
    const [row] = await this.db<{ phone: string }[]>`select s.phone from whatsapp_received_senders s
      join messages m on (m.business_id,m.id,m.connection_id)=(s.business_id,s.message_id,s.connection_id)
      join whatsapp_sender_bindings b on (b.business_id,b.connection_id,b.phone)=(s.business_id,s.connection_id,s.phone)
      where s.message_id=${messageId} and m.direction='inbound'`;
    return row?.phone ?? null;
  }
  async lockAgendaDialogue(businessId: string, connectionId: string, phone: string): Promise<AgendaDialogue> {
    await this.db`select pg_advisory_xact_lock(hashtextextended(${`agenda:${businessId}:${connectionId}:${phone}`},0))`;
    const [row] = await this.db<{ dialogue: AgendaDialogue }[]>`select dialogue from whatsapp_agenda_dialogues
      where business_id=${businessId} and connection_id=${connectionId} and phone=${phone}`;
    return row?.dialogue ?? emptyAgendaDialogue();
  }
  async saveAgendaDialogue(businessId: string, connectionId: string, phone: string, dialogue: AgendaDialogue) {
    await this.db`insert into whatsapp_agenda_dialogues(business_id,connection_id,phone,dialogue)
      values(${businessId},${connectionId},${phone},${this.db.json(asDbJson(dialogue))})
      on conflict(business_id,connection_id,phone) do update set dialogue=excluded.dialogue,updated_at=now()`;
  }
  async lockAgendaSource(messageId: string) {
    await this.db`select c.id from conversations c join messages m on m.conversation_id=c.id
      where m.id=${messageId} for update of c`;
    return this.loadAiMessage(messageId, true);
  }
  async agendaQuoteDelivered(outboundId: string | null, connectionId: string, phone: string): Promise<boolean> {
    if (!outboundId) return false;
    const [row] = await this.db`select o.outbound_id from outbound_commands o
      join whatsapp_received_senders s on s.message_id=o.source_message_id and s.business_id=o.business_id
      where o.outbound_id=${outboundId} and o.connection_id=${connectionId} and s.phone=${phone} and o.state='sent'`;
    return !!row;
  }
  async recordAgendaReceipt(businessId: string, messageId: string, outboundId: string, operation: string) {
    await this.db`insert into whatsapp_agenda_receipts(business_id,message_id,outbound_id,operation)
      values(${businessId},${messageId},${outboundId},${operation})`;
  }
  /** Metadata-only expression does not need an active catalog or reserve capacity. */
  async setAgendaPreference(businessId: string, id: string, resourceId: string | null, now: string) {
    await this.acquireBusinessCalendarLock({ businessId });
    const current = await this.getAppointment(businessId, id);
    if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
    if (current.state !== "confirmed") throw new AppointmentError("STATE_LOCKED");
    if (Date.parse(now) >= current.startMs) throw new AppointmentError("STARTED_STRUCTURE_LOCKED");
    if (resourceId !== null && !(await this.getResource(businessId, resourceId))) throw new AppointmentError("UNKNOWN_OWNED_ID");
    await this.db`update appointments set customer_resource_preference_id=${resourceId},updated_at=now()
      where business_id=${businessId} and id=${id} and state='confirmed'`;
    return { ...current, customerResourcePreference: resourceId };
  }
  async routeSession(session: string) {
    return (
      (
        await this.db<
          {
            business_id: string;
            connection_id: string;
            business_status: "active" | "suspended";
            assistant_active: boolean;
          }[]
        >`select * from route_whatsapp_session(${session}::uuid)`
      )[0] ?? null
    );
  }
  async ingestInbound(input: {
    businessId: string;
    connectionId: string;
    providerId: string;
    remoteJid: string;
    text: string | null;
    receivedAt: Date;
    classification: string;
    senderEvidence?: SenderEvidence;
  }) {
    const seen = await this
      .db`insert into inbox_events(business_id,source,stable_key) values(${input.businessId},'baileys',${input.providerId}) on conflict do nothing returning id`;
    if (!seen.length) return null;
    const senderPhone = input.classification === "accepted" && input.senderEvidence
      ? await this.bindReceivedSender(input.businessId, input.connectionId, input.remoteJid, input.senderEvidence) : null;
    const businessText = input.classification === "accepted_business";
    if (input.classification !== "accepted" && !businessText) {
      await this
        .db`insert into technical_events(business_id,component,code,severity) values(${input.businessId},'whatsapp-manager',${input.classification},'info')`;
      return { duplicate: false };
    }
    const conversation = (
      await this.db<
        { id: string; reply_due_at: Date | null; last_reply_at: Date | null; last_exchange_at: Date | null; accepted_at: Date }[]
      >`insert into conversations(business_id,connection_id,remote_jid) values(${input.businessId},${input.connectionId},${input.remoteJid}) on conflict(business_id,connection_id,remote_jid) do update set remote_jid=excluded.remote_jid returning id,reply_due_at,last_reply_at,last_exchange_at,clock_timestamp() accepted_at`
    )[0]!;
    // The upsert holds the conversation lock, shared with generation save,
    // outbound claim and confirmation. Recheck echo identity after that lock.
    // Identity outlives delivery state: even a late echo after a terminal
    // failure must not masquerade as manual input and cancel fresh work.
    if (businessText) {
      const echo = await this.db`select outbound_id from outbound_commands where business_id=${input.businessId} and connection_id=${input.connectionId} and conversation_id=${conversation.id} and (outbound_id::text=${input.providerId} or provider_message_id=${input.providerId})`;
      const persisted = await this.db`select id from messages where business_id=${input.businessId} and connection_id=${input.connectionId} and provider_message_id=${input.providerId} and direction='outbound'`;
      if (echo.length || persisted.length) return { duplicate: false, generatedEcho: true };
    }
    const sequence = Number(
      (
        await this.db<
          { sequence: string }[]
        >`update conversations set next_sequence=next_sequence+1 where id=${conversation.id} returning next_sequence-1 sequence`
      )[0]!.sequence,
    );
    if (businessText) {
      await this.db`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at,processing_state) values(${input.businessId},${conversation.id},${input.connectionId},${input.providerId},${sequence},'outbound',${input.text!},${input.receivedAt},'sent')`;
      await this.db`update conversations set latest_inbound_id=null,reply_due_at=null,last_reply_at=${conversation.accepted_at},last_exchange_at=${conversation.accepted_at} where id=${conversation.id}`;
      await this.db`update messages set processing_state='superseded' where conversation_id=${conversation.id} and direction='inbound' and processing_state in ('pending','generated') and not exists(select 1 from outbound_commands o where o.source_message_id=messages.id and o.state in ('sending','sent','delivery_unknown'))`;
      await this.db`update outbound_commands set state='failed',failure_code='manual_reply',updated_at=now() where conversation_id=${conversation.id} and state='generated'`;
      await this.db`update outbox_events set published_at=now() where topic='ai.generate' and published_at is null and payload->>'messageId' in (select id::text from messages where conversation_id=${conversation.id} and processing_state='superseded')`;
      return { duplicate: false, sequence };
    }
    const message = (
      await this.db<
        { id: string }[]
      >`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at) values(${input.businessId},${conversation.id},${input.connectionId},${input.providerId},${sequence},'inbound',${input.text!},${input.receivedAt}) returning id`
    )[0]!;
    if (senderPhone) await this.db`insert into whatsapp_received_senders(business_id,message_id,connection_id,phone)
      values(${input.businessId},${message.id},${input.connectionId},${senderPhone})`;
    const policy = await this.globalReplyPacing();
    const due = replyDeadline(conversation.accepted_at, conversation.last_reply_at, conversation.last_exchange_at, conversation.reply_due_at, policy);
    await this.db`update conversations set latest_inbound_id=${message.id},reply_due_at=${due},last_exchange_at=${conversation.accepted_at} where id=${conversation.id}`;
    await this.db`update messages set processing_state='superseded' where conversation_id=${conversation.id} and direction='inbound' and id<>${message.id} and processing_state in ('pending','generated')`;
    await this.db`update outbound_commands set state='failed',failure_code='superseded',updated_at=now() where conversation_id=${conversation.id} and state='generated'`;
    await this.db`update outbox_events set published_at=now() where topic='ai.generate' and published_at is null and payload->>'messageId' in (select id::text from messages where conversation_id=${conversation.id} and processing_state='superseded')`;
    await this.db`insert into outbox_events(business_id,topic,stable_key,payload,next_attempt_at) values(${input.businessId},'ai.generate',${`ai:${input.providerId}`},${this.db.json({ businessId: input.businessId, messageId: message.id })},${due}) on conflict do nothing`;
    return { duplicate: false, messageId: message.id, sequence };
  }
  async loadAiMessage(messageId: string, requireDue = false) {
    const message = (
      await this.db<
        {
          id: string;
          business_id: string;
          sequence: string;
          conversation_id: string;
          connection_id: string;
          raw_text: string;
        }[]
      >`select m.id,m.business_id,m.sequence,m.conversation_id,m.connection_id,m.raw_text from messages m join conversations c on c.id=m.conversation_id and c.business_id=m.business_id join businesses b on b.id=m.business_id join assistant_configs a on a.business_id=b.id join whatsapp_connections w on w.id=m.connection_id where m.id=${messageId} and m.direction='inbound' and m.processing_state='pending' and c.latest_inbound_id=m.id and (not ${requireDue} or c.reply_due_at<=now()) and b.status='active' and a.active and w.state='CONNECTED'`
    )[0];
    if (!message) return null;
    const profile =
      (
        await this.db<
          Record<string, string>[]
        >`select display_name,description,address from business_profiles limit 1`
      )[0] ?? {};
    const assistant =
      (
        await this.db<
          Record<string, string>[]
        >`select style,business_instructions from assistant_configs limit 1`
      )[0] ?? {};
    const turns = await this.db<
      {
        id: string;
        sequence: string;
        direction: "inbound" | "outbound";
        raw_text: string;
        processing_state: string;
        closes_group: boolean;
      }[]
    >`select m.id,m.sequence,m.direction,m.raw_text,m.processing_state,
      case when m.direction='inbound' then m.processing_state='ai_failed' or exists(
        select 1 from outbound_commands o where o.business_id=m.business_id
        and o.connection_id=m.connection_id and o.conversation_id=m.conversation_id
        and o.source_message_id=m.id and o.send_started_at is not null)
      else m.processing_state='sent' and not exists(
        select 1 from outbound_commands o where o.business_id=m.business_id
        and o.connection_id=m.connection_id and o.conversation_id=m.conversation_id
        and (o.provider_message_id=m.provider_message_id or o.outbound_id::text=m.provider_message_id
          or (o.source_message_id is null and o.send_started_at is not null and o.provider_message_id is null)))
      end closes_group
      from messages m where m.business_id=${message.business_id}
      and m.connection_id=${message.connection_id} and m.conversation_id=${message.conversation_id} order by m.sequence`;
    // Claimed output closes at its inbound source, never its delayed sent row.
    // Unknown-source legacy output cannot prove a boundary; unknown delivery
    // identity also prevents guessing that a sent row was a manual reply.
    const closedThrough = turns.reduce((closed, turn) => turn.closes_group && Number(turn.sequence) < Number(message.sequence)
      ? Math.max(closed, Number(turn.sequence)) : closed, 0);
    const currentGroup = turns.filter((turn) => turn.direction === 'inbound'
      && Number(turn.sequence) > closedThrough && Number(turn.sequence) <= Number(message.sequence));
    const summaries = await this.db<
      { version: number; covered_through: string; structured_summary: any }[]
    >`select version,covered_through,structured_summary from conversation_summaries where conversation_id=${message.conversation_id} and covered_through<=(select coalesce(max(sequence),0) from messages where conversation_id=${message.conversation_id}) order by covered_through desc,version desc`;
    return { ...message, profile, assistant, turns, summaries, currentGroup };
  }
  async loadSummarySource(conversationId: string, coveredThrough: number) {
    const exists = (
      await this.db<
        { id: string }[]
      >`select id from conversations where id=${conversationId}`
    )[0];
    if (!exists) return null;
    const turns = await this.db<
      {
        sequence: string;
        direction: "inbound" | "outbound";
        raw_text: string;
        processing_state: string;
      }[]
    >`select sequence,direction,raw_text,processing_state from messages where conversation_id=${conversationId} and sequence<=${coveredThrough} order by sequence`;
    const summaries = await this.db<
      { version: number; covered_through: string; structured_summary: any }[]
    >`select version,covered_through,structured_summary from conversation_summaries where conversation_id=${conversationId} and covered_through<=${coveredThrough} order by covered_through desc,version desc`;
    return { turns, summaries };
  }
  async saveConversationSummary(
    conversationId: string,
    expectedVersion: number,
    coveredThrough: number,
    summary: unknown,
  ) {
    await this
      .db`select pg_advisory_xact_lock(hashtextextended(${"summary:" + conversationId},0))`;
    return Boolean(
      (
        await this
          .db`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) select current_setting('app.tenant_id')::uuid,${conversationId},${expectedVersion + 1},${coveredThrough},${this.db.json(asDbJson(summary))} where ${coveredThrough}>(select coalesce(max(covered_through),0) from conversation_summaries where conversation_id=${conversationId}) and ${expectedVersion}=(select coalesce(max(version),0) from conversation_summaries where conversation_id=${conversationId}) and ${coveredThrough}<=(select coalesce(max(sequence),0) from messages where conversation_id=${conversationId}) on conflict do nothing returning id`
      ).length,
    );
  }
  recordSummaryFailure(businessId: string) {
    return this
      .db`insert into technical_events(business_id,component,code,severity) values(${businessId},'message-worker','ai.summary_failed','error')`;
  }
  async failAi(messageId: string, businessId: string, code: string) {
    await this.db`select c.id from conversations c join messages m on m.conversation_id=c.id where m.id=${messageId} for update of c`;
    const changed = await this
      .db`update messages set processing_state='ai_failed' where id=${messageId} and processing_state='pending'`;
    if (!changed.count) return;
    await this.db`update conversations set reply_due_at=null where latest_inbound_id=${messageId}`;
    await this
      .db`insert into technical_events(business_id,component,code,severity) values(${businessId},'message-worker',${code},'error')`;
    await this.appendAudit(businessId, {
      eventType: "ai.failed",
      outcome: "failure",
      eventHash: "f".repeat(64),
    });
  }
  async saveGenerated(messageId: string, businessId: string, text: string) {
    await this.db`select c.id from conversations c join messages m on m.conversation_id=c.id where m.id=${messageId} for update of c`;
    const source = (
      await this.db<
        { conversation_id: string; connection_id: string }[]
      >`update messages set processing_state='generated' where id=${messageId} and processing_state='pending' and exists(select 1 from conversations c where c.id=messages.conversation_id and c.latest_inbound_id=messages.id and c.reply_due_at<=now()) returning conversation_id,connection_id`
    )[0];
    if (!source) return null;
    return (
      (
        await this.db<
          { outbound_id: string }[]
        >`insert into outbound_commands(business_id,conversation_id,connection_id,source_message_id,text,state) values(${businessId},${source.conversation_id},${source.connection_id},${messageId},${text},'generated') on conflict(source_message_id) where source_message_id is not null do nothing returning outbound_id`
      )[0] ?? null
    );
  }
  async claimOwnedOutbound(owner: string, ownership: string[]) {
    return (
      (
        await this.db<
          {
            outbound_id: string;
            business_id: string;
            conversation_id: string;
            connection_id: string;
            remote_jid: string;
            text: string;
            ownership_token: string;
          }[]
        >`select * from claim_owned_outbound(${owner},${ownership})`
      )[0] ?? null
    );
  }
  async finishOutbound(
    id: string,
    state: "sent" | "failed" | "delivery_unknown",
    providerId: string | undefined,
    ownership: string,
  ) {
    await this.db`select c.id from conversations c join outbound_commands o on o.conversation_id=c.id where o.outbound_id=${id} for update of c`;
    const [connection] = await this.db`select w.id from whatsapp_connections w join outbound_commands o
      on o.connection_id=w.id and o.business_id=w.business_id where o.outbound_id=${id} for update of w`;
    if (!connection || !await this.lockWhatsAppOwnership(connection.id, ownership)) return false;
    const row = (
      await this.db<
        {
          business_id: string;
          conversation_id: string;
          connection_id: string;
          text: string;
        }[]
      >`update outbound_commands set state=${state},provider_message_id=${providerId ?? null},acknowledged_at=case when ${state}='sent' then now() end,failure_code=case when ${state}='sent' then null else ${state} end,updated_at=now() where outbound_id=${id} and state='sending' and ownership_token=${ownership} returning business_id,conversation_id,connection_id,text`
    )[0];
    if (!row) return false;
    const code =
      state === "sent"
        ? "whatsapp.outbound.acknowledged"
        : state === "failed"
          ? "whatsapp.send_failed"
          : "whatsapp.delivery_unknown";
    if (state === "sent")
      await this
        .db`insert into technical_events(business_id,component,code,severity,safe_details) values(${row.business_id},'whatsapp-manager',${code},'info','{}')`;
    else
      await this.recordRuntimeEvent(row.business_id, {
        code,
        outcome: "failure",
        source: "whatsapp-manager",
        requestId: `outbound:${id}`,
        severity: "error",
      });
    if (state === "sent") {
      const seq = (
        await this.db<
          { sequence: string }[]
        >`update conversations set next_sequence=next_sequence+1,last_reply_at=date_trunc('milliseconds',clock_timestamp()),last_exchange_at=date_trunc('milliseconds',clock_timestamp()) where id=${row.conversation_id} returning next_sequence-1 sequence`
      )[0]!.sequence;
      await this
        .db`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at,processing_state) values(${row.business_id},${row.conversation_id},${row.connection_id},${providerId!},${seq},'outbound',${row.text},now(),'sent') on conflict do nothing`;
    }
    return true;
  }
  recordInbox(businessId: string, source: string, stableKey: string) {
    return this
      .db`insert into inbox_events (business_id,source,stable_key) values (${businessId},${source},${stableKey}) on conflict do nothing`;
  }
  enqueueOutbox(
    businessId: string,
    topic: string,
    stableKey: string,
    payload: unknown,
  ) {
    return this
      .db`insert into outbox_events (business_id,topic,stable_key,payload) values (${businessId},${topic},${stableKey},${this.db.json(asDbJson(payload))}) on conflict do nothing`;
  }
  async claimOutbox() {
    return (
      (
        await this.db<
          { id: string; topic: string; stable_key: string }[]
        >`select id,topic,stable_key from outbox_events where published_at is null order by created_at for update skip locked limit 1`
      )[0] ?? null
    );
  }
  async markOutboxPublished(id: string) {
    return (
      await this
        .db`update outbox_events set published_at=now() where id=${id} and published_at is null returning id`
    ).length;
  }
  claimAiOutbox(token: string, limit: number, staleMs: number) {
    return this.db<
      {
        id: string;
        business_id: string;
        stable_key: string;
        payload: object;
        publish_attempts: number;
      }[]
    >`select * from claim_ai_outbox(${token},${limit},${staleMs})`;
  }
  async completeAiOutbox(id: string, token: string) {
    return (
      await this.db<
        { complete_ai_outbox: boolean }[]
      >`select complete_ai_outbox(${id},${token})`
    )[0]?.complete_ai_outbox
      ? 1
      : 0;
  }
  async releaseAiOutbox(id: string, token: string, delayMs: number) {
    return Boolean(
      (
        await this.db<
          { release_ai_outbox: boolean }[]
        >`select release_ai_outbox(${id},${token},${delayMs})`
      )[0]?.release_ai_outbox,
    );
  }
  async appendAudit(
    businessId: string,
    event: { eventType: string; outcome: string; eventHash: string },
  ) {
    await this
      .db`select pg_advisory_xact_lock(hashtext(${"audit:" + businessId}))`;
    const previous = (
      await this.db<
        { stream_sequence: string; event_hash: string }[]
      >`select stream_sequence,event_hash from audit_events where business_id=${businessId} order by stream_sequence desc limit 1`
    )[0];
    return this
      .db`insert into audit_events (business_id,actor_id,event_type,outcome,request_id,stream_sequence,previous_hash,event_hash,hmac_key_version) values (${businessId},current_setting('app.actor_id',true),${event.eventType},${event.outcome},current_setting('app.request_id',true),${Number(previous?.stream_sequence ?? 0) + 1},${previous?.event_hash ?? "GENESIS"},${event.eventHash},'runtime-v1')`;
  }
  async auditCount() {
    return Number(
      (
        await this.db<
          { count: string }[]
        >`select count(*) count from audit_events`
      )[0]?.count ?? 0,
    );
  }
  async tenantSnapshot() {
    const profile = (
      await this.db<
        { display_name: string }[]
      >`select display_name from business_profiles limit 1`
    )[0];
    const assistant = (
      await this.db<
        { active: boolean }[]
      >`select active from assistant_configs limit 1`
    )[0];
    const inbox = Number(
      (
        await this.db<
          { count: string }[]
        >`select count(*) count from inbox_events`
      )[0]?.count ?? 0,
    );
    const outbox = Number(
      (
        await this.db<
          { count: string }[]
        >`select count(*) count from outbox_events`
      )[0]?.count ?? 0,
    );
    return {
      profile: profile?.display_name ?? null,
      assistantActive: assistant?.active ?? null,
      inbox,
      outbox,
    };
  }
  conversationTexts() {
    return this.db`select raw_text from messages`;
  }
  authRecordNames() {
    return this.db`select record_name from whatsapp_auth_records`;
  }
}

export { RolePool, createRuntimePools } from "./runtime-pools.ts";
