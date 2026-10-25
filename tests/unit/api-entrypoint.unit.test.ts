import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const env = {
  PATH: process.env.PATH!,
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  APP_ORIGIN: "https://panel.example.test",
  WHATSAPP_LINK_CODE_KEY: Buffer.alloc(32, 1).toString("base64"),
  API_HOST: "127.0.0.1",
};
const launch = (args: string[], extra: Record<string, string | undefined> = {}) => {
  const childEnv: Record<string, string | undefined> = { ...env, ...extra };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  return Bun.spawn(
    [process.execPath, "--no-env-file", ...args],
    { cwd: root, env: childEnv, stdout: "pipe", stderr: "pipe" },
  );
};

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test.each([
  { host: undefined, wildcard: false },
  { host: "0.0.0.0", wildcard: true },
])("direct API preserves host binding with API_HOST=$host", async ({ host, wildcard }) => {
  const port = await unusedPort();
  const child = launch(["apps/api/src/index.ts"], { API_HOST: host, API_PORT: String(port) });
  try {
    const deadline = Date.now() + 3_000;
    let response: Response | undefined;
    while (!response) {
      if (child.exitCode !== null) throw new Error("API exited before listening");
      try { response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) }); }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(20);
      }
    }
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
    const alternate = fetch(`http://127.0.0.2:${port}/`, { signal: AbortSignal.timeout(250) });
    if (wildcard) {
      const alternateResponse = await alternate;
      expect(alternateResponse.status).toBe(404);
      expect(await alternateResponse.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
    } else {
      await expect(alternate).rejects.toThrow();
    }
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

test("imported startApi retains its wildcard host default", async () => {
  const child = launch(["--eval", `
    const { startApi } = await import('./apps/api/src/index.ts');
    const runtime = await startApi();
    try { console.log(runtime.app.server.address().address); }
    finally { await runtime.app.close(); await runtime.pools.end(); }
  `], { API_HOST: undefined, API_PORT: "0" });
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "0.0.0.0\n", stderr: "" });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

test("direct API execution rejects missing configuration without leaking it", async () => {
  const child = launch(["apps/api/src/index.ts"], { APP_ORIGIN: "" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exit).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe('{"event":"api.bootstrap","outcome":"failure"}\n');
});

test.each(["SIGTERM", "SIGINT"] as const)("direct API serves HTTP and closes cleanly on %s", async (signal) => {
  const port = await unusedPort();
  const child = launch(["apps/api/src/index.ts"], { API_PORT: String(port) });
  const url = `http://127.0.0.1:${port}/`;
  try {
    const deadline = Date.now() + 3_000;
    let response: Response | undefined;
    while (!response) {
      if (child.exitCode !== null) throw new Error("API exited before listening");
      try { response = await fetch(url, { signal: AbortSignal.timeout(250) }); }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await Bun.sleep(20);
      }
    }
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
    child.kill(signal);
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toBe("");
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

test("importing the API preserves its exports without starting a server", async () => {
  const child = launch(["--eval", `
    const api = await import('./apps/api/src/index.ts');
    if (typeof api.startApi !== 'function' || typeof api.buildApi !== 'function' || typeof api.createProductionApi !== 'function') process.exit(2);
    console.log('imported');
  `], { DATABASE_URL: "", APP_ORIGIN: "" });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe("imported\n");
  expect(await new Response(child.stderr).text()).toBe("");
});
