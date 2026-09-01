import type {
  AiGenerateRequest,
  AiGenerateResult,
  AiProvider,
} from "@agendia/domain";
import {
  AiProviderError,
  type AiProviderErrorCode,
} from "@agendia/ai-deepseek";

interface AiJob {
  businessId: string;
  conversationId: string;
  messageId: string;
  request: AiGenerateRequest;
}

export class InMemoryAiJobRepository {
  readonly messages = new Map<
    string,
    { state: "processing" | "generated" | "ai_failed" }
  >();
  readonly outbound: Array<{
    businessId: string;
    conversationId: string;
    messageId: string;
    text: string;
  }> = [];
  readonly technicalEvents: Array<{
    businessId: string;
    code: string;
    correlationId: string;
  }> = [];
  readonly auditEvents: Array<{
    businessId: string;
    eventType: string;
    outcome: "failure";
  }> = [];
  sendAttempts = 0;
}

export class DeterministicAiProvider implements AiProvider {
  constructor(
    private readonly result:
      | { type: "success"; text: string }
      | { type: "failure"; code: AiProviderErrorCode },
  ) {}
  async generate(_request: AiGenerateRequest): Promise<AiGenerateResult> {
    if (this.result.type === "failure")
      throw new AiProviderError(this.result.code);
    return {
      text: this.result.text,
      providerId: "deterministic-ai",
      usageTokens: 1,
    };
  }
}

export class AiJobProcessor {
  private readonly conversationLocks = new Set<string>();
  constructor(
    private readonly provider: AiProvider,
    private readonly repository: InMemoryAiJobRepository,
  ) {}

  async process(job: AiJob): Promise<void> {
    const lock = `${job.businessId}:${job.conversationId}`;
    if (this.conversationLocks.has(lock))
      throw new Error("conversation already processing");
    this.conversationLocks.add(lock);
    this.repository.messages.set(job.messageId, { state: "processing" });
    try {
      const result = await this.provider.generate(job.request);
      this.repository.messages.set(job.messageId, { state: "generated" });
      this.repository.outbound.push({
        businessId: job.businessId,
        conversationId: job.conversationId,
        messageId: job.messageId,
        text: result.text,
      });
    } catch (error) {
      const code =
        error instanceof AiProviderError ? error.code : "provider_unavailable";
      this.repository.messages.set(job.messageId, { state: "ai_failed" });
      this.repository.technicalEvents.push({
        businessId: job.businessId,
        code: `ai.${code}`,
        correlationId: job.request.correlationId,
      });
      this.repository.auditEvents.push({
        businessId: job.businessId,
        eventType: "ai.failed",
        outcome: "failure",
      });
    } finally {
      this.conversationLocks.delete(lock);
    }
  }
}
