import { createHash } from "node:crypto";
import { tenantContext, AppointmentError, type createRuntimePools, type PostgresRepositories,
  type StoredAppointment, type AppointmentAvailabilityOption } from "@agendia/db";
import {
  argentinaDate, nearbyDate, agendaTime, customerTemporalSelection, emptyAgendaDialogue, explicitQuoteConfirmation,
  explicitCustomerNames, explicitCancel, structuralChangeIntent, customerChangeChoice, explicitNotes, explicitPreference, expressedBookingPreference,
  quoteTermsEqual, quoteText, missingFieldText, type AgendaDialogue, type AgendaQuote,
} from "../../../packages/domain/src/whatsapp-agenda.ts";
import type { PostgresAiJob } from "./ai-job.ts";
import { ReceptionistToolSession, canonicalReceptionistDate, RECEPTIONIST_CALENDAR_TIME_ZONE, emitReceptionistDiagnostic,
  type ReceptionistToolCommand, type ReceptionistToolResult,
  type ReceptionistSessionOutcome, type ReceptionistToolDiagnostics } from "./receptionist-tools.ts";

import { buildReceptionistMessages } from "./receptionist.ts";

type Pools = ReturnType<typeof createRuntimePools>;
type Source = NonNullable<Awaited<ReturnType<PostgresRepositories["loadAiMessage"]>>>;
type Reply = { text: string; dialogue: AgendaDialogue; saved?: StoredAppointment; renderedQuote?: string };
const unchanged = (text: string, dialogue: AgendaDialogue, awaiting?: readonly string[]): Reply => ({
  text, dialogue: awaiting ? { ...dialogue, awaiting } : dialogue,
});
/** Only this renderer attests that the reply contains the retained quote's exact summary. */
const summaryReply = (dialogue: AgendaDialogue, prefix = ""): Reply => {
  if (!dialogue.quote) throw new Error("Cannot render an absent agenda quote");
  return {
    text: prefix + quoteText(dialogue.quote), dialogue,
    renderedQuote: JSON.stringify(dialogue.quote),
  };
};
/** Resource authority comes from customer expressions and retained state, never model arguments. */
const trustedPreference = (text: string, resources: readonly { id: string; name: string }[],
  previous?: string | null, unresolved = false) => {
  const preferred = resources.find(resource => expressedBookingPreference(text, resource.name));
  const removePreference = explicitPreference(text, null);
  const unknownPreference = /\bprefiero\b/iu.test(text) && !preferred;
  return {
    preferred, removePreference, unknownPreference,
    preference: removePreference ? null : preferred?.id ?? previous,
    unresolved: preferred || removePreference ? false : unknownPreference || unresolved,
  };
};
const snapshot = (appointment: StoredAppointment): string => JSON.stringify({
  startsAt: appointment.startsAt, terms: appointment.terms, state: appointment.state,
  preference: appointment.customerResourcePreference,
});
const actionContext = (now: string) => ({ actor: "customer" as const, channel: "ai" as const, now });
type GuardedMutation = Extract<ReceptionistToolCommand, { name: "cancel" | "notes" | "preference" }>;

