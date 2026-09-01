import type { WhatsAppConnectionService } from "@agendia/domain";
import type {
  BaileysLifecycleEvent,
  WhatsAppGateway,
} from "../../../apps/whatsapp-manager/src/lifecycle.ts";

export class DeterministicBaileysDouble implements WhatsAppGateway {
  private events: BaileysLifecycleEvent[] = [];
  script(events: BaileysLifecycleEvent[]): void {
    this.events = [...events];
  }
  connect(
    _connectionId: string,
    onEvent: (event: BaileysLifecycleEvent) => void,
  ): void {
    for (const event of this.events) onEvent(event);
    this.events = [];
  }
}

interface LinkCommand {
  businessId: string;
  stableKey: string;
}
export class DurableLinkCommands {
  private readonly pending: LinkCommand[] = [];
  enqueue(businessId: string): void {
    if (!this.pending.some((command) => command.businessId === businessId)) {
      this.pending.push({ businessId, stableKey: `link:${businessId}` });
    }
  }
  claim(): LinkCommand | null {
    return this.pending.shift() ?? null;
  }
}

interface LinkCode {
  businessId: string;
  value: string;
  expiresAt: number;
}
export class EphemeralLinkCodeStore {
  private readonly codes = new Map<string, LinkCode>();
  put(
    businessId: string,
    connectionId: string,
    value: string,
    now: number,
  ): void {
    this.codes.set(connectionId, {
      businessId,
      value,
      expiresAt: now + 5 * 60_000,
    });
  }
  consume(
    businessId: string,
    connectionId: string,
    now: number,
  ): string | null {
    const code = this.codes.get(connectionId);
    if (!code || code.businessId !== businessId || now >= code.expiresAt)
      return null;
    this.codes.delete(connectionId);
    return code.value;
  }
}

export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(1_000 * 2 ** attempt, 60_000);
  return Math.min(Math.round(base + base * 0.2 * random()), 60_000);
}

export class WhatsAppLifecycleManager {
  readonly activity: Array<{ businessId: string; code: string }> = [];
  constructor(
    private readonly connections: WhatsAppConnectionService,
    private readonly gateway: WhatsAppGateway,
    private readonly commands: DurableLinkCommands,
    private readonly links: EphemeralLinkCodeStore,
  ) {}

  requestLink(businessId: string): void {
    const connection = this.connections.ensureConnection(businessId);
    if (connection.state !== "LINK_REQUIRED" && connection.state !== "ERROR")
      throw new Error("WhatsApp connection already linked");
    if (connection.state === "ERROR")
      this.connections.transition(businessId, "LINK_REQUIRED", Date.now());
    this.commands.enqueue(businessId);
  }

  async processNext(now: number): Promise<boolean> {
    const command = this.commands.claim();
    if (!command) return false;
    const connection = this.connections.ensureConnection(command.businessId);
    this.connections.transition(command.businessId, "LINKING", now);
    this.activity.push({
      businessId: command.businessId,
      code: "whatsapp.link.started",
    });
    await this.gateway.connect(connection.id, (event) =>
      this.apply(command.businessId, connection.id, event, now),
    );
    return true;
  }

  restorePersistedSessions(businessIds: string[]): string[] {
    return businessIds.flatMap((businessId) => {
      const connection = this.connections.get(businessId);
      return connection &&
        ["CONNECTED", "RECONNECTING", "DISCONNECTED"].includes(connection.state)
        ? [connection.id]
        : [];
    });
  }

  private apply(
    businessId: string,
    connectionId: string,
    event: BaileysLifecycleEvent,
    now: number,
  ): void {
    if (event.type === "qr")
      this.links.put(businessId, connectionId, event.value, now);
    if (event.type === "open")
      this.connections.transition(
        businessId,
        "CONNECTED",
        now,
        event.linkedNumber,
      );
    if (event.type === "transient-close") {
      this.connections.transition(businessId, "RECONNECTING", now);
      this.activity.push({ businessId, code: "whatsapp.reconnecting" });
    }
    if (event.type === "logout") {
      this.connections.transition(businessId, "LINK_REQUIRED", now);
      this.activity.push({ businessId, code: "whatsapp.link_required" });
    }
    if (event.type === "corrupt") {
      this.connections.transition(businessId, "ERROR", now);
      this.activity.push({ businessId, code: "whatsapp.auth_corrupt" });
    }
  }
}
