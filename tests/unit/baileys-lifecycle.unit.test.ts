import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { PostgresWhatsAppManager } from "../../apps/whatsapp-manager/src/connection.ts";
import { normalizeBaileysMessage } from "../../packages/whatsapp-baileys/src/baileys-gateway.ts";
import { classifyInbound } from "../../apps/whatsapp-manager/src/inbound.ts";
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

describe("PostgreSQL manager acquired-lock cleanup", () => {
  for (const failure of ["clearLinkCode", "clearWhatsAppAuth", "takeOverWhatsApp", "recordRuntimeEvent", "currentLinkCode", "connect-and-audit", "pending-event"] as const) {
    test(`releases ownership after ${failure} fails`, async () => {
      let released = 0, closed = 0;
      const businessId = "11111111-1111-4111-8111-111111111111";
      const fail = () => { throw new Error("injected lifecycle failure"); };
      const repo = {
        claimWhatsAppLink: async () => ({ business_id: businessId, command_id: "command-a" }),
        admitWhatsAppLink: async () => {
          await repo.clearLinkCode();
          await repo.clearWhatsAppAuth();
          return true;
        },
        completeWhatsAppLink: async () => true,
        lockWhatsAppOwnership: async () => true,
        releaseWhatsApp: async () => undefined,
        saveConnection: async () => undefined,
        connection: async () => ({ id: "connection-a", sessionPublicId: "session-a", linkPending: true, linkCommandId: "command-a" }),
        restorableWhatsApp: async () => [{ business_id: businessId, id: "connection-a" }],
        clearLinkCode: async () => { if (failure === "clearLinkCode") fail(); },
        clearWhatsAppAuth: async () => { if (failure === "clearWhatsAppAuth") fail(); },
        takeOverWhatsApp: async () => { if (failure === "takeOverWhatsApp") fail(); },
        recordRuntimeEvent: async () => { if (failure === "recordRuntimeEvent") fail(); },
        currentLinkCode: async () => { if (failure === "currentLinkCode") fail(); return null; },
        setWhatsAppState: async () => { if (failure === "connect-and-audit" || failure === "pending-event") fail(); },
      };
      const pools = { manager: {
        run: async (_context: unknown, work: (value: typeof repo) => unknown) => work(repo),
        reserveAdvisoryLock: async () => async () => { released++; },
      } } as unknown as ConstructorParameters<typeof PostgresWhatsAppManager>[0];
      const manager = new PostgresWhatsAppManager(pools, "owner", () => ({
        connect: async (_id, emit) => {
          if (failure === "connect-and-audit") fail();
          if (failure === "pending-event") {
            void Promise.resolve(emit({ type: "corrupt" })).catch(() => undefined);
          }
          return { closed: new Promise<void>(() => {}), close: () => { closed++; } };
        },
      }));
      const work = failure.startsWith("clear") ? manager.processNext() : manager.restart();
      await expect(work).rejects.toThrow("injected lifecycle failure");
      expect(released).toBe(1);
      expect(closed).toBe(failure === "pending-event" ? 1 : 0);
      await manager.stop();
    });
  }

  test("releases the held lock even when shutdown bookkeeping fails", async () => {
    let released = 0, close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const repo = {
      restorableWhatsApp: async () => [{ business_id: "11111111-1111-4111-8111-111111111111", id: "connection-a" }],
      connection: async () => ({ id: "connection-a" }),
      takeOverWhatsApp: async () => undefined,
      recordRuntimeEvent: async () => undefined,
      currentLinkCode: async () => null,
      releaseWhatsApp: async () => { throw new Error("shutdown bookkeeping failed"); },
    };
    const pools = { manager: {
      run: async (_context: unknown, work: (value: typeof repo) => unknown) => work(repo),
      reserveAdvisoryLock: async () => async () => { released++; },
    } } as unknown as ConstructorParameters<typeof PostgresWhatsAppManager>[0];
    const manager = new PostgresWhatsAppManager(pools, "owner", () => ({ connect: async () => ({ closed, close }) }));
    expect(await manager.restart()).toEqual(["connection-a"]);
    await expect(manager.stop()).rejects.toThrow("shutdown bookkeeping failed");
    expect(released).toBe(1);
  });
});

describe("live customer identity classification", () => {
  test("only the customer branch can hand provider evidence to agenda ingestion", () => {
    const base = { key: { id: "received", remoteJid: "123456789@lid", remoteJidAlt: "5491123456789@s.whatsapp.net" }, message: { conversation: "reservar" } };
    const customer = normalizeBaileysMessage("session", base)!;
    expect(classifyInbound(customer)).toBe("accepted");
    expect(customer.senderEvidence?.phone).toBe("+5491123456789");
    const manual = normalizeBaileysMessage("session", { ...base, key: { ...base.key, fromMe: true } })!;
    expect(classifyInbound(manual)).toBe("accepted_business");
    expect(manual.senderEvidence).toBeUndefined();
    const group = normalizeBaileysMessage("session", { ...base, key: { ...base.key, remoteJid: "123@g.us" } })!;
    expect(classifyInbound(group)).toBe("ignored_group");
    expect(group.senderEvidence).toBeUndefined();
  });
  test("a stored mapping cannot manufacture evidence for a subsequent unresolved LID", () => {
    const unbound = normalizeBaileysMessage("session", {
      key: { id: "received", remoteJid: "123456789@lid" }, message: { conversation: "Mi teléfono es +5491123456789" },
    })!;
    expect(classifyInbound(unbound)).toBe("accepted");
    expect(unbound.senderEvidence).toBeUndefined();
  });
});

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
