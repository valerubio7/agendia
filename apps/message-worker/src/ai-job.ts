import {
  ConversationContextBuilder,
  InMemoryConversationHistory,
  type AiProvider,
  type ConversationSummarizer,
  type ConversationSummaryContent,
} from "@agendia/domain";
import { tenantContext, type createRuntimePools } from "@agendia/db";
import { AiProviderError } from "@agendia/ai-deepseek";

type Pools = ReturnType<typeof createRuntimePools>;
export interface PostgresAiJob {
  businessId: string;
  messageId: string;
  correlationId: string;
}
export interface PostgresSummaryJob {
  businessId: string;
  conversationId: string;
  coveredThrough: number;
  correlationId: string;
}
const summaryContent = (value: any): ConversationSummaryContent | null =>
  value &&
  ["facts", "requests", "commitments", "preferences", "openItems"].every(
    (key) =>
      Array.isArray(value[key]) &&
      value[key].every((item: unknown) => typeof item === "string"),
  )
    ? value
    : null;
const validSummary = <T extends { structured_summary: any }>(rows: T[]) =>
  rows.find((row) => summaryContent(row.structured_summary)) ?? null;
const visible = (turn: { direction: string; processing_state: string }) =>
  turn.direction === "inbound" || turn.processing_state === "sent";
export class PostgresAiJobProcessor {
  constructor(
    private pools: Pools,
    private provider: AiProvider,
    private budget = 8_000,
  ) {}
  private context(businessId: string, correlationId: string) {
    return tenantContext({
      businessId,
      actorId: "message-worker",
      role: "internal_worker",
      requestId: correlationId,
    });
  }
  async planSummary(job: PostgresAiJob): Promise<PostgresSummaryJob | null> {
    const data = await this.pools.worker.run(
      this.context(job.businessId, job.correlationId),
      (r) => r.loadAiMessage(job.messageId),
    );
    if (!data) return null;
    const turns = data.turns.filter(visible),
      summary = validSummary(data.summaries),
      through = Math.max(0, ...turns.map((turn) => Number(turn.sequence))),
      covered = Number(summary?.covered_through ?? 0),
      cost = turns.reduce((sum, turn) => sum + turn.raw_text.length + 24, 0);
    return cost > this.budget && through > covered
      ? {
          businessId: job.businessId,
          conversationId: data.conversation_id,
          coveredThrough: through,
          correlationId: `summary:${data.conversation_id}:${through}`,
        }
      : null;
  }
  async process(job: PostgresAiJob): Promise<void> {
    const context = this.context(job.businessId, job.correlationId),
      initial = await this.pools.worker.run(context, (r) =>
        r.loadAiMessage(job.messageId),
      );
    if (!initial) return;
    const release = await this.pools.worker.reserveAdvisoryLock(
      `ai:${job.businessId}:${initial.conversation_id}`,
    );
    if (!release) return;
    try {
      const data = await this.pools.worker.run(context, (r) =>
        r.loadAiMessage(job.messageId),
      );
      if (!data) return;
      const history = new InMemoryConversationHistory();
      history.append(
        job.businessId,
        data.conversation_id,
        data.turns.map((t) => ({
          sequence: Number(t.sequence),
          role:
            t.direction === "inbound"
              ? ("customer" as const)
              : ("assistant" as const),
          text: t.raw_text,
          ...(t.direction === "outbound"
            ? {
                delivery:
                  t.processing_state === "sent"
                    ? ("sent" as const)
                    : ("failed" as const),
              }
            : {}),
        })),
      );
      const summary = validSummary(data.summaries);
      if (summary) {
        const content = summaryContent(summary.structured_summary)!;
        history.saveSummary(job.businessId, data.conversation_id, {
          version: summary.version,
          coveredThrough: Number(summary.covered_through),
          ...content,
        });
      }
      const built = new ConversationContextBuilder(history).build({
        businessId: job.businessId,
        conversationId: data.conversation_id,
        query: data.raw_text,
        maxCharacters: this.budget,
      });
      if (built.status === "blocked") {
        await this.pools.worker.run(context, (r) =>
          r.failAi(job.messageId, job.businessId, "ai.context_unavailable"),
        );
        return;
      }
      const result = await this.provider.generate({
        business: data.profile,
        assistant: data.assistant,
        context: {
          summary: JSON.stringify(built.context.summary),
          retrieved: built.context.retrieved.map((t) => t.text),
          recent: built.context.recent.map((t) => t.text),
        },
        message: data.raw_text,
        maxOutputCharacters: 2_000,
        correlationId: job.correlationId,
      });
      await this.pools.worker.run(context, (r) =>
        r.saveGenerated(job.messageId, job.businessId, result.text),
      );
    } catch (error) {
      const code =
        error instanceof AiProviderError ? error.code : "provider_unavailable";
      await this.pools.worker.run(context, (r) =>
        r.failAi(job.messageId, job.businessId, `ai.${code}`),
      );
    } finally {
      await release();
    }
  }
}

export class PostgresSummaryJobProcessor {
  constructor(
    private pools: Pools,
    private summarizer: ConversationSummarizer,
  ) {}
  async process(job: PostgresSummaryJob): Promise<"updated" | "stale"> {
    const context = tenantContext({
        businessId: job.businessId,
        actorId: "message-worker",
        role: "internal_worker",
        requestId: job.correlationId,
      }),
      release = await this.pools.worker.reserveAdvisoryLock(
        `summary:${job.businessId}:${job.conversationId}`,
      );
    if (!release) return "stale";
    try {
      const source = await this.pools.worker.run(context, (r) =>
        r.loadSummarySource(job.conversationId, job.coveredThrough),
      );
      if (!source) return "stale";
      const summary = validSummary(source.summaries),
        prior = summaryContent(summary?.structured_summary),
        covered = Number(summary?.covered_through ?? 0),
        messages = source.turns
          .filter((turn) => visible(turn) && Number(turn.sequence) > covered)
          .map((turn) => ({
            sequence: Number(turn.sequence),
            role:
              turn.direction === "inbound"
                ? ("customer" as const)
                : ("assistant" as const),
            text: turn.raw_text,
          }));
      if (!messages.length) return "stale";
      try {
        const content = await this.summarizer.summarize({
          prior,
          messages,
          correlationId: job.correlationId,
        });
        return (await this.pools.worker.run(context, (r) =>
          r.saveConversationSummary(
            job.conversationId,
            Number(source.summaries[0]?.version ?? 0),
            job.coveredThrough,
            content,
          ),
        ))
          ? "updated"
          : "stale";
      } catch (error) {
        await this.pools.worker.run(context, (r) =>
          r.recordSummaryFailure(job.businessId),
        );
        throw error;
      }
    } finally {
      await release();
    }
  }
}
