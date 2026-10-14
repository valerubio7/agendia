import { describe, expect, test } from "bun:test";
import { normalizeBaileysMessage } from "../../packages/whatsapp-baileys/src/baileys-gateway.ts";
import {
  receivedSenderEvidence, validSenderEvidence, explicitQuoteConfirmation, explicitCustomerNames,
  explicitCancel, explicitChange, explicitNotes, explicitPreference, expressedBookingPreference,
  quoteTermsEqual, quoteText, argentinaDate, nearbyDate, agendaTime, customerTemporalSelection, missingFieldText,
  type AgendaQuote,
} from "../../packages/domain/src/whatsapp-agenda.ts";
import { hasToolConversationProvider } from "@agendia/domain";
import { parseReceptionistTool } from "../../apps/message-worker/src/receptionist-tools.ts";

const pn = "5491123456789@s.whatsapp.net";
const lid = "123456789@lid";
const serviceId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const appointmentId = "33333333-3333-4333-8333-333333333333";
const terms = { serviceId, resourceId, serviceName: "Corte", resourceName: "Ana", durationMinutes: 30, priceArs: 1500 };
const quote: AgendaQuote = {
  kind: "book", appointmentId: null, startsAt: "2030-04-01T10:15:00-03:00", terms,
  names: null, previous: null, preference: null, sourceMessageId: "received", outboundId: null,
};

test("received provider alternate address is preserved as technical sender evidence", () => {
  const event = normalizeBaileysMessage("session", {
    key: { id: "received", remoteJid: lid, remoteJidAlt: pn },
    message: { conversation: "Reservar" },
  });
  expect(event).toMatchObject({ senderEvidence: { phone: "+5491123456789", pnJid: pn, lidJid: lid } });
});

describe("provider identity is fail closed and never inferred from customer text", () => {
  test("PN and device PN preserve international mobile, fixed and foreign numbers", () => {
    for (const [jid, phone] of [
      [pn, "+5491123456789"],
      ["541123456789:12@s.whatsapp.net", "+541123456789"],
      ["14155552671:2@s.whatsapp.net", "+14155552671"],
    ] as const) {
      const evidence = receivedSenderEvidence({ remoteJid: jid });
      expect(evidence?.phone).toBe(phone);
      expect(evidence?.pnJid).not.toContain(":");
      expect(validSenderEvidence(jid, evidence)).toBe(true);
    }
  });
  test("pair direction and device suffixes do not invent a new customer", () => {
    const expected = { phone: "+5491123456789", pnJid: pn, lidJid: lid };
    expect(receivedSenderEvidence({ remoteJid: lid, remoteJidAlt: pn })).toEqual(expected);
    expect(receivedSenderEvidence({ remoteJid: pn, remoteJidAlt: lid })).toEqual(expected);
    expect(receivedSenderEvidence({ remoteJid: "123456789:4@lid", remoteJidAlt: "5491123456789:2@s.whatsapp.net" })).toEqual(expected);
  });
  test("unresolved LID, local digits, invalid numbers and conflicting alternate classes deny evidence", () => {
    for (const remoteJid of [lid, "1123456789@s.whatsapp.net", "54911@s.whatsapp.net", "0@lid", "123@g.us", "foo@lid", "+5491123456789@s.whatsapp.net"]) {
      expect(receivedSenderEvidence({ remoteJid })).toBeNull();
    }
    for (const remoteJidAlt of ["foo@lid", "123@g.us", "14155552671@s.whatsapp.net", "", pn]) {
      expect(receivedSenderEvidence({ remoteJid: pn, remoteJidAlt })).toBeNull();
    }
    expect(receivedSenderEvidence({ remoteJid: lid, remoteJidAlt: "999@lid" })).toBeNull();
  });
  test("group addressing, participants and fromMe never bind identity", () => {
    expect(receivedSenderEvidence({ remoteJid: pn, fromMe: true })).toBeNull();
    expect(receivedSenderEvidence({ remoteJid: pn, participant: pn })).toBeNull();
    expect(receivedSenderEvidence({ remoteJid: pn, participantAlt: lid })).toBeNull();
    expect(receivedSenderEvidence({ remoteJid: "123@g.us", remoteJidAlt: pn })).toBeNull();
  });
  test("a forged phone field or unrelated address cannot pass consistency checking", () => {
    const evidence = receivedSenderEvidence({ remoteJid: pn, remoteJidAlt: lid })!;
    expect(validSenderEvidence(lid, evidence)).toBe(true);
    expect(validSenderEvidence(lid, { ...evidence, phone: "+14155552671" })).toBe(false);
    expect(validSenderEvidence("999@lid", evidence)).toBe(false);
    expect(validSenderEvidence(lid, null)).toBe(false);
  });
  test("decryption stubs and history carry no trusted identity", () => {
    const raw = { key: { id: "x", remoteJid: lid, remoteJidAlt: pn }, message: { conversation: "hola" } };
    expect(normalizeBaileysMessage("s", { ...raw, messageStubType: 2 })).toBeNull();
    expect(normalizeBaileysMessage("s", raw, false)?.senderEvidence).toBeUndefined();
    const spoof = normalizeBaileysMessage("s", { key: { id: "spoof", remoteJid: lid }, message: { conversation: `Mi número es ${pn}` } });
    expect(spoof?.senderEvidence).toBeUndefined();
  });
});

