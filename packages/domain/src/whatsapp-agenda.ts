import { normalizeClientPhone } from "./client-registry.ts";
import { parseCalendarDateMs } from "./calendar-values.ts";
import type { AppointmentTermsSnapshot } from "./appointment-lifecycle.ts";

/** Only the received-message adapter may create this evidence. Never parse user prose as an address. */
export interface SenderEvidence {
  phone: string;
  pnJid: string;
  lidJid: string | null;
}
export interface ProviderAddressKey {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
  fromMe?: boolean | null;
}
const pnAddress = /^([1-9][0-9]{6,14})(?::([0-9]+))?@s\.whatsapp\.net$/;
const lidAddress = /^([1-9][0-9]{0,19})(?::([0-9]+))?@lid$/;
function address(jid: string) {
  const pn = pnAddress.exec(jid);
  if (pn) {
    // Adding + is mandatory: manual Argentina defaults are not provider identity evidence.
    const phone = normalizeClientPhone(`+${pn[1]}`);
    return phone ? { kind: "pn" as const, jid: `${pn[1]}@s.whatsapp.net`, phone } : null;
  }
  const lid = lidAddress.exec(jid);
  return lid ? { kind: "lid" as const, jid: `${lid[1]}@lid`, phone: null } : null;
}
export function receivedSenderEvidence(key: ProviderAddressKey): SenderEvidence | null {
  if (key.fromMe || key.participant || key.participantAlt || !key.remoteJid) return null;
  const primary = address(key.remoteJid);
  if (!primary) return null;
  const alternate = key.remoteJidAlt == null ? null : address(key.remoteJidAlt);
  if (key.remoteJidAlt != null && (!alternate || alternate.kind === primary.kind)) return null;
  const pn = primary.kind === "pn" ? primary : alternate?.kind === "pn" ? alternate : null;
  const lid = primary.kind === "lid" ? primary : alternate?.kind === "lid" ? alternate : null;
  if (!pn?.phone) return null;
  return { phone: pn.phone, pnJid: pn.jid, lidJid: lid?.jid ?? null };
}
export function validSenderEvidence(remoteJid: string, evidence: SenderEvidence | null | undefined): boolean {
  if (!evidence) return false;
  const primary = address(remoteJid);
  if (!primary || (primary.jid !== evidence.pnJid && primary.jid !== evidence.lidJid)) return false;
  const reconstructed = receivedSenderEvidence({
    remoteJid: evidence.pnJid,
    ...(evidence.lidJid ? { remoteJidAlt: evidence.lidJid } : {}),
  });
  return reconstructed !== null && reconstructed.phone === evidence.phone
    && reconstructed.pnJid === evidence.pnJid && reconstructed.lidJid === evidence.lidJid;
}

