import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { containQueueErrors, createRuntimePools } from "@agendia/db";
import { DeepSeekAdapter, DeepSeekSummarizer } from "@agendia/ai-deepseek";
import type { AiProvider } from "@agendia/domain";
import {
	createDrain,
	createDurableReadiness,
	createHeartbeat,
	createLoopbackProbe,
	loadRuntimeConfig,
	preflightReleaseEnvironment,
	runPreflightBeforeActivity,
	serializeOperationalLog,
} from "@agendia/runtime-config";
import {
	PostgresAiJobProcessor,
	PostgresSummaryJobProcessor,
	type PostgresAiJob,
	type PostgresSummaryJob,
} from "./ai-job.ts";

export const serviceName = "message-worker" as const;
export * from "./ai-job.ts";
export function resolveLoopbackProbePort(value: string | undefined) {
	if (value === undefined) return 9090;
	if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65_535)
		throw new Error("LOOPBACK_PROBE_PORT must be an integer from 1 to 65535");
	return Number(value);
}
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
	let inFlightLockCleanup = Promise.resolve();
	const trackLockCleanup = async (work: () => Promise<void>) => {
		inFlightLockCleanup = inFlightLockCleanup.then(work, work);
		await inFlightLockCleanup;
	};
	await boss.work<PostgresSummaryJob>("conversation-summary", async ([job]) => {
		if (job)
			await trackLockCleanup(async () => {
				await summaryWorker.process(job.data);
			});
	});
	await boss.work<PostgresAiJob>("ai-generate", async ([job]) => {
		if (!job) return;
		await trackLockCleanup(async () => {
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
				console.info(
					serializeOperationalLog({
						level: "warn",
						service: "message-worker",
						environment: env.AGENDIA_ENVIRONMENT ?? "development",
						releaseDigest: env.AGENDIA_RELEASE_DIGEST ?? "development",
						instanceId: env.AGENDIA_INSTANCE_ID ?? "worker",
						code: "timeout",
					}),
				);
			}
			await worker.process(job.data);
		});
	});
	const instanceId = env.AGENDIA_INSTANCE_ID ?? randomUUID();
	const readiness = createDurableReadiness({
		persistDraining: () =>
			pools.worker.run(undefined, (repo) =>
				repo.upsertServiceHeartbeat({
					service: "message-worker",
					instanceId,
					releaseDigest: env.AGENDIA_RELEASE_DIGEST ?? "development",
					state: "draining",
				}),
			),
	});
	const heartbeat = createHeartbeat({
		write: () =>
			pools.worker.run(undefined, (repo) =>
				repo.upsertServiceHeartbeat({
					service: "message-worker",
					instanceId,
					releaseDigest: env.AGENDIA_RELEASE_DIGEST ?? "development",
					state: "ready",
				}),
			),
	});
	await heartbeat.start();
	const probe = createLoopbackProbe({
		port: resolveLoopbackProbePort(env.LOOPBACK_PROBE_PORT),
		ready: () =>
			!readiness.ready().ready
				? readiness.ready()
				: heartbeat.isFresh()
					? { ready: true, code: "ready" }
					: { ready: false, code: "heartbeat.stale" },
	});
	await probe.start();
	const stop = createDrain({
		timeoutMs: 90_000,
		markUnready: () => readiness.markUnready(),
		stopIntake: async () => {},
		stopTimers: async () => heartbeat.stop(),
		stopProbe: () => probe.stop(),
		stopRuntime: () => boss.stop(),
		releaseLocks: async () => {},
		awaitInFlightLockCleanup: () => inFlightLockCleanup,
		closePools: () => pools.end(),
	});
	return {
		boss,
		pools,
		worker,
		summaryWorker,
		stop,
		readiness: () => heartbeat.isFresh(),
	};
}
if (process.env.AGENDIA_RUN_MESSAGE_WORKER === "1") {
	const config = loadRuntimeConfig("message-worker");
	void runPreflightBeforeActivity(
		() => preflightReleaseEnvironment(config),
		() =>
			startMessageWorker({
				...process.env,
				DATABASE_URL: undefined,
				WORKER_DATABASE_URL: config.databaseUrl,
			}),
	)
		.then((runtime) => {
			const instanceId = process.env.AGENDIA_INSTANCE_ID ?? "worker";
			const log = (
				level: "info" | "warn" | "error",
				code: "startup" | "draining" | "stopped" | "timeout",
			) =>
				console.info(
					serializeOperationalLog({
						level,
						service: "message-worker",
						environment: config.environment,
						releaseDigest: config.releaseDigest,
						instanceId,
						code,
					}),
				);
			log("info", "startup");
			const stop = () => {
				log("info", "draining");
				return void runtime
					.stop()
					.then(() => log("info", "stopped"))
					.finally(() => process.exit());
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		})
		.catch(() => {
			console.info(
				serializeOperationalLog({
					level: "error",
					service: "message-worker",
					environment: config.environment,
					releaseDigest: config.releaseDigest,
					instanceId: "bootstrap",
					code: "stopped",
				}),
			);
			process.exitCode = 1;
		});
}
