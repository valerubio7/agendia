import { tenantContext, type createRuntimePools } from "@agendia/db";

export type InboundMessageKind =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document";
export interface InboundWhatsAppEvent {
  sessionPublicId: string;
  providerMessageId: string;
  remoteJid: string;
  chatType: "individual" | "group";
  fromMe: boolean;
  kind: InboundMessageKind;
  text: string | null;
  receivedAt: number;
}

export type InboundOutcome =
  | "unknown_session"
  | "duplicate"
  | "ignored_group"
  | "ignored_from_me"
  | "ignored_non_text"
  | "automation_inactive"
  | "accepted";
export interface InboundResult {
  outcome: InboundOutcome;
  sequence?: number;
}

export function classifyInbound(
  event: InboundWhatsAppEvent,
):
  | Exclude<
      InboundOutcome,
      "unknown_session" | "duplicate" | "automation_inactive" | "accepted"
    >
  | "accepted" {
  if (event.chatType === "group") return "ignored_group";
  if (event.fromMe) return "ignored_from_me";
  if (event.kind !== "text" || event.text === null) return "ignored_non_text";
  return "accepted";
}

type Pools = ReturnType<typeof createRuntimePools>;
export class PostgresInboundHandler {
  constructor(private pools: Pools) {}
  async handle(event: InboundWhatsAppEvent): Promise<InboundResult> {
    const route = await this.pools.manager.run(undefined, (r) =>
      r.routeSession(event.sessionPublicId),
    );
    if (!route) return { outcome: "unknown_session" };
    let outcome: InboundOutcome = classifyInbound(event);
    if (
      outcome === "accepted" &&
      (route.business_status !== "active" || !route.assistant_active)
    )
      outcome = "automation_inactive";
    const context = tenantContext({
      businessId: route.business_id,
      actorId: "whatsapp-manager",
      role: "internal_worker",
      requestId: `inbound:${event.providerMessageId}`,
    });
    const stored = await this.pools.manager.run(context, (r) =>
      r.ingestInbound({
        businessId: route.business_id,
        connectionId: route.connection_id,
        providerId: event.providerMessageId,
        remoteJid: event.remoteJid,
        text: event.text,
        receivedAt: new Date(event.receivedAt),
        classification: outcome,
      }),
    );
    if (!stored) return { outcome: "duplicate" };
    if (outcome !== "accepted") return { outcome };
    if (stored.sequence === undefined)
      throw new Error("accepted message was not persisted");
    return { outcome: "accepted", sequence: stored.sequence };
  }
}
