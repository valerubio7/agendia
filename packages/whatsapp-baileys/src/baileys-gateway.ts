import makeWASocket, {
  Browsers,
  BufferJSON,
  fetchLatestWaWebVersion,
  initAuthCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import type { BaileysLifecycleEvent } from "../../../apps/whatsapp-manager/src/lifecycle.ts";
import type { BaileysAuthStore } from "./auth-store.ts";

type Update = {
  qr?: string;
  connection?: string;
  lastDisconnect?: { error?: unknown };
};
type RawContent = {
  conversation?: unknown;
  extendedTextMessage?: { text?: unknown } | null;
  imageMessage?: unknown;
  audioMessage?: unknown;
  videoMessage?: unknown;
  documentMessage?: unknown;
};
type RawMessage = {
  key?: {
    id?: string | null;
    remoteJid?: string | null;
    fromMe?: boolean | null;
  };
  message?: RawContent | null;
  messageTimestamp?: number | { toNumber(): number } | null;
};
export type NormalizedInboundEvent = {
  sessionPublicId: string;
  providerMessageId: string;
  remoteJid: string;
  chatType: "individual" | "group";
  fromMe: boolean;
  kind: "text" | "image" | "audio" | "video" | "document";
  text: string | null;
  receivedAt: number;
};
export type BaileysSocket = {
  user?: { id: string };
  ready?: Promise<void>;
  ev: { on(name: string, listener: (value: any) => unknown): void };
  sendMessage?(
    jid: string,
    content: { text: string },
    options?: { messageId?: string },
  ): Promise<{ key?: { id?: string } }>;
  end?(error?: Error): void;
};
export type SocketFactory = (options: Record<string, unknown>) => BaileysSocket;
export type WhatsAppVersion = [number, number, number];
export type WhatsAppVersionResolver = () => Promise<{
  version: WhatsAppVersion;
  isLatest?: boolean;
}>;
export type DefaultSocketDependencies = {
  socketFactory: SocketFactory;
  versionResolver?: WhatsAppVersionResolver;
};
export interface GatewayLease {
  closed: Promise<void>;
  close(): void;
}

const defaultSocketDependencies: DefaultSocketDependencies = {
  // SAFETY: Baileys accepts a richer socket configuration and returns the subset used by this gateway.
  socketFactory: makeWASocket as unknown as SocketFactory,
  versionResolver: fetchLatestWaWebVersion,
};
const browserIdentity = Browsers.ubuntu("Chrome");
const jidPattern = /^[^@\s]+@(s\.whatsapp\.net|lid|g\.us)$/;
export function normalizeBaileysMessage(
  sessionPublicId: string,
  raw: RawMessage,
): NormalizedInboundEvent | null {
  const providerMessageId = raw.key?.id ?? "",
    remoteJid = raw.key?.remoteJid ?? "",
    message = raw.message;
  if (!providerMessageId || !jidPattern.test(remoteJid) || !message)
    return null;
  const text =
    typeof message.conversation === "string"
      ? message.conversation
      : typeof message.extendedTextMessage?.text === "string"
        ? message.extendedTextMessage.text
        : null;
  const kind =
    text === null
      ? message.imageMessage
        ? "image"
        : message.audioMessage
          ? "audio"
          : message.videoMessage
            ? "video"
            : message.documentMessage
              ? "document"
              : null
      : "text";
  if (!kind) return null;
  const timestamp =
    typeof raw.messageTimestamp === "object"
      ? raw.messageTimestamp?.toNumber()
      : raw.messageTimestamp;
  return {
    sessionPublicId,
    providerMessageId,
    remoteJid,
    chatType: remoteJid.endsWith("@g.us") ? "group" : "individual",
    fromMe: raw.key?.fromMe === true,
    kind,
    text,
    receivedAt: timestamp ? timestamp * 1_000 : Date.now(),
  };
}
const individualJid = /^[^@\s]+@(s\.whatsapp\.net|lid)$/;

export class BaileysAuthStateAdapter {
  constructor(
    private readonly store: Pick<
      BaileysAuthStore,
      "read" | "write" | "version"
    >,
  ) {}
  private revive(value: unknown) {
    return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
  }
  private persistable(value: unknown) {
    try {
      return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    } catch {
      throw new Error("Baileys auth state serialization failed");
    }
  }
  async load(
    businessId: string,
    connectionId: string,
  ): Promise<{ state: AuthenticationState; saveCreds(): Promise<void> }> {
    const creds =
      this.revive(await this.store.read(businessId, connectionId, "creds")) ??
      initAuthCreds();
    const keys = {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ) => {
        const result: Partial<Record<string, SignalDataTypeMap[T]>> = {};
        for (const id of ids) {
          const value = this.revive(
            await this.store.read(businessId, connectionId, `${type}:${id}`),
          );
          if (value != null) result[id] = value;
        }
        return result as Record<string, SignalDataTypeMap[T]>;
      },
      set: async (data: SignalDataSet) => {
        for (const [type, values] of Object.entries(data))
          for (const [id, value] of Object.entries(values ?? {})) {
            const name = `${type}:${id}`;
            await this.store.write(
              businessId,
              connectionId,
              name,
              this.persistable(value),
              await this.store.version(connectionId, name),
            );
          }
      },
    };
    return {
      state: { creds, keys },
      saveCreds: async () => {
        await this.store.write(
          businessId,
          connectionId,
          "creds",
          this.persistable(creds),
          await this.store.version(connectionId, "creds"),
        );
      },
    };
  }
}

