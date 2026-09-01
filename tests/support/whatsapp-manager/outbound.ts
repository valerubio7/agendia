import {
  transitionDelivery,
  type OutboundDeliveryState,
} from "@agendia/domain";
import type { OutboundGateway } from "../../../apps/whatsapp-manager/src/outbound-dispatcher.ts";

export interface OutboundRecord {
  outboundId: string;
  businessId: string;
  connectionId: string;
  remoteJid: string;
  text: string;
  state: OutboundDeliveryState;
  providerMessageId?: string;
}

export interface OwnedConnection {
  connectionId: string;
  state: "CONNECTED" | "DISCONNECTED" | "LINK_REQUIRED" | "ERROR";
  ownerId: string | null;
}

export class InMemoryOutboundRepository {
  private readonly rows = new Map<string, OutboundRecord>();
  readonly auditEvents: Array<{
    businessId: string;
    eventType: string;
    outcome: "success" | "failure";
  }> = [];
  readonly technicalEvents: Array<{ businessId: string; code: string }> = [];
  readonly aiJobs: Array<{ outboundId: string }> = [];

  add(record: OutboundRecord): void {
    this.rows.set(record.outboundId, { ...record });
  }

  get(outboundId: string): OutboundRecord | null {
    const record = this.rows.get(outboundId);
    return record ? { ...record } : null;
  }

  updateState(
    outboundId: string,
    state: OutboundDeliveryState,
    providerMessageId?: string,
  ): void {
    const current = this.rows.get(outboundId);
    if (!current) throw new Error("Unknown outbound delivery");
    const updated: OutboundRecord = { ...current, state };
    if (providerMessageId !== undefined)
      updated.providerMessageId = providerMessageId;
    this.rows.set(outboundId, updated);
  }
}

export class DeterministicOutboundGateway implements OutboundGateway {
  readonly calls: Array<{
    connectionId: string;
    outboundId: string;
    remoteJid: string;
    text: string;
  }> = [];

  constructor(private readonly result: "ack" | "rejected" | "crash") {}

  async send(command: {
    connectionId: string;
    outboundId: string;
    remoteJid: string;
    text: string;
  }) {
    this.calls.push(command);
    if (this.result === "crash")
      throw new Error("connection lost after send started");
    if (this.result === "rejected") return { outcome: "rejected" as const };
    return {
      outcome: "ack" as const,
      providerMessageId: `ack-${command.outboundId}`,
    };
  }
}

export class OutboundDispatcher {
  constructor(
    private readonly repository: InMemoryOutboundRepository,
    private readonly gateway: OutboundGateway,
    private readonly managerId = "manager-1",
  ) {}

  async dispatch(
    outboundId: string,
    connection: OwnedConnection,
  ): Promise<void> {
    const outbound = this.repository.get(outboundId);
    if (!outbound || outbound.state !== "generated") return;

    if (
      connection.state !== "CONNECTED" ||
      connection.connectionId !== outbound.connectionId ||
      connection.ownerId !== this.managerId
    ) {
      this.repository.technicalEvents.push({
        businessId: outbound.businessId,
        code: "whatsapp.connection_not_ready",
      });
      return;
    }

    this.repository.updateState(
      outboundId,
      transitionDelivery(outbound.state, "sending"),
    );
    try {
      const result = await this.gateway.send({
        connectionId: outbound.connectionId,
        outboundId: outbound.outboundId,
        remoteJid: outbound.remoteJid,
        text: outbound.text,
      });
      if (result.outcome === "rejected") {
        this.finishFailure(outbound, "failed", "whatsapp.outbound.rejected");
        return;
      }
      this.repository.updateState(
        outboundId,
        transitionDelivery("sending", "sent"),
        result.providerMessageId,
      );
      this.repository.auditEvents.push({
        businessId: outbound.businessId,
        eventType: "whatsapp.outbound.sent",
        outcome: "success",
      });
      this.repository.technicalEvents.push({
        businessId: outbound.businessId,
        code: "whatsapp.outbound.acknowledged",
      });
    } catch {
      this.finishFailure(
        outbound,
        "delivery_unknown",
        "whatsapp.outbound.delivery_unknown",
      );
    }
  }

  reconcileAck(outboundId: string, providerMessageId: string): boolean {
    const outbound = this.repository.get(outboundId);
    if (!outbound || outbound.state !== "sending") return false;
    this.repository.updateState(
      outboundId,
      transitionDelivery("sending", "sent"),
      providerMessageId,
    );
    return true;
  }

  reconcileFromMe(outboundId: string, providerMessageId: string): boolean {
    const outbound = this.repository.get(outboundId);
    if (!outbound || !["sent", "delivery_unknown"].includes(outbound.state))
      return false;
    this.repository.updateState(outboundId, outbound.state, providerMessageId);
    return true;
  }

  private finishFailure(
    outbound: OutboundRecord,
    state: "failed" | "delivery_unknown",
    code: string,
  ): void {
    this.repository.updateState(
      outbound.outboundId,
      transitionDelivery("sending", state),
    );
    this.repository.auditEvents.push({
      businessId: outbound.businessId,
      eventType: code,
      outcome: "failure",
    });
    this.repository.technicalEvents.push({
      businessId: outbound.businessId,
      code,
    });
  }
}
