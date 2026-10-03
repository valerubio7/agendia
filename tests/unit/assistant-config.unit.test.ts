import { describe, expect, test } from "bun:test";
import { AssistantConfigService, InMemoryAssistantRepository, isAutomationEligible } from "../../packages/domain/src/assistant-config.ts";

// Headed legacy sections use "Label:\ntext", separated by two newlines.
const styleLimit = 32_000 + "Personalidad:\n".length + "Tono:\n".length + 2;
const businessLimit = 64_000 + ["Instrucciones", "Conocimiento", "Reglas", "Restricciones"].reduce((n, label) => n + label.length + 2, 0) + 6;
const empty = { style: "", businessInstructions: "", active: true, expectedRevision: 0 };

describe("assistant configuration and activation", () => {
  test("activates a schema-valid minimal configuration without completeness rules", () => {
    const service = new AssistantConfigService(new InMemoryAssistantRepository());
    expect(service.save("tenant-a", empty)).toMatchObject({ style: "", businessInstructions: "", active: true, revision: 1 });
    expect(service.get("tenant-b")).toBeNull();
  });

  test("uses optimistic revision and leaves prior state intact on conflict", () => {
    const service = new AssistantConfigService(new InMemoryAssistantRepository());
    service.save("tenant-a", { ...empty, style: "Amable" });
    expect(() => service.save("tenant-a", { ...empty, style: "Otra" })).toThrow("Revision conflict");
    expect(service.get("tenant-a")?.style).toBe("Amable");
  });

  test("preserves whitespace and maximum Unicode headed content without truncation", () => {
    const service = new AssistantConfigService(new InMemoryAssistantRepository());
    const text = "😀".repeat(8_000);
    const style = `Personalidad:\n${text}\n\nTono:\n${text}`;
    const businessInstructions = ["Instrucciones", "Conocimiento", "Reglas", "Restricciones"].map(label => `${label}:\n${text}`).join("\n\n");
    expect(style.length).toBe(styleLimit);
    expect(businessInstructions.length).toBe(businessLimit);
    expect(service.save("tenant-a", { ...empty, style, businessInstructions })).toMatchObject({ style, businessInstructions });
    expect(service.save("tenant-b", { ...empty, style: " \n\t ", businessInstructions: "\n " })).toMatchObject({ style: " \n\t ", businessInstructions: "\n " });
    for (const fields of [{ style: style + "x", businessInstructions }, { style, businessInstructions: businessInstructions + "x" }]) {
      expect(() => service.save("tenant-c", { ...empty, ...fields })).toThrow();
    }
    expect(service.get("tenant-c")).toBeNull();
  });

  test("rejects legacy and incomplete bodies without mutating saved content", () => {
    const service = new AssistantConfigService(new InMemoryAssistantRepository());
    const saved = service.save("tenant-a", { ...empty, style: "Keep me" });
    for (const body of [
      { personality: "old", tone: "", instructions: "", knowledge: "", rules: "", restrictions: "", active: true, expectedRevision: 1 },
      { style: "replacement", active: true, expectedRevision: 1 },
    ]) expect(() => service.save("tenant-a", body)).toThrow();
    expect(service.get("tenant-a")).toEqual(saved);
  });

  test("requires active tenant, active assistant and connected session but ignores business hours", () => {
    expect(isAutomationEligible({ businessStatus: "active", assistantActive: true, whatsappStatus: "connected", withinBusinessHours: false })).toBe(true);
    expect(isAutomationEligible({ businessStatus: "suspended", assistantActive: true, whatsappStatus: "connected", withinBusinessHours: true })).toBe(false);
    expect(isAutomationEligible({ businessStatus: "active", assistantActive: false, whatsappStatus: "connected", withinBusinessHours: true })).toBe(false);
  });
});