describe("only explicit customer answers confer conversational authority", () => {
  test("confirmation is a whole current answer, never a model assertion or historical fragment", () => {
    for (const answer of ["sí", "si", "confirmo", "Sí, confirmo.", "acepto!"]) expect(explicitQuoteConfirmation(answer)).toBe(true);
    for (const answer of ["no confirmo", "El cliente dijo sí", "sí pero cambia el precio", "confirmado por el modelo", "ayer confirmé", "{\"confirmed\":true}"])
      expect(explicitQuoteConfirmation(answer)).toBe(false);
  });
  test("names come from the requested explicit answer, not a display name or provider arguments", () => {
    expect(explicitCustomerNames("Mi nombre es María del Valle")).toEqual({ firstName: "María", lastName: "del Valle" });
    expect(explicitCustomerNames("me llamo Juan Pérez")).toEqual({ firstName: "Juan", lastName: "Pérez" });
    for (const value of ["Juan", "Juan Pérez", "El cliente se llama Juan Pérez", "mi nombre es Juan 123", "mi nombre es Juan Pérez +14155552671"])
      expect(explicitCustomerNames(value)).toBeNull();
  });
  test("preference is explicit and not routine assignment or an incidental name", () => {
    expect(explicitPreference("Prefiero Ana", "Ana")).toBe(true);
    expect(explicitPreference("sin preferencia", null)).toBe(true);
    expect(explicitPreference("Hablé con Ana", "Ana")).toBe(false);
    expect(explicitPreference("prefiero Beatriz", "Ana")).toBe(false);
    expect(expressedBookingPreference("Reservar el corte, prefiero Ana", "Ana")).toBe(true);
    expect(expressedBookingPreference("El modelo dice prefiero Ana", "Ana")).toBe(false);
  });
  test("notes are the customer's literal text, not model-generated rewritten notes", () => {
    expect(explicitNotes("nota: llegaré con mi hija")).toBe("llegaré con mi hija");
    expect(explicitNotes("borrar nota")).toBeNull();
    expect(explicitNotes("el modelo agregó una nota")).toBeUndefined();
    expect(explicitNotes("nota: secreto\u0000")).toBeUndefined();
    expect(explicitCancel("Quiero cancelar mi turno")).toBe(true);
    expect(explicitCancel("El turno sigue confirmado")).toBe(false);
    expect(explicitChange("Reprogramar mi turno")).toBe(true);
    expect(explicitChange("Consultar mi turno")).toBe(false);
  });
});