export interface AgendaQuote {
  kind: "book" | "change";
  appointmentId: string | null;
  startsAt: string;
  terms: AppointmentTermsSnapshot;
  preference: string | null;
  /** A change quote binds the inspected appointment, not merely its identifier. */
  previous: string | null;
  names: { firstName: string; lastName: string } | null;
  sourceMessageId: string;
  outboundId: string | null;
}
export interface AgendaDialogue {
  quote: AgendaQuote | null;
  awaitingNames: boolean;
  /** Concrete expected answers, not a permanent conversation-wide agenda mode. */
  awaiting?: readonly string[];
  requestedDate?: string;
  requestedTime?: string;
  /** Pending booking only: explicit customer preference and verified names survive offers. */
  bookingPreference?: string | null;
  bookingUnresolvedPreference?: boolean;
  bookingNames?: AgendaQuote["names"];
  /** Draft-local literal fields; omitted patches retain previously supplied values. */
  bookingNameFields?: { firstName?: string; lastName?: string };
  /** Missing service/resource choices are scoped to an inspected owned appointment. */
  change?: { appointmentId: string; previous: string; kind: "service" | "resource" };
  /** Owned appointment and inspected structure bind a multi-turn reschedule selection. */
  reschedule?: {
    appointmentId: string;
    previous: string;
    serviceId: string;
    resourceId: string | null;
    preference?: string | null;
    unresolvedPreference?: boolean;
    date?: string;
    time?: string;
  };
}
export const emptyAgendaDialogue = (): AgendaDialogue => ({ quote: null, awaitingNames: false });
const plain = (text: string) => text.trim().normalize("NFC").toLocaleLowerCase("es-AR");
/** A model's 'confirmed' assertion, a past summary, and an embedded yes are not consent. */
export function explicitQuoteConfirmation(text: string): boolean {
  return /^(sí|si|confirmo|sí, confirmo|si, confirmo|confirmar|acepto)[.!]?$/u.test(plain(text));
}
export function explicitCustomerNames(text: string): { firstName: string; lastName: string } | null {
  const answer = /^(?:mi nombre es|me llamo)\s+([\p{L}][\p{L}'’ -]{0,99})$/iu.exec(text.trim());
  if (!answer) return null;
  const parts = answer[1]!.trim().split(/\s+/u);
  if (parts.length < 2) return null;
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}
export function explicitCancel(text: string): boolean {
  return /^(?:(?:quiero|necesito|por favor)\s+)?(?:cancelar|cancela|cancelá|cancelo|anular|anulá)(?:\s|[.!]|$)/iu.test(text.trim());
}
export function explicitChange(text: string): boolean {
  return structuralChangeIntent(text) !== undefined;
}
export function structuralChangeIntent(text: string): "temporal" | "service" | "resource" | undefined {
  const request = /^(?:(?:quiero|necesito|por favor)\s+)?(cambiar|cambia|cambiá|reprogramar|reprogramá|mover|mové|pasar)(?:\s|[.!]|$)(.*)$/u.exec(plain(text));
  if (!request || explicitNotes(text) !== undefined) return undefined;
  const target = request[2]!.trim().replace(/^(?:(?:para|de|el|la|mi|un|una|a|las|los)\s+)*/u, "");
  if (/^(?:cambiar|cambia|cambiá)$/u.test(request[1]!)) {
    if (/^servicio\b/u.test(target)) return "service";
    if (/^recurso\b/u.test(target)) return "resource";
    if (/^(?:día|dia|fecha|hora|horario)\b/u.test(target)) return "temporal";
  } else if (!target || /^(?:turno|cita|día|dia|fecha|hora|horario|hoy|mañana|pasado mañana|domingo|lunes|martes|miércoles|jueves|viernes|sábado|[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}:[0-9]{2})(?:\b|$)/u.test(target)) {
    return "temporal";
  }
  return undefined;
}
export function customerChangeChoice(text: string, kind: "service" | "resource",
  catalog: readonly { id: string; name: string }[], pending: boolean): string | undefined {
  const field = kind === "service" ? "servicio" : "recurso";
  const directive = new RegExp(`^(?:(?:quiero|necesito|por favor)\\s+)?(?:cambiar|cambia|cambiá)\\s+(?:(?:de|el|la|mi)\\s+)*${field}(?:\\s+del\\s+turno)?\\s+(?:a|por|con)\\s+(.+)$`, "u");
  const value = plain(text).replace(/[.!]$/, "");
  const match = directive.exec(value);
  if (!match && (!pending || explicitNotes(text) !== undefined
    || /^(?:(?:quiero|necesito|por favor)\s+)?(?:cambiar|cambia|cambiá|reprogramar|reprogramá|mover|mové|pasar|cancelar|cancelá|anular|agregar|borrar|quitar|nota|mi nombre|me llamo|no|ayer|antes|el modelo|el cliente)\b/u.test(value))) return undefined;
  const target = match?.[1] ?? value;
  if (!target) return undefined;
  const matches = catalog.filter(item => plain(item.name) === target);
  return matches.length === 1 ? matches[0]!.id : undefined;
}
export function explicitNotes(text: string): string | null | undefined {
  if (/^\s*(?:borrar|quitar)\s+(?:la\s+)?nota[.!]?\s*$/iu.test(text)) return null;
  const match = /^\s*(?:nota|agregar nota|cambiar nota)\s*:\s*([^\u0000]*)$/iu.exec(text);
  return match ? match[1]!.trim() : undefined;
}
export function explicitPreference(text: string, resourceName: string | null): boolean {
  if (resourceName === null) return /^(?:sin preferencia|quitar preferencia)[.!]?$/iu.test(text.trim());
  // Exact expression; a quoted history, resource mentions or model inference are insufficient.
  return plain(text).replace(/[.!]$/, "") === `prefiero ${plain(resourceName)}`;
}
export function expressedBookingPreference(text: string, resourceName: string): boolean {
  const value = plain(text).replace(/[.!]$/, "");
  const expression = `prefiero ${plain(resourceName)}`;
  return value === expression || value.endsWith(`, ${expression}`) || value.endsWith(`; ${expression}`);
}
export function quoteTermsEqual(a: AppointmentTermsSnapshot, b: AppointmentTermsSnapshot): boolean {
  return a.serviceId === b.serviceId && a.resourceId === b.resourceId
    && a.serviceName === b.serviceName && a.resourceName === b.resourceName
    && a.durationMinutes === b.durationMinutes && a.priceArs === b.priceArs;
}
export function argentinaDate(instant: string): string {
  return new Date(Date.parse(instant) - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export function nearbyDate(date: string, offset: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}
export function customerTemporalSelection(text: string, now: string): { date?: string; time?: string } {
  const selected: { date?: string; time?: string } = {};
  const date = /\b([0-9]{4}-[0-9]{2}-[0-9]{2})\b/u.exec(text);
  if (date && parseCalendarDateMs(date[1]) !== undefined) selected.date = date[1]!;
  const value = plain(text);
  if (!selected.date) {
    if (/\bpasado mañana\b/u.test(value)) selected.date = nearbyDate(argentinaDate(now), 2);
    else if (/\bmañana\b/u.test(value)) selected.date = nearbyDate(argentinaDate(now), 1);
    else if (/\bhoy\b/u.test(value)) selected.date = argentinaDate(now);
    else {
      const weekdays = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
      const requested = weekdays.findIndex(day => value.includes(day));
      if (requested >= 0) {
        const today = argentinaDate(now);
        const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
        selected.date = nearbyDate(today, (requested - weekday + 7) % 7);
      }
    }
  }
  const time = /(?:^|\s)([01]?[0-9]|2[0-3]):([0-5][0-9])(?:\s|[.,!]|$)/u.exec(text);
  if (time) selected.time = `${time[1]!.padStart(2, "0")}:${time[2]}`;
  return selected;
}
export function customerSelectedStart(date: string | undefined, time: string | undefined): string | null {
  if (!date || !time || parseCalendarDateMs(date) === undefined || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(time)) return null;
  return `${date}T${time}:00-03:00`;
}
/** A pending dialogue admits bounded answers, not every future customer message.
 * Unrelated text can use the legacy provider without deleting the durable quote.
 * These hints route only; they never authorize names, confirmation or mutations.
 */
export function isAgendaDialogueFollowup(text: string, dialogue: AgendaDialogue): boolean {
  if (dialogue.quote && explicitQuoteConfirmation(text)) return true;
  if (dialogue.quote && dialogue.awaitingNames) {
    if (explicitCustomerNames(text)) return true;
    // Keep malformed short name answers in the deterministic name prompt. Questions,
    // phones and arbitrary prose are not name authority and need not capture the chat.
    if (/^[\p{L}'’-]+(?:\s+[\p{L}'’-]+){1,5}[.!]?$/u.test(text.trim())) return true;
  }
  const awaiting = dialogue.awaiting ?? [];
  if (!awaiting.length && !dialogue.quote) return false;
  const value = plain(text);
  const dateAnswer = /^(?:(?:el|para|para el)\s+)?(?:hoy|mañana|pasado mañana|domingo|lunes|martes|miércoles|jueves|viernes|sábado|[0-9]{4}-[0-9]{2}-[0-9]{2})(?:\s+(?:a las|a la|a)\s+[0-9]{1,2}:[0-9]{2})?[.!]?$/u;
  const timeAnswer = /^(?:(?:a las|a la|a)\s+)?(?:[01]?[0-9]|2[0-3]):[0-5][0-9][.!]?$/u;
  if (dateAnswer.test(value) || timeAnswer.test(value)) return true;
  if (awaiting.includes("appointment") && /^[0-9a-f-]{36}$/iu.test(value)) return true;
  if (awaiting.some(field => field === "service" || field === "resource"))
    return /^[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,3}[.!]?$/u.test(text.trim());
  return false;
}
export function agendaTime(instant: string): string {
  return new Date(Date.parse(instant) - 3 * 60 * 60 * 1000).toISOString().slice(11, 16);
}
export function quoteText(quote: AgendaQuote): string {
  const t = quote.terms;
  return `${quote.kind === "book" ? "Reserva propuesta" : "Cambio propuesto"}: ${t.serviceName}, ${argentinaDate(quote.startsAt)} a las ${agendaTime(quote.startsAt)}, ${t.durationMinutes} minutos, ARS ${t.priceArs}. Respondé «confirmo» para guardar. Todavía no está guardado.`;
}
export function missingFieldText(fields: readonly string[]): string {
  const prompts: Record<string, string> = {
    service: "¿Qué servicio querés?", date: "¿Para qué día?", time: "¿A qué hora?",
    resource: "No reconocí el recurso solicitado. ¿Cuál querés?",
    appointment: "¿Qué turno querés modificar?", names: "Decime tu nombre y apellido.",
    firstName: "Decime tu nombre.", lastName: "Decime tu apellido.",
  };
  return fields.map(field => prompts[field]).filter(Boolean).join(" ");
}
