import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { Algorithm, hash } from "@node-rs/argon2";
import { startApi } from "../../../apps/api/src/index.ts";
import { startMessageWorker } from "../../../apps/message-worker/src/index.ts";
import {
  startWhatsAppManager,
  type InboundWhatsAppEvent,
} from "../../../apps/whatsapp-manager/src/index.ts";
import {
  applyPostgresMigrations,
  startTestPostgres,
} from "../../support/index.ts";
import { SystemProviders } from "./providers.ts";

const admin = {
  email: "admin@example.test",
  password: "correct horse battery staple",
};
export const systemExposure = (ui: string, evidence: unknown, logs: string[]) =>
  `${ui}\n${JSON.stringify(evidence)}\n${logs.join("\n")}`;
export function assertSemanticBoundary(
  id: string,
  facts: Record<string, boolean>,
) {
  const failed = Object.entries(facts)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (!Object.keys(facts).length || failed.length)
    throw new Error(
      `semantic boundary ${id} failed: ${failed.join(",") || "no facts"}`,
    );
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Dynamic port unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function probeHttp(url: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).status < 500) return true;
    } catch {
      await delay(100);
      continue;
    }
    await delay(100);
  }
  throw new Error(`Readiness probe failed: ${url}`);
}

export interface SystemHarness {
  webUrl: string;
  apiUrl: string;
  admin: typeof admin;
  providers: SystemProviders;
  logs: string[];
  readiness(): Promise<
    Record<
      | "postgres"
      | "api"
      | "web"
      | "manager"
      | "worker"
      | "baileys"
      | "deepSeek",
      boolean
    >
  >;
  receiveText(
    email: string,
    chat: string,
    text: string,
  ): Promise<{
    connectionId: string;
    remoteJid: string;
    providerMessageId: string;
    outcome: string;
  }>;
  receiveGroup(email: string): Promise<string>;
  receive(
    email: string,
    overrides?: Partial<InboundWhatsAppEvent>,
  ): Promise<{
    connectionId: string;
    remoteJid: string;
    providerMessageId: string;
    outcome: string;
  }>;
  receiveUnknown(): Promise<{ outcome: string }>;
  expireSessions(email: string): Promise<void>;
  expireLinkCode(email: string): Promise<void>;
  restartManager(): Promise<void>;
  restartWorker(): Promise<void>;
  recoverWorker(
    email: string,
    overrides?: Partial<InboundWhatsAppEvent>,
  ): Promise<void>;
  evidence(): Promise<{
    outbound: Array<{ email: string; state: string }>;
    technical: Array<{ email: string; code: string; details: object }>;
    audit: Array<{ email: string; type: string; metadata: object }>;
    tenants: Array<{ email: string; messages: number }>;
  }>;
  summaryEvidence(): Promise<
    Array<{ email: string; version: number; coveredThrough: number }>
  >;
  deliveryEvidence(): Promise<
    Array<{ connection_id: string; state: string; provider_message_id: string }>
  >;
  outboxEvidence(
    providerMessageId: string,
  ): Promise<{ persisted: boolean; published: boolean; sent: boolean }>;
  stop(): Promise<void>;
}