export class BaileysGateway {
  private readonly active = new Map<string, BaileysSocket>();
  private readonly sockets: SocketFactory;
  private readonly versionResolver: WhatsAppVersionResolver | undefined;
  constructor(
    private readonly auth: (
      connectionId: string,
    ) => ReturnType<BaileysAuthStateAdapter["load"]>,
    socketFactory?: SocketFactory,
    private readonly log: (record: Record<string, unknown>) => void = () =>
      undefined,
    defaults: DefaultSocketDependencies = defaultSocketDependencies,
  ) {
    this.sockets = socketFactory ?? defaults.socketFactory;
    this.versionResolver =
      socketFactory === undefined ? defaults.versionResolver : undefined;
  }
  async connect(
    connectionId: string,
    onEvent: (event: BaileysLifecycleEvent) => unknown,
    onInbound: (event: NormalizedInboundEvent) => unknown = () => undefined,
    sessionPublicId = connectionId,
  ): Promise<GatewayLease> {
    const auth = await this.auth(connectionId);
    const logger: Record<string, unknown> = { child: () => logger };
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"])
      logger[level] = () => undefined;
    const options: Record<string, unknown> = {
      auth: auth.state,
      browser: [...browserIdentity],
      printQRInTerminal: false,
      logger,
    };
    if (this.versionResolver)
      options.version = (await this.versionResolver()).version;
    const socket = this.sockets(options);
    this.active.set(connectionId, socket);
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    let pendingCreds = Promise.resolve(),
      authWriteFailed = false;
    socket.ev.on("creds.update", () => {
      pendingCreds = pendingCreds
        .then(() => auth.saveCreds())
        .catch(() => {
          authWriteFailed = true;
        });
      return pendingCreds;
    });
    socket.ev.on(
      "messages.upsert",
      async ({ messages }: { messages?: RawMessage[] }) => {
        for (const raw of messages ?? []) {
          const event = normalizeBaileysMessage(sessionPublicId, raw);
          if (event) await onInbound(event);
        }
      },
    );
    socket.ev.on("connection.update", async (update: Update) => {
      if (update.qr) await onEvent({ type: "qr", value: update.qr });
      if (update.connection === "open")
        await onEvent({
          type: "open",
          linkedNumber: socket.user?.id.split(":")[0] ?? "unknown",
        });
      if (update.connection !== "close") return;
      this.active.delete(connectionId);
      const candidateStatus = (
        update.lastDisconnect?.error as { output?: { statusCode?: unknown } }
      )?.output?.statusCode;
      const statusCode =
        typeof candidateStatus === "number" && Number.isFinite(candidateStatus)
          ? candidateStatus
          : "unknown";
      await pendingCreds;
      const type =
        authWriteFailed || statusCode === 500
          ? "corrupt"
          : statusCode === 401
            ? "logout"
            : "transient-close";
      this.log({ code: `whatsapp.${type}`, statusCode });
      await onEvent({ type });
      close();
    });
    await socket.ready;
    return {
      closed,
      close: () => {
        this.active.delete(connectionId);
        socket.end?.();
        close();
      },
    };
  }
  async send(command: {
    connectionId: string;
    outboundId: string;
    remoteJid: string;
    text: string;
  }) {
    const socket = this.active.get(command.connectionId);
    if (!socket?.sendMessage || !individualJid.test(command.remoteJid))
      return { outcome: "rejected" as const };
    try {
      const sent = await socket.sendMessage(command.remoteJid, {
        text: command.text,
      });
      return {
        outcome: "ack" as const,
        providerMessageId: sent.key?.id ?? command.outboundId,
      };
    } catch (error) {
      const candidateStatus = (error as { output?: { statusCode?: unknown } })
        .output?.statusCode;
      this.log({
        code: "whatsapp.send_failed",
        statusCode:
          typeof candidateStatus === "number" &&
          Number.isFinite(candidateStatus)
            ? candidateStatus
            : "unknown",
      });
      if ((error as { code?: string }).code === "WA_REJECTED")
        return { outcome: "rejected" as const };
      throw error;
    }
  }
}
