import { describe, expect, test } from "bun:test";
import managerPackage from "../../apps/whatsapp-manager/package.json";
import {
  InMemoryWhatsAppConnections,
  WhatsAppConnectionService,
} from "@agendia/domain";
import {
  BaileysAuthStore,
  InMemoryAuthRecordRepository,
  InMemoryKms,
  BaileysAuthStateAdapter,
  BaileysGateway,
  type DefaultSocketDependencies,
  type SocketFactory,
} from "@agendia/whatsapp-baileys";
import { createWhatsAppLifecycleLogger } from "../../apps/whatsapp-manager/src/index.ts";
import {
  DeterministicBaileysDouble,
  DurableLinkCommands,
  EphemeralLinkCodeStore,
  WhatsAppLifecycleManager,
  type WhatsAppGateway,
} from "../../apps/whatsapp-manager/src/lifecycle.ts";
import { FakeBaileysSocket } from "@agendia/test-support";

const lifecycle = (gateway: WhatsAppGateway) => {
  const connections = new WhatsAppConnectionService(
    new InMemoryWhatsAppConnections(),
  );
  const links = new EphemeralLinkCodeStore();
  return {
    connections,
    links,
    manager: new WhatsAppLifecycleManager(
      connections,
      gateway,
      new DurableLinkCommands(),
      links,
    ),
  };
};
const fakeGateway = (
  updates: object[],
  log: (record: Record<string, unknown>) => void = () => undefined,
) => {
  const auth = new BaileysAuthStateAdapter(
    new BaileysAuthStore(
      new InMemoryAuthRecordRepository(),
      new InMemoryKms({ test: Buffer.alloc(32, 7) }, "test"),
    ),
  );
  const socket = new FakeBaileysSocket(updates);
  return {
    socket,
    gateway: new BaileysGateway(
      (id) => auth.load("11111111-1111-4111-8111-111111111111", id),
      () => socket,
      log,
    ),
  };
};

async function linkContract(gateway: WhatsAppGateway) {
  const h = lifecycle(gateway);
  h.manager.requestLink("tenant-a");
  await h.manager.processNext(1_000);
  expect(h.links.consume("tenant-b", "wa-tenant-a", 1_001)).toBeNull();
  expect(h.links.consume("tenant-a", "wa-tenant-a", 1_001)).toBe(
    "temporary-qr",
  );
  const expired = lifecycle(gateway);
  expired.links.put("tenant-a", "wa-tenant-a", "expired-qr", 1_000);
  expect(expired.links.consume("tenant-a", "wa-tenant-a", 301_000)).toBeNull();
  expect(h.connections.get("tenant-a")).toMatchObject({
    state: "CONNECTED",
    linkedNumber: "549111",
  });
  expect(() => h.manager.requestLink("tenant-a")).toThrow("already linked");
}

