import { PgBoss } from "pg-boss";
import { containQueueErrors, createRuntimePools } from "@agendia/db";
import { DeepSeekAdapter, DeepSeekSummarizer } from "@agendia/ai-deepseek";
import type { AiProvider } from "@agendia/domain";
import {
  PostgresAiJobProcessor,
  PostgresSummaryJobProcessor,
  type PostgresAiJob,
  type PostgresSummaryJob,
} from "./ai-job.ts";

export const serviceName = "message-worker" as const;
export * from "./ai-job.ts";
export const createMessageWorker = (
  pools: ReturnType<typeof createRuntimePools>,
  provider: AiProvider,
) => new PostgresAiJobProcessor(pools, provider);
export async function startMessageWorker(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
) {
  const database = env.WORKER_DATABASE_URL ?? env.DATABASE_URL;
  if (!database)
    throw new Error("WORKER_DATABASE_URL or DATABASE_URL is required");
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required");
  const pools = createRuntimePools(database),
    boss = new PgBoss({
      connectionString: database,
      schema: "pgboss",
      createSchema: false,
    });
  containQueueErrors(boss, "message-worker");
  await boss.start();
  await boss.createQueue("ai-generate");
  await boss.createQueue("conversation-summary");
  const options = {
      apiKey: env.DEEPSEEK_API_KEY,
      fetcher,
      ...(env.DEEPSEEK_MODEL ? { model: env.DEEPSEEK_MODEL } : {}),
    },
    worker = createMessageWorker(pools, new DeepSeekAdapter(options)),
    summaryWorker = new PostgresSummaryJobProcessor(
      pools,
      new DeepSeekSummarizer(options),
    );
  await boss.work<PostgresSummaryJob>("conversation-summary", async ([job]) => {
    if (job) await summaryWorker.process(job.data);
  });
  await boss.work<PostgresAiJob>("ai-generate", async ([job]) => {
    if (!job) return;
    try {
      const plan = await worker.planSummary(job.data);
      if (plan)
        await boss.send("conversation-summary", plan, {
          singletonKey: `${plan.businessId}:${plan.conversationId}:${plan.coveredThrough}`,
          retryLimit: 5,
          retryDelay: 5,
          expireInSeconds: 30,
        });
    } catch {
      console.warn(
        JSON.stringify({
          code: "ai.summary_schedule_failed",
          component: "message-worker",
        }),
      );
    }
    await worker.process(job.data);
  });
  return {
    boss,
    pools,
    worker,
    summaryWorker,
    stop: async () => {
      await boss.stop();
      await pools.end();
    },
  };
}
if (process.env.AGENDIA_RUN_MESSAGE_WORKER === "1")
  void startMessageWorker()
    .then((runtime) => {
      const stop = () => void runtime.stop().finally(() => process.exit());
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch(() => {
      console.error(
        JSON.stringify({ code: "message.worker.bootstrap_failed" }),
      );
      process.exitCode = 1;
    });
