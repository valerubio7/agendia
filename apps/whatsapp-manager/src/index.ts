import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import {
  containQueueErrors,
  createRuntimePools,
  linkCodeKeyFromEnv,
  tenantContext,
} from "@agendia/db";
import {
  BaileysAuthStateAdapter,
  BaileysGateway,
  EnvironmentKms,
  PostgresBaileysAuthStore,
  type SocketFactory,
} from "@agendia/whatsapp-baileys";
import { PostgresWhatsAppManager, type WhatsAppGateway } from "./lifecycle.ts";
import { PostgresInboundHandler } from "./inbound-handler.ts";
import {
  AiOutboxDispatcher,
  type JobPublisher,
} from "./ai-outbox-dispatcher.ts";
import {
  PostgresOutboundDispatcher,
  type OutboundGateway,
} from "./outbound-dispatcher.ts";

export const serviceName = "whatsapp-manager" as const;
export * from "./lifecycle.ts";
export * from "./inbound-handler.ts";
export * from "./ai-outbox-dispatcher.ts";
export * from "./outbound-dispatcher.ts";

export const MIN_RECONNECT_INTERVAL_MS = 15_000;

export function createReconnectThrottle(options: {
  run: () => Promise<unknown>;
  intervalMs: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now,
    intervalMs = Math.max(MIN_RECONNECT_INTERVAL_MS, options.intervalMs);
  let running = false,
    nextAt = now() + MIN_RECONNECT_INTERVAL_MS;
  return {
    snapshot: () => ({ running, nextAt }),
    tryRun: () => {
      if (running || now() < nextAt) return false;
      running = true;
      void options.run().finally(() => {
        running = false;
        nextAt = now() + intervalMs;
      });
      return true;
    },
  };
}

type Pools = ReturnType<typeof createRuntimePools>;
const whatsappLifecycleCodes = new Set([
  "whatsapp.transient-close",
  "whatsapp.logout",
  "whatsapp.corrupt",
]);
export function createWhatsAppLifecycleLogger(
  write: (line: string) => void = (line) => console.info(line),
) {
  return (record: Record<string, unknown>) => {
    if (!whatsappLifecycleCodes.has(String(record.code))) return;
    if (
      !(
        record.statusCode === "unknown" ||
        (typeof record.statusCode === "number" &&
          Number.isFinite(record.statusCode))
      )
    )
      return;
    write(JSON.stringify({ code: record.code, statusCode: record.statusCode }));
  };
}
export function createWhatsAppManager(options: {
  pools: Pools;
  ownerId: string;
  gateway: WhatsAppGateway;
  heartbeatMs?: number;
  onInbound?: (
    event: import("./inbound-handler.ts").InboundWhatsAppEvent,
  ) => unknown;
  linkCodeKey?: Buffer;
}) {
  return new PostgresWhatsAppManager(
    options.pools,
    options.ownerId,
    () => options.gateway,
    options.heartbeatMs,
    options.onInbound,
    options.linkCodeKey,
  );
}
export function createProductionWhatsAppManager(
  env: NodeJS.ProcessEnv = process.env,
  socketFactory?: SocketFactory,
  onInbound?: (
    event: import("./inbound-handler.ts").InboundWhatsAppEvent,
  ) => unknown,
) {
  const database = env.MANAGER_DATABASE_URL ?? env.DATABASE_URL;
  if (!database)
    throw new Error("MANAGER_DATABASE_URL or DATABASE_URL is required");
  const pools = createRuntimePools(database),
    kms = EnvironmentKms.fromEnv(env),
    linkCodeKey = linkCodeKeyFromEnv(env),
    ownerId = env.WHATSAPP_MANAGER_ID ?? randomUUID(),
    gateways: BaileysGateway[] = [],
    lifecycleLog = createWhatsAppLifecycleLogger();
  const manager = new PostgresWhatsAppManager(
    pools,
    ownerId,
    (businessId) => {
      const context = tenantContext({
        businessId,
        actorId: ownerId,
        role: "internal_worker",
        requestId: `whatsapp-manager:${ownerId}`,
      });
      const auth = new BaileysAuthStateAdapter(
          new PostgresBaileysAuthStore(pools.manager, context, kms),
        ),
        gateway = new BaileysGateway(
          (connectionId) => auth.load(businessId, connectionId),
          socketFactory,
          lifecycleLog,
        );
      gateways.push(gateway);
      return gateway;
    },
    undefined,
    onInbound,
    linkCodeKey,
  );
  const outboundGateway: OutboundGateway = {
    send: async (command) => {
      for (const gateway of gateways) {
        const result = await gateway.send(command);
        if (result.outcome === "ack") return result;
      }
      return { outcome: "rejected" };
    },
  };
  return { manager, pools, ownerId, outboundGateway };
}
export const createMessagingRuntime = (
  pools: Pools,
  queue: JobPublisher,
  gateway: OutboundGateway,
  ownerId: string,
) => ({
  inbound: new PostgresInboundHandler(pools),
  aiOutbox: new AiOutboxDispatcher(pools, queue),
  outbound: new PostgresOutboundDispatcher(pools, gateway, ownerId),
});
export async function startWhatsAppManager(
  env: NodeJS.ProcessEnv = process.env,
  socketFactory?: SocketFactory,
) {
  let inbound: PostgresInboundHandler | undefined;
  const runtime = createProductionWhatsAppManager(env, socketFactory, (event) =>
      inbound?.handle(event),
    ),
    queueUrl = env.WORKER_DATABASE_URL ?? env.DATABASE_URL;
  if (!queueUrl)
    throw new Error("WORKER_DATABASE_URL or DATABASE_URL is required");
  const boss = new PgBoss({
    connectionString: queueUrl,
    schema: "pgboss",
    createSchema: false,
  });
  containQueueErrors(boss, "whatsapp-manager");
  await boss.start();
  await boss.createQueue("ai-generate");
  const messaging = createMessagingRuntime(
    runtime.pools,
    boss,
    runtime.outboundGateway,
    runtime.ownerId,
  );
  inbound = messaging.inbound;
  await runtime.manager.restart();
  await messaging.aiOutbox.dispatchBatch();
  const pollMs = Number(env.WHATSAPP_COMMAND_POLL_MS ?? 1_000),
    reconnect = createReconnectThrottle({
      run: () => runtime.manager.restart(),
      intervalMs: pollMs,
    });
  const timer = setInterval(() => {
    void runtime.manager.processNext();
    reconnect.tryRun();
    void messaging.aiOutbox.dispatchBatch();
    void messaging.outbound.dispatchNext();
  }, pollMs);
  return {
    ...runtime,
    ...messaging,
    boss,
    stop: async () => {
      clearInterval(timer);
      await boss.stop();
      await runtime.manager.stop();
      await runtime.pools.end();
    },
  };
}

if (process.env.AGENDIA_RUN_WHATSAPP_MANAGER === "1") {
  void startWhatsAppManager()
    .then((runtime) => {
      const shutdown = () => void runtime.stop().finally(() => process.exit());
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch(() => {
      console.error(
        JSON.stringify({ code: "whatsapp.manager.bootstrap_failed" }),
      );
      process.exitCode = 1;
    });
}