describe("WhatsAppGateway contract", () => {
  test("provides an executable production manager bootstrap", () => {
    expect(managerPackage.scripts?.start).toBe(
      "AGENDIA_RUN_WHATSAPP_MANAGER=1 node --import tsx src/index.ts",
    );
  });

  test("matches QR/open, expiry and single-link behavior for the deterministic double and fake socket", async () => {
    const double = new DeterministicBaileysDouble();
    double.script([
      { type: "qr", value: "temporary-qr" },
      { type: "open", linkedNumber: "549111" },
    ]);
    await linkContract(double);
    const fake = fakeGateway([{ qr: "temporary-qr" }, { connection: "open" }]);
    fake.socket.user = { id: "549111:1@s.whatsapp.net" };
    await linkContract(fake.gateway);
  });

  test("resolves the latest version and stable browser identity for the default socket mode", async () => {
    const auth = new BaileysAuthStateAdapter(
      new BaileysAuthStore(
        new InMemoryAuthRecordRepository(),
        new InMemoryKms({ test: Buffer.alloc(32, 7) }, "test"),
      ),
    );
    const socket = new FakeBaileysSocket();
    let options: Record<string, unknown> | undefined;
    let resolutions = 0;
    const defaults: DefaultSocketDependencies = {
      socketFactory: ((value) => {
        options = value;
        return socket;
      }) as SocketFactory,
      versionResolver: async () => {
        resolutions += 1;
        return { version: [2, 3_000, 1_043_857_760], isLatest: true };
      },
    };
    const gateway = new BaileysGateway(
      (id) => auth.load("11111111-1111-4111-8111-111111111111", id),
      undefined,
      undefined,
      defaults,
    );

    await gateway.connect("connection-a", () => undefined);

    expect(resolutions).toBe(1);
    expect(options).toMatchObject({
      version: [2, 3_000, 1_043_857_760],
      browser: ["Ubuntu", "Chrome", "22.04.4"],
      printQRInTerminal: false,
    });
  });

  test("does not resolve a network version for ordinary custom socket doubles", async () => {
    const auth = new BaileysAuthStateAdapter(
      new BaileysAuthStore(
        new InMemoryAuthRecordRepository(),
        new InMemoryKms({ test: Buffer.alloc(32, 7) }, "test"),
      ),
    );
    const socket = new FakeBaileysSocket();
    let resolutions = 0;
    const defaults: DefaultSocketDependencies = {
      socketFactory: () => {
        throw new Error("default socket must not be used");
      },
      versionResolver: async () => {
        resolutions += 1;
        throw new Error("version resolver must not be used");
      },
    };
    const gateway = new BaileysGateway(
      (id) => auth.load("11111111-1111-4111-8111-111111111111", id),
      () => socket,
      undefined,
      defaults,
    );

    await gateway.connect("connection-a", () => undefined);

    expect(resolutions).toBe(0);
  });

  test("routes socket messages.upsert into the inbound boundary", async () => {
    const fake = fakeGateway([]),
      received: Record<string, unknown>[] = [];
    await (fake.gateway.connect as any)(
      "connection-a",
      () => undefined,
      (event: Record<string, unknown>) => received.push(event),
      "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    );
    await fake.socket.emit("messages.upsert", {
      messages: [
        {
          key: {
            id: "provider-1",
            remoteJid: "54911@s.whatsapp.net",
            fromMe: false,
          },
          message: { conversation: "hola" },
          messageTimestamp: 10,
        },
      ],
    });
    expect(received).toEqual([
      expect.objectContaining({
        providerMessageId: "provider-1",
        remoteJid: "54911@s.whatsapp.net",
        kind: "text",
        text: "hola",
      }),
    ]);
  });

  test("sends only to the exact validated individual JID", async () => {
    const fake = fakeGateway([]);
    fake.socket.expectedRecipient = "54911@s.whatsapp.net";
    await (fake.gateway.connect as any)("connection-a", () => undefined);
    expect(
      await (fake.gateway.send as any)({
        connectionId: "connection-a",
        outboundId: "out-1",
        remoteJid: "54911@s.whatsapp.net",
        text: "respuesta",
      }),
    ).toMatchObject({ outcome: "ack" });
    expect(fake.socket.sentRecipients).toEqual(["54911@s.whatsapp.net"]);
  });

  test("triangulates groups, fromMe, media and rejects invalid recipients before the socket", async () => {
    const fake = fakeGateway([]),
      received: Record<string, unknown>[] = [];
    await (fake.gateway.connect as any)(
      "connection-a",
      () => undefined,
      (event: Record<string, unknown>) => received.push(event),
      "unknown-session",
    );
    await fake.socket.emit("messages.upsert", {
      messages: [
        {
          key: { id: "group", remoteJid: "123@g.us" },
          message: { conversation: "grupo" },
        },
        {
          key: { id: "own", remoteJid: "123@s.whatsapp.net", fromMe: true },
          message: { conversation: "propio" },
        },
        {
          key: { id: "media", remoteJid: "123@s.whatsapp.net" },
          message: { imageMessage: {} },
        },
        {
          key: { id: "unsupported", remoteJid: "123@s.whatsapp.net" },
          message: { reactionMessage: {} },
        },
      ],
    });
    expect(
      received.map(({ chatType, fromMe, kind }) => ({
        chatType,
        fromMe,
        kind,
      })),
    ).toEqual([
      { chatType: "group", fromMe: false, kind: "text" },
      { chatType: "individual", fromMe: true, kind: "text" },
      { chatType: "individual", fromMe: false, kind: "image" },
    ]);
    expect(
      await (fake.gateway.send as any)({
        connectionId: "connection-a",
        outboundId: "bad",
        remoteJid: "",
        text: "x",
      }),
    ).toEqual({ outcome: "rejected" });
    expect(fake.socket.sentRecipients).toHaveLength(0);
  });

  test("maps close states and logs only allowlisted lifecycle fields", async () => {
    for (const [statusCode, expected, code] of [
      [408, "RECONNECTING", "whatsapp.transient-close"],
      [401, "LINK_REQUIRED", "whatsapp.logout"],
      [500, "ERROR", "whatsapp.corrupt"],
    ] as const) {
      const lines: string[] = [];
      const fake = fakeGateway(
        [
          ...(statusCode === 408 ? [{ connection: "open" }] : []),
          {
            connection: "close",
            lastDisconnect: {
              error: {
                output: { statusCode },
                credential: "do-not-log",
                qr: "secret-qr",
              },
            },
          },
        ],
        createWhatsAppLifecycleLogger((line) => lines.push(line)),
      );
      fake.socket.user = { id: "549111:1@s.whatsapp.net" };
      const h = lifecycle(fake.gateway);
      h.manager.requestLink("tenant-a");
      await h.manager.processNext(2_000);
      expect(h.connections.get("tenant-a")?.state).toBe(expected);
      expect(lines).toEqual([JSON.stringify({ code, statusCode })]);
      expect(lines.join(" ")).not.toContain("do-not-log");
      expect(lines.join(" ")).not.toContain("secret-qr");
    }
  });

  test("suppresses generic Baileys records and reports an unknown close status safely", async () => {
    const lines: string[] = [];
    const socket = new FakeBaileysSocket();
    let options: Record<string, unknown> | undefined;
    const auth = new BaileysAuthStateAdapter(
      new BaileysAuthStore(
        new InMemoryAuthRecordRepository(),
        new InMemoryKms({ test: Buffer.alloc(32, 7) }, "test"),
      ),
    );
    const gateway = new BaileysGateway(
      (id) => auth.load("11111111-1111-4111-8111-111111111111", id),
      (value) => {
        options = value;
        return socket;
      },
      createWhatsAppLifecycleLogger((line) => lines.push(line)),
    );
    await gateway.connect("connection-a", () => undefined);

    (options?.logger as { error(value: Record<string, unknown>): void }).error({
      code: "baileys.internal",
      credential: "do-not-log",
      qr: "secret-qr",
    });
    await socket.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { message: "private provider failure" } },
    });

    expect(lines).toEqual([
      JSON.stringify({
        code: "whatsapp.transient-close",
        statusCode: "unknown",
      }),
    ]);
  });
});
