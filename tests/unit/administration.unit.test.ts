import { describe, expect, test } from "bun:test";
import { AuthService, InMemoryAuthStore } from "../../packages/auth/src/index.ts";
import { AdministrationService, InMemoryAdministrationStore } from "../../packages/domain/src/administration.ts";

describe("business administration", () => {
  test("creates a business and its single user with atomic audit/outbox", async () => {
    const authStore = new InMemoryAuthStore();
    const store = new InMemoryAdministrationStore();
    const service = new AdministrationService(store, new AuthService(authStore));
    const business = await service.createBusiness({ name: "Estética Bella", userEmail: "bella@example.com", initialPassword: "correct horse battery staple", requestId: "req-1" });
    expect(service.project(business.id)).toEqual({ id: business.id, name: "Estética Bella", status: "active", assistantStatus: "inactive", whatsappStatus: "link_required", createdAt: business.createdAt, lastTechnicalActivityAt: null });
    expect(authStore.identities.filter((item) => item.businessId === business.id).length).toBe(1);
    expect(store.audit.map((event) => event.type)).toEqual(["business.created", "business_user.created"]);
    expect(store.outbox).toEqual([`business.created:${business.id}`]);
  });

  test("rejects a second business user and preserves the original", async () => {
    const authStore = new InMemoryAuthStore();
    const service = new AdministrationService(new InMemoryAdministrationStore(), new AuthService(authStore));
    const business = await service.createBusiness({ name: "A", userEmail: "a@example.com", initialPassword: "correct horse battery staple", requestId: "req-2" });
    await expect(service.replaceBusinessUser(business.id, "second@example.com", "another correct horse battery staple", "req-3")).rejects.toThrow("already has a user");
    expect(authStore.identities.find((item) => item.businessId === business.id)?.email).toBe("a@example.com");
  });

  test("suspends access immediately and reactivates without enabling assistant", async () => {
    const authStore = new InMemoryAuthStore();
    const auth = new AuthService(authStore);
    const service = new AdministrationService(new InMemoryAdministrationStore(), auth);
    const business = await service.createBusiness({ name: "A", userEmail: "a@example.com", initialPassword: "correct horse battery staple", requestId: "req-4" });
    const session = await auth.login("a@example.com", "correct horse battery staple", 1_000);
    service.setBusinessStatus(business.id, "suspended", "req-5", 1_001);
    expect(await auth.authenticate(session.token, 1_002)).toBeNull();
    service.setBusinessStatus(business.id, "active", "req-6", 1_003);
    expect(service.project(business.id)?.assistantStatus).toBe("inactive");
    expect(service.project("99999999-9999-4999-8999-999999999999")).toBeNull();
  });
});
