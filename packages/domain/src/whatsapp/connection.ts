export type WhatsAppConnectionState =
  | "LINK_REQUIRED"
  | "LINKING"
  | "CONNECTED"
  | "RECONNECTING"
  | "DISCONNECTED"
  | "ERROR";

export type PublicWhatsAppStatus = "link_required" | "connected" | "disconnected" | "error";

export interface WhatsAppConnection {
  id: string;
  businessId: string;
  state: WhatsAppConnectionState;
  linkedNumber: string | null;
  linkedAt: number | null;
  lastConnectedAt: number | null;
  ownerId: string | null;
  heartbeatAt: number | null;
  version: number;
}

const TRANSITIONS: Readonly<Record<WhatsAppConnectionState, readonly WhatsAppConnectionState[]>> = {
  LINK_REQUIRED: ["LINKING"],
  LINKING: ["CONNECTED", "LINK_REQUIRED", "ERROR"],
  CONNECTED: ["RECONNECTING", "DISCONNECTED", "LINK_REQUIRED", "ERROR"],
  RECONNECTING: ["CONNECTED", "DISCONNECTED", "LINK_REQUIRED", "ERROR"],
  DISCONNECTED: ["CONNECTED", "RECONNECTING", "LINK_REQUIRED", "ERROR"],
  ERROR: ["LINK_REQUIRED"],
};

export function projectWhatsAppStatus(state: WhatsAppConnectionState): PublicWhatsAppStatus {
  if (state === "CONNECTED") return "connected";
  if (state === "LINK_REQUIRED") return "link_required";
  if (state === "ERROR") return "error";
  return "disconnected";
}

export class InMemoryWhatsAppConnections {
  readonly rows = new Map<string, WhatsAppConnection>();
}

export class WhatsAppConnectionService {
  constructor(private readonly repository: InMemoryWhatsAppConnections) {}

  ensureConnection(businessId: string): WhatsAppConnection {
    const existing = this.repository.rows.get(businessId);
    if (existing) return existing;
    const connection: WhatsAppConnection = {
      id: `wa-${businessId}`,
      businessId,
      state: "LINK_REQUIRED",
      linkedNumber: null,
      linkedAt: null,
      lastConnectedAt: null,
      ownerId: null,
      heartbeatAt: null,
      version: 0,
    };
    this.repository.rows.set(businessId, connection);
    return connection;
  }

  createSecondConnection(businessId: string): never {
    if (this.repository.rows.has(businessId)) throw new Error("Only one WhatsApp connection is allowed per business");
    throw new Error("Use ensureConnection to create the one WhatsApp connection");
  }

  get(businessId: string): WhatsAppConnection | null {
    return this.repository.rows.get(businessId) ?? null;
  }

  transition(businessId: string, next: WhatsAppConnectionState, now: number, linkedNumber?: string): WhatsAppConnection {
    const current = this.ensureConnection(businessId);
    if (!TRANSITIONS[current.state].includes(next)) throw new Error(`Invalid WhatsApp transition: ${current.state} -> ${next}`);
    const connected = next === "CONNECTED";
    const updated: WhatsAppConnection = {
      ...current,
      state: next,
      version: current.version + 1,
      linkedNumber: linkedNumber ?? current.linkedNumber,
      linkedAt: connected && current.linkedAt === null ? now : current.linkedAt,
      lastConnectedAt: connected ? now : current.lastConnectedAt,
    };
    this.repository.rows.set(businessId, updated);
    return updated;
  }

  claimLease(businessId: string, ownerId: string, now: number): WhatsAppConnection {
    const current = this.ensureConnection(businessId);
    const updated = { ...current, ownerId, heartbeatAt: now, version: current.version + 1 };
    this.repository.rows.set(businessId, updated);
    return updated;
  }

  canSend(businessId: string, businessStatus: "active" | "suspended"): boolean {
    return businessStatus === "active" && this.repository.rows.get(businessId)?.state === "CONNECTED";
  }
}
