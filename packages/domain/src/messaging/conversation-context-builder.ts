export interface ConversationTurn {
  id?: string;
  sequence: number;
  role: "customer" | "assistant";
  text: string;
  delivery?: "sent" | "failed" | "delivery_unknown";
}

export interface ConversationSummary {
  version: number;
  coveredThrough: number;
  facts: string[];
  requests: string[];
  commitments: string[];
  preferences: string[];
  openItems: string[];
}

const scopedKey = (businessId: string, conversationId: string) => `${businessId}:${conversationId}`;

export class InMemoryConversationHistory {
  private readonly raw = new Map<string, ConversationTurn[]>();
  private readonly summaries = new Map<string, ConversationSummary>();

  append(businessId: string, conversationId: string, turns: ConversationTurn[]): void {
    const key = scopedKey(businessId, conversationId);
    this.raw.set(key, [...(this.raw.get(key) ?? []), ...turns].sort((a, b) => a.sequence - b.sequence));
  }
  listRaw(businessId: string, conversationId: string): ConversationTurn[] {
    return [...(this.raw.get(scopedKey(businessId, conversationId)) ?? [])];
  }
  saveSummary(businessId: string, conversationId: string, summary: ConversationSummary): void {
    this.summaries.set(scopedKey(businessId, conversationId), structuredClone(summary));
  }
  summary(businessId: string, conversationId: string): ConversationSummary | null {
    return this.summaries.get(scopedKey(businessId, conversationId)) ?? null;
  }
  removeSummary(businessId: string, conversationId: string): void {
    this.summaries.delete(scopedKey(businessId, conversationId));
  }
}

interface BuildRequest {
  businessId: string;
  conversationId: string;
  currentGroupIds?: string[];
}

type BuildResult =
  | { status: "blocked"; reason: "summary_required" }
  | { status: "ready"; context: { summary: ConversationSummary | null; recent: ConversationTurn[]; representsThrough: number } };

function visibleTurn(turn: ConversationTurn): boolean {
  return turn.role === "customer" || turn.delivery === "sent";
}

export class ConversationContextBuilder {
  constructor(private readonly history: InMemoryConversationHistory) {}

  build(request: BuildRequest): BuildResult {
    if (!request.businessId || !request.conversationId) throw new Error("tenant and conversation are required");
    const raw = this.history.listRaw(request.businessId, request.conversationId);
    const eligible = raw.filter(visibleTurn);
    const summary = this.history.summary(request.businessId, request.conversationId);
    const currentGroup = new Set(request.currentGroupIds ?? []);
    // Choose the visible suffix first: exclusions must not refill older history.
    const recent = eligible.slice(-50).filter((turn) => !turn.id || !currentGroup.has(turn.id));
    return {
      status: "ready",
      context: {
        summary: summary ? structuredClone(summary) : null,
        recent,
        representsThrough: Math.max(summary?.coveredThrough ?? 0, ...recent.map((turn) => turn.sequence), 0),
      },
    };
  }
}
