import { tenantContext, type createRuntimePools } from "@agendia/db";

export type InboundMessageKind = "text" | "image" | "audio" | "video" | "document";
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

interface RoutedSession {
  businessId: string;
  businessStatus: "active" | "suspended";
  assistantActive: boolean;
}

export class InMemorySessionRouter {
  private readonly sessions = new Map<string, RoutedSession>();
  add(sessionPublicId: string, session: RoutedSession): void { this.sessions.set(sessionPublicId, session); }
  resolve(sessionPublicId: string): RoutedSession | null { return this.sessions.get(sessionPublicId) ?? null; }
}

export interface StoredInboundMessage {
  businessId: string;
  conversationKey: string;
  providerMessageId: string;
  sequence: number;
  text: string;
  receivedAt: number;
}

export class InMemoryInboundRepository {
  readonly inbox = new Set<string>();
  readonly messages: StoredInboundMessage[] = [];
  readonly aiJobs: Array<{ businessId: string; conversationKey: string; sequence: number }> = [];
  readonly technicalEvents: Array<{ businessId: string; code: string }> = [];
  tenantTouches = 0;

  transact<T>(operation: () => T): T {
    this.tenantTouches += 1;
    return operation();
  }
}

export type InboundOutcome = "unknown_session" | "duplicate" | "ignored_group" | "ignored_from_me" | "ignored_non_text" | "automation_inactive" | "accepted";
export interface InboundResult { outcome: InboundOutcome; sequence?: number }

export function classifyInbound(event: InboundWhatsAppEvent): Exclude<InboundOutcome, "unknown_session" | "duplicate" | "automation_inactive" | "accepted"> | "accepted" {
  if (event.chatType === "group") return "ignored_group";
  if (event.fromMe) return "ignored_from_me";
  if (event.kind !== "text" || event.text === null) return "ignored_non_text";
  return "accepted";
}

export class InboundMessageHandler {
  constructor(private readonly router: InMemorySessionRouter, private readonly repository: InMemoryInboundRepository) {}

  handle(event: InboundWhatsAppEvent): InboundResult {
    const session = this.router.resolve(event.sessionPublicId);
    if (!session) return { outcome: "unknown_session" };
    return this.repository.transact(() => {
      const inboxKey = `${event.sessionPublicId}:${event.providerMessageId}`;
      if (this.repository.inbox.has(inboxKey)) return { outcome: "duplicate" };
      this.repository.inbox.add(inboxKey);
      const classification = classifyInbound(event);
      if (classification !== "accepted") {
        this.repository.technicalEvents.push({ businessId: session.businessId, code: classification });
        return { outcome: classification };
      }
      if (session.businessStatus !== "active" || !session.assistantActive) return { outcome: "automation_inactive" };
      const conversationKey = `${event.sessionPublicId}:${event.remoteJid}`;
      const sequence = this.repository.messages.filter((message) => message.conversationKey === conversationKey).length + 1;
      this.repository.messages.push({
        businessId: session.businessId,
        conversationKey,
        providerMessageId: event.providerMessageId,
        sequence,
        text: event.text!,
        receivedAt: event.receivedAt,
      });
      this.repository.aiJobs.push({ businessId: session.businessId, conversationKey, sequence });
      return { outcome: "accepted", sequence };
    });
  }
}

type Pools=ReturnType<typeof createRuntimePools>;
export class PostgresInboundHandler{
  constructor(private pools:Pools){}
  async handle(event:InboundWhatsAppEvent):Promise<InboundResult>{
    const route=await this.pools.manager.run(undefined,r=>r.routeSession(event.sessionPublicId)); if(!route)return{outcome:"unknown_session"};
    let outcome:InboundOutcome=classifyInbound(event); if(outcome==="accepted"&&(route.business_status!=="active"||!route.assistant_active))outcome="automation_inactive";
    const context=tenantContext({businessId:route.business_id,actorId:"whatsapp-manager",role:"internal_worker",requestId:`inbound:${event.providerMessageId}`});
    const stored=await this.pools.manager.run(context,r=>r.ingestInbound({businessId:route.business_id,connectionId:route.connection_id,providerId:event.providerMessageId,remoteJid:event.remoteJid,text:event.text,receivedAt:new Date(event.receivedAt),classification:outcome}));
    if(!stored)return{outcome:"duplicate"}; if(outcome!=="accepted")return{outcome};
    if(stored.sequence===undefined)throw new Error("accepted message was not persisted");return{outcome:"accepted",sequence:stored.sequence};
  }
}
