import { describe, expect, test } from "bun:test";
import { BusinessProfileSchema, InMemoryProfileRepository, ProfileService, serializeProfileForAi } from "../../packages/domain/src/business-profile.ts";

const valid = { displayName: "Estética Bella", description: "Tratamientos faciales", address: "Av. Siempre Viva 123", contact: "+54 11 5555 5555", businessHours: "Lunes a viernes 9–18", offerings: "Limpieza facial", faq: "Turnos con reserva", policies: "24 h de anticipación", additionalInfo: "Acceso por escalera" };

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

  test("rejects invalid data atomically and keeps business hours informational", () => {
    const repository = new InMemoryProfileRepository();
    const service = new ProfileService(repository);
    service.save("tenant-a", valid);
    expect(() => service.save("tenant-a", { ...valid, description: "x".repeat(4_001) })).toThrow();
    expect(service.get("tenant-a")?.description).toBe("Tratamientos faciales");
    expect(BusinessProfileSchema.parse({ ...valid, businessHours: "Cerrado hoy" }).businessHours).toBe("Cerrado hoy");
  });
});
