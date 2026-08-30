import { createRuntimePools, linkCodeKeyFromEnv } from "@agendia/db";
import { buildApi } from "./app.ts";
export { buildApi } from "./app.ts";

export function createProductionApi(env: NodeJS.ProcessEnv = process.env) {
  const database = env.DATABASE_URL;
  const expectedOrigin = env.APP_ORIGIN;
  if (!database || !expectedOrigin) throw new Error("DATABASE_URL and APP_ORIGIN are required");
  const pools = createRuntimePools({ api: env.API_DATABASE_URL ?? database, admin: env.ADMIN_DATABASE_URL ?? database, manager: env.MANAGER_DATABASE_URL ?? database, worker: env.WORKER_DATABASE_URL ?? database });
  return { app: buildApi({ pools, expectedOrigin,linkCodeKey:linkCodeKeyFromEnv(env) }), pools };
}

export async function startApi(env: NodeJS.ProcessEnv = process.env) {
  const runtime = createProductionApi(env);
  await runtime.app.listen({ host: env.API_HOST ?? "0.0.0.0", port: Number(env.API_PORT ?? 3001) });
  return runtime;
}
