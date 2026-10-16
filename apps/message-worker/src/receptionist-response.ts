import { z } from "zod";
import type { ReceptionistToolCommand, ReceptionistToolResult } from "./receptionist-tools.ts";

const factNames = ["read_business", "read_catalog", "read_resources", "read_calendar", "availability",
  "owned_appointments", "owned_appointment"] as const;
const questions = {
  service: "¿Qué servicio querés?", date: "¿Para qué día?", time: "¿Qué horario elegís?",
  resource: "¿Con qué profesional querés atenderte?", names: "Decime tu nombre y apellido: «mi nombre es Nombre Apellido».",
  change: "¿Qué querés cambiar de tu turno?", clarify: "¿Podés aclarar qué necesitás?",
  booking: "¿Querés reservar? Decime el servicio, día y horario.", greeting: "Hola, ¿en qué puedo ayudarte?",
  start: "¿Qué servicio y día querés consultar?",
} as const;
const response = z.discriminatedUnion("kind", [z.object({
  kind: z.literal("reply"),
  facts: z.array(z.enum(factNames)).max(7).optional(),
  ask: z.enum(["service", "date", "time", "resource", "names", "change", "clarify", "start", "booking", "greeting"]).optional(),
  businessFields: z.array(z.enum(["displayName", "description", "address"])).max(3).optional(),
}).strict(), z.object({
  kind: z.literal("informational_prose"),
  text: z.string().min(1).max(4000).refine(value => Boolean(value.trim())),
}).strict()]);
export interface ReceptionistFact {
  name: ReceptionistToolCommand["name"];
  result: ReceptionistToolResult;
}
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
const items = (value: unknown): RecordValue[] => Array.isArray(record(value).items)
  ? (record(value).items as unknown[]).map(record) : [];
const label = (value: RecordValue) => text(record(value.presentation).label);
const terms = (value: RecordValue) => `${text(value.serviceName)}, ${numeric(value.durationMinutes)} minutos, ARS ${numeric(value.priceArs)}`;

// Selector facts display only repository/tool-owned fields, never opaque bindings
// or arbitrary object serialization.
function renderFact({ name, result }: ReceptionistFact, businessFields = ["displayName", "description", "address"]): string {
  if (result.status === "unavailable_data") return "Ese dato no está registrado en el negocio.";
  if (result.status !== "data") return "";
  const data = record(result.data);
  switch (name) {
    case "read_business": {
      const labels: Record<string, string> = {
        displayName: "Nombre registrado", description: "Descripción registrada", address: "Dirección registrada",
      };
      return businessFields.map(field => {
        if (data[field]) return `${labels[field]}: ${JSON.stringify(text(data[field]))}.`;
        return field === "address" ? "No hay dirección registrada."
          : field === "description" ? "No hay descripción registrada." : "No hay nombre registrado.";
      }).join("\n");
    }
    case "read_catalog":
      return items(data).map(item => `${text(item.name)}: ${numeric(item.durationMinutes)} minutos, ARS ${numeric(item.priceArs)}`
        + (item.description ? `. ${text(item.description)}` : "")).join("\n") || "No hay servicios activos registrados.";
    case "read_resources":
      return items(data).map(item => text(item.name)).filter(Boolean).join(", ") || "No hay profesionales activos registrados.";
    case "availability": return text(data.message);
    case "read_calendar": {
      const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
      const clock = (minute: unknown) => typeof minute === "number" && Number.isInteger(minute) && minute >= 0 && minute <= 1440
        ? `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}` : "—";
      const schedule = record(data.weeklySchedule);
      const hours = days.flatMap((day, index) => {
        if (!Array.isArray(schedule[index])) return [];
        const ranges = (schedule[index] as unknown[]).map(record)
          .map(range => `${clock(range.startMinute)}–${clock(range.endMinute)}`);
        return [`${day}: ${ranges.join(", ") || "cerrado"}`];
      });
      const closures = items(data.closures).map(item => item.kind === "interval"
        ? `${text(item.start)} – ${text(item.end)}` : text(item.date)).filter(Boolean);
      if (!hours.length) return "No hay horarios habituales registrados.";
      return `Horarios habituales (${text(data.timeZone)}): ${hours.join("; ")}.`
        + (closures.length ? ` Cierres: ${closures.join(", ")}.` : "")
        + " Esto no establece disponibilidad de turnos.";
    }
    case "owned_appointments":
    case "owned_appointment": {
      const appointments = name === "owned_appointments" ? items(data) : [data];
      return appointments.map(item => `Turno registrado: ${terms(record(item.terms))}, ${label(item)}, estado: ${text(item.state)}.`)
        .join("\n") || "No tenés turnos registrados.";
    }
    default: return "";
  }
}

/** This receives only transaction-local tool evidence, never model proof objects.
 * The prose schema validates shape, not factual truth or operation authority. */
export function renderReceptionistResponse(raw: string, evidence: readonly ReceptionistFact[]): string {
  let act: z.infer<typeof response> | undefined;
  try { act = response.parse(JSON.parse(raw)); } catch { /* Closed contract: discard all unbound content. */ }
  const last = evidence.at(-1)?.result;
  const failure = last && (last.status === "rejected" || last.status === "clarification")
    // Only audited public backend messages may replace fixed diagnostic responses.
    ? (last.code === "UNKNOWN_RESOURCE" || last.code === "CUSTOMER_INPUT_REQUIRED")
      && typeof last.message === "string" && last.message.length <= 4000 && last.message.trim()
      ? last.message.trim()
      : last.code === "UNVERIFIED_SENDER" ? "No pude verificar tu número. No se guardó ningún cambio."
      : last.code === "UNKNOWN_RESOURCE" ? "No reconocí el recurso solicitado. ¿Cuál querés?"
      : last.code === "SERVICE_REFERENCE_REQUIRED" ? "No pude verificar el servicio. ¿Qué servicio querés consultar?"
      : last.code === "RESOURCE_REFERENCE_REQUIRED" ? "No pude verificar el profesional. ¿Con quién querés atenderte?"
      : "No se guardó ningún cambio. No pude verificar la operación. ¿Podés aclarar qué necesitás?" : "";
  if (act?.kind === "informational_prose") return failure || act.text;
  const latest = new Map(evidence.filter(item => factNames.includes(item.name as typeof factNames[number]))
    .map(item => [item.name, item]));
  const selected = act?.facts ?? [...latest.keys()];
  const facts = [...new Set(selected)].map(name => latest.get(name)).filter((item): item is ReceptionistFact => Boolean(item))
    .map(item => renderFact(item, act?.businessFields)).filter(Boolean);
  const question = act?.ask ? questions[act.ask] : "";
  return [...facts, question].filter(Boolean).join("\n\n") || failure || questions.start;
}
