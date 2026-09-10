import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PgBoss } from "pg-boss";
import {
	containQueueErrors,
	createRuntimePools,
	linkCodeKeyFromEnv,
	tenantContext,
} from "@agendia/db";
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
	BaileysAuthStateAdapter,
	BaileysGateway,
	EnvironmentKms,
	PostgresBaileysAuthStore,
	type SocketFactory,
} from "@agendia/whatsapp-baileys";
import { PostgresWhatsAppManager, type WhatsAppGateway } from "./lifecycle.ts";
import { PostgresInboundHandler } from "./inbound-handler.ts";
import {
	AiOutboxDispatcher,
	type JobPublisher,
} from "./ai-outbox-dispatcher.ts";
import {
	PostgresOutboundDispatcher,
	type OutboundGateway,
} from "./outbound-dispatcher.ts";

export const serviceName = "whatsapp-manager" as const;
export * from "./lifecycle.ts";
export * from "./inbound-handler.ts";
export * from "./ai-outbox-dispatcher.ts";
export * from "./outbound-dispatcher.ts";

export const MIN_RECONNECT_INTERVAL_MS = 15_000;

export function resolveLoopbackProbePort(value: string | undefined) {
	if (value === undefined) return 9090;
	if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65_535)
		throw new Error("LOOPBACK_PROBE_PORT must be an integer from 1 to 65535");
	return Number(value);
}

export function createInFlightOperations() {
	const operations = new Set<Promise<unknown>>();
	return {
		track<T>(work: () => Promise<T>) {
			const operation = work();
			operations.add(operation);
			void operation.then(
				() => operations.delete(operation),
				() => operations.delete(operation),
			);
			return operation;
		},
		async wait() {
			const errors: unknown[] = [];
			while (operations.size) {
				const results = await Promise.allSettled([...operations]);
				for (const result of results)
					if (result.status === "rejected") errors.push(result.reason);
			}
			if (errors.length)
				throw new AggregateError(errors, "In-flight runtime work failed");
		},
	};
}

export function createReconnectThrottle(options: {
	run: () => Promise<unknown>;
	intervalMs: number;
	now?: () => number;
}) {
	const now = options.now ?? Date.now,
		intervalMs = Math.max(MIN_RECONNECT_INTERVAL_MS, options.intervalMs);
	let running = false,
		nextAt = now() + MIN_RECONNECT_INTERVAL_MS,
		inFlight: Promise<unknown> | undefined;
	return {
		snapshot: () => ({ running, nextAt }),
		tryRun: () => {
			if (running || now() < nextAt) return false;
			running = true;
			inFlight = options.run().finally(() => {
				running = false;
				nextAt = now() + intervalMs;
			});
			return true;
		},
		waitForIdle: async () => {
			await inFlight;
		},
	};
}

