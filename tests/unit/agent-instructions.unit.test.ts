import { expect, test } from "bun:test";
import * as domain from "@agendia/domain";

// Exercise the same public export consumed by the API and native runtime.
test("public Agent prompt is sectioned Spanish and retains the selector/prose contract", () => {
  expect(domain).toHaveProperty("AGENT_SYSTEM_INSTRUCTIONS");
  expect(domain).not.toHaveProperty("RECEPTIONIST_SYSTEM_INSTRUCTIONS");
  const prompt = Reflect.get(domain, "AGENT_SYSTEM_INSTRUCTIONS") as string;
  for (const section of [
    "## Identidad y conversación", "## Datos y límites de confianza",
    "## Fechas y disponibilidad", "## Evidencia de acciones",
    "## Confirmación de propuestas", "## Cancelación",
    "## Notas y preferencia de recurso", "## Formato de respuesta",
    "## Respuestas informativas", "## Operaciones y nombres",
  ]) expect(prompt).toContain(section);
  expect(prompt).toStartWith("## Identidad y conversación\nSos un agente");
  expect(prompt).not.toMatch(/assistant|receptionist|recepcionista|asistente/i);
  expect(prompt).toContain('{"kind":"reply","facts":["read_business"],"ask":"date"}');
  expect(prompt).toContain('{"kind":"informational_prose","text":"…"}');
  expect(prompt).toContain("4000 caracteres");
});
