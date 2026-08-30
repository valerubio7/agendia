import { startApi } from "../apps/api/src/index.ts";

export async function runApi(env: NodeJS.ProcessEnv = process.env) {
  const runtime = await startApi({
    ...env,
    API_HOST: env.API_HOST ?? "127.0.0.1",
    API_PORT: env.API_PORT ?? "3001",
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.app.close();
    await runtime.pools.end();
  };
  return { ...runtime, stop };
}

if (import.meta.main) {
  try {
    const runtime = await runApi();
    const shutdown = () => void runtime.stop().finally(() => process.exit());
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    console.error(
      JSON.stringify({ event: "api.bootstrap", outcome: "failure" }),
    );
    process.exitCode = 1;
  }
}