type Pools = ReturnType<typeof createRuntimePools>;
const whatsappLifecycleCodes = new Set([
	"whatsapp.transient-close",
	"whatsapp.logout",
	"whatsapp.corrupt",
]);
export function createWhatsAppLifecycleLogger(write?: (line: string) => void) {
	return (record: Record<string, unknown>) => {
		if (!whatsappLifecycleCodes.has(String(record.code))) return;
		if (
			!(
				record.statusCode === "unknown" ||
				(typeof record.statusCode === "number" &&
					Number.isFinite(record.statusCode))
			)
		)
			return;
		const safe = JSON.stringify({
			code: record.code,
			statusCode: record.statusCode,
		});
		if (write) return write(safe);
		console.info(
			serializeOperationalLog({
				level: "warn",
				service: "whatsapp-manager",
				environment: process.env.AGENDIA_ENVIRONMENT ?? "development",
				releaseDigest: process.env.AGENDIA_RELEASE_DIGEST ?? "development",
				instanceId: process.env.AGENDIA_INSTANCE_ID ?? "manager",
				code: "timeout",
				details: { lifecycleCode: record.code, statusCode: record.statusCode },
			}),
		);
	};
}
export function createWhatsAppManager(options: {
	pools: Pools;
	ownerId: string;
	gateway: WhatsAppGateway;
	heartbeatMs?: number;
	onInbound?: (
		event: import("./inbound-handler.ts").InboundWhatsAppEvent,
	) => unknown;
	linkCodeKey?: Buffer;
}) {
	return new PostgresWhatsAppManager(
		options.pools,
		options.ownerId,
		() => options.gateway,
		options.heartbeatMs,
		options.onInbound,
		options.linkCodeKey,
	);
}
export function createProductionWhatsAppManager(
	env: NodeJS.ProcessEnv = process.env,
	socketFactory?: SocketFactory,
	onInbound?: (
		event: import("./inbound-handler.ts").InboundWhatsAppEvent,
	) => unknown,
) {
	const database = env.MANAGER_DATABASE_URL ?? env.DATABASE_URL;
	if (!database)
		throw new Error("MANAGER_DATABASE_URL or DATABASE_URL is required");
	const pools = createRuntimePools(database),
		kms = EnvironmentKms.fromEnv(env),
		linkCodeKey = linkCodeKeyFromEnv(env),
		ownerId = env.WHATSAPP_MANAGER_ID ?? randomUUID(),
		gateways: BaileysGateway[] = [],
		lifecycleLog = createWhatsAppLifecycleLogger();
	const manager = new PostgresWhatsAppManager(
		pools,
		ownerId,
		(businessId) => {
			const context = tenantContext({
				businessId,
				actorId: ownerId,
				role: "internal_worker",
				requestId: `whatsapp-manager:${ownerId}`,
			});
			const auth = new BaileysAuthStateAdapter(
					new PostgresBaileysAuthStore(pools.manager, context, kms),
				),
				gateway = new BaileysGateway(
					(connectionId) => auth.load(businessId, connectionId),
					socketFactory,
					lifecycleLog,
				);
			gateways.push(gateway);
			return gateway;
		},
		undefined,
		onInbound,
		linkCodeKey,
	);
	const outboundGateway: OutboundGateway = {
		send: async (command) => {
			for (const gateway of gateways) {
				const result = await gateway.send(command);
				if (result.outcome === "ack") return result;
			}
			return { outcome: "rejected" };
		},
	};
	return { manager, pools, ownerId, outboundGateway };
}
export const createMessagingRuntime = (
	pools: Pools,
	queue: JobPublisher,
	gateway: OutboundGateway,
	ownerId: string,
) => ({
	inbound: new PostgresInboundHandler(pools),
	aiOutbox: new AiOutboxDispatcher(pools, queue),
	outbound: new PostgresOutboundDispatcher(pools, gateway, ownerId),
});
export async function startWhatsAppManager(
	env: NodeJS.ProcessEnv = process.env,
	socketFactory?: SocketFactory,
) {
	let inbound: PostgresInboundHandler | undefined;
	const runtime = createProductionWhatsAppManager(env, socketFactory, (event) =>
		inbound?.handle(event),
	);
	const queuePublisherFile = env.QUEUE_PUBLISHER_DATABASE_URL_FILE;
	if (!queuePublisherFile)
		throw new Error("QUEUE_PUBLISHER_DATABASE_URL_FILE is required");
	const queueUrl = readFileSync(queuePublisherFile, "utf8").trim();
	if (!queueUrl)
		throw new Error("QUEUE_PUBLISHER_DATABASE_URL_FILE is unavailable");
	const boss = new PgBoss({
		connectionString: queueUrl,
		schema: "pgboss",
		createSchema: false,
	});
	containQueueErrors(boss, "whatsapp-manager");
	await boss.start();
	const messaging = createMessagingRuntime(
		runtime.pools,
		boss,
		runtime.outboundGateway,
		runtime.ownerId,
	);
	inbound = messaging.inbound;
	await runtime.manager.restart();
	await messaging.aiOutbox.dispatchBatch();
	const pollMs = Number(env.WHATSAPP_COMMAND_POLL_MS ?? 1_000),
		reconnect = createReconnectThrottle({
			run: () => runtime.manager.restart(),
			intervalMs: pollMs,
		});
	const timerOperations = createInFlightOperations();
	const timer = setInterval(() => {
		void timerOperations.track(() => runtime.manager.processNext());
		reconnect.tryRun();
		void timerOperations.track(() => messaging.aiOutbox.dispatchBatch());
		void timerOperations.track(() => messaging.outbound.dispatchNext());
	}, pollMs);
	const readiness = createDurableReadiness({
		persistDraining: () =>
			runtime.pools.manager.run(undefined, (repo) =>
				repo.upsertServiceHeartbeat({
					service: "whatsapp-manager",
					instanceId: runtime.ownerId,
					releaseDigest: env.AGENDIA_RELEASE_DIGEST ?? "development",
					state: "draining",
				}),
			),
	});
	const heartbeat = createHeartbeat({
		write: () =>
			runtime.pools.manager.run(undefined, (repo) =>
				repo.upsertServiceHeartbeat({
					service: "whatsapp-manager",
					instanceId: runtime.ownerId,
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
		stopTimers: async () => {
			clearInterval(timer);
			heartbeat.stop();
			const results = await Promise.allSettled([
				timerOperations.wait(),
				reconnect.waitForIdle(),
			]);
			const errors = results
				.filter((result) => result.status === "rejected")
				.map((result) => (result as PromiseRejectedResult).reason);
			if (errors.length)
				throw new AggregateError(errors, "Runtime timer shutdown failed");
		},
		stopProbe: () => probe.stop(),
		stopRuntime: () => boss.stop(),
		releaseLocks: () => runtime.manager.stop(),
		awaitInFlightLockCleanup: async () => {},
		closePools: () => runtime.pools.end(),
	});
	return { ...runtime, ...messaging, boss, stop };
}

if (process.env.AGENDIA_RUN_WHATSAPP_MANAGER === "1") {
	const config = loadRuntimeConfig("whatsapp-manager");
	void runPreflightBeforeActivity(
		() => preflightReleaseEnvironment(config),
		() =>
			startWhatsAppManager({
				...process.env,
				DATABASE_URL: undefined,
				MANAGER_DATABASE_URL: config.databaseUrl,
			}),
	)
		.then((runtime) => {
			const log = (
				level: "info" | "warn" | "error",
				code: "startup" | "draining" | "stopped" | "timeout",
			) =>
				console.info(
					serializeOperationalLog({
						level,
						service: "whatsapp-manager",
						environment: config.environment,
						releaseDigest: config.releaseDigest,
						instanceId: runtime.ownerId,
						code,
					}),
				);
			log("info", "startup");
			const shutdown = () => {
				log("info", "draining");
				return void runtime
					.stop()
					.then(() => log("info", "stopped"))
					.finally(() => process.exit());
			};
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
		})
		.catch(() => {
			console.info(
				serializeOperationalLog({
					level: "error",
					service: "whatsapp-manager",
					environment: config.environment,
					releaseDigest: config.releaseDigest,
					instanceId: "bootstrap",
					code: "stopped",
				}),
			);
			process.exitCode = 1;
		});
}
