export interface AiGenerateRequest {
  business: Record<string, string>;
  assistant: Record<string, string>;
  context: { summary: string; retrieved: string[]; recent: string[] };
  message: string;
  maxOutputCharacters: number;
  correlationId: string;
}

export interface AiGenerateResult {
  text: string;
  providerId: string;
  usageTokens: number;
}

export interface AiProvider {
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
}

export interface ConversationSummaryContent {
  facts: string[];
  requests: string[];
  commitments: string[];
  preferences: string[];
  openItems: string[];
}
export interface ConversationSummaryRequest {
  prior: ConversationSummaryContent | null;
  messages: Array<{ sequence: number; role: "customer" | "assistant"; text: string }>;
  correlationId: string;
}
export interface ConversationSummarizer {
  summarize(request: ConversationSummaryRequest): Promise<ConversationSummaryContent>;
}
