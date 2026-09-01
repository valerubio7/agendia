import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  InMemoryWhatsAppConnections,
  WhatsAppConnectionService,
} from "../../packages/domain/src/whatsapp/connection.ts";
import { registerWhatsAppRoutes } from "../support/api/me-whatsapp.ts";
import {
  DeterministicBaileysDouble,
  DurableLinkCommands,
  EphemeralLinkCodeStore,
  WhatsAppLifecycleManager,
  reconnectDelay,
} from "../support/whatsapp-manager/lifecycle.ts";

function harness(events: Parameters<DeterministicBaileysDouble["script"]>[0]) {
  const connections = new WhatsAppConnectionService(
    new InMemoryWhatsAppConnections(),
  );
  const gateway = new DeterministicBaileysDouble();
  gateway.script(events);
  const commands = new DurableLinkCommands();
  const links = new EphemeralLinkCodeStore();
  return {
    connections,
    gateway,
    commands,
    links,
    manager: new WhatsAppLifecycleManager(
      connections,
      gateway,
      commands,
      links,
    ),
  };
}

describe("persistent Baileys linking lifecycle", () => {
  test("processes a durable link command, exposes an expiring QR only to its tenant and opens", async () => {
    const h = harness([
      { type: "qr", value: "temporary-qr" },
      { type: "open", linkedNumber: "+549111" },
    ]);
    h.manager.requestLink("tenant-a");
    await h.manager.processNext(1_000);
    expect(h.links.consume("tenant-b", "wa-tenant-a", 1_001)).toBeNull();
    expect(h.links.consume("tenant-a", "wa-tenant-a", 1_001)).toBe(
      "temporary-qr",
    );
    expect(h.links.consume("tenant-a", "wa-tenant-a", 301_001)).toBeNull();
    expect(h.connections.get("tenant-a")).toMatchObject({
      state: "CONNECTED",
      linkedNumber: "+549111",
    });
  });

  test("reconnects transient closures with bounded deterministic backoff", async () => {
    const h = harness([
      { type: "open", linkedNumber: "+549111" },
      { type: "transient-close" },
    ]);
    h.manager.requestLink("tenant-a");
    await h.manager.processNext(2_000);
    expect(h.connections.get("tenant-a")?.state).toBe("RECONNECTING");
    expect(reconnectDelay(0, () => 0)).toBe(1_000);
    expect(reconnectDelay(20, () => 1)).toBe(60_000);
  });

  test("logout requires a new link while corrupt auth becomes an observable error", async () => {
    const logout = harness([
      { type: "open", linkedNumber: "+549111" },
      { type: "logout" },
    ]);
    logout.manager.requestLink("tenant-a");
    await logout.manager.processNext(3_000);
    expect(logout.connections.get("tenant-a")?.state).toBe("LINK_REQUIRED");
    const corrupt = harness([{ type: "corrupt" }]);
    corrupt.manager.requestLink("tenant-a");
    await corrupt.manager.processNext(3_000);
    expect(corrupt.connections.get("tenant-a")?.state).toBe("ERROR");
  });

  test("restores eligible persisted sessions after a manager restart and rejects a second link", async () => {
    const h = harness([{ type: "open", linkedNumber: "+549111" }]);
    h.manager.requestLink("tenant-a");
    await h.manager.processNext(4_000);
    const restarted = new WhatsAppLifecycleManager(
      h.connections,
      h.gateway,
      h.commands,
      h.links,
    );
    expect(
      restarted.restorePersistedSessions(["tenant-a", "tenant-missing"]),
    ).toEqual(["wa-tenant-a"]);
    expect(() => restarted.requestLink("tenant-a")).toThrow("already linked");
  });

  test("serves link commands and ephemeral QR with no-store headers", async () => {
    const h = harness([{ type: "qr", value: "temporary-qr" }]);
    const app = Fastify();
    registerWhatsAppRoutes(app, h.connections, () => "tenant-a", {
      requestLink: (tenant) => h.manager.requestLink(tenant),
      consumeLink: (tenant, now) =>
        h.links.consume(tenant, `wa-${tenant}`, now),
      now: () => 5_001,
    });
    expect(
      (await app.inject({ method: "POST", url: "/me/whatsapp/link" }))
        .statusCode,
    ).toBe(202);
    await h.manager.processNext(5_000);
    const response = await app.inject({
      method: "GET",
      url: "/me/whatsapp/link",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json() as { qr: string }).toEqual({ qr: "temporary-qr" });
  });
});