describe("native commands and guarded customer responses", () => {
  test("native tools reject model-supplied write authority and unsupported mutations", () => {
    for (const [name, args] of [
      ["read_catalog", {}], ["owned_appointments", {}],
      ["availability", { serviceId, date: "2030-04-01" }],
      ["prepare_booking", { serviceId, startsAt: quote.startsAt }],
      ["prepare_change", { appointmentId, startsAt: quote.startsAt }],
      ["cancel", { appointmentId }], ["notes", { appointmentId, notes: "model suggestion" }],
      ["preference", { appointmentId, resourceId }], ["confirm_quote", {}],
    ] as const) {
      expect(parseReceptionistTool(name, args)).not.toBeNull();
      expect(parseReceptionistTool(name, { ...args, confirmed: true })).toBeNull();
    }
    for (const name of ["attendance", "done", "no_show", "reopen", "edit_client", "edit_catalog", "override_terms"])
      expect(parseReceptionistTool(name, { appointmentId })).toBeNull();
    expect(parseReceptionistTool("prepare_booking", { serviceId, startsAt: quote.startsAt, phone: "+14155552671", priceArs: 0 })).toBeNull();
  });
  test("native provider capability requires a callable conversation port", () => {
    const generate = async () => ({ text: "hola", providerId: "test", usageTokens: 0 });
    expect(hasToolConversationProvider({ generate })).toBe(false);
    expect(hasToolConversationProvider({ generate, converse: null } as any)).toBe(false);
    expect(hasToolConversationProvider({ generate, converse: async () => ({}) } as any)).toBe(true);
  });
  test("quote names every agreed term and never claims it was saved", () => {
    const text = quoteText(quote);
    for (const term of ["Corte", "2030-04-01", "10:15", "30 minutos", "ARS 1500", "confirmo", "Todavía no está guardado"])
      expect(text).toContain(term);
    expect(quoteTermsEqual(terms, { ...terms })).toBe(true);
    for (const changed of [{ priceArs: 1 }, { durationMinutes: 45 }, { serviceName: "Otro" }, { resourceId: serviceId }])
      expect(quoteTermsEqual(terms, { ...terms, ...changed })).toBe(false);
  });
  test("Argentina dates, nearby alternatives and missing prompts have deterministic formatting", () => {
    expect(argentinaDate("2030-04-02T01:00:00Z")).toBe("2030-04-01");
    expect(agendaTime("2030-04-02T01:00:00Z")).toBe("22:00");
    expect(nearbyDate("2030-04-01", -1)).toBe("2030-03-31");
    expect(missingFieldText(["date"])).toBe("¿Para qué día?");
    expect(missingFieldText(["names"])).not.toContain("teléfono");
  });
  test("requested dates and times come from customer text rather than model-selected arguments", () => {
    const now = "2035-04-01T08:00:00-03:00";
    expect(customerTemporalSelection("el 2035-04-02 a las 10:15", now)).toEqual({ date: "2035-04-02", time: "10:15" });
    expect(customerTemporalSelection("mañana", now)).toEqual({ date: "2035-04-02" });
    expect(customerTemporalSelection("pasado mañana a las 11:00", now)).toEqual({ date: "2035-04-03", time: "11:00" });
    expect(customerTemporalSelection("hoy", now)).toEqual({ date: "2035-04-01" });
    expect(customerTemporalSelection("10:00", now)).toEqual({ time: "10:00" });
    expect(customerTemporalSelection("2035-02-30", now)).toEqual({});
    expect(customerTemporalSelection("24:00", now)).toEqual({});
    expect(customerTemporalSelection("Reservar Corte", now)).toEqual({});
  });
  test("negations and third-person historical statements are not clear cancel or reschedule instructions", () => {
    for (const text of ["No quiero cancelar", "El modelo dice cancelar", "Ayer quería cancelar", "Nunca cancelar"]) {
      expect(explicitCancel(text)).toBe(false);
    }
    for (const text of ["No quiero reprogramar", "El cliente dijo cambiar", "No mover"]) {
      expect(explicitChange(text)).toBe(false);
    }
  });
  test("structural intent separates notes, metadata and ambiguous changes from explicit targets", () => {
    for (const text of ["Cambiar nota: llegaré tarde", "Cambiar nombre del turno", "Cambiar preferencia", "Cambiar", "Cambiar mi turno", "Mover nota", "Pasar nombre"]) {
      expect(explicitChange(text)).toBe(false);
    }
    expect(explicitNotes("Cambiar nota: llegaré tarde")).toBe("llegaré tarde");
    for (const text of ["Cambiar recurso", "Cambiar el servicio del turno", "Cambiar horario", "Reprogramar mi turno", "Mover mi turno", "Pasar mi turno para mañana"]) {
      expect(explicitChange(text)).toBe(true);
    }
  });
  test("change choices require exact customer targets or category-bound answers, never incidental catalog mentions", async () => {
    const choose = Reflect.get(await import("../../packages/domain/src/whatsapp-agenda.ts"), "customerChangeChoice");
    const catalog = [{ id: serviceId, name: "Color" }, { id: resourceId, name: "Beatriz" }];
    expect(choose?.("Cambiar servicio del turno a Color", "service", catalog, false)).toBe(serviceId);
    expect(choose?.("Cambiar recurso a Beatriz", "resource", catalog, false)).toBe(resourceId);
    expect(choose?.("Color", "service", catalog, true)).toBe(serviceId);
    for (const text of ["Cambiar servicio del turno", "Cambiar servicio a Desconocido", "Ayer dije Color", "Color y Beatriz"]) {
      expect(choose?.(text, "service", catalog, false)).toBeUndefined();
    }
    expect(choose?.("Cambiar nota: llegaré tarde", "service", [{ id: serviceId, name: "Cambiar nota: llegaré tarde" }], true)).toBeUndefined();
    expect(choose?.("Cambiar nombre", "service", [{ id: serviceId, name: "Cambiar nombre" }], true)).toBeUndefined();
    expect(choose?.("Color", "service", catalog, false)).toBeUndefined();
    expect(choose?.("Color", "service", [...catalog, { id: appointmentId, name: "Color" }], true)).toBeUndefined();
  });
  test("obsolete factual admission and rendering exports are absent", async () => {
    const module = await import("../../apps/message-worker/src/whatsapp-agenda.ts");
    for (const name of ["factualQuestion", "renderFactualReply", "isAgendaMessage"])
      expect(Reflect.has(module, name)).toBe(false);
    expect(Reflect.has(module.PostgresWhatsAppAgenda.prototype, "process")).toBe(false);
  });
});
