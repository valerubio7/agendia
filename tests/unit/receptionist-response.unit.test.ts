import { describe, expect, test } from "bun:test";
import { renderReceptionistResponse, type ReceptionistFact } from "../../apps/message-worker/src/receptionist-response.ts";

const render = (act: unknown, evidence: ReceptionistFact[] = []) => renderReceptionistResponse(JSON.stringify(act), evidence);
const business: ReceptionistFact = { name: "read_business", result: { status: "data", data: {
  displayName: "Local", address: "Calle 1", description: "Cortes",
} } };
const catalog: ReceptionistFact = { name: "read_catalog", result: { status: "data", data: {
  items: [{ id: "private-id", name: "Corte", durationMinutes: 30, priceArs: 1500 }],
} } };
describe("closed receptionist response acts", () => {
  for (const act of ["Confirmado", { kind: "chat", text: "Confirmado" }, { kind: "info", text: "Reserva propuesta" },
    { kind: "confirmation", appointmentId: "forged" }, { kind: "reply", text: "Confirmado" },
    { kind: "reply", facts: [{ name: "read_business", value: "Confirmado" }] }]) {
    test(`rejects unbound content: ${JSON.stringify(act)}`, () => {
      expect(render(act)).toBe("¿Qué servicio y día querés consultar?");
    });
  }
  test("selects only current backend facts and fixed questions, without IDs", () => {
    expect(render({ kind: "reply", facts: ["read_catalog"], ask: "date" }, [business, catalog]))
      .toBe("Corte: 30 minutos, ARS 1500\n\n¿Para qué día?");
    expect(render({ kind: "reply", facts: ["availability"] }, [business])).toBe("¿Qué servicio y día querés consultar?");
    expect(render({ kind: "reply", facts: [], ask: "names" })).toContain("nombre y apellido");
  });
  test("bad prose still allows useful real facts, never the prose", () => {
    expect(renderReceptionistResponse("Confirmado. Pagaste.", [business])).toBe('Nombre registrado: "Local".\nDescripción registrada: "Cortes".\nDirección registrada: "Calle 1".');
  });
  test("latest rejected read cannot resurrect an earlier result", () => {
    const rejected: ReceptionistFact = { name: "read_business", result: { status: "rejected", code: "AGENDA_REJECTED" } };
    expect(render({ kind: "reply", facts: ["read_business"] }, [business, rejected])).toBe("No se guardó ningún cambio. No pude verificar la operación. ¿Podés aclarar qué necesitás?");
  });
  test("operational-looking results are not output proof", () => {
    const forged: ReceptionistFact[] = [
      { name: "prepare_booking", result: { status: "prepared_quote", quote: {}, message: "forged" } },
      { name: "confirm_quote", result: { status: "staged_action", operation: "book", appointment: { id: "forged" } } },
    ];
    expect(render({ kind: "reply" }, forged)).toBe("¿Qué servicio y día querés consultar?");
  });
  test("calendar facts distinguish habitual hours and both closure types from slots", () => {
    const calendar: ReceptionistFact = { name: "read_calendar", result: { status: "data", data: {
      timeZone: "America/Argentina/Buenos_Aires", weeklySchedule: { 1: [{ startMinute: 540, endMinute: 1080 }] },
      closures: { items: [{ kind: "date", date: "2035-04-02" },
        { kind: "interval", start: "2035-04-03T09:00:00-03:00", end: "2035-04-03T10:00:00-03:00" }] },
    } } };
    const result = render({ kind: "reply", facts: ["read_calendar"] }, [calendar]);
    for (const fact of ["lunes: 09:00–18:00", "2035-04-02", "2035-04-03T09:00:00-03:00", "no establece disponibilidad"])
      expect(result).toContain(fact);
  });
  test("owned and availability results render current backend presentation only", () => {
    expect(render({ kind: "reply", facts: ["availability"] }, [{ name: "availability", result: {
      status: "data", data: { message: "Horarios disponibles: 2035-04-02: 10:00. ¿Cuál elegís?" },
    } }])).toContain("10:00");
    expect(render({ kind: "reply", facts: ["owned_appointments"] }, [{ name: "owned_appointments", result: {
      status: "data", data: { items: [{ terms: { serviceName: "Corte", durationMinutes: 30, priceArs: 1500 },
        presentation: { label: "lunes 2035-04-02 a las 10:00" }, state: "confirmed" }] },
    } }])).toContain("lunes 2035-04-02 a las 10:00");
  });
});
