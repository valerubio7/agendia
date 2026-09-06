import { createRuntimePools, linkCodeKeyFromEnv } from "@agendia/db";
import {
	createDrain,
	loadRuntimeConfig,
	serializeOperationalLog,
	preflightReleaseEnvironment,
	runPreflightBeforeActivity,
} from "@agendia/runtime-config";
import { buildApi } from "./app.ts";
export { buildApi } from "./app.ts";

export function createProductionApi(env: NodeJS.ProcessEnv = process.env) {
	const database = env.API_DATABASE_URL ?? env.DATABASE_URL;
	const expectedOrigin = env.APP_ORIGIN;
	if (!database || !expectedOrigin)
		throw new Error("DATABASE_URL and APP_ORIGIN are required");
	const pools = createRuntimePools({
		api: env.API_DATABASE_URL ?? database,
		admin: env.ADMIN_DATABASE_URL ?? database,
		manager: env.MANAGER_DATABASE_URL ?? database,
		worker: env.WORKER_DATABASE_URL ?? database,
	});
	return {
		app: buildApi({
			pools,
			expectedOrigin,
			linkCodeKey: linkCodeKeyFromEnv(env),
		}),
		pools,
	};
}

export async function startApi(env: NodeJS.ProcessEnv = process.env) {
	const runtime = createProductionApi(env);
	await runtime.app.listen({
		host: env.API_HOST ?? "0.0.0.0",
		port: Number(env.API_PORT ?? 3001),
	});
	return runtime;
}

const isReleaseEntrypoint = /(?:^|\/)index\.(?:ts|js)$/.test(
	process.argv[1] ?? "",
);
if (isReleaseEntrypoint) {
	const config = loadRuntimeConfig("api");
	void runPreflightBeforeActivity(
		() => preflightReleaseEnvironment(config),
		() =>
			startApi({
				...process.env,
				DATABASE_URL: undefined,
				API_DATABASE_URL: config.databaseUrl,
			}),
	)
		.then((runtime) => {
			const log = (level: "info" | "warn" | "error", code: "startup" | "draining" | "stopped" | "timeout") =>
				console.info(serializeOperationalLog({ level, service: "api", environment: config.environment, releaseDigest: config.releaseDigest, instanceId: process.pid.toString(), code }));
			log("info", "startup");
			const drain = createDrain({
				timeoutMs: 30_000,
				markUnready: async () => log("info", "draining"),
				stopIntake: async () => {},
				stopTimers: async () => {},
				stopProbe: async () => {},
				stopRuntime: () => runtime.app.close(),
				releaseLocks: async () => {},
				awaitInFlightLockCleanup: async () => {},
				closePools: () => runtime.pools.end(),
				onTimeout: () => log("warn", "timeout"),
			});
			const stop = async () => { await drain(); log("info", "stopped"); };
			process.once("SIGINT", () => void stop());
			process.once("SIGTERM", () => void stop());
		})
		.catch(() => {
			console.info(serializeOperationalLog({ level: "error", service: "api", environment: config.environment, releaseDigest: config.releaseDigest, instanceId: process.pid.toString(), code: "stopped" }));
			process.exitCode = 1;
		});
}
