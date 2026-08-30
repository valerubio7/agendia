import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRuntimePools, sealLinkCode, tenantContext } from "@agendia/db";
import {
  BaileysAuthStateAdapter,
  BaileysGateway,
  EnvironmentKms,
  PostgresBaileysAuthStore,
} from "@agendia/whatsapp-baileys";
import {
  applyPostgresMigrations,
  FakeBaileysSocket,
  startTestPostgres,
  testTenantContext,
  type TestPostgres,
} from "@agendia/test-support";
import { createWhatsAppManager } from "../../apps/whatsapp-manager/src/index.ts";
import type { WhatsAppGateway } from "../../apps/whatsapp-manager/src/lifecycle.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const context = tenantContext(testTenantContext(A, "internal_worker"));
let database: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(
    database.sql,
    join(import.meta.dir, "../../packages/db/migrations"),
  );
  pools = createRuntimePools(database.container.getConnectionUri());
  await database.sql`insert into businesses(id,name) values(${A},'Tenant A'),(${B},'Tenant B')`;
  await pools.manager.run(context, (repo) =>
    repo.saveConnection(CONNECTION, A),
  );
}, 120_000);
afterAll(async () => {
  await pools?.end();
  await database?.stop();
});

describe("persistent PostgreSQL Baileys manager", () => {
  test("persists encrypted auth with an environment KMS and never exposes plaintext", async () => {
    const kms = EnvironmentKms.fromEnv({
      BAILEYS_KMS_VERSION: "test-v1",
      BAILEYS_KMS_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    const store = new PostgresBaileysAuthStore(pools.manager, context, kms);
    await store.write(A, CONNECTION, "creds", { token: "provider-secret" }, 0);
    expect(await store.read(A, CONNECTION, "creds")).toEqual({
      token: "provider-secret",
    });
    const persisted =
      await database.sql`select ciphertext from whatsapp_auth_records where connection_id=${CONNECTION}`;
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("provider-secret");
  });

  test("persists only the current expiring QR and invalidates it after open", async () => {
    await pools.api.run(tenantContext(testTenantContext(A)), (repo) =>
      repo.enqueueOutbox(A, "whatsapp.link_requested", `link:${A}`, {}),
    );
    let releaseOpen = () => {},
      qrReady = () => {};
    const open = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const qr = new Promise<void>((resolve) => {
      qrReady = resolve;
    });
    const gateway: WhatsAppGateway = {
      connect: async (_id, emit) => {
        await emit({ type: "qr", value: "temporary-qr" });
        qrReady();
        await open;
        await emit({ type: "open", linkedNumber: "549111" });
      },
    };
    const manager = createWhatsAppManager({
      pools,
      ownerId: "manager-a",
      gateway,
      linkCodeKey: Buffer.alloc(32, 4),
    });
    const processing = manager.processNext(10_000);
    try {
      await qr;
      const persisted = (
        await database.sql<
          { ciphertext: Buffer; expires_at: Date }[]
        >`select ciphertext,expires_at from whatsapp_link_codes where connection_id=${CONNECTION}`
      )[0]!;
      expect(persisted.expires_at.getTime()).toBe(310_000);
      expect(persisted.ciphertext.toString()).not.toContain("temporary-qr");
      releaseOpen();
      expect(await processing).toBe(true);
      expect(
        await database.sql`select token from whatsapp_link_codes where connection_id=${CONNECTION}`,
      ).toHaveLength(0);
      await pools.manager.run(context, async (repo) => {
        const old = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          fresh = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        await repo.replaceLinkCode(
          CONNECTION,
          sealLinkCode(Buffer.alloc(32, 4), A, CONNECTION, old, "old"),
          new Date(20_000),
        );
        await repo.replaceLinkCode(
          CONNECTION,
          sealLinkCode(Buffer.alloc(32, 4), A, CONNECTION, fresh, "fresh"),
          new Date(30_000),
        );
        await repo.invalidateLinkCode(CONNECTION, old);
        expect((await repo.currentLinkCode(new Date(15_000)))?.token).toBe(
          fresh,
        );
        await repo.clearLinkCode(CONNECTION);
      });
      expect(
        await pools.api.run(tenantContext(testTenantContext(A)), (repo) =>
          repo.whatsapp(),
        ),
      ).toMatchObject({ status: "connected", linkedNumber: "549111" });
      const events = await database.sql<
        { event_type: string; metadata: object }[]
      >`select event_type,metadata from audit_events where business_id=${A} and event_type like 'whatsapp.%' order by stream_sequence`;
      expect(events.map((row) => row.event_type)).toEqual(
        expect.arrayContaining([
          "whatsapp.manager.started",
          "whatsapp.link_qr_available",
          "whatsapp.connected",
        ]),
      );
      const safeEvidence = JSON.stringify({
        events,
        technical:
          await database.sql`select code,safe_details from technical_events where business_id=${A}`,
      });
      for (const sensitive of [
        "temporary-qr",
        "provider-secret",
        "549111:1@s.whatsapp.net",
      ])
        expect(safeEvidence).not.toContain(sensitive);
      expect(await manager.restart(11_000)).toEqual([CONNECTION]);
    } finally {
      releaseOpen();
      await processing.catch(() => undefined);
      await manager.stop();
    }
  });

  test("invalidates a persisted QR when a restarted socket logs out", async () => {
    const token = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await pools.manager.run(context, async (repo) => {
      await repo.setWhatsAppState(
        CONNECTION,
        "CONNECTED",
        new Date(20_000),
        "549111",
      );
      await repo.replaceLinkCode(
        CONNECTION,
        sealLinkCode(Buffer.alloc(32, 4), A, CONNECTION, token, "restart-qr"),
        new Date(320_000),
      );
    });
    const gateway: WhatsAppGateway = {
      connect: async (_id, emit) => {
        await emit({ type: "logout" });
      },
    };
    const manager = createWhatsAppManager({
      pools,
      ownerId: "manager-restart",
      gateway,
      linkCodeKey: Buffer.alloc(32, 4),
    });
    try {
      expect(await manager.restart(21_000)).toEqual([CONNECTION]);
      expect(
        await database.sql`select token from whatsapp_link_codes where connection_id=${CONNECTION}`,
      ).toHaveLength(0);
      expect(
        await database.sql`select id from audit_events where business_id=${A} and event_type='whatsapp.link_required'`,
      ).toHaveLength(1);
    } finally {
      await manager.stop();
      await pools.manager.run(context, (repo) =>
        repo.setWhatsAppState(
          CONNECTION,
          "CONNECTED",
          new Date(22_000),
          "549111",
        ),
      );
    }
  });

  test("audits safe close and error lifecycle codes in append order", async () => {
    const gateway: WhatsAppGateway = {
      connect: async (_id, emit) => {
        await emit({ type: "transient-close" });
        await emit({ type: "corrupt" });
      },
    };
    const manager = createWhatsAppManager({
      pools,
      ownerId: "manager-failure",
      gateway,
      linkCodeKey: Buffer.alloc(32, 4),
    });
    try {
      await pools.manager.run(context, (repo) =>
        repo.setWhatsAppState(
          CONNECTION,
          "CONNECTED",
          new Date(23_000),
          "549111",
        ),
      );
      expect(await manager.restart(24_000)).toEqual([CONNECTION]);
      const audit = await database.sql<
        { event_type: string; metadata: object }[]
      >`select event_type,metadata from audit_events where business_id=${A} and event_type in ('whatsapp.disconnected','whatsapp.connection_failed') order by stream_sequence`;
      expect(
        audit.map((row) => ({
          event_type: row.event_type,
          metadata: row.metadata,
        })),
      ).toEqual([
        { event_type: "whatsapp.disconnected", metadata: {} },
        { event_type: "whatsapp.connection_failed", metadata: {} },
      ]);
      expect(
        await database.sql`select id from technical_events where business_id=${A} and code in ('whatsapp.disconnected','whatsapp.connection_failed')`,
      ).toHaveLength(2);
    } finally {
      await manager.stop();
      await pools.manager.run(context, (repo) =>
        repo.setWhatsAppState(
          CONNECTION,
          "CONNECTED",
          new Date(25_000),
          "549111",
        ),
      );
    }
  });

  test("binds runtime audit source to the DB role and tenant context", async () => {
    const event = {
      code: "whatsapp.connection_failed",
      outcome: "failure",
      source: "whatsapp-manager",
      requestId: "scope-negative",
      severity: "error",
    } as const;
    await expect(
      pools.manager.run(context, (repo) => repo.recordRuntimeEvent(B, event)),
    ).rejects.toThrow();
    await expect(
      pools.api.run(context, (repo) => repo.appendRuntimeAudit(A, event)),
    ).rejects.toThrow();
    await expect(
      pools.manager.run(context, (repo) =>
        repo.appendRuntimeAudit(null, event),
      ),
    ).rejects.toThrow();
    await expect(
      pools.worker.run(context, (repo) => repo.appendRuntimeAudit(A, event)),
    ).rejects.toThrow(/permission denied/i);
    expect(
      await database.sql`select id from audit_events where request_id='scope-negative'`,
    ).toHaveLength(0);
  });

  test("contains a secret-bearing gateway connect rejection and projects failure activity", async () => {
    const secret = "provider-token-never-persist";
    await database.sql`update businesses set last_technical_activity_at=null where id=${A}`;
    await pools.manager.run(context, async (repo) => {
      await repo.setWhatsAppState(CONNECTION, "LINK_REQUIRED", new Date());
      await repo.enqueueOutbox(
        A,
        "whatsapp.link_requested",
        `link:connect-rejection`,
        {},
      );
    });
    const manager = createWhatsAppManager({
      pools,
      ownerId: "manager-rejection",
      gateway: {
        connect: async () => {
          throw new Error(secret);
        },
      },
      linkCodeKey: Buffer.alloc(32, 4),
    });
    try {
      await expect(manager.processNext()).resolves.toBe(false);
    } finally {
      await manager.stop();
    }
    const evidence = await database.sql<
      { code: string; safe_details: object; occurred_at: Date }[]
    >`select code,safe_details,occurred_at from technical_events where business_id=${A} and code in ('whatsapp.manager.started','whatsapp.connection_failed') order by occurred_at`;
    expect(evidence.at(-1)?.code).toBe("whatsapp.connection_failed");
    expect(JSON.stringify(evidence)).not.toContain(secret);
    const activity = (
      await database.sql<
        { last_technical_activity_at: Date }[]
      >`select last_technical_activity_at from businesses where id=${A}`
    )[0]!.last_technical_activity_at;
    expect(activity.getTime()).toBe(evidence.at(-1)!.occurred_at.getTime());
    await pools.manager.run(context, (repo) =>
      repo.setWhatsAppState(CONNECTION, "CONNECTED", new Date(), "549111"),
    );
  });

  test("claims a durable API link command, owns one advisory lock, heartbeats and restores", async () => {
    const gateway = (ownerId: string, socket: FakeBaileysSocket) => {
      socket.user = { id: "549111:1@s.whatsapp.net" };
      const kms = EnvironmentKms.fromEnv({
        BAILEYS_KMS_VERSION: "test-v1",
        BAILEYS_KMS_KEY: Buffer.alloc(32, 9).toString("base64"),
      });
      const authContext = tenantContext({
        ...testTenantContext(A, "internal_worker"),
        actorId: ownerId,
        requestId: `manager-test:${ownerId}`,
      });
      const auth = new BaileysAuthStateAdapter(
        new PostgresBaileysAuthStore(pools.manager, authContext, kms),
      );
      return new BaileysGateway(
        (id) => auth.load(A, id),
        () => socket,
      );
    };
    const socketA = new FakeBaileysSocket([{ connection: "open" }]),
      socketB = new FakeBaileysSocket([{ connection: "open" }]),
      inbound: object[] = [];
    const managerA = createWhatsAppManager({
      pools,
      ownerId: "manager-live-a",
      gateway: gateway("manager-live-a", socketA),
      heartbeatMs: 5,
      onInbound: (event) => inbound.push(event),
    });
    const managerB = createWhatsAppManager({
      pools,
      ownerId: "manager-live-b",
      gateway: gateway("manager-live-b", socketB),
      heartbeatMs: 5,
    });
    try {
      expect(await managerA.restart(12_000)).toEqual([CONNECTION]);
      await socketA.emit("messages.upsert", {
        messages: [
          {
            key: {
              id: "socket-1",
              remoteJid: "54911@s.whatsapp.net",
              fromMe: false,
            },
            message: { conversation: "hola" },
          },
        ],
      });
      expect(inbound).toEqual([
        expect.objectContaining({
          sessionPublicId: expect.any(String),
          providerMessageId: "socket-1",
          remoteJid: "54911@s.whatsapp.net",
        }),
      ]);
      expect(await managerB.restart(12_001)).toEqual([]);
      const before = (
        await database.sql`select version from whatsapp_connections where id=${CONNECTION}`
      )[0]!.version;
      await Bun.sleep(25);
      expect(
        (
          await database.sql`select version from whatsapp_connections where id=${CONNECTION}`
        )[0]!.version,
      ).toBeGreaterThan(before);
      await managerA.stop();
      const stopped = (
        await database.sql`select owner_id,heartbeat_at,version from whatsapp_connections where id=${CONNECTION}`
      )[0]!;
      await Bun.sleep(15);
      expect(
        (
          await database.sql`select owner_id,heartbeat_at,version from whatsapp_connections where id=${CONNECTION}`
        )[0],
      ).toEqual(stopped);
      expect(stopped).toMatchObject({ owner_id: null, heartbeat_at: null });
      expect(await managerB.restart(12_002)).toEqual([CONNECTION]);
    } finally {
      await managerA.stop();
      await managerB.stop();
    }
    expect(socketA.ended).toBe(1);
    expect(socketB.ended).toBe(1);
  });
});
