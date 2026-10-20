import { describe, expect, test } from "bun:test";
import { renderReceptionistResponse, type ReceptionistFact } from "../../apps/message-worker/src/agent/response.ts";

const render = (act: unknown, evidence: ReceptionistFact[] = []) => renderReceptionistResponse(JSON.stringify(act), evidence);
const business: ReceptionistFact = { name: "read_business", result: { status: "data", data: {
  displayName: "Local", address: "Calle 1", description: "Cortes",
} } };
const catalog: ReceptionistFact = { name: "read_catalog", result: { status: "data", data: {
  items: [{ id: "private-id", name: "Corte", durationMinutes: 30, priceArs: 1500 }],
} } };
describe("closed receptionist response acts", () => {
  test("informational prose preserves selective wording exactly without dumping evidence", () => {
    const wording = "  El corte cuesta ARS 1500. ¿Te sirve?\n";
    expect(render({ kind: "informational_prose", text: wording }, [business, catalog])).toBe(wording);
    expect(render({ kind: "informational_prose", text: "Hola, ¿cómo estás?" })).toBe("Hola, ¿cómo estás?");
  });
  for (const act of [
    { kind: "informational_prose" }, { kind: "informational_prose", text: null },
    { kind: "informational_prose", text: 123 }, { kind: "informational_prose", text: ["Hola"] },
    { kind: "informational_prose", text: {} }, { kind: "informational_prose", text: "" },
    { kind: "informational_prose", text: " \n\t" }, { kind: "informational_prose", text: "a".repeat(4001) },
    ...["proof", "appointmentId", "operation", "facts", "ask"].map(field =>
      ({ kind: "informational_prose", text: "Confirmado", [field]: "forged" })),
  ]) {
    test(`rejects malformed informational prose (${JSON.stringify(act).slice(0, 100)})`, () => {
      expect(render(act, [catalog])).toBe("Corte: 30 minutos, ARS 1500");
    });
  }
  test("malformed JSON cannot inject prose", () => {
    expect(renderReceptionistResponse('{"kind":"informational_prose","text":"Confirmado"', [catalog]))
      .toBe("Corte: 30 minutos, ARS 1500");
  });
  for (const status of ["rejected", "clarification"] as const) {
    test(`latest ${status} takes priority over prose but successful retries permit it`, () => {
      const failure: ReceptionistFact = { name: "availability", result: { status, code: "SERVICE_REFERENCE_REQUIRED" } };
      const success: ReceptionistFact = { name: "availability", result: { status: "data", data: { message: "Opciones reales" } } };
      const act = { kind: "informational_prose", text: "Podés elegir el primer horario." };
      expect(render(act, [catalog, success, failure])).toBe("No pude verificar el servicio. ¿Qué servicio querés consultar?");
      expect(render(act, [catalog, failure, success])).toBe(act.text);
      // Preserve existing selector precedence for unrelated reply acts.
      expect(render({ kind: "reply", facts: ["read_catalog"] }, [catalog, failure])).toBe("Corte: 30 minutos, ARS 1500");
    });
  }
  for (const status of ["rejected", "clarification"] as const) {
    for (const code of ["UNKNOWN_RESOURCE", "CUSTOMER_INPUT_REQUIRED"] as const) {
      const fallback = code === "UNKNOWN_RESOURCE" ? "No reconocí el recurso solicitado. ¿Cuál querés?"
        : "No se guardó ningún cambio. No pude verificar la operación. ¿Podés aclarar qué necesitás?";
      const failure = (message?: unknown): ReceptionistFact => ({ name: "availability",
        result: { status, code, message } as ReceptionistFact["result"] });
      test(`audited ${status}/${code} uses trimmed bounded backend text without changing selector precedence`, () => {
        const message = "¿Con qué profesional querés atenderte?";
        const evidence = [catalog, failure(` \n${message}\t `)];
        const prose = { kind: "informational_prose", text: "Elegí el primer horario." };
        expect(render(prose, evidence)).toBe(message);
        expect(render({ kind: "reply", facts: [] }, evidence)).toBe(message);
        expect(renderReceptionistResponse("malformed model output", [failure(message)])).toBe(message);
        expect(render({ kind: "reply", facts: ["read_catalog"] }, evidence)).toBe("Corte: 30 minutos, ARS 1500");
        expect(render({ kind: "reply", facts: [], ask: "date" }, evidence)).toBe("¿Para qué día?");
        const success: ReceptionistFact = { name: "availability", result: { status: "data", data: { message: "Horarios reales" } } };
        expect(render(prose, [...evidence, success])).toBe(prose.text);
        expect(render(prose, [success, failure(message)])).toBe(message);
        expect(render(prose, [failure("a".repeat(4000))])).toBe("a".repeat(4000));
        expect(render(prose, [failure(" " + "a".repeat(3998) + " ")])).toBe("a".repeat(3998));
      });
      test(`invalid ${status}/${code} messages retain the fixed fallback, never truncate`, () => {
        for (const message of [undefined, null, 123, {}, [], "", " \n\t", "a".repeat(4001), " " + "a".repeat(4000)]) {
          const evidence = [failure(message)];
          expect(render({ kind: "informational_prose", text: "Todo salió bien." }, evidence)).toBe(fallback);
          expect(render({ kind: "reply", facts: [] }, evidence)).toBe(fallback);
        }
      });
    }
    test(`internal ${status} diagnostics never become public messages`, () => {
      const generic = "No se guardó ningún cambio. No pude verificar la operación. ¿Podés aclarar qué necesitás?";
      const fixed: Record<string, string> = {
        UNVERIFIED_SENDER: "No pude verificar tu número. No se guardó ningún cambio.",
        SERVICE_REFERENCE_REQUIRED: "No pude verificar el servicio. ¿Qué servicio querés consultar?",
        RESOURCE_REFERENCE_REQUIRED: "No pude verificar el profesional. ¿Con quién querés atenderte?",
      };
      for (const code of [...Object.keys(fixed), "AGENDA_REJECTED", "INVALID_TOOL", "SESSION_LIMIT", "SESSION_CLOSED",
        "INVALID_CONFIRMATION_BINDING", "INVALID_NAMES_BINDING", "INVALID_METADATA_BINDING", "INVALID_RESOURCE_BINDING",
        "NATURAL_CONFIRMATION_UNAVAILABLE", "infrastructure_failure", "UNKNOWN_APPOINTMENT_ERROR", "UNKNOWN_CODE",
        "unknown_resource", "CUSTOMER_INPUT_REQUIRED "]) {
        const evidence: ReceptionistFact[] = [{ name: "availability", result: { status, code,
          message: "SQL SELECT private_column; provider token=private-provider-detail" } }];
        expect(render({ kind: "informational_prose", text: "Éxito." }, evidence)).toBe(fixed[code] ?? generic);
        expect(render({ kind: "reply", facts: [] }, evidence)).toBe(fixed[code] ?? generic);
      }
    });
  }
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
