import { createHash } from "node:crypto";
import { tenantContext, AppointmentError, type createRuntimePools, type PostgresRepositories,
  type StoredAppointment, type AppointmentAvailabilityOption, type CatalogResource } from "@agendia/db";
import {
  argentinaDate, nearbyDate, customerTemporalSelection, emptyAgendaDialogue, explicitQuoteConfirmation,
  explicitCustomerNames, explicitCancel, explicitNotes, explicitPreference, expressedBookingPreference,
  quoteTermsEqual, type AgendaDialogue,
} from "../../../../../packages/domain/src/whatsapp/agenda.ts";
import type { PostgresAiJob } from "../../jobs/ai-job.ts";
import { AgentToolSession, canonicalAgentDate, AGENT_CALENDAR_TIME_ZONE, emitAgentDiagnostic,
  type AgentToolCommand, type AgentToolResult,
  type AgentSessionOutcome, type AgentToolDiagnostics } from "../tools.ts";

import { buildAgentMessages } from "../context.ts";
import { presentAvailability } from "../availability-presentation.ts";

type Pools = ReturnType<typeof createRuntimePools>;
type Source = NonNullable<Awaited<ReturnType<PostgresRepositories["loadAiMessage"]>>>;
type PreparationOutcome = "prepared" | "retained-noop" | "rejected";
type Reply = { reason: string; dialogue: AgendaDialogue; saved?: StoredAppointment; proposal?: true;
  preparation?: PreparationOutcome; missingFields?: readonly string[];
  alternatives?: { items: unknown[]; hasMore: boolean; resourceName?: string | null };
  data?: { pending: "retained" | "unchanged" } };
