import { describe, expect, test } from "bun:test";
import { InMemoryWhatsAppConnections, WhatsAppConnectionService, projectWhatsAppStatus } from "../../packages/domain/src/whatsapp/connection.ts";

describe("single WhatsApp connection state machine", () => {
  test("creates one link-required connection and rejects a second", () => {
    const service = new WhatsAppConnectionService(new InMemoryWhatsAppConnections());
    const first = service.ensureConnection("tenant-a");
    expect(first.state).toBe("LINK_REQUIRED");
    expect(projectWhatsAppStatus(first.state)).toBe("link_required");
    expect(() => service.createSecondConnection("tenant-a")).toThrow("one WhatsApp connection");
    expect(service.get("tenant-a")?.id).toBe(first.id);
  });

  test("allows approved transitions and projects transient states as disconnected", () => {
    const service = new WhatsAppConnectionService(new InMemoryWhatsAppConnections());
    service.ensureConnection("tenant-a");
    service.transition("tenant-a", "LINKING", 100);
    expect(projectWhatsAppStatus(service.get("tenant-a")!.state)).toBe("disconnected");
    service.transition("tenant-a", "CONNECTED", 200, "+5491155555555");
    expect(service.get("tenant-a")).toMatchObject({ state: "CONNECTED", linkedNumber: "+5491155555555", linkedAt: 200, lastConnectedAt: 200 });
    expect(() => service.transition("tenant-a", "LINKING", 300)).toThrow("Invalid WhatsApp transition");
  });

  test("records lease heartbeat and blocks sending when suspended or not connected", () => {
    const service = new WhatsAppConnectionService(new InMemoryWhatsAppConnections());
    service.ensureConnection("tenant-a");
    service.claimLease("tenant-a", "manager-1", 500);
    expect(service.get("tenant-a")?.ownerId).toBe("manager-1");
    expect(service.canSend("tenant-a", "active")).toBe(false);
    service.transition("tenant-a", "LINKING", 501); service.transition("tenant-a", "CONNECTED", 502);
    expect(service.canSend("tenant-a", "active")).toBe(true);
    expect(service.canSend("tenant-a", "suspended")).toBe(false);
  });
});
