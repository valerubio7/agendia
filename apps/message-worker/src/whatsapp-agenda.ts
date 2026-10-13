import { createHash } from "node:crypto";
import { tenantContext, AppointmentError, type createRuntimePools, type PostgresRepositories,
  type StoredAppointment, type AppointmentAvailabilityOption } from "@agendia/db";
import { AgendaProposalSchema, WeeklyScheduleSchema, type AgendaProposal, type AgendaProposalProvider } from "@agendia/domain";
import {
  argentinaDate, nearbyDate, agendaTime, customerTemporalSelection, customerSelectedStart, emptyAgendaDialogue, explicitQuoteConfirmation,
  explicitCustomerNames, explicitCancel, explicitChange, structuralChangeIntent, customerChangeChoice, explicitNotes, explicitPreference, expressedBookingPreference,
  quoteTermsEqual, quoteText, missingFieldText, isAgendaDialogueFollowup, type AgendaDialogue, type AgendaQuote,
} from "../../../packages/domain/src/whatsapp-agenda.ts";
import type { PostgresAiJob } from "./ai-job.ts";

type Pools = ReturnType<typeof createRuntimePools>;
type Source = NonNullable<Awaited<ReturnType<PostgresRepositories["loadAiMessage"]>>>;
type Reply = { text: string; dialogue: AgendaDialogue; saved?: StoredAppointment; renderedQuote?: string };
export function isAgendaMessage(text: string): boolean {
  return /\b(turnos?|reserv\w*|servicios?|citas?|agenda|horarios?|precio|cancel\w*|reprogram\w*|prefiero|preferencia|nota|confirmo|book\w*|appointment\w*)\b/iu.test(text);
}
export type FactualQuestion = "address" | "hours" | "greeting" | "unsupported";
/** Classify received questions only. Neither model prose nor model-selected facts enter this boundary. */
export function factualQuestion(text: string): FactualQuestion | null {
  const value = text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es-AR").trim()
    .replace(/^[¿¡]\s*|[?.!]+$/gu, "");
  if (explicitChange(text) || explicitCancel(text) || explicitNotes(text) !== undefined
    || /\b(turnos?|citas?|reserv\w*|servicios?|precio|prefiero|preferencia|confirmo|book\w*|appointment\w*)\b/u.test(value)) return null;
  if (/^(?:hola|buenos dias|buenas tardes|buenas noches|hello|hi)$/u.test(value)) return "greeting";
  if (/^(?:donde (?:estan(?: ubicad[oa]s)?|se ubican)|cual es (?:la|su) direccion|direccion|ubicacion|como (?:puedo )?llegar|(?:what is (?:your|the) )?address|where are you(?: located)?)$/u.test(value)) return "address";
  if (/^(?:cual(?:es)? (?:es|son) (?:el|los) horario(?:s)?(?: de atencion| habitual(?:es)?)?|horario(?: de atencion| habitual)|a que hora (?:abren|cierran)|(?:what are (?:your|the) )?opening hours)$/u.test(value)) return "hours";
  if (/\b(direccion|ubicacion|ubicad\w*|abren|cierran|address|hours)\b/u.test(value)) return "unsupported";
  if (/\bhorarios?\b/u.test(value) && /\b(atencion|habitual(?:es)?|negocio|apertura)\b/u.test(value)) return "unsupported";
  return null;
}
/** All speech acts are fixed backend text. The address is an opaque, quoted tenant fact. */
export function renderFactualReply(kind: FactualQuestion, address: string, weeklySchedule: unknown): string {
  if (kind === "address") {
    if (!address.trim()) return "No hay una dirección registrada. Podés consultar el horario habitual.";
    const literal = JSON.stringify(address.trim()).replace(/[\u202a-\u202e\u2066-\u2069]/gu,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return `Dirección registrada: ${literal}.`;
  }
  if (kind === "hours") {
    const parsed = WeeklyScheduleSchema.safeParse(weeklySchedule);
    if (!parsed.success || !Object.values(parsed.data).some(intervals => (intervals?.length ?? 0) > 0))
      return "No hay un horario habitual registrado.";
    const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
    const time = (minute: number) => `${Math.floor(minute / 60).toString().padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}`;
    const hours = ([1, 2, 3, 4, 5, 6, 0] as const).map(day => {
      const intervals = parsed.data[day] ?? [];
      return `${days[day]}: ${intervals.length ? intervals.map(interval => `${time(interval.startMinute)}–${time(interval.endMinute)}${interval.endMinute < interval.startMinute ? " (día siguiente)" : ""}`).join(", ") : "sin atención habitual"}`;
    });
    return `Horario habitual: ${hours.join("; ")}. No confirma apertura en una fecha ni disponibilidad de turnos.`;
  }
  if (kind === "greeting") return "Hola. Podés consultar la dirección y el horario habitual, o gestionar un turno.";
  return "Puedo informar la dirección y el horario habitual. Para gestionar un turno, indicá el servicio y el día. No se guardó ningún cambio de agenda.";
}
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
const noSave = "No se guardó el cambio. El turno o la disponibilidad ya no permiten esa operación. Podés consultar alternativas.";

export class PostgresWhatsAppAgenda {
  constructor(private pools: Pools, private provider: AgendaProposalProvider, private clock = () => new Date().toISOString()) {}
  private context(job: PostgresAiJob) {
    return tenantContext({ businessId: job.businessId, actorId: "message-worker", role: "internal_worker", requestId: job.correlationId });
  }
  async process(job: PostgresAiJob): Promise<boolean> {
    const context = this.context(job);
    const plan = await this.pools.worker.run(context, async repo => {
      const source = await repo.loadAiMessage(job.messageId, true);
      if (!source) return null;
      const phone = await repo.agendaSender(job.messageId);
      const dialogue = phone ? await repo.lockAgendaDialogue(job.businessId, source.connection_id, phone) : emptyAgendaDialogue();
      const services = await repo.listServices();
      const resources = await repo.listResources(job.businessId);
      const catalogAnswer = isAgendaDialogueFollowup(source.raw_text, dialogue)
        && [...services, ...resources].some(item => item.name.trim().toLocaleLowerCase("es-AR") === source.raw_text.trim().toLocaleLowerCase("es-AR"));
      if (factualQuestion(source.raw_text) !== null && !catalogAnswer) return null;
      const namedService = services.some(service => source.raw_text.toLocaleLowerCase("es-AR").includes(service.name.toLocaleLowerCase("es-AR")));
      // Admission recognizes clear customer actions; the executor still establishes
      // ownership, confirmation and lifecycle authority before any mutation.
      const explicitAction = explicitChange(source.raw_text) || explicitCancel(source.raw_text)
        || explicitNotes(source.raw_text) !== undefined;
      if (!isAgendaMessage(source.raw_text) && !explicitAction && !namedService
        && !isAgendaDialogueFollowup(source.raw_text, dialogue)) return null;
      return { source, phone, dialogue, services, resources };
    });
    if (!plan) return false;
    const localAnswer = plan.dialogue.quote && (explicitQuoteConfirmation(plan.source.raw_text)
      || (plan.dialogue.awaitingNames && explicitCustomerNames(plan.source.raw_text)));
    // Model plans never establish confirmation, names, preference expressions or identity.
    const proposal = !plan.phone || localAnswer ? null : AgendaProposalSchema.parse(await this.provider.proposeAgenda({
      message: plan.source.raw_text,
      context: { summary: "", recent: plan.source.turns.slice(-12).map(turn => turn.raw_text.slice(0, 2000)) },
      catalog: {
        services: plan.services.filter(service => service.status === "active").slice(0, 100).map(({ id, name }) => ({ id, name })),
        resources: plan.resources.slice(0, 100).map(({ id, name }) => ({ id, name })),
      },
      correlationId: job.correlationId,
    }));
    await this.pools.worker.run(context, async repo => {
      // Conversation fencing prevents a late plan from mutating after a newer inbound/manual reply.
      const source = await repo.lockAgendaSource(job.messageId);
      if (!source) return;
      const phone = await repo.agendaSender(job.messageId);
      let reply: Reply;
      if (!phone || phone !== plan.phone) {
        reply = unchanged("No pude verificar tu número de WhatsApp. No se guardó ningún turno. Escribí desde tu número real; no envíes otro teléfono.", emptyAgendaDialogue());
      } else {
        const dialogue = await repo.lockAgendaDialogue(job.businessId, source.connection_id, phone);
        await repo.acquireBusinessCalendarLock({ businessId: job.businessId });
        try {
          reply = await repo.appointmentOperationSavepoint(inner => this.respond(inner, job, source, phone, structuredClone(dialogue), proposal));
        } catch (error) {
          if (!(error instanceof AppointmentError)) throw error;
          // Deterministic domain rejection is a terminal saved reply. Infrastructure errors
          // roll back the entire receive operation and remain retryable, without a false success.
          reply = unchanged(noSave, emptyAgendaDialogue());
        }
      }
      const output = await repo.saveGenerated(job.messageId, job.businessId, reply.text);
      if (!output) throw new Error("Agenda source changed before atomic save");
      // A catalog, slot list or name prompt is not delivery evidence for quote terms.
      if (reply.dialogue.quote && reply.renderedQuote === JSON.stringify(reply.dialogue.quote))
        reply.dialogue.quote.outboundId = output.outbound_id;
      if (phone) await repo.saveAgendaDialogue(job.businessId, source.connection_id, phone, reply.dialogue);
      await repo.recordAgendaReceipt(job.businessId, job.messageId, output.outbound_id, proposal?.operation ?? "dialogue");
      await repo.appendAudit(job.businessId, {
        eventType: reply.saved ? "whatsapp.agenda.saved" : "whatsapp.agenda.reply",
        outcome: "success", eventHash: createHash("sha256").update(job.messageId).digest("hex"),
      });
      if (reply.saved) await repo.enqueueOutbox(job.businessId, "appointment.changed", `agenda:${job.messageId}`, {
        appointmentId: reply.saved.id, sourceMessageId: job.messageId,
      });
    });
    return true;
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
    dialogue: AgendaDialogue, proposal: AgendaProposal | null): Promise<Reply> {
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
      if (explicitQuoteConfirmation(source.raw_text)) return unchanged(missingFieldText(["names"]), dialogue);
    }
    if (dialogue.quote && explicitQuoteConfirmation(source.raw_text)) {
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
    if (!proposal) return unchanged("¿Qué servicio y día querés consultar?", dialogue);
    switch (proposal.operation) {
      case "clarify": {
        const missing = proposal.arguments.missing.filter(field => (field !== "names" || !client)
          && (field !== "resource" || /\b(prefiero|recurso|con)\b/iu.test(source.raw_text)));
        const awaiting = missing.length ? missing : ["service", "date"];
        return unchanged(missingFieldText(awaiting), dialogue, awaiting);
      }
      case "read_catalog": {
        const services = (await repo.listServices()).filter(service => service.status === "active");
        return unchanged(services.length ? services.map(service => `${service.name}: ${service.durationMinutes} minutos, ARS ${service.priceArs}`).join("\n") : "No hay servicios activos.", dialogue);
      }
      case "list_appointments": {
        const appointments = client ? await repo.listAppointments(job.businessId, { clientId: client.id }) : [];
        return unchanged(appointments.length ? appointments.map(ap => `${ap.id}: ${ap.terms.serviceName}, ${argentinaDate(ap.startsAt)} ${agendaTime(ap.startsAt)}, ${ap.state}`).join("\n") : "No tenés turnos registrados con este número.", dialogue);
      }
      case "availability": {
        const args = proposal.arguments;
        const binding = dialogue.reschedule;
        let serviceId = args.serviceId;
        let appointmentId: string | undefined;
        if (binding) {
          // Only a current sender-owned, inspected binding can exclude occupancy
          // or preserve agreed terms. Model IDs/services never establish this context.
          const current = await this.owned(repo, job.businessId, phone, binding.appointmentId);
          if (current.state !== "confirmed") throw new AppointmentError("STATE_LOCKED");
          if (Date.parse(now) >= current.startMs) throw new AppointmentError("STARTED_STRUCTURE_LOCKED");
          if (binding.previous !== snapshot(current) || binding.serviceId !== current.terms.serviceId)
            return unchanged("El turno cambió desde tu solicitud. Pedí el cambio nuevamente; no se guardó nada.", emptyAgendaDialogue());
          if (args.serviceId !== binding.serviceId)
            return unchanged("La consulta cambia un servicio que no pediste; no se guardó nada.", dialogue);
          serviceId = binding.serviceId;
          appointmentId = current.id;
        }
        const resources = await repo.listResources(job.businessId);
        const resolved = trustedPreference(source.raw_text, resources,
          binding ? binding.preference : dialogue.bookingPreference,
          binding ? binding.unresolvedPreference : dialogue.bookingUnresolvedPreference);
        if (binding) {
          if (resolved.preferred || resolved.removePreference || resolved.unknownPreference) {
            if (resolved.preference === undefined) delete binding.preference;
            else binding.preference = resolved.preference;
            binding.unresolvedPreference = resolved.unresolved;
          }
        } else {
          if (resolved.preference === undefined) delete dialogue.bookingPreference;
          else dialogue.bookingPreference = resolved.preference;
          dialogue.bookingUnresolvedPreference = resolved.unresolved;
        }
        if (resolved.unresolved) return unchanged(missingFieldText(["resource"]), dialogue, ["resource"]);
        if (!dialogue.requestedDate) return unchanged(missingFieldText(["date"]), dialogue, ["date"]);
        const preferredName = resources.find(resource => resource.id === resolved.preference)?.name;
        return unchanged(this.slotsText(await this.alternatives(repo, job.businessId, serviceId,
          dialogue.requestedDate, resolved.preference ?? undefined, appointmentId), preferredName), dialogue, ["date", "time"]);
      }
      case "book":
      case "change": {
        const args = proposal.arguments;
        const current = proposal.operation === "change" ? await this.owned(repo, job.businessId, phone, proposal.arguments.appointmentId) : null;
        let serviceId = args.serviceId ?? current!.terms.serviceId;
        let resourceId = args.resourceId;
        let startsAt = args.startsAt ?? current!.startsAt;
        const resources = await repo.listResources(job.businessId);
        const resolved = trustedPreference(source.raw_text, resources,
          dialogue.bookingPreference, dialogue.bookingUnresolvedPreference);
        const { preferred, removePreference, unknownPreference } = resolved;
        let preference = removePreference ? null : preferred?.id;
        if (current) {
          const intent = structuralChangeIntent(source.raw_text);
          const explicit = intent !== undefined;
          const continuing = dialogue.reschedule?.appointmentId === current.id
            && ((isAgendaDialogueFollowup(source.raw_text, dialogue) && (selection.date !== undefined || selection.time !== undefined))
              || (/^prefiero\b/iu.test(source.raw_text.trim()) && (preferred !== undefined || unknownPreference)) || removePreference);
          const kind = intent ?? (dialogue.change?.appointmentId === current.id ? dialogue.change.kind : continuing ? "temporal" : undefined);
          if (!kind) return unchanged("Indicá explícitamente qué cambio querés hacer en tu turno.", dialogue);
          if (current.state !== "confirmed") throw new AppointmentError("STATE_LOCKED");
          if (Date.parse(now) >= current.startMs) throw new AppointmentError("STARTED_STRUCTURE_LOCKED");
          if (explicit) dialogue.quote = null;
          if (kind !== "temporal") {
            const binding = explicit ? { appointmentId: current.id, previous: snapshot(current), kind } : dialogue.change;
            if (!binding || binding.previous !== snapshot(current))
              return unchanged("El turno cambió desde tu solicitud. Pedí el cambio nuevamente; no se guardó nada.", emptyAgendaDialogue());
            dialogue.change = binding;
            delete dialogue.reschedule;
            dialogue.quote = null;
            dialogue.awaitingNames = false;
            const catalog = kind === "service" ? (await repo.listServices()).filter(item => item.status === "active")
              : resources.filter(item => item.status === "active");
            const chosen = customerChangeChoice(source.raw_text, kind, catalog, !explicit) ?? (kind === "resource" ? preferred?.id : undefined);
            if (!chosen) return unchanged(missingFieldText([kind]), dialogue, [kind]);
            const incompatible = (args.startsAt !== undefined && Date.parse(args.startsAt) !== current.startMs)
              || (kind === "service" && ((args.resourceId !== undefined && args.resourceId !== current.terms.resourceId)
                || (args.serviceId !== undefined && args.serviceId !== chosen)))
              || (kind === "resource" && ((args.serviceId !== undefined && args.serviceId !== current.terms.serviceId)
                || (args.resourceId !== undefined && args.resourceId !== chosen)));
            if (incompatible) return unchanged("La propuesta cambia campos que no pediste. No se guardó ningún cambio.", dialogue);
            if (kind === "service" && chosen === current.terms.serviceId)
              return unchanged("Ese ya es el servicio del turno. ¿Qué servicio querés?", dialogue, ["service"]);
            serviceId = kind === "service" ? chosen : current.terms.serviceId;
            resourceId = kind === "resource" ? chosen : undefined;
            startsAt = current.startsAt;
          } else {
            delete dialogue.change;
            serviceId = current.terms.serviceId;
            if (args.serviceId !== undefined && args.serviceId !== serviceId)
              return unchanged("La propuesta cambia un servicio que no pediste. No se guardó ningún cambio.", dialogue);
            const binding: AgendaDialogue["reschedule"] = explicit ? {
              appointmentId: current.id, previous: snapshot(current), serviceId, resourceId: null,
              ...(selection.date ? { date: selection.date } : {}),
              ...(selection.time ? { time: selection.time } : {}),
            } : dialogue.reschedule;
            if (!binding || binding.previous !== snapshot(current))
              return unchanged("El turno cambió desde tu solicitud. Pedí el cambio nuevamente; no se guardó nada.", emptyAgendaDialogue());
            if (preferred) binding.preference = preferred.id;
            else if (removePreference) binding.preference = null;
            if (preferred || removePreference) binding.unresolvedPreference = false;
            else if (unknownPreference) binding.unresolvedPreference = true;
            if (!explicit && args.serviceId !== undefined && args.serviceId !== binding.serviceId)
              return unchanged("La propuesta cambió de servicio o recurso. Indicá nuevamente el cambio; no se guardó nada.", dialogue);
            if (selection.date) binding.date = selection.date;
            if (selection.time) binding.time = selection.time;
            dialogue.reschedule = binding;
            dialogue.quote = null;
            dialogue.awaitingNames = false;
            if (binding.unresolvedPreference) return unchanged(missingFieldText(["resource"]), dialogue, ["resource"]);
            if (args.resourceId !== undefined && args.resourceId !== current.terms.resourceId && !binding.preference)
              return unchanged("La propuesta cambia un recurso que no pediste. No se guardó ningún cambio.", dialogue);
            preference = binding.preference;
            const missing = [...(!binding.date ? ["date"] : []), ...(!binding.time ? ["time"] : [])];
            if (missing.length) return unchanged(missingFieldText(missing), dialogue, missing);
            const selectedStart = customerSelectedStart(binding.date, binding.time);
            if (!selectedStart) throw new AppointmentError("INVALID_INPUT");
            if (args.startsAt !== undefined && Date.parse(args.startsAt) !== Date.parse(selectedStart))
              return unchanged("La propuesta no coincide con el día y hora que pediste. Indicá nuevamente el día y la hora; no se guardó nada.", dialogue, ["date", "time"]);
            // Only customer-derived values become the trusted target. Old booking selection
            // and model-only startsAt are never reschedule authority, even across restarts.
            startsAt = selectedStart;
            serviceId = binding.serviceId;
            resourceId = binding.resourceId ?? undefined;
          }
        }
        if (current && unknownPreference) return unchanged(missingFieldText(["resource"]), dialogue);
        if (!current) {
          if (resolved.preference === undefined) delete dialogue.bookingPreference;
          else dialogue.bookingPreference = resolved.preference;
          dialogue.bookingUnresolvedPreference = resolved.unresolved;
          if (dialogue.bookingUnresolvedPreference) return unchanged(missingFieldText(["resource"]), dialogue, ["resource"]);
        }
        if (!current) preference = dialogue.bookingPreference;
        const requestedResource = preference ?? resourceId;
        const preferredName = resources.find(resource => resource.id === preference)?.name;
        if (!current) {
          if (!dialogue.requestedDate) return unchanged(missingFieldText(["date"]), dialogue, ["date"]);
          if (!dialogue.requestedTime) return this.bookingAlternatives(repo, job.businessId,
            serviceId, dialogue.requestedDate, dialogue, requestedResource, preferredName);
          if (dialogue.requestedDate !== argentinaDate(startsAt) || dialogue.requestedTime !== agendaTime(startsAt))
            return unchanged("La propuesta no coincide con el día y hora que pediste. Indicá nuevamente el día y la hora; no se guardó nada.", dialogue);
        }
        const options = await repo.listAppointmentAvailability(job.businessId, {
          serviceId, date: argentinaDate(startsAt), ...(requestedResource ? { resourceId: requestedResource } : {}),
        }, { clock: this.clock, ...(current ? { appointmentId: current.id } : {}) });
        const matching = options.filter(option => option.startMs === Date.parse(startsAt));
        const selected = matching.find(option => option.resourceId === current?.terms.resourceId) ?? matching[0];
        if (!selected) {
          if (!current) return this.bookingAlternatives(repo, job.businessId,
            serviceId, argentinaDate(startsAt), dialogue, requestedResource, preferredName);
          return unchanged(this.slotsText(await this.alternatives(repo, job.businessId, serviceId,
            argentinaDate(startsAt), requestedResource, current.id), preferredName),
            { ...dialogue, quote: null, awaitingNames: false }, ["date", "time"]);
        }
        // Routine assignment is not preference. Only an explicit customer expression may set metadata.
        const quote: AgendaQuote = {
          kind: current ? "change" : "book", appointmentId: current?.id ?? null,
          startsAt: selected.start, terms: selected.terms, preference: preference ?? null,
          previous: current ? snapshot(current) : null, names: current ? null : dialogue.bookingNames ?? null,
          sourceMessageId: source.id, outboundId: null,
        };
        if (current && serviceId === current.terms.serviceId) {
          const saved = await repo.changeAppointment(job.businessId, current.id, {
            serviceId, resourceId: selected.resourceId, startRaw: selected.start,
          }, { now, ...(preference !== undefined ? { customerResourceExpression: preference === null
            ? { kind: "none" as const } : { kind: "chosen" as const, resourceId: preference } } : {}) });
          return { text: `Cambio guardado: ${saved.terms.serviceName}, ${argentinaDate(saved.startsAt)} ${agendaTime(saved.startsAt)}, ${saved.terms.durationMinutes} minutos, ARS ${saved.terms.priceArs}.`, dialogue: emptyAgendaDialogue(), saved };
        }
        const awaitingNames = !current && !client && !quote.names;
        const next = { ...dialogue, quote, awaitingNames, awaiting: [] };
        return awaitingNames ? unchanged(missingFieldText(["names"]), next) : summaryReply(next);
      }
      case "cancel": {
        if (!explicitCancel(source.raw_text)) return unchanged("Indicá explícitamente si querés cancelar tu turno.", dialogue);
        const ap = await this.owned(repo, job.businessId, phone, proposal.arguments.appointmentId);
        const saved = await repo.transitionAppointment(job.businessId, ap.id, "cancelled", actionContext(now));
        return { text: `Cancelación guardada. Turno ${saved.id}.`, dialogue: emptyAgendaDialogue(), saved };
      }
      case "notes": {
        const notes = explicitNotes(source.raw_text);
        if (notes === undefined) return unchanged("Escribí «nota: texto» o «borrar nota» para modificar la nota de tu turno.", dialogue);
        const ap = await this.owned(repo, job.businessId, phone, proposal.arguments.appointmentId);
        const saved = await repo.setAppointmentNotes(job.businessId, ap.id, { notes }, actionContext(now));
        return { text: "Nota guardada.", dialogue: emptyAgendaDialogue(), saved };
      }
      case "preference": {
        const args = proposal.arguments;
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
