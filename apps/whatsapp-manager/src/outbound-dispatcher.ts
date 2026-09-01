import { tenantContext, type createRuntimePools } from "@agendia/db";

export interface OutboundGateway {
  send(command: {
    connectionId: string;
    outboundId: string;
    remoteJid: string;
    text: string;
  }): Promise<
    { outcome: "ack"; providerMessageId: string } | { outcome: "rejected" }
  >;
}

type Pools = ReturnType<typeof createRuntimePools>;
export class PostgresOutboundDispatcher {
  constructor(
    private pools: Pools,
    private gateway: OutboundGateway,
    private managerId: string,
  ) {}
  async dispatchNext(): Promise<boolean> {
    const row = await this.pools.manager.run(undefined, (r) =>
      r.claimOwnedOutbound(this.managerId),
    );
    if (!row) return false;
    const context = tenantContext({
      businessId: row.business_id,
      actorId: this.managerId,
      role: "internal_worker",
      requestId: `outbound:${row.outbound_id}`,
    });
    try {
      const result = await this.gateway.send({
        connectionId: row.connection_id,
        outboundId: row.outbound_id,
        remoteJid: row.remote_jid,
        text: row.text,
      });
      await this.pools.manager.run(context, (r) =>
        r.finishOutbound(
          row.outbound_id,
          result.outcome === "ack" ? "sent" : "failed",
          result.outcome === "ack" ? result.providerMessageId : undefined,
        ),
      );
    } catch {
      await this.pools.manager.run(context, (r) =>
        r.finishOutbound(row.outbound_id, "delivery_unknown"),
      );
    }
    return true;
  }
}
