import {
    classifyInbound,
    type InboundResult,
    type InboundWhatsAppEvent,
} from "../../../apps/whatsapp-manager/src/inbound-handler.ts";

interface RoutedSession {
    businessId: string;
    businessStatus: "active" | "suspended";
    assistantActive: boolean;
}

export class InMemorySessionRouter {
    private readonly sessions = new Map<string, RoutedSession>();
    add(sessionPublicId: string, session: RoutedSession): void {
        this.sessions.set(sessionPublicId, session);
    }
    resolve(sessionPublicId: string): RoutedSession | null {
        return this.sessions.get(sessionPublicId) ?? null;
    }
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
    readonly aiJobs: Array<{
        businessId: string;
        conversationKey: string;
        sequence: number;
    }> = [];
    readonly technicalEvents: Array<{ businessId: string; code: string }> = [];
    tenantTouches = 0;

    transact<T>(operation: () => T): T {
        this.tenantTouches += 1;
        return operation();
    }
}

export class InboundMessageHandler {
    constructor(
        private readonly router: InMemorySessionRouter,
        private readonly repository: InMemoryInboundRepository,
    ) {}

    handle(event: InboundWhatsAppEvent): InboundResult {
        const session = this.router.resolve(event.sessionPublicId);
        if (!session) return { outcome: "unknown_session" };
        return this.repository.transact(() => {
            const inboxKey = `${event.sessionPublicId}:${event.providerMessageId}`;
            if (this.repository.inbox.has(inboxKey))
                return { outcome: "duplicate" };
            this.repository.inbox.add(inboxKey);
            const classification = classifyInbound(event);
            if (classification !== "accepted") {
                this.repository.technicalEvents.push({
                    businessId: session.businessId,
                    code: classification,
                });
                return { outcome: classification };
            }
            if (session.businessStatus !== "active" || !session.assistantActive)
                return { outcome: "automation_inactive" };
            const conversationKey = `${event.sessionPublicId}:${event.remoteJid}`;
            const sequence =
                this.repository.messages.filter(
                    (message) => message.conversationKey === conversationKey,
                ).length + 1;
            this.repository.messages.push({
                businessId: session.businessId,
                conversationKey,
                providerMessageId: event.providerMessageId,
                sequence,
                text: event.text!,
                receivedAt: event.receivedAt,
            });
            this.repository.aiJobs.push({
                businessId: session.businessId,
                conversationKey,
                sequence,
            });
            return { outcome: "accepted", sequence };
        });
    }
}
