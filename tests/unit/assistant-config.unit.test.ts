import { describe, expect, test } from "bun:test";
import { AssistantConfigService, InMemoryAssistantRepository, isAutomationEligible } from "../../packages/domain/src/assistant-config.ts";

describe("assistant configuration and activation", () => {
  test("activates a schema-valid minimal configuration without completeness rules", () => {
    const service = new AssistantConfigService(new InMemoryAssistantRepository());
    const saved = service.save("tenant-a", { personality: "", tone: "", instructions: "", knowledge: "", rules: "", restrictions: "", active: true, expectedRevision: 0 });
    expect(saved).toMatchObject({ active: true, revision: 1 });
    expect(service.get("tenant-b")).toBeNull();
  });

  test("uses optimistic revision and leaves prior state intact on conflict", () => {
    const service = new AssistantConfigService(new InMemoryAssistantRepository());
    service.save("tenant-a", { personality: "Amable", tone: "Breve", instructions: "Ayudar", knowledge: "Servicios", rules: "No inventar", restrictions: "Sin secretos", active: false, expectedRevision: 0 });
    expect(() => service.save("tenant-a", { personality: "Otra", tone: "", instructions: "", knowledge: "", rules: "", restrictions: "", active: true, expectedRevision: 0 })).toThrow("Revision conflict");
    expect(service.get("tenant-a")?.personality).toBe("Amable");
  });

  test("requires active tenant, active assistant and connected session but ignores business hours", () => {
    expect(isAutomationEligible({ businessStatus: "active", assistantActive: true, whatsappStatus: "connected", withinBusinessHours: false })).toBe(true);
    expect(isAutomationEligible({ businessStatus: "suspended", assistantActive: true, whatsappStatus: "connected", withinBusinessHours: true })).toBe(false);
    expect(isAutomationEligible({ businessStatus: "active", assistantActive: false, whatsappStatus: "connected", withinBusinessHours: true })).toBe(false);
  });
});
