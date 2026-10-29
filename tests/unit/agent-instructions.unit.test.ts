import { expect, test } from "bun:test";
import * as domain from "@agendia/domain";

test("appointment duration stays internal unless the customer explicitly asks", () => {
  const prompt = domain.AGENT_SYSTEM_PROMPT;
  const responses = prompt.split("## Respuestas del modelo\n")[1]!.split("## Presentación de propuestas")[0]!;
  expect(responses).toContain("La duración del turno es información interna para organizar la agenda.");
  expect(responses).toContain("No menciones la duración al cliente salvo que la pida explícitamente; en ese caso, respondé con datos reales.");
  expect(prompt).not.toContain("respondé sobre duración o recurso cuando corresponda");
  expect(responses).toContain("cada grupo continuo representa opciones de inicio cada 15 minutos, no el fin de una atención");
  expect(responses).toContain("hasMore indica resultados incompletos");
  expect(responses).toContain("No unas grupos ni infieras horarios intermedios fuera de ellos");
});

// Exercise the same public export consumed by the API and native runtime.
test("public Agent prompt is sectioned Spanish and retains the model-authored contract", () => {
  expect(domain).toHaveProperty("AGENT_SYSTEM_PROMPT");
  expect(domain).not.toHaveProperty("RECEPTIONIST_SYSTEM_INSTRUCTIONS");
  const prompt = Reflect.get(domain, "AGENT_SYSTEM_PROMPT") as string;
  for (const section of [
    "## Identidad y conversación", "## Datos y límites de confianza",
    "## Fechas y disponibilidad", "## Evidencia de acciones",
    "## Confirmación de propuestas", "## Cancelación",
    "## Notas y preferencia de recurso", "## Formato de respuesta",
    "## Respuestas del modelo", "## Presentación de propuestas", "## Operaciones y nombres",
  ]) expect(prompt).toContain(section);
  expect(prompt).toStartWith("## Identidad y conversación\nSos un agente");
  expect(prompt).not.toMatch(/assistant|receptionist|recepcionista|asistente/i);
  expect(prompt).toContain('"text":"…"');
  expect(prompt).toContain("presentedQuoteReference");
  expect(prompt).toContain("4000 caracteres");
  expect(prompt).toContain("Por defecto, no uses emojis");
  expect(prompt).toContain("tono que indique el negocio");
  expect(prompt).toContain("ofrecé opciones relevantes");
  expect(prompt).toContain("preguntas en un mismo mensaje cuando resulte natural");
  expect(prompt).toContain("confirmación breve y natural");
  expect(prompt).toContain("sin repetir todos los detalles ya claros");
  expect(prompt).toContain("servicio y horario sin ambigüedad");
  expect(prompt).toContain("informá el precio solo si el cliente lo pregunta");
  expect(prompt).not.toContain("detallá servicio, recurso, fecha, duración y precio reales");
  expect(prompt).toContain("podés expresarla con palabras naturales");
  expect(prompt).toContain("sin cambiar la fecha, hora ni zona horaria");
  expect(prompt).not.toContain("literalmente presentation.label");
});