const unchanged = (reason: string, dialogue: AgendaDialogue, awaiting?: readonly string[]): Reply => ({
  reason, dialogue: awaiting ? { ...dialogue, awaiting } : dialogue,
  ...(awaiting ? { missingFields: awaiting } : {}),
});
const proposalReply = (dialogue: AgendaDialogue, reason = "PROPOSAL_READY"): Reply => {
  if (!dialogue.quote) throw new Error("Cannot present an absent agenda quote");
  return { reason, dialogue, proposal: true };
};
const bounded = <T>(items: T[]) => {
  const selected = items.slice(0, 50);
  while (selected.length && new TextEncoder().encode(JSON.stringify(selected)).byteLength > 12000) selected.pop();
  return { items: selected, hasMore: selected.length < items.length };
};
const availableSlots = (options: AppointmentAvailabilityOption[]) => {
  const selected = bounded(options.map(option => ({
    startsAt: option.start, resourceId: option.resourceId,
    serviceId: option.terms.serviceId, durationMinutes: option.terms.durationMinutes, priceArs: option.terms.priceArs,
    presentation: canonicalAgentDate(option.start, AGENT_CALENDAR_TIME_ZONE),
  })));
  let result = presentAvailability(selected);
  while (selected.items.length && new TextEncoder().encode(JSON.stringify(result)).byteLength > 12000) {
    selected.items.pop();
    selected.hasMore = true;
    result = presentAvailability(selected);
  }
  return result;
};
/** Persistent preference comes from customer expressions/retained state, not query or assignment arguments. */
const trustedPreference = (text: string, resources: readonly { id: string; name: string }[],
  previous?: string | null, unresolved = false, selectedResourceId?: string) => {
  const preferred = resources.find(resource => expressedBookingPreference(text, resource.name));
  const removePreference = explicitPreference(text, null);
  const unknownPreference = /\bprefiero\b/iu.test(text) && !preferred && !selectedResourceId;
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
const missingNames = (dialogue: AgendaDialogue): string[] => {
  const fields = dialogue.bookingNameFields ?? dialogue.bookingNames;
  return [...(!fields?.firstName ? ["firstName"] : []), ...(!fields?.lastName ? ["lastName"] : [])];
};
const namesReply = (dialogue: AgendaDialogue): Reply => ({
  reason: "MISSING_NAMES", dialogue, missingFields: missingNames(dialogue),
});
type GuardedMutation = Extract<AgentToolCommand, { name: "cancel" | "notes" | "preference" }>;

export class PostgresWhatsAppAgenda {
  constructor(private pools: Pools, private clock = () => new Date().toISOString(),
    private diagnose?: AgentToolDiagnostics) {}
  private context(job: PostgresAiJob) {
    return tenantContext({ businessId: job.businessId, actorId: "message-worker", role: "internal_worker", requestId: job.correlationId });
  }
  /** T3 entry point: no linguistic admission or proposal-provider call. The callback
   * authors a strict final response while holding source/dialogue/calendar fences.
   * Do not send externally from the callback. A staged effect becomes committed only
   * after this method returns committed; any callback/persistence failure rolls back.
   * T3 must bound provider rounds/time because locks live for the callback duration.
   */
  async withAgentSession(job: PostgresAiJob,
    converse: (session: AgentToolSession) => Promise<string>): Promise<AgentSessionOutcome> {
    let completedSession: AgentToolSession | undefined;
    try {
      const outcome = await this.pools.worker.run(this.context(job), async repo => {
        const source = await repo.lockAgendaSource(job.messageId);
        if (!source || source.business_id !== job.businessId) return { status: "not_current" } as const;
        const phone = await repo.agendaSender(job.messageId);
        let dialogue = phone ? await repo.lockAgendaDialogue(job.businessId, source.connection_id, phone) : emptyAgendaDialogue();
        await repo.acquireBusinessCalendarLock({ businessId: job.businessId });
        const actions: { operation: string; appointmentId: string }[] = [];
        const initialDialogue = JSON.stringify(dialogue);
        let presentationRevision = 0;
        const rejectPreparation = () => {
          if (actions.length) return; // A staged action reply survives subsequent refusals until outer commit.
          dialogue.quote = null;
          presentationRevision++;
          dialogue.awaitingNames = false;
          if (dialogue.awaiting?.includes("names")) {
            dialogue.awaiting = dialogue.awaiting.filter(field => field !== "names");
            if (!dialogue.awaiting.length) delete dialogue.awaiting;
          }
          namesRevision++;
        };
        // Opaque bindings commit to the trusted runtime scope and the whole quote,
        // including operation, appointment, terms, names and delivery provenance.
        // These are context checks, NOT proof that free text semantically consents.
        const fingerprint = (kind: string, value: unknown) => createHash("sha256").update(JSON.stringify({
          kind, businessId: job.businessId, connectionId: source.connection_id, phone, value,
        })).digest("hex");
        const issuedPresentations = new Set<string>();
        const currentPresentationReference = () => fingerprint("quote_presentation", {
          sourceMessageId: source.id, revision: presentationRevision, quote: dialogue.quote,
        });
        const presentationReference = () => {
          if (!dialogue.quote) return null;
          const reference = currentPresentationReference();
          issuedPresentations.add(reference);
          return reference;
        };
        const pendingQuotePresentationReference = presentationReference();
        const cancellationReferences = new Map<string, string>();
        const cancellationReference = (ap: StoredAppointment) => fingerprint("cancellation", {
          sourceMessageId: source.id, text: source.raw_text, appointment: this.agentAppointment(ap),
        });
        const metadataReferences = { notes: new Map<string, string>(), preference: new Map<string, string>() };
        const metadataReference = (operation: "notes" | "preference", ap: StoredAppointment) => fingerprint(operation, {
          sourceMessageId: source.id, text: source.raw_text, nameSources, appointment: this.agentAppointment(ap),
        });
        const inspectAppointment = (ap: StoredAppointment) => {
          const reference = cancellationReference(ap), notesReference = metadataReference("notes", ap), preferenceReference = metadataReference("preference", ap);
          cancellationReferences.set(ap.id, reference);
          metadataReferences.notes.set(ap.id, notesReference);
          metadataReferences.preference.set(ap.id, preferenceReference);
          return { ...this.agentAppointment(ap), cancellationReference: reference, notesReference, preferenceReference };
        };
        const resourceReferences = new Map<string, string>();
        const resourceReference = (resource: CatalogResource) => fingerprint("preference_resource", { sourceMessageId: source.id, text: source.raw_text, resource });
        const inspectResource = (resource: CatalogResource) => {
          const reference = resourceReference(resource);
          resourceReferences.set(resource.id, reference);
          return { ...resource, resourceReference: reference };
        };
        const nameSources: { messageId: string; text: string }[] = [];
        for (const member of source.currentGroup) {
          if (phone && await repo.agendaSender(member.id) === phone)
            nameSources.push({ messageId: member.id, text: member.raw_text });
        }
        const knownClient = phone ? await repo.findClientByCanonicalPhone(phone) : null;
        let namesRevision = 0;
        const namesReference = () => phone && !knownClient && !dialogue.change && !dialogue.reschedule
          && (dialogue.quote?.kind === "book" || dialogue.awaiting?.length)
          ? fingerprint("booking_names", { inbound: source.id, text: source.raw_text, nameSources, draft: dialogue, namesRevision }) : null;
        const initialQuoteSnapshot = dialogue.quote ? JSON.stringify(dialogue.quote) : null;
        const naturalConfirmation = phone && dialogue.quote && (!dialogue.awaitingNames || dialogue.quote.kind === "book")
          && dialogue.quote.sourceMessageId !== source.id
          && await repo.agendaQuoteDelivered(dialogue.quote.outboundId, source.connection_id, phone)
          ? Object.freeze({ evidenceReference: fingerprint("inbound", { id: source.id, text: source.raw_text }),
            quoteFingerprint: fingerprint("quote", dialogue.quote) }) : null;
        const now = this.clock();
        const pendingPresentation = canonicalAgentDate(dialogue.quote?.startsAt, AGENT_CALENDAR_TIME_ZONE);
        const messages = buildAgentMessages(source, now, {
          pending: structuredClone(dialogue), pendingPresentation, pendingQuotePresentationReference, naturalConfirmation, currentEvidence: source.raw_text,
          namesReference: namesReference(), nameSources,
          calendarTimeZone: AGENT_CALENDAR_TIME_ZONE,
          serverPresentation: canonicalAgentDate(now, AGENT_CALENDAR_TIME_ZONE),
        });
        const session = new AgentToolSession(async command => {
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
          if (command.name === "cancel" && command.arguments.binding) {
            const { appointmentId, binding } = command.arguments;
            if (binding.evidence !== source.raw_text || cancellationReferences.get(appointmentId) !== binding.evidenceReference)
              return { status: "rejected", code: "INVALID_CANCELLATION_BINDING" };
          }
          try {
            const result = await repo.appointmentOperationSavepoint(async inner => {
              if (reading) return { result: await this.agentRead(inner, job, source, phone, command, dialogue, inspectAppointment, inspectResource) };
              const draft = structuredClone(dialogue);
              let reply: Reply;
              if (command.name === "clear_pending") {
                reply = unchanged("PENDING_CLEARED", emptyAgendaDialogue());
              } else if (command.name === "collect_booking_names") {
                const args = command.arguments, reference = namesReference();
                if (!reference || args.namesReference !== reference || await inner.findClientByCanonicalPhone(phone!))
                  return { result: { status: "rejected", code: "INVALID_NAMES_BINDING" } as const };
                const previousFields = draft.bookingNameFields ?? draft.bookingNames ?? {};
                const fields = { ...previousFields };
                for (const key of ["firstName", "lastName"] as const) {
                  const patch = args[key];
                  if (!patch) continue;
                  const member = nameSources.find(row => row.messageId === patch.messageId);
                  if (!member || await inner.agendaSender(patch.messageId) !== phone
                    || member.text.slice(patch.start, patch.start + patch.value.length) !== patch.value)
                    return { result: { status: "rejected", code: "INVALID_NAME_SOURCE" } as const };
                  fields[key] = patch.value;
                }
                if (fields.firstName === previousFields.firstName && fields.lastName === previousFields.lastName) {
                  // Repeated names are data, not a corrected proposal or consent.
                  if (fields.firstName && fields.lastName)
                    return { result: { status: "data", data: { bookingNameFields: fields } } as const };
                  return { result: { status: "clarification", code: "CUSTOMER_INPUT_REQUIRED",
                    reason: "MISSING_NAMES", missingFields: missingNames(draft) } as const, reply: namesReply(draft) };
                }
                const accepted = draft.quote?.kind === "book" && draft.acceptedBookingQuote === JSON.stringify(draft.quote)
                  && (!previousFields.firstName || previousFields.firstName === fields.firstName)
                  && (!previousFields.lastName || previousFields.lastName === fields.lastName);
                if (!accepted) delete draft.acceptedBookingQuote;
                draft.bookingNameFields = fields;
                draft.bookingNames = fields.firstName && fields.lastName ? { firstName: fields.firstName, lastName: fields.lastName } : null;
                if (draft.quote?.kind === "book") {
                  draft.quote.names = draft.bookingNames;
                  if (!accepted) { draft.quote.sourceMessageId = source.id; draft.quote.outboundId = null; }
                  draft.awaitingNames = !draft.bookingNames;
                  if (!draft.awaitingNames) delete draft.awaiting;
                }
                reply = accepted && draft.bookingNames
                  ? await this.respond(inner, job, source, phone!, draft, null, undefined, undefined, true)
                  : draft.awaitingNames ? namesReply(draft)
                  : draft.quote ? proposalReply(draft) : unchanged("MISSING_FIELDS", draft, draft.awaiting ?? ["time"]);
              } else if ((command.name === "notes" || command.name === "preference") && command.arguments.binding) {
                const args = command.arguments, binding = args.binding!;
                const member = nameSources.find(row => row.messageId === binding.messageId);
                const ap = await this.owned(inner, job.businessId, phone!, args.appointmentId);
                if (metadataReferences[command.name].get(ap.id) !== binding.evidenceReference
                  || metadataReference(command.name, ap) !== binding.evidenceReference || !member || member.text !== binding.evidence
                  || await inner.agendaSender(binding.messageId) !== phone)
                  return { result: { status: "rejected", code: "INVALID_METADATA_BINDING" } as const };
                let saved: StoredAppointment;
                if (command.name === "notes") {
                  const { notes, binding } = command.arguments;
                  if (notes !== null && (binding!.start! + notes.length > member.text.length
                    || member.text.slice(binding!.start!, binding!.start! + notes.length) !== notes))
                    return { result: { status: "rejected", code: "INVALID_NOTE_SPAN" } as const };
                  saved = await inner.setAppointmentNotes(job.businessId, ap.id, { notes }, actionContext(this.clock()));
                } else {
                  const { resourceId, binding } = command.arguments;
                  if (resourceId !== null) {
                    const resource = await inner.getResource(job.businessId, resourceId);
                    if (!resource || resourceReferences.get(resourceId) !== binding!.resourceReference
                      || resourceReference(resource) !== binding!.resourceReference)
                      return { result: { status: "rejected", code: "INVALID_RESOURCE_BINDING" } as const };
                  }
                  saved = await inner.setAgendaPreference(job.businessId, ap.id, resourceId, this.clock());
                }
                reply = { reason: "METADATA_STAGED",
                  dialogue: emptyAgendaDialogue(), saved };
              } else if (command.name === "prepare_booking" || command.name === "prepare_change") {
                reply = await this.prepareAgentQuote(inner, job, source, phone!, draft, command);
              } else {
                const mutation = command.name === "cancel" || command.name === "notes" || command.name === "preference"
                  ? command : null;
                // Only this separate, runtime-bound protocol enables model-interpreted
                // consent. Delivery, ownership, terms, capacity and persistence still
                // follow the same guarded branch; other linguistic guards stay intact.
                reply = await this.respond(inner, job, source, phone!, draft, mutation,
                  command.name === "confirm_quote_naturally" ? { sourceMessageId: source.id, quoteSnapshot: initialQuoteSnapshot! } : undefined,
                  command.name === "cancel" && command.arguments.binding
                    ? ap => cancellationReference(ap) === command.arguments.binding!.evidenceReference : undefined);
              }
              const result: AgentToolResult = command.name === "clear_pending" ? { status: "data", data: { pending: null } }
                : reply.data ? { status: "data", data: { ...reply.data, reason: reply.reason,
                    ...(reply.dialogue.quote ? { proposal: structuredClone(reply.dialogue.quote),
                      presentation: canonicalAgentDate(reply.dialogue.quote.startsAt, AGENT_CALENDAR_TIME_ZONE) } : {}) } }
                : reply.saved
                ? { status: "staged_action", operation: command.name, appointment: this.agentAppointment(reply.saved) }
                : reply.proposal && reply.dialogue.quote
                  ? { status: "prepared_quote", quote: structuredClone(reply.dialogue.quote), reason: reply.reason,
                    presentation: canonicalAgentDate(reply.dialogue.quote.startsAt, AGENT_CALENDAR_TIME_ZONE) }
                  : { status: command.name === "confirm_quote" || command.name === "confirm_quote_naturally" || command.name === "collect_booking_names" || command.name.startsWith("prepare_") ? "clarification" : "rejected",
                    code: "CUSTOMER_INPUT_REQUIRED", reason: reply.reason,
                    missingFields: reply.missingFields ?? (reply.dialogue.awaitingNames ? missingNames(reply.dialogue) : []),
                    ...(reply.preparation !== "rejected" && reply.dialogue.quote ? { proposal: structuredClone(reply.dialogue.quote) } : {}),
                    ...(reply.alternatives ? { alternatives: reply.alternatives } : {}) };
              return { result, reply };
            });
            if (result.reply?.preparation === "rejected") {
              // Preparation refusals carry customer context, never rejected selection fields.
              dialogue = result.reply.dialogue;
              rejectPreparation();
            } else if (result.reply) {
              if (JSON.stringify(dialogue.quote) !== JSON.stringify(result.reply.dialogue.quote)) presentationRevision++;
              dialogue = result.reply.dialogue;
              namesRevision++;
              if (result.reply.saved) actions.push({ operation: command.name, appointmentId: result.reply.saved.id });
            }
            return { ...result.result, namesReference: namesReference(),
              ...(dialogue.quote ? { presentationReference: presentationReference() } : {}) };
          } catch (error) {
            if (!(error instanceof AppointmentError)) throw error;
            const errorCode = ["INVALID_INPUT", "UNKNOWN_OWNED_ID", "INELIGIBLE_CATALOG", "UNAVAILABLE", "BUSY", "CLIENT_CONFLICT",
              "STATE_LOCKED", "STARTED_STRUCTURE_LOCKED", "LEAD_TIME", "NOTES_LOCKED", "NOT_TRANSITION", "INVALID_ACTION_CONTEXT",
              "ATTENDANCE_FORBIDDEN", "INVALID_ATTENDANCE_TIME", "BEFORE_START", "CONFIRMATION_REQUIRED"].includes(error.code)
              ? error.code : "UNKNOWN_APPOINTMENT_ERROR";
            emitAgentDiagnostic(this.diagnose, { code: "agent.tool_rejected", toolName: command.name, errorCode });
            return { status: "rejected", code: "AGENDA_REJECTED", reason: errorCode };
          }
        }, { message: source.raw_text, recent: source.turns.slice(-12).map(turn => turn.raw_text.slice(0, 2000)),
          pending: structuredClone(dialogue), pendingPresentation, pendingQuotePresentationReference, naturalConfirmation, messages,
          namesReference: namesReference(), nameSources: structuredClone(nameSources) }, this.diagnose, rejectPreparation);
        completedSession = session;
        let text: string;
        try {
          text = await converse(session);
          await session.drain();
        } finally { session.close(); await session.drain(); }
        const final = session.renderResponse(text);
        if (final.text === null) {
          if (session.attemptedAgendaChange || actions.length || JSON.stringify(dialogue) !== initialDialogue)
            throw new Error("Silent completion cannot hide agenda work");
          if (!await repo.saveSilentCompletion(job.messageId, job.businessId)) throw new Error("Agent source changed before atomic save");
          await repo.recordAgendaReceipt(job.businessId, job.messageId, null, "silent");
          await repo.appendAudit(job.businessId, {
            eventType: "whatsapp.agenda.silent", outcome: "success",
            eventHash: createHash("sha256").update(job.messageId).digest("hex"),
          });
          return { status: "silent" } as const;
        }
        if (final.presentedQuoteReference && (!dialogue.quote
          || !issuedPresentations.has(final.presentedQuoteReference)
          || final.presentedQuoteReference !== currentPresentationReference()))
          throw new Error("Invalid quote presentation reference");
        const output = await repo.saveGenerated(job.messageId, job.businessId, final.text);
        if (!output) throw new Error("Agent source changed before atomic save");
        if (dialogue.quote && final.presentedQuoteReference) {
          dialogue.quote.outboundId = output.outbound_id;
          dialogue.quote.sourceMessageId = source.id;
        }
        if (phone) await repo.saveAgendaDialogue(job.businessId, source.connection_id, phone, dialogue);
        await repo.recordAgendaReceipt(job.businessId, job.messageId, output.outbound_id, actions[0]?.operation ?? "agent");
        await repo.appendAudit(job.businessId, {
          eventType: actions.length ? "whatsapp.agenda.saved" : "whatsapp.agenda.reply", outcome: "success",
          eventHash: createHash("sha256").update(job.messageId).digest("hex"),
        });
        for (const action of actions) await repo.enqueueOutbox(job.businessId, "appointment.changed", `agenda:${job.messageId}`, {
          appointmentId: action.appointmentId, sourceMessageId: job.messageId,
        });
        return { status: "committed", outboundId: output.outbound_id, actions } as const;
      });
      if (outcome.status === "committed" || outcome.status === "silent") completedSession?.reportCompletedTurn();
      return outcome;
    } catch {
      // No SQL/provider details become customer facts, and the pending source remains
      // retryable. The caller must treat this as infrastructure failure, not success.
      return { status: "infrastructure_failure" };
    }
  }
  private agentAppointment(ap: StoredAppointment) {
    return { id: ap.id, startsAt: ap.startsAt, terms: ap.terms, state: ap.state,
      notes: ap.notes, preference: ap.customerResourcePreference,
      presentation: canonicalAgentDate(ap.startsAt, AGENT_CALENDAR_TIME_ZONE) };
  }
  private async agentRead(repo: PostgresRepositories, job: PostgresAiJob, source: Source,
    phone: string | null, command: AgentToolCommand, dialogue: AgendaDialogue,
    inspectAppointment: (ap: StoredAppointment) => unknown,
    inspectResource: (resource: CatalogResource) => unknown): Promise<AgentToolResult> {
    switch (command.name) {
      case "read_business": {
        const profile = source.profile;
        if (!Object.keys(profile).length) return { status: "unavailable_data", code: "BUSINESS_PROFILE_MISSING" };
        return { status: "data", data: { displayName: profile.display_name || null,
          description: profile.description || null, address: profile.address || null } };
      }
      case "read_catalog": return { status: "data", data: bounded((await repo.listServices()).filter(item => item.status === "active")
        .map(({ id, name, description, durationMinutes, priceArs }) => ({ id, name, description, durationMinutes, priceArs }))) };
      case "read_resources": return { status: "data", data: bounded((await repo.listResources(job.businessId)).filter(item => item.status === "active").map(inspectResource)) };
      case "read_calendar": {
        const calendar = await repo.getBusinessCalendar(job.businessId);
        if (!calendar.weeklySchedule) return { status: "unavailable_data", code: "BUSINESS_CALENDAR_MISSING" };
        return { status: "data", data: { timeZone: AGENT_CALENDAR_TIME_ZONE,
          weeklySchedule: calendar.weeklySchedule, closures: bounded(await repo.listBusinessClosures(job.businessId)),
          establishesAvailability: false } };
      }
      case "availability": {
        const args = command.arguments, serviceId = args.serviceId.toLowerCase(), resourceId = args.resourceId?.toLowerCase();
        const referenceFailure = (kind: "service" | "resource" | "appointment_context",
          errorCode: AppointmentError["code"] = "UNKNOWN_OWNED_ID"): AgentToolResult => {
          emitAgentDiagnostic(this.diagnose, { code: "agent.tool_rejected", toolName: "availability",
            errorCode, referenceFailureKind: kind });
          return { status: "rejected", code: kind === "service" ? "SERVICE_REFERENCE_REQUIRED"
            : kind === "resource" ? "RESOURCE_REFERENCE_REQUIRED" : "AGENDA_REJECTED" };
        };
        if (!(await repo.listServices()).some(item => item.id === serviceId && item.status === "active"))
          return referenceFailure("service");
        if (resourceId && (await repo.getResource(job.businessId, resourceId))?.status !== "active")
          return referenceFailure("resource");
        const binding = dialogue.reschedule;
        const appointmentId = binding?.appointmentId ?? args.appointmentId?.toLowerCase();
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
            || serviceId !== binding.serviceId || (args.appointmentId && args.appointmentId.toLowerCase() !== binding.appointmentId)))
            return referenceFailure("appointment_context");
        }
        const resources = await repo.listResources(job.businessId);
        const resolved = trustedPreference(source.raw_text, resources,
          binding ? binding.preference : dialogue.bookingPreference,
          binding ? binding.unresolvedPreference : dialogue.bookingUnresolvedPreference, resourceId);
        if (binding) {
          if (resolved.preference === undefined) delete binding.preference;
          else binding.preference = resolved.preference;
          binding.unresolvedPreference = resolved.unresolved;
        } else {
          if (resolved.preference === undefined) delete dialogue.bookingPreference;
          else dialogue.bookingPreference = resolved.preference;
          dialogue.bookingUnresolvedPreference = resolved.unresolved;
        }
        if (resolved.unresolved && !resourceId) return { status: "clarification", code: "UNKNOWN_RESOURCE", missingFields: ["resource"] };
        const queryResource = resourceId ?? resolved.preference ?? undefined;
        const options = await repo.listAppointmentAvailability(job.businessId, { serviceId, date: args.date,
          ...(queryResource ? { resourceId: queryResource } : {}) }, { clock: this.clock, ...(appointmentId ? { appointmentId } : {}) });
        return { status: "data", data: { ...availableSlots(options), date: args.date,
          serviceId, resourceId: queryResource ?? null,
          resourceName: resources.find(item => item.id === queryResource)?.name ?? null } };
      }
      case "owned_appointments": {
        const client = await repo.findClientByCanonicalPhone(phone!);
        const appointments = client ? await repo.listAppointments(job.businessId, { clientId: client.id }) : [];
        return { status: "data", data: bounded(appointments.filter(ap => ap.client.phone === phone).map(inspectAppointment)) };
      }
      case "owned_appointment": return { status: "data", data: inspectAppointment(await this.owned(repo, job.businessId, phone!, command.arguments.appointmentId)) };
      default: throw new Error("Non-reading tool reached read handler");
    }
  }
  /** Native arguments propose alternatives, never authorize a mutation.
   * Actual preference/name context stays separate. Confirmation still requires
   * actual subsequent input and delivered quote evidence.
   */
  private async prepareAgentQuote(repo: PostgresRepositories, job: PostgresAiJob, source: Source, phone: string,
    dialogue: AgendaDialogue, command: Extract<AgentToolCommand, { name: "prepare_booking" | "prepare_change" }>): Promise<Reply & { preparation: PreparationOutcome }> {
    const outcome = (preparation: PreparationOutcome, reply: Reply) => ({ ...reply, preparation });
    const args = command.arguments;
    const current = command.name === "prepare_change" ? await this.owned(repo, job.businessId, phone, command.arguments.appointmentId) : null;
    if (current && (current.state !== "confirmed" || Date.parse(this.clock()) >= current.startMs)) throw new AppointmentError("STATE_LOCKED");
    const bookingContext = !dialogue.reschedule && !dialogue.change && dialogue.quote?.kind !== "change";
    const pending = dialogue.quote?.kind === (current ? "change" : "book") && (current || bookingContext) ? dialogue.quote : null;
    const retained = current ? dialogue.reschedule ?? dialogue.change : undefined;
    if (current && ((pending && pending.appointmentId !== current.id) || (retained && retained.appointmentId !== current.id)))
      return outcome("rejected", unchanged("PROPOSAL_TARGET_MISMATCH", dialogue));
    if (current && ((pending && pending.previous !== snapshot(current)) || (retained && retained.previous !== snapshot(current)))) {
      const next = { ...dialogue };
      delete next.change;
      delete next.reschedule;
      return outcome("rejected", unchanged("APPOINTMENT_CHANGED", next));
    }
    const serviceId = (args.serviceId ?? pending?.terms.serviceId ?? current!.terms.serviceId).toLowerCase();
    const startsAt = args.startsAt ?? pending?.startsAt ?? current?.startsAt!;
    if (!(await repo.listServices()).some(item => item.id === serviceId && item.status === "active")) throw new AppointmentError("UNKNOWN_OWNED_ID");
    const resources = await repo.listResources(job.businessId);
    if (args.resourceId && !resources.some(item => item.id === args.resourceId!.toLowerCase() && item.status === "active")) throw new AppointmentError("UNKNOWN_OWNED_ID");
    const binding = current && dialogue.reschedule?.appointmentId === current.id ? dialogue.reschedule : undefined;
    const previousPreference = current ? binding?.preference !== undefined ? binding.preference : pending ? pending.preference : current.customerResourcePreference : bookingContext ? dialogue.bookingPreference : undefined;
    const repeatBook = !current && pending && pending.terms.serviceId === serviceId && Date.parse(pending.startsAt) === Date.parse(startsAt);
    const resolved = trustedPreference(source.raw_text, resources, previousPreference,
      current ? binding?.unresolvedPreference : bookingContext && dialogue.bookingUnresolvedPreference, args.resourceId);
    const next: AgendaDialogue = { ...emptyAgendaDialogue(),
      ...(!current && bookingContext && dialogue.bookingNames !== undefined ? { bookingNames: dialogue.bookingNames } : {}),
      ...(!current && bookingContext && dialogue.bookingNameFields ? { bookingNameFields: dialogue.bookingNameFields } : {}),
      ...(resolved.preference !== undefined ? { bookingPreference: resolved.preference } : {}),
      bookingUnresolvedPreference: resolved.unresolved };
    if (current) next.reschedule = {
      appointmentId: current.id, previous: snapshot(current), serviceId: current.terms.serviceId, resourceId: null,
      ...(resolved.preference !== undefined ? { preference: resolved.preference } : {}), unresolvedPreference: resolved.unresolved,
      ...(binding?.date ? { date: binding.date } : {}), ...(binding?.time ? { time: binding.time } : {}),
    };
    if (resolved.unresolved && (current || (!args.resourceId && (!repeatBook || resolved.unknownPreference))))
      return outcome("rejected", unchanged("UNKNOWN_RESOURCE", { ...dialogue, ...next }, ["resource"]));
    // Assignment/query choices are not persistent preference or temporal evidence.
    const resourceId = current ? args.resourceId?.toLowerCase()
      ?? (resolved.preferred || resolved.removePreference ? resolved.preference ?? undefined : pending?.terms.resourceId ?? resolved.preference ?? undefined)
      : args.resourceId?.toLowerCase() ?? (repeatBook && !resolved.preferred && !resolved.removePreference ? pending.terms.resourceId : resolved.preference ?? undefined);
    const options = await repo.listAppointmentAvailability(job.businessId, { serviceId, date: argentinaDate(startsAt),
      ...(resourceId ? { resourceId } : {}) }, { clock: this.clock, ...(current ? { appointmentId: current.id } : {}) });
    const selected = options.find(option => option.startMs === Date.parse(startsAt) && option.resourceId === current?.terms.resourceId)
      ?? options.find(option => option.startMs === Date.parse(startsAt));
    if (!selected) return outcome("rejected", {
      ...unchanged("SLOT_UNAVAILABLE", { ...dialogue, ...next }, ["time"]),
      alternatives: { ...availableSlots(await this.alternatives(repo, job.businessId, serviceId,
        argentinaDate(startsAt), resourceId, current?.id)), resourceName: resources.find(item => item.id === resourceId)?.name ?? null },
    });
    if (current && selected.startMs === current.startMs && serviceId === current.terms.serviceId
      && selected.resourceId === current.terms.resourceId)
      return outcome("retained-noop", { reason: "APPOINTMENT_UNCHANGED", dialogue: emptyAgendaDialogue(), data: { pending: "unchanged" } });
    const client = await repo.findClientByCanonicalPhone(phone);
    const names = current || client ? null : explicitCustomerNames(source.raw_text) ?? (bookingContext ? dialogue.bookingNames : null) ?? null;
    if (pending && Date.parse(pending.startsAt) === selected.startMs && quoteTermsEqual(pending.terms, selected.terms)
      && pending.preference === (resolved.preference ?? null) && pending.names?.firstName === names?.firstName && pending.names?.lastName === names?.lastName) {
      if (!current && !client && !names) return outcome("retained-noop", namesReply(dialogue));
      const retainedDialogue = current ? dialogue : { ...dialogue, bookingUnresolvedPreference: resolved.unresolved,
        ...(resolved.preference !== undefined ? { bookingPreference: resolved.preference } : {}) };
      return outcome("retained-noop", { reason: "PROPOSAL_UNCHANGED", dialogue: retainedDialogue, data: { pending: "retained" } });
    }
    if (!current) { next.bookingNames = names; if (names) next.bookingNameFields = { ...names }; }
    next.quote = { kind: current ? "change" : "book", appointmentId: current?.id ?? null, startsAt: selected.start,
      terms: selected.terms, preference: resolved.preference ?? null, previous: current ? snapshot(current) : null,
      names: current ? null : names, sourceMessageId: source.id, outboundId: null };
    next.awaitingNames = !current && !client && !names;
    return outcome("prepared", next.awaitingNames ? { ...namesReply(next), dialogue: { ...next, awaiting: ["names"] } } : proposalReply(next));
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
    date: string, dialogue: AgendaDialogue, resourceId?: string): Promise<Reply> {
    const options = await this.alternatives(repo, businessId, serviceId, date, resourceId);
    const next: AgendaDialogue = { ...dialogue, quote: null, awaitingNames: false };
    // An offer is not a quote or consent. Retain customer data, discard the failed
    // target/time, and bind a short time answer to the actual day being offered.
    delete next.requestedTime;
    if (options[0]) next.requestedDate = argentinaDate(options[0].start);
    return { ...unchanged("SLOT_UNAVAILABLE", next, options.length ? ["time"] : ["date"]),
      alternatives: { ...availableSlots(options), resourceName: resourceId ? (await repo.getResource(businessId, resourceId))?.name ?? null : null } };
  }
  private async respond(repo: PostgresRepositories, job: PostgresAiJob, source: Source, phone: string,
    dialogue: AgendaDialogue, mutation: GuardedMutation | null,
    naturalConfirmation?: { sourceMessageId: string; quoteSnapshot: string },
    validateCancellation?: (ap: StoredAppointment) => boolean, retainedBookingAcceptance = false): Promise<Reply> {
    const now = this.clock();
    const selection = customerTemporalSelection(source.raw_text, now);
    if (selection.date) dialogue.requestedDate = selection.date;
    if (selection.time) dialogue.requestedTime = selection.time;
    const client = await repo.findClientByCanonicalPhone(phone);
    if (!mutation && dialogue.quote && dialogue.awaitingNames && !naturalConfirmation) {
      const names = explicitCustomerNames(source.raw_text);
      if (names) {
        dialogue.quote.names = names;
        dialogue.bookingNames = names;
        dialogue.bookingNameFields = { ...names };
        dialogue.awaitingNames = false;
        delete dialogue.awaiting;
        dialogue.quote.sourceMessageId = source.id;
        dialogue.quote.outboundId = null;
        return proposalReply(dialogue);
      }
      return namesReply(dialogue);
    }
    // Runtime binding establishes authentic context only; semantics are model risk.
    // Literal confirmation remains an independent received-answer guard.
    const boundInterpretation = naturalConfirmation?.sourceMessageId === source.id
      && naturalConfirmation.quoteSnapshot === JSON.stringify(dialogue.quote);
    if (!mutation && dialogue.quote && (explicitQuoteConfirmation(source.raw_text) || boundInterpretation || retainedBookingAcceptance)) {
      const quote = dialogue.quote;
      if (!await repo.agendaQuoteDelivered(quote.outboundId, source.connection_id, phone))
        return proposalReply(dialogue, "PROPOSAL_NOT_DELIVERED");
      if (quote.sourceMessageId === source.id) return proposalReply(dialogue);
      let current: StoredAppointment | null = null;
      if (quote.kind === "change") {
        current = await this.owned(repo, job.businessId, phone, quote.appointmentId!);
        if (snapshot(current) !== quote.previous) return unchanged("APPOINTMENT_CHANGED", emptyAgendaDialogue());
      }
      const options = await repo.listAppointmentAvailability(job.businessId, {
        serviceId: quote.terms.serviceId, resourceId: quote.terms.resourceId, date: argentinaDate(quote.startsAt),
      }, { clock: this.clock, ...(current ? { appointmentId: current.id } : {}) });
      const option = options.find(option => option.startMs === Date.parse(quote.startsAt));
      if (!option) {
        if (!current) {
          const offered = await this.bookingAlternatives(repo, job.businessId, quote.terms.serviceId,
            argentinaDate(quote.startsAt), { ...dialogue, bookingPreference: quote.preference, bookingNames: quote.names },
            quote.preference ?? undefined);
          return offered;
        }
        return { ...unchanged("SLOT_UNAVAILABLE", emptyAgendaDialogue()), missingFields: ["time"],
          alternatives: { ...availableSlots(await this.alternatives(repo, job.businessId,
            quote.terms.serviceId, argentinaDate(quote.startsAt), quote.preference ?? undefined, current.id)),
            resourceName: quote.preference ? quote.terms.resourceName : null } };

      }
      if (!quoteTermsEqual(quote.terms, option.terms)) {
        delete dialogue.acceptedBookingQuote;
        quote.terms = option.terms;
        quote.sourceMessageId = source.id;
        quote.outboundId = null;
        return proposalReply(dialogue, "TERMS_CHANGED");
      }
      const preference = quote.preference ? { kind: "chosen" as const, resourceId: quote.preference }
        : quote.kind === "change" && dialogue.reschedule?.preference === null ? { kind: "none" as const } : undefined;
      let saved: StoredAppointment;
      if (current) {
        saved = await repo.changeAppointment(job.businessId, current.id, {
          serviceId: quote.terms.serviceId, resourceId: quote.terms.resourceId, startRaw: quote.startsAt,
        }, { now, ...(preference ? { customerResourceExpression: preference } : {}) });
      } else {
        if (!client && !quote.names) {
          if (boundInterpretation) dialogue.acceptedBookingQuote = JSON.stringify(quote);
          return namesReply({ ...dialogue, awaitingNames: true });
        }
        saved = await repo.createAppointment(job.businessId, {
          serviceId: quote.terms.serviceId, resourceId: quote.terms.resourceId, startRaw: quote.startsAt,
          ...(client ? { clientId: client.id } : { newClient: { ...quote.names!, phone } }),
        }, { now, origin: "ai", ...(preference ? { customerResourceExpression: preference } : {}) });
      }
      return { reason: "APPOINTMENT_STAGED", dialogue: emptyAgendaDialogue(), saved };
    }
    if (!mutation) return unchanged("NO_CONFIRMATION", dialogue);
    switch (mutation.name) {
      case "cancel": {
        if (!validateCancellation && !explicitCancel(source.raw_text)) return unchanged("CANCELLATION_REQUIRED", dialogue);
        const ap = await this.owned(repo, job.businessId, phone, mutation.arguments.appointmentId);
        // Fresh ownership and snapshot checks are independent of interpreted intent.
        if (validateCancellation && !validateCancellation(ap)) throw new AppointmentError("CONFIRMATION_REQUIRED");
        const saved = await repo.transitionAppointment(job.businessId, ap.id, "cancelled", actionContext(now));
        return { reason: "CANCELLATION_STAGED", dialogue: emptyAgendaDialogue(), saved };
      }
      case "notes": {
        const notes = explicitNotes(source.raw_text);
        if (notes === undefined) return unchanged("NOTE_REQUEST_REQUIRED", dialogue);
        const ap = await this.owned(repo, job.businessId, phone, mutation.arguments.appointmentId);
        const saved = await repo.setAppointmentNotes(job.businessId, ap.id, { notes }, actionContext(now));
        return { reason: "NOTES_STAGED", dialogue: emptyAgendaDialogue(), saved };
      }
      case "preference": {
        const args = mutation.arguments;
        const resource = args.resourceId ? await repo.getResource(job.businessId, args.resourceId) : null;
        if ((args.resourceId && !resource) || !explicitPreference(source.raw_text, resource?.name ?? null))
          return unchanged("PREFERENCE_REQUEST_REQUIRED", dialogue);
        const ap = await this.owned(repo, job.businessId, phone, args.appointmentId);
        const saved = await repo.setAgendaPreference(job.businessId, ap.id, args.resourceId, now);
        return { reason: "PREFERENCE_STAGED", dialogue: emptyAgendaDialogue(), saved };
      }
    }
  }
}
