import {
  type AiProvider,
  hasToolConversationProvider,
  type ToolConversationProvider,
  type ConversationSummarizer,
  type ConversationSummaryContent,
} from "@agendia/domain";
import { tenantContext, type createRuntimePools } from "@agendia/db";
import { PostgresWhatsAppAgenda } from "./whatsapp-agenda.ts";
import { converseReceptionist } from "./receptionist.ts";
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
  private readonly agenda: PostgresWhatsAppAgenda;
  private readonly conversational: ToolConversationProvider;
  constructor(
    private pools: Pools,
    provider: AiProvider,
    private budget = 8_000,
  ) {
    if (!hasToolConversationProvider(provider)) throw new Error("AI job provider requires callable converse");
    this.conversational = provider;
    this.agenda = new PostgresWhatsAppAgenda(pools, undefined,
      event => console.warn(JSON.stringify(event)));
  }
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
        r.loadAiMessage(job.messageId, true),
      );
    if (!initial) return;
    const release = await this.pools.worker.reserveAdvisoryLock(
      `ai:${job.businessId}:${initial.conversation_id}`,
      true,
    );
    if (!release) return;
    try {
      // Native execution has no language gate or legacy fallback.
      let conversationFailure: unknown;
      const outcome = await this.agenda.withReceptionistSession(job, async session => {
        if (!session.context.messages) throw new Error("Missing receptionist context");
        try {
          return await converseReceptionist(this.conversational, session, [...session.context.messages], job.correlationId);
        } catch (error) {
          if (error instanceof AiProviderError || (error instanceof DOMException && error.name === "AbortError"))
            conversationFailure = error;
          throw error;
        }
      });
      // Preserve the transport classification only AFTER the transaction rolls
      // back. Never expose provider errors as customer facts or persist success.
      if (outcome.status === "infrastructure_failure")
        throw conversationFailure ?? new Error("Receptionist infrastructure failure");
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