export async function startSystem(): Promise<SystemHarness> {
  const cleanup: Array<() => Promise<void>> = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const errors: unknown[] = [];
    for (const close of cleanup.reverse())
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length)
      throw new AggregateError(errors, "System E2E cleanup failed");
  };
  try {
    const database = await startTestPostgres();
    cleanup.push(() => database.stop());
    await applyPostgresMigrations(
      database.sql,
      join(process.cwd(), "packages/db/migrations"),
    );
    await database.sql`insert into auth_identities(normalized_email,password_phc,role) values(${admin.email},${await hash(admin.password, { algorithm: Algorithm.Argon2id })},'platform_admin')`;

    const providers = new SystemProviders();
    providers.start();
    cleanup.push(async () => providers.stop());
    const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
    const webUrl = `http://localhost:${webPort}`,
      apiOrigin = `http://127.0.0.1:${apiPort}`;
    const common: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: database.container.getConnectionUri(),
      WORKER_DATABASE_URL: database.container.getConnectionUri(),
      WHATSAPP_LINK_CODE_KEY: Buffer.alloc(32, 8).toString("base64"),
    };
    const managerEnv = {
      ...common,
      BAILEYS_KMS_VERSION: "e2e-v1",
      BAILEYS_KMS_KEY: Buffer.alloc(32, 7).toString("base64"),
      WHATSAPP_MANAGER_ID: "e2e-manager",
      WHATSAPP_COMMAND_POLL_MS: "25",
    };
    const workerEnv = {
      ...common,
      DEEPSEEK_API_KEY: "E2E_PROVIDER_SECRET",
      DEEPSEEK_MODEL: "deterministic",
    };
    const api = await startApi({
      ...common,
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      APP_ORIGIN: webUrl,
    });
    cleanup.push(async () => {
      await api.app.close();
      await api.pools.end();
    });
    let manager = await startWhatsAppManager(
      managerEnv,
      providers.baileys.factory,
    );
    cleanup.push(() => manager.stop());
    let worker = await startMessageWorker(
      workerEnv,
      providers.deepSeek.fetcher as typeof fetch,
    );
    cleanup.push(() => worker.stop());

    const logs: string[] = [];
    const web = spawn(
      join(process.cwd(), "apps/web/node_modules/.bin/next"),
      ["dev", "--hostname", "127.0.0.1", "--port", String(webPort)],
      {
        cwd: join(process.cwd(), "apps/web"),
        env: { ...process.env, AGENDIA_API_ORIGIN: apiOrigin },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const stream of [web.stdout, web.stderr])
      stream?.on("data", (chunk) => logs.push(String(chunk)));
    cleanup.push(async () => {
      if (web.exitCode !== null) return;
      web.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        web.once("exit", () => resolve());
        setTimeout(resolve, 5_000);
      });
    });

    const readiness = async () => {
      await database.sql`select 1`;
      await Promise.all([
        probeHttp(`${apiOrigin}/auth/session`),
        probeHttp(webUrl),
      ]);
      await manager.pools.manager.run(undefined, (repo) =>
        repo.restorableWhatsApp(),
      );
      await worker.pools.worker.run(undefined, (repo) =>
        repo.conversationTexts(),
      );
      return {
        postgres: true,
        api: true,
        web: true,
        manager: true,
        worker: true,
        ...providers.probe(),
      };
    };
    await readiness();
    const connection = async (email: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const row = (
          await database.sql<
            {
              connection_id: string;
              session_public_id: string;
              linked_number: string;
            }[]
          >`select w.id connection_id,w.session_public_id,w.linked_number from whatsapp_connections w join auth_identities i on i.business_id=w.business_id where i.normalized_email=${email} and w.state='CONNECTED'`
        )[0];
        if (row) return row;
        await delay(100);
      }
      throw new Error(`Connected session unavailable for ${email}`);
    };
    let inboundSequence = 0;
    const receive = async (
      email: string,
      overrides: Partial<InboundWhatsAppEvent> = {},
    ) => {
      const row = await connection(email),
        sequence = ++inboundSequence;
      const event: InboundWhatsAppEvent = {
        sessionPublicId: row.session_public_id,
        providerMessageId: `system-${sequence}`,
        remoteJid: `chat-${sequence}@s.whatsapp.net`,
        chatType: "individual",
        fromMe: false,
        kind: "text",
        text: "consulta",
        receivedAt: Date.now(),
        ...overrides,
      };
      if (event.chatType === "group" && !event.remoteJid.endsWith("@g.us"))
        event.remoteJid = `group-${sequence}@g.us`;
      const message =
        event.kind === "text"
          ? { conversation: event.text }
          : event.kind === "image"
            ? { imageMessage: {} }
            : event.kind === "audio"
              ? { audioMessage: {} }
              : event.kind === "video"
                ? { videoMessage: {} }
                : { documentMessage: {} };
      await providers.baileys.emit(row.linked_number, {
        key: {
          id: event.providerMessageId,
          remoteJid: event.remoteJid,
          fromMe: event.fromMe,
        },
        message,
        messageTimestamp: Math.floor(event.receivedAt / 1_000),
      });
      const inbox =
          await database.sql`select id from inbox_events where stable_key=${event.providerMessageId}`,
        stored =
          await database.sql`select id from messages where provider_message_id=${event.providerMessageId}`;
      if (!inbox.length)
        throw new Error(
          `socket ingress did not persist ${event.providerMessageId}`,
        );
      const outcome =
        event.chatType === "group"
          ? "ignored_group"
          : event.fromMe
            ? "ignored_from_me"
            : event.kind !== "text"
              ? "ignored_non_text"
              : stored.length
                ? "accepted"
                : "automation_inactive";
      return {
        connectionId: row.connection_id,
        remoteJid: event.remoteJid,
        providerMessageId: event.providerMessageId,
        outcome,
      };
    };
    const evidence = async () => ({
      outbound: await database.sql<
        { email: string; state: string }[]
      >`select i.normalized_email email,o.state from outbound_commands o join auth_identities i on i.business_id=o.business_id order by o.created_at`,
      technical: await database.sql<
        { email: string; code: string; details: object }[]
      >`select i.normalized_email email,t.code,t.safe_details details from technical_events t join auth_identities i on i.business_id=t.business_id order by t.occurred_at`,
      audit: await database.sql<
        { email: string; type: string; metadata: object }[]
      >`select i.normalized_email email,a.event_type type,a.metadata from audit_events a join auth_identities i on i.business_id=a.business_id order by a.occurred_at`,
      tenants: await database.sql<
        { email: string; messages: number }[]
      >`select i.normalized_email email,(select count(*)::int from messages m where m.business_id=i.business_id) messages from auth_identities i where i.role='business_user' order by email`,
    });
    return {
      webUrl,
      apiUrl: apiOrigin,
      admin,
      providers,
      logs,
      readiness,
      evidence,
      receive: (email, overrides) => receive(email, overrides),
      receiveText: (email, chat, text) =>
        receive(email, { remoteJid: chat, text }),
      receiveGroup: async (email) =>
        (
          await receive(email, {
            remoteJid: "group@g.us",
            chatType: "group",
            text: "ignored",
          })
        ).outcome,
      receiveUnknown: async () => {
        const email = (
            await database.sql<
              { normalized_email: string }[]
            >`select normalized_email from auth_identities where role='business_user' order by normalized_email limit 1`
          )[0]!.normalized_email,
          row = await connection(email),
          id = `unknown-${++inboundSequence}`;
        await database.sql`update whatsapp_connections set session_public_id=${randomUUID()} where id=${row.connection_id}`;
        await providers.baileys.emit(row.linked_number, {
          key: { id, remoteJid: "unknown@s.whatsapp.net", fromMe: false },
          message: { conversation: "unknown" },
        });
        await database.sql`update whatsapp_connections set session_public_id=${row.session_public_id} where id=${row.connection_id}`;
        return {
          outcome: (
            await database.sql`select id from inbox_events where stable_key=${id}`
          ).length
            ? "unexpected"
            : "unknown_session",
        };
      },
      expireSessions: async (email) => {
        await database.sql`update web_sessions set absolute_expires_at=now()-interval '1 second' where identity_id in(select id from auth_identities where normalized_email=${email})`;
      },
      expireLinkCode: async (email) => {
        await database.sql`update whatsapp_link_codes set expires_at=now()-interval '1 second' where business_id=(select business_id from auth_identities where normalized_email=${email})`;
      },
      restartManager: async () => {
        await manager.stop();
        manager = await startWhatsAppManager(
          managerEnv,
          providers.baileys.factory,
        );
        await readiness();
      },
      restartWorker: async () => {
        await worker.stop();
        worker = await startMessageWorker(
          workerEnv,
          providers.deepSeek.fetcher as typeof fetch,
        );
        await readiness();
      },
      recoverWorker: async (email, overrides) => {
        await worker.stop();
        await receive(email, overrides);
        worker = await startMessageWorker(
          workerEnv,
          providers.deepSeek.fetcher as typeof fetch,
        );
      },
      summaryEvidence: () =>
        database.sql`select i.normalized_email email,s.version,s.covered_through::int "coveredThrough" from conversation_summaries s join auth_identities i on i.business_id=s.business_id order by email,s.version`,
      deliveryEvidence: () =>
        database.sql`select connection_id,state,provider_message_id from outbound_commands order by created_at`,
      outboxEvidence: async (providerMessageId) => {
        const outbox = (
          await database.sql<
            { published: boolean }[]
          >`select published_at is not null published from outbox_events where stable_key=${`ai:${providerMessageId}`}`
        )[0];
        const sent =
          (
            await database.sql`select o.outbound_id from outbound_commands o join messages m on m.id=o.source_message_id where m.provider_message_id=${providerMessageId} and o.state='sent'`
          ).length > 0;
        return {
          persisted: Boolean(outbox),
          published: Boolean(outbox?.published),
          sent,
        };
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
