export interface ConversationTurn {
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
  query: string;
  maxCharacters: number;
}

type BuildResult =
  | { status: "blocked"; reason: "summary_required" }
  | { status: "ready"; context: { summary: ConversationSummary | null; retrieved: ConversationTurn[]; recent: ConversationTurn[]; representsThrough: number } };

function visibleTurn(turn: ConversationTurn): boolean {
  return turn.role === "customer" || turn.delivery === "sent";
}

function queryTerms(query: string): string[] {
  return query.toLocaleLowerCase("es").match(/[\p{L}\p{N}]+/gu)?.filter((term) => term.length > 2) ?? [];
}

function takeRecentWithinBudget(turns: ConversationTurn[], maxCharacters: number): ConversationTurn[] {
  const selected: ConversationTurn[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    const cost = turn.text.length + 24;
    if (selected.length > 0 && used + cost > maxCharacters) break;
    if (cost > maxCharacters) continue;
    selected.unshift(turn);
    used += cost;
  }
  return selected;
}

export class ConversationContextBuilder {
  constructor(private readonly history: InMemoryConversationHistory) {}

  build(request: BuildRequest): BuildResult {
    if (!request.businessId || !request.conversationId) throw new Error("tenant and conversation are required");
    const raw = this.history.listRaw(request.businessId, request.conversationId);
    const eligible = raw.filter(visibleTurn);
    const summary = this.history.summary(request.businessId, request.conversationId);
    const coveredThrough = summary?.coveredThrough ?? 0;
    const prefix = eligible.filter((turn) => turn.sequence <= coveredThrough);
    const terms = queryTerms(request.query);
    const retrieved = prefix.filter((turn) => terms.some((term) => turn.text.toLocaleLowerCase("es").includes(term))).slice(-4);
    const fixedCost = (summary ? JSON.stringify(summary).length : 0) + retrieved.reduce((total, turn) => total + turn.text.length + 24, 0);
    const recent = takeRecentWithinBudget(eligible.filter((turn) => turn.sequence > coveredThrough), Math.max(0, request.maxCharacters - fixedCost));
    return {
      status: "ready",
      context: {
        summary: summary ? structuredClone(summary) : null,
        retrieved,
        recent,
        representsThrough: Math.max(coveredThrough, ...recent.map((turn) => turn.sequence), 0),
      },
    };
  }
}
