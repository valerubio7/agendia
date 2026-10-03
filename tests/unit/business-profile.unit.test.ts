import { describe, expect, test } from "bun:test";
import { BusinessProfileSchema, InMemoryProfileRepository, ProfileService, serializeProfileForAi } from "../../packages/domain/src/business-profile.ts";

const valid = { displayName: "Estética Bella", description: "Tratamientos faciales", address: "Av. Siempre Viva 123", businessHours: "Lunes a viernes 9–18", offerings: "Limpieza facial" };
const legacy = { contact: "LEGACY_CONTACT", faq: "LEGACY_FAQ", policies: "LEGACY_POLICIES", additionalInfo: "LEGACY_ADDITIONAL_INFO" };

describe("tenant business profile", () => {
  test("stores every allowed field under the authenticated tenant and serializes only allowed context", () => {
    const repository = new InMemoryProfileRepository();
    const service = new ProfileService(repository);
    service.save("tenant-a", { ...valid, businessId: "tenant-b" } as typeof valid & { businessId: string });
    expect(service.get("tenant-a")).toEqual(valid);
    expect(service.get("tenant-b")).toBeNull();
    expect(serializeProfileForAi(service.get("tenant-a")!)).toContain("Estética Bella");
    expect(serializeProfileForAi(service.get("tenant-a")!)).not.toContain("tenant-b");
  });

  test("strips removed fields and excludes legacy runtime properties from AI context", () => {
    expect(BusinessProfileSchema.parse({ ...valid, ...legacy })).toEqual(valid);
    expect(Object.keys(BusinessProfileSchema.shape)).toEqual(Object.keys(valid));
    expect(serializeProfileForAi({ ...valid, ...legacy })).toBe(
      Object.entries(valid).map(([field, value]) => `${field}: ${value}`).join("\n"),
    );
  });

  test("rejects invalid data atomically and keeps business hours informational", () => {
    const repository = new InMemoryProfileRepository();
    const service = new ProfileService(repository);
    service.save("tenant-a", valid);
    expect(() => service.save("tenant-a", { ...valid, description: "x".repeat(4_001) })).toThrow();
    expect(service.get("tenant-a")?.description).toBe("Tratamientos faciales");
    expect(BusinessProfileSchema.parse({ ...valid, businessHours: "Cerrado hoy" }).businessHours).toBe("Cerrado hoy");
  });
});