export class PostgresWhatsAppAgenda {
  constructor(private pools: Pools, private clock = () => new Date().toISOString(),
    private diagnose?: ReceptionistToolDiagnostics) {}
  private context(job: PostgresAiJob) {
    return tenantContext({ businessId: job.businessId, actorId: "message-worker", role: "internal_worker", requestId: job.correlationId });
  }
  /** T3 entry point: no linguistic admission or proposal-provider call. The callback
   * selects a closed final response act while holding source/dialogue/calendar fences.
   * Do not send externally from the callback. A staged effect becomes committed only
   * after this method returns committed; any callback/persistence failure rolls back.
   * T3 must bound provider rounds/time because locks live for the callback duration.
   */
  async withReceptionistSession(job: PostgresAiJob,
    converse: (session: ReceptionistToolSession) => Promise<string>): Promise<ReceptionistSessionOutcome> {
    let completedSession: ReceptionistToolSession | undefined;
    try {
      const outcome = await this.pools.worker.run(this.context(job), async repo => {
        const source = await repo.lockAgendaSource(job.messageId);
        if (!source || source.business_id !== job.businessId) return { status: "not_current" } as const;
        const phone = await repo.agendaSender(job.messageId);
        let dialogue = phone ? await repo.lockAgendaDialogue(job.businessId, source.connection_id, phone) : emptyAgendaDialogue();
        await repo.acquireBusinessCalendarLock({ businessId: job.businessId });
        const actions: { operation: string; appointmentId: string }[] = [];
        let quoteNeedsDelivery = false;
        let backendReply: string | undefined;
        // Opaque bindings commit to the trusted runtime scope and the whole quote,
        // including operation, appointment, terms, names and delivery provenance.
        // These are context checks, NOT proof that free text semantically consents.
        const fingerprint = (kind: string, value: unknown) => createHash("sha256").update(JSON.stringify({
          kind, businessId: job.businessId, connectionId: source.connection_id, phone, value,
        })).digest("hex");
        const initialQuoteSnapshot = dialogue.quote ? JSON.stringify(dialogue.quote) : null;
        const naturalConfirmation = phone && dialogue.quote && !dialogue.awaitingNames
          && dialogue.quote.sourceMessageId !== source.id
          && await repo.agendaQuoteDelivered(dialogue.quote.outboundId, source.connection_id, phone)
          ? Object.freeze({ evidenceReference: fingerprint("inbound", { id: source.id, text: source.raw_text }),
            quoteFingerprint: fingerprint("quote", dialogue.quote) }) : null;
        const settings = await repo.platformAiInstructions();
        const now = this.clock();
        const pendingPresentation = canonicalReceptionistDate(dialogue.quote?.startsAt, RECEPTIONIST_CALENDAR_TIME_ZONE);
        const messages = buildReceptionistMessages(source, settings.additionalInstructions, now, {
          pending: structuredClone(dialogue), pendingPresentation, naturalConfirmation, currentEvidence: source.raw_text,
          calendarTimeZone: RECEPTIONIST_CALENDAR_TIME_ZONE,
          serverPresentation: canonicalReceptionistDate(now, RECEPTIONIST_CALENDAR_TIME_ZONE),
        });
        const session = new ReceptionistToolSession(async command => {
          const reading = ["read_business", "read_catalog", "read_calendar", "read_resources", "availability", "owned_appointments", "owned_appointment"].includes(command.name);
          if (actions.length && !reading) return { status: "rejected", code: "ACTION_ALREADY_STAGED" };
          if (!phone && !["read_business", "read_catalog", "read_calendar", "read_resources", "availability"].includes(command.name))
            return { status: "rejected", code: "UNVERIFIED_SENDER" };
          if (command.name === "confirm_quote_naturally") {
            if (!naturalConfirmation) return { status: "clarification", code: "NATURAL_CONFIRMATION_UNAVAILABLE" };
            const args = command.arguments;
            if (args.evidence !== source.raw_text || args.evidenceReference !== naturalConfirmation.evidenceReference
              || args.quoteFingerprint !== naturalConfirmation.quoteFingerprint || !dialogue.quote
              || JSON.stringify(dialogue.quote) !== initialQuoteSnapshot
              || fingerprint("quote", dialogue.quote) !== args.quoteFingerprint)
              return { status: "rejected", code: "INVALID_CONFIRMATION_BINDING" };
          }
          try {
            const result = await repo.appointmentOperationSavepoint(async inner => {
              if (reading) return { result: await this.receptionistRead(inner, job, source, phone, command, dialogue) };
              const draft = structuredClone(dialogue);
              let reply: Reply;
              if (command.name === "clear_pending") {
                reply = unchanged("No se guardó ningún turno nuevo ni se cambió un turno existente.", emptyAgendaDialogue());
              } else if (command.name === "prepare_booking" || command.name === "prepare_change") {
                reply = await this.prepareReceptionistQuote(inner, job, source, phone!, draft, command);
              } else {
                const mutation = command.name === "cancel" || command.name === "notes" || command.name === "preference"
                  ? command : null;
                // Only this separate, runtime-bound protocol enables model-interpreted
                // consent. Delivery, ownership, terms, capacity and persistence still
                // follow the same guarded branch; other linguistic guards stay intact.
                reply = await this.respond(inner, job, source, phone!, draft, mutation,
                  command.name === "confirm_quote_naturally" ? { sourceMessageId: source.id, quoteSnapshot: initialQuoteSnapshot! } : undefined);
              }
              const result: ReceptionistToolResult = command.name === "clear_pending" ? { status: "data", data: { pending: null } }
                : reply.saved
                ? { status: "staged_action", operation: command.name, appointment: this.receptionistAppointment(reply.saved) }
                : reply.renderedQuote && reply.dialogue.quote
                  ? { status: "prepared_quote", quote: structuredClone(reply.dialogue.quote), message: reply.text,
                    presentation: canonicalReceptionistDate(reply.dialogue.quote.startsAt, RECEPTIONIST_CALENDAR_TIME_ZONE) }
                  : { status: command.name === "confirm_quote" || command.name === "confirm_quote_naturally" || command.name.startsWith("prepare_") ? "clarification" : "rejected",
                    code: "CUSTOMER_INPUT_REQUIRED", message: reply.text };
              return { result, reply };
            });
            if (result.reply) {
              const previouslyQuoted = quoteNeedsDelivery && dialogue.quote ? JSON.stringify(dialogue.quote) : null;
              dialogue = result.reply.dialogue;
              backendReply = command.name === "clear_pending" ? undefined : result.reply.text;
              quoteNeedsDelivery = Boolean(dialogue.quote && (result.reply.renderedQuote === JSON.stringify(dialogue.quote)
                || previouslyQuoted === JSON.stringify(dialogue.quote)));
              if (result.reply.saved) actions.push({ operation: command.name, appointmentId: result.reply.saved.id });
            }
            return result.result;
          } catch (error) {
            if (!(error instanceof AppointmentError)) throw error;
            const errorCode = ["INVALID_INPUT", "UNKNOWN_OWNED_ID", "INELIGIBLE_CATALOG", "UNAVAILABLE", "BUSY", "CLIENT_CONFLICT",
              "STATE_LOCKED", "STARTED_STRUCTURE_LOCKED", "LEAD_TIME", "NOTES_LOCKED", "NOT_TRANSITION", "INVALID_ACTION_CONTEXT",
              "ATTENDANCE_FORBIDDEN", "INVALID_ATTENDANCE_TIME", "BEFORE_START", "CONFIRMATION_REQUIRED"].includes(error.code)
              ? error.code : "UNKNOWN_APPOINTMENT_ERROR";
            emitReceptionistDiagnostic(this.diagnose, { code: "receptionist.tool_rejected", toolName: command.name, errorCode });
            return { status: "rejected", code: "AGENDA_REJECTED" };
          }
        }, { message: source.raw_text, recent: source.turns.slice(-12).map(turn => turn.raw_text.slice(0, 2000)),
          pending: structuredClone(dialogue), pendingPresentation, naturalConfirmation, messages }, this.diagnose);
        completedSession = session;
        let text: string;
        try {
          text = await converse(session);
          await session.drain();
        } finally { session.close(); await session.drain(); }
        if (typeof text !== "string" || !text.trim() || text.length > 12000) throw new Error("Invalid receptionist response");
        // Neither free prose nor provider-authored proof can enter the outbox.
        // A quote/action reply comes only from the guarded backend branch above.
        text = backendReply ?? session.renderResponse(text);
        if (dialogue.quote && quoteNeedsDelivery && !text.includes(quoteText(dialogue.quote)))
          text += "\n\n" + quoteText(dialogue.quote);
        if (!text.trim() || text.length > 12000) throw new Error("Rendered receptionist response limit");
        const output = await repo.saveGenerated(job.messageId, job.businessId, text);
        if (!output) throw new Error("Receptionist source changed before atomic save");
        if (dialogue.quote && quoteNeedsDelivery) dialogue.quote.outboundId = output.outbound_id;
        if (phone) await repo.saveAgendaDialogue(job.businessId, source.connection_id, phone, dialogue);
        await repo.recordAgendaReceipt(job.businessId, job.messageId, output.outbound_id, actions[0]?.operation ?? "receptionist");
        await repo.appendAudit(job.businessId, {
          eventType: actions.length ? "whatsapp.agenda.saved" : "whatsapp.agenda.reply", outcome: "success",
          eventHash: createHash("sha256").update(job.messageId).digest("hex"),
        });
        for (const action of actions) await repo.enqueueOutbox(job.businessId, "appointment.changed", `agenda:${job.messageId}`, {
          appointmentId: action.appointmentId, sourceMessageId: job.messageId,
        });
        return { status: "committed", outboundId: output.outbound_id, actions } as const;
      });
      if (outcome.status === "committed") completedSession?.reportCompletedTurn();
      return outcome;
    } catch {
      // No SQL/provider details become customer facts, and the pending source remains
      // retryable. The caller must treat this as infrastructure failure, not success.
      return { status: "infrastructure_failure" };
    }
  }
  private receptionistAppointment(ap: StoredAppointment) {
    return { id: ap.id, startsAt: ap.startsAt, terms: ap.terms, state: ap.state,
      notes: ap.notes, preference: ap.customerResourcePreference,
      presentation: canonicalReceptionistDate(ap.startsAt, RECEPTIONIST_CALENDAR_TIME_ZONE) };
  }
  private async receptionistRead(repo: PostgresRepositories, job: PostgresAiJob, source: Source,
    phone: string | null, command: ReceptionistToolCommand, dialogue: AgendaDialogue): Promise<ReceptionistToolResult> {
    const bounded = <T>(items: T[]) => {
      const selected = items.slice(0, 50);
      while (selected.length && new TextEncoder().encode(JSON.stringify(selected)).byteLength > 12000) selected.pop();
      return { items: selected, hasMore: selected.length < items.length };
    };
    switch (command.name) {
      case "read_business": {
        const profile = source.profile;
        if (!Object.keys(profile).length) return { status: "unavailable_data", code: "BUSINESS_PROFILE_MISSING" };
        return { status: "data", data: { displayName: profile.display_name || null,
          description: profile.description || null, address: profile.address || null } };
      }
      case "read_catalog": return { status: "data", data: bounded((await repo.listServices()).filter(item => item.status === "active")
        .map(({ id, name, description, durationMinutes, priceArs }) => ({ id, name, description, durationMinutes, priceArs }))) };
      case "read_resources": return { status: "data", data: bounded((await repo.listResources(job.businessId)).filter(item => item.status === "active")) };
      case "read_calendar": {
        const calendar = await repo.getBusinessCalendar(job.businessId);
        if (!calendar.weeklySchedule) return { status: "unavailable_data", code: "BUSINESS_CALENDAR_MISSING" };
        return { status: "data", data: { timeZone: RECEPTIONIST_CALENDAR_TIME_ZONE,
          weeklySchedule: calendar.weeklySchedule, closures: bounded(await repo.listBusinessClosures(job.businessId)),
          establishesAvailability: false } };
      }
      case "availability": {
        const args = command.arguments;
        const referenceFailure = (kind: "service" | "resource" | "appointment_context",
          errorCode: AppointmentError["code"] = "UNKNOWN_OWNED_ID"): ReceptionistToolResult => {
          emitReceptionistDiagnostic(this.diagnose, { code: "receptionist.tool_rejected", toolName: "availability",
            errorCode, referenceFailureKind: kind });
          return { status: "rejected", code: kind === "service" ? "SERVICE_REFERENCE_REQUIRED"
            : kind === "resource" ? "RESOURCE_REFERENCE_REQUIRED" : "AGENDA_REJECTED",
            message: kind === "service"
              ? "Consultá read_catalog y reintentá con el ID devuelto del mismo servicio elegido; si no está o es ambiguo, preguntá sin elegir otro."
              : kind === "resource"
                ? "Consultá read_resources y reintentá con el ID devuelto del mismo recurso elegido; si no está o es ambiguo, preguntá sin elegir otro ni quitar la preferencia."
                : "No se pudo verificar la consulta; no se guardó nada. Actualizá read_catalog/read_resources sin cambiar la elección. Para reprogramar, consultá owned_appointments del remitente actual y usá solo un turno propio elegible; nunca inventes IDs ni borres el contexto retenido. Para una búsqueda nueva, no envíes appointmentId." };
        };
        if (!(await repo.listServices()).some(item => item.id === args.serviceId && item.status === "active"))
          return referenceFailure("service");
        if (args.resourceId && (await repo.getResource(job.businessId, args.resourceId))?.status !== "active")
          return referenceFailure("resource");
        const binding = dialogue.reschedule;
        const appointmentId = binding?.appointmentId ?? args.appointmentId;
        if (appointmentId) {
          if (!phone) return referenceFailure("appointment_context");
          let current: StoredAppointment;
          try { current = await this.owned(repo, job.businessId, phone, appointmentId); }
          catch (error) {
            if (!(error instanceof AppointmentError)) throw error;
            return referenceFailure("appointment_context", error.code);
          }
          if (current.state !== "confirmed" || Date.parse(this.clock()) >= current.startMs)
            return referenceFailure("appointment_context", "STATE_LOCKED");
          if (binding && (binding.previous !== snapshot(current) || binding.serviceId !== current.terms.serviceId
            || args.serviceId !== binding.serviceId || (args.appointmentId && args.appointmentId !== binding.appointmentId)))
            return referenceFailure("appointment_context");
        }
        const resources = await repo.listResources(job.businessId);
        const resolved = trustedPreference(source.raw_text, resources,
          binding ? binding.preference : dialogue.bookingPreference,
          binding ? binding.unresolvedPreference : dialogue.bookingUnresolvedPreference);
        if (binding) {
          if (resolved.preference === undefined) delete binding.preference;
          else binding.preference = resolved.preference;
          binding.unresolvedPreference = resolved.unresolved;
        } else {
          if (resolved.preference === undefined) delete dialogue.bookingPreference;
          else dialogue.bookingPreference = resolved.preference;
          dialogue.bookingUnresolvedPreference = resolved.unresolved;
        }
        const selection = customerTemporalSelection(source.raw_text, this.clock());
        const retainedScope = binding || dialogue.bookingPreference !== undefined || dialogue.bookingUnresolvedPreference
          || dialogue.requestedDate !== undefined;
        const date = selection.date ?? (retainedScope ? dialogue.requestedDate ?? args.date : args.date);
        if (selection.date) dialogue.requestedDate = selection.date;
        if (resolved.unresolved) return { status: "clarification", code: "UNKNOWN_RESOURCE", message: missingFieldText(["resource"]) };
        const options = await this.alternatives(repo, job.businessId, args.serviceId, date,
          resolved.preference ?? undefined, appointmentId);
        if (options[0] && dialogue.requestedDate) dialogue.requestedDate = argentinaDate(options[0].start);
        const resourceName = resources.find(item => item.id === resolved.preference)?.name;
        return { status: "data", data: { ...bounded(options.map(option => ({ startsAt: option.start, resourceId: option.resourceId,
          serviceId: option.terms.serviceId, durationMinutes: option.terms.durationMinutes, priceArs: option.terms.priceArs,
          presentation: canonicalReceptionistDate(option.start, RECEPTIONIST_CALENDAR_TIME_ZONE) }))),
          message: this.slotsText(options, resourceName) } };
      }
      case "owned_appointments": {
        const client = await repo.findClientByCanonicalPhone(phone!);
        const appointments = client ? await repo.listAppointments(job.businessId, { clientId: client.id }) : [];
        return { status: "data", data: bounded(appointments.filter(ap => ap.client.phone === phone).map(ap => this.receptionistAppointment(ap))) };
      }
      case "owned_appointment": return { status: "data", data: this.receptionistAppointment(await this.owned(repo, job.businessId, phone!, command.arguments.appointmentId)) };
      default: throw new Error("Non-reading tool reached read handler");
    }
  }
  /** Model selections can propose alternatives, never override customer-selected
   * fields or authorize a mutation. This is not conversation admission: relative
   * requests may receive a disclosed quote without an exact literal clock time.
   * Confirmation still uses actual subsequent input and delivered quote evidence.
   */
  private async prepareReceptionistQuote(repo: PostgresRepositories, job: PostgresAiJob, source: Source, phone: string,
    dialogue: AgendaDialogue, command: Extract<ReceptionistToolCommand, { name: "prepare_booking" | "prepare_change" }>): Promise<Reply> {
    const args = command.arguments;
    const current = command.name === "prepare_change" ? await this.owned(repo, job.businessId, phone, command.arguments.appointmentId) : null;
    if (current && (current.state !== "confirmed" || Date.parse(this.clock()) >= current.startMs)) throw new AppointmentError("STATE_LOCKED");
    const serviceId = args.serviceId ?? current!.terms.serviceId;
    const startsAt = args.startsAt ?? current!.startsAt;
    if (!(await repo.listServices()).some(item => item.id === serviceId && item.status === "active")) throw new AppointmentError("UNKNOWN_OWNED_ID");
    const resources = await repo.listResources(job.businessId);
    if (args.resourceId && !resources.some(item => item.id === args.resourceId && item.status === "active")) throw new AppointmentError("UNKNOWN_OWNED_ID");
    if (current && dialogue.reschedule && dialogue.reschedule.appointmentId !== current.id
      && structuralChangeIntent(source.raw_text) === undefined)
      return unchanged("La propuesta cambia un turno que no pediste. No se guardó ningún cambio.", dialogue);
    const binding = current && dialogue.reschedule?.appointmentId === current.id ? dialogue.reschedule : undefined;
    const previousPreference = current ? binding?.preference !== undefined ? binding.preference : current.customerResourcePreference : dialogue.bookingPreference;
    const resolved = trustedPreference(source.raw_text, resources, previousPreference,
      current ? binding?.unresolvedPreference : dialogue.bookingUnresolvedPreference);
    const next: AgendaDialogue = { ...emptyAgendaDialogue(),
      ...(dialogue.bookingNames !== undefined ? { bookingNames: dialogue.bookingNames } : {}),
      ...(resolved.preference !== undefined ? { bookingPreference: resolved.preference } : {}),
      bookingUnresolvedPreference: resolved.unresolved };
    const receivedSelection = customerTemporalSelection(source.raw_text, this.clock());
    const requestedDate = receivedSelection.date ?? dialogue.requestedDate;
    const requestedTime = receivedSelection.time ?? dialogue.requestedTime;
    if (requestedDate) next.requestedDate = requestedDate;
    if (requestedTime) next.requestedTime = requestedTime;
    if (current) next.reschedule = {
      appointmentId: current.id, previous: snapshot(current), serviceId: current.terms.serviceId, resourceId: null,
      ...(resolved.preference !== undefined ? { preference: resolved.preference } : {}), unresolvedPreference: resolved.unresolved,
      ...(receivedSelection.date ?? binding?.date ? { date: receivedSelection.date ?? binding!.date! } : {}),
      ...(receivedSelection.time ?? binding?.time ? { time: receivedSelection.time ?? binding!.time! } : {}),
    };
    if (resolved.unresolved) return unchanged(missingFieldText(["resource"]), next, ["resource"]);
    if (current) {
      const intent = structuralChangeIntent(source.raw_text);
      const pendingChange = dialogue.change?.appointmentId === current.id ? dialogue.change : undefined;
      const kind = intent ?? pendingChange?.kind ?? "temporal";
      // Preparation does not require keyword admission, but a different received
      // operation cannot be laundered into a structural quote by model arguments.
      const unsupportedDirective = intent === undefined && /^(?:(?:quiero|necesito|por favor)\s+)?(?:cambiar|cambia|cambiá|reprogramar|reprogramá|mover|mové|pasar)(?:\s|[.!]|$)/iu.test(source.raw_text.trim());
      if (explicitNotes(source.raw_text) !== undefined || explicitCancel(source.raw_text) || unsupportedDirective)
        return unchanged("Indicá qué cambio de horario, servicio o recurso querés. No se preparó ningún cambio.", { ...dialogue, quote: null });
      const retained = pendingChange ?? binding;
      if (intent === undefined && retained && retained.previous !== snapshot(current))
        return unchanged("El turno cambió desde tu solicitud. Pedí el cambio nuevamente; no se guardó nada.", emptyAgendaDialogue());
      if (kind !== "temporal") {
        const catalog = kind === "service" ? (await repo.listServices()).filter(item => item.status === "active")
          : resources.filter(item => item.status === "active");
        const chosen = customerChangeChoice(source.raw_text, kind, catalog, intent === undefined)
          ?? (kind === "resource" ? resolved.preferred?.id : undefined);
        next.change = { appointmentId: current.id, previous: snapshot(current), kind };
        delete next.reschedule;
        if (!chosen) return unchanged(missingFieldText([kind]), next, [kind]);
        const incompatible = Date.parse(startsAt) !== current.startMs
          || (kind === "service" && ((args.resourceId !== undefined && args.resourceId !== current.terms.resourceId)
            || serviceId !== chosen))
          || (kind === "resource" && (serviceId !== current.terms.serviceId || args.resourceId !== chosen));
        if (incompatible) return unchanged("La propuesta cambia campos que no pediste. No se guardó ningún cambio.", next);
        if (kind === "service" && chosen === current.terms.serviceId)
          return unchanged("Ese ya es el servicio del turno. ¿Qué servicio querés?", next, ["service"]);
      } else {
        if (serviceId !== current.terms.serviceId)
          return unchanged("La propuesta cambia un servicio que no pediste. No se guardó ningún cambio.", next);
        if (args.resourceId !== undefined && args.resourceId !== current.terms.resourceId && !resolved.preferred && !binding?.preference)
          return unchanged("La propuesta cambia un recurso que no pediste. No se guardó ningún cambio.", next);
        const selection = customerTemporalSelection(source.raw_text, this.clock());
        const date = selection.date ?? (intent === undefined ? binding?.date : undefined);
        const time = selection.time ?? (intent === undefined ? binding?.time : undefined);
        if ((date && date !== argentinaDate(startsAt)) || (time && time !== agendaTime(startsAt)))
          return unchanged("La propuesta no coincide con el día y hora que pediste. Indicá nuevamente el día y la hora; no se guardó nada.", { ...next, reschedule: { ...next.reschedule!, ...(date ? { date } : {}), ...(time ? { time } : {}) } }, ["date", "time"]);
        // Retain only received selections, never promote a proposed model slot
        // into customer intent for a later preparation.
        next.reschedule = { ...next.reschedule!, ...(date ? { date } : {}), ...(time ? { time } : {}) };
        if (intent !== undefined || binding) {
          const missing = [...(!date ? ["date"] : []), ...(!time ? ["time"] : [])];
          if (missing.length) return unchanged(missingFieldText(missing), next, missing);
        }
      }
    }
    const resourceId = current && next.change ? next.change.kind === "service" ? current.terms.resourceId : args.resourceId
      : resolved.preference ?? args.resourceId;
    const preferredName = resources.find(item => item.id === resolved.preference)?.name;
    if (!current && requestedDate && !requestedTime)
      return this.bookingAlternatives(repo, job.businessId, serviceId, requestedDate, next, resourceId, preferredName);
    if (!current && ((requestedDate && requestedDate !== argentinaDate(startsAt)) || (requestedTime && requestedTime !== agendaTime(startsAt))))
      return unchanged("La propuesta no coincide con el día y hora que pediste. Indicá nuevamente el día y la hora; no se guardó nada.", next);
    const options = await repo.listAppointmentAvailability(job.businessId, { serviceId, date: argentinaDate(startsAt),
      ...(resourceId ? { resourceId } : {}) }, { clock: this.clock, ...(current ? { appointmentId: current.id } : {}) });
    const selected = options.find(option => option.startMs === Date.parse(startsAt) && option.resourceId === current?.terms.resourceId)
      ?? options.find(option => option.startMs === Date.parse(startsAt));
    if (!selected) return unchanged(this.slotsText(await this.alternatives(repo, job.businessId, serviceId,
      argentinaDate(startsAt), resourceId, current?.id), preferredName), next, ["time"]);
    if (current && selected.startMs === current.startMs && serviceId === current.terms.serviceId
      && selected.resourceId === current.terms.resourceId && (resolved.preference ?? null) === current.customerResourcePreference)
      return unchanged("La propuesta no cambia el turno. Indicá qué querés cambiar.", next);
    const client = await repo.findClientByCanonicalPhone(phone);
    const names = explicitCustomerNames(source.raw_text) ?? dialogue.bookingNames ?? null;
    next.bookingNames = names;
    next.quote = { kind: current ? "change" : "book", appointmentId: current?.id ?? null, startsAt: selected.start,
      terms: selected.terms, preference: resolved.preference ?? null, previous: current ? snapshot(current) : null,
      names: current ? null : names, sourceMessageId: source.id, outboundId: null };
    next.awaitingNames = !current && !client && !names;
    return next.awaitingNames ? unchanged(missingFieldText(["names"]), next, ["names"]) : summaryReply(next);
  }
  private async owned(repo: PostgresRepositories, businessId: string, phone: string, id: string): Promise<StoredAppointment> {
    const current = await repo.getAppointment(businessId, id);
    // Re-resolve the *current* stored phone, never a historical binding to client ID.
    if (!current || current.client.phone !== phone) throw new AppointmentError("UNKNOWN_OWNED_ID");
    return current;
  }
  private async alternatives(repo: PostgresRepositories, businessId: string, serviceId: string, date: string,
    resourceId?: string, appointmentId?: string): Promise<AppointmentAvailabilityOption[]> {
    const input = { serviceId, date, ...(resourceId ? { resourceId } : {}) };
    const options = await repo.listAppointmentAvailability(businessId, input, {
      clock: this.clock, ...(appointmentId ? { appointmentId } : {}),
    });
    if (options.length) return options;
    // Same day first; only when it has no choices expand nearby dates, preserving all true slots.
    for (const offset of [1, -1, 2, -2, 3, -3, 7]) {
      const day = nearbyDate(date, offset);
      const nearby = await repo.listAppointmentAvailability(businessId, { ...input, date: day }, {
        clock: this.clock, ...(appointmentId ? { appointmentId } : {}),
      });
      if (nearby.length) return nearby;
    }
    return [];
  }
  private async bookingAlternatives(repo: PostgresRepositories, businessId: string, serviceId: string,
    date: string, dialogue: AgendaDialogue, resourceId?: string, resourceName?: string): Promise<Reply> {
    const options = await this.alternatives(repo, businessId, serviceId, date, resourceId);
    const next: AgendaDialogue = { ...dialogue, quote: null, awaitingNames: false };
    // An offer is not a quote or consent. Retain customer data, discard the failed
    // target/time, and bind a short time answer to the actual day being offered.
    delete next.requestedTime;
    if (options[0]) next.requestedDate = argentinaDate(options[0].start);
    return unchanged(this.slotsText(options, resourceName), next, options.length ? ["time"] : ["date"]);
  }
  private slotsText(options: AppointmentAvailabilityOption[], resourceName?: string): string {
    const scope = resourceName ? ` con ${resourceName}` : "";
    if (!options.length) return `No hay horarios disponibles${scope} en ese día ni en los días cercanos consultados. ¿Qué otro día te sirve?`;
    const unique = [...new Map(options.map(option => [option.startMs, option])).values()];
    // Adaptive response by real day and hour, not a rigid three-slot recommendation.
    const days = new Map<string, string[]>();
    for (const option of unique) {
      const day = argentinaDate(option.start);
      days.set(day, [...(days.get(day) ?? []), agendaTime(option.start)]);
    }
    return `Horarios disponibles${scope}: ${[...days].map(([day, times]) => `${day}: ${times.join(", ")}`).join("; ")}. ¿Cuál elegís?`;
  }
  private async respond(repo: PostgresRepositories, job: PostgresAiJob, source: Source, phone: string,
    dialogue: AgendaDialogue, mutation: GuardedMutation | null,
    naturalConfirmation?: { sourceMessageId: string; quoteSnapshot: string }): Promise<Reply> {
    const now = this.clock();
    const selection = customerTemporalSelection(source.raw_text, now);
    if (selection.date) dialogue.requestedDate = selection.date;
    if (selection.time) dialogue.requestedTime = selection.time;
    const client = await repo.findClientByCanonicalPhone(phone);
    if (dialogue.quote && dialogue.awaitingNames) {
      const names = explicitCustomerNames(source.raw_text);
      if (names) {
        dialogue.quote.names = names;
        dialogue.bookingNames = names;
        dialogue.awaitingNames = false;
        dialogue.quote.sourceMessageId = source.id;
        return summaryReply(dialogue);
      }
      return unchanged(missingFieldText(["names"]), dialogue);
    }
    // Runtime binding establishes authentic context only; semantics are model risk.
    // Literal confirmation remains an independent received-answer guard.
    const boundInterpretation = naturalConfirmation?.sourceMessageId === source.id
      && naturalConfirmation.quoteSnapshot === JSON.stringify(dialogue.quote);
    if (dialogue.quote && (explicitQuoteConfirmation(source.raw_text) || boundInterpretation)) {
      const quote = dialogue.quote;
      if (!await repo.agendaQuoteDelivered(quote.outboundId, source.connection_id, phone))
        return summaryReply(dialogue, "Primero necesitás recibir el detalle de la propuesta. ");
      if (quote.sourceMessageId === source.id) return summaryReply(dialogue);
      let current: StoredAppointment | null = null;
      if (quote.kind === "change") {
        current = await this.owned(repo, job.businessId, phone, quote.appointmentId!);
        if (snapshot(current) !== quote.previous) return unchanged("El turno cambió desde la propuesta. Pedí el cambio nuevamente; no se guardó nada.", emptyAgendaDialogue());
      }
      const options = await repo.listAppointmentAvailability(job.businessId, {
        serviceId: quote.terms.serviceId, resourceId: quote.terms.resourceId, date: argentinaDate(quote.startsAt),
      }, { clock: this.clock, ...(current ? { appointmentId: current.id } : {}) });
      const option = options.find(option => option.startMs === Date.parse(quote.startsAt));
      if (!option) {
        if (!current) {
          const offered = await this.bookingAlternatives(repo, job.businessId, quote.terms.serviceId,
            argentinaDate(quote.startsAt), { ...dialogue, bookingPreference: quote.preference, bookingNames: quote.names },
            quote.preference ?? undefined, quote.preference ? quote.terms.resourceName : undefined);
          return { ...offered, text: "El horario ya no está disponible. " + offered.text };
        }
        return unchanged("El horario ya no está disponible. " + this.slotsText(await this.alternatives(repo, job.businessId,
          quote.terms.serviceId, argentinaDate(quote.startsAt), quote.preference ?? undefined, current.id),
          quote.preference ? quote.terms.resourceName : undefined), emptyAgendaDialogue());
      }
      if (!quoteTermsEqual(quote.terms, option.terms)) {
        quote.terms = option.terms;
        quote.sourceMessageId = source.id;
        quote.outboundId = null;
        return summaryReply(dialogue, "Las condiciones cambiaron. ");
      }
      const preference = quote.preference ? { kind: "chosen" as const, resourceId: quote.preference }
        : quote.kind === "change" && dialogue.reschedule?.preference === null ? { kind: "none" as const } : undefined;
      let saved: StoredAppointment;
      if (current) {
        saved = await repo.changeAppointment(job.businessId, current.id, {
          serviceId: quote.terms.serviceId, resourceId: quote.terms.resourceId, startRaw: quote.startsAt,
        }, { now, ...(preference ? { customerResourceExpression: preference } : {}) });
      } else {
        if (!client && !quote.names) return unchanged(missingFieldText(["names"]), { ...dialogue, awaitingNames: true });
        saved = await repo.createAppointment(job.businessId, {
          serviceId: quote.terms.serviceId, resourceId: quote.terms.resourceId, startRaw: quote.startsAt,
          ...(client ? { clientId: client.id } : { newClient: { ...quote.names!, phone } }),
        }, { now, origin: "ai", ...(preference ? { customerResourceExpression: preference } : {}) });
      }
      return { text: `Guardado: ${saved.terms.serviceName}, ${argentinaDate(saved.startsAt)} a las ${agendaTime(saved.startsAt)}, ${saved.terms.durationMinutes} minutos, ARS ${saved.terms.priceArs}. Turno ${saved.id}.`, dialogue: emptyAgendaDialogue(), saved };
    }
    if (!mutation) return unchanged("¿Qué servicio y día querés consultar?", dialogue);
    switch (mutation.name) {
      case "cancel": {
        if (!explicitCancel(source.raw_text)) return unchanged("Indicá explícitamente si querés cancelar tu turno.", dialogue);
        const ap = await this.owned(repo, job.businessId, phone, mutation.arguments.appointmentId);
        const saved = await repo.transitionAppointment(job.businessId, ap.id, "cancelled", actionContext(now));
        return { text: `Cancelación guardada. Turno ${saved.id}.`, dialogue: emptyAgendaDialogue(), saved };
      }
      case "notes": {
        const notes = explicitNotes(source.raw_text);
        if (notes === undefined) return unchanged("Escribí «nota: texto» o «borrar nota» para modificar la nota de tu turno.", dialogue);
        const ap = await this.owned(repo, job.businessId, phone, mutation.arguments.appointmentId);
        const saved = await repo.setAppointmentNotes(job.businessId, ap.id, { notes }, actionContext(now));
        return { text: "Nota guardada.", dialogue: emptyAgendaDialogue(), saved };
      }
      case "preference": {
        const args = mutation.arguments;
        const resource = args.resourceId ? await repo.getResource(job.businessId, args.resourceId) : null;
        if ((args.resourceId && !resource) || !explicitPreference(source.raw_text, resource?.name ?? null))
          return unchanged("Indicá «prefiero Nombre del recurso» o «sin preferencia». No se guardó ninguna preferencia.", dialogue);
        const ap = await this.owned(repo, job.businessId, phone, args.appointmentId);
        const saved = await repo.setAgendaPreference(job.businessId, ap.id, args.resourceId, now);
        return { text: "Preferencia guardada. No cambia la asignación ni garantiza disponibilidad.", dialogue: emptyAgendaDialogue(), saved };
      }
    }
  }
}
