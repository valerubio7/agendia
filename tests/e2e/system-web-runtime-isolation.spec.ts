import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./support/fixtures.ts";
import { startWebProxy } from "./support/web-proxy.ts";
import { captureWebDiagnostics, createWebRuntime, probeHttp, webRuntimeEnv } from "./support/web-runtime.ts";

test("two production runtimes route the same API path to their own servers", async ({ webBuild }) => {
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const urls: string[] = [];
    for (const marker of ["first", "second"]) {
      const api = createServer((req, res) => {
        res.setHeader("set-cookie", `marker=${marker}; Path=/`);
        res.end(`${marker}:${req.url}:${req.headers.origin}:${req.headers.cookie}`);
      });
      await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())));
      const apiPort = (api.address() as { port: number }).port;
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const nextPort = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const runtime = await createWebRuntime(process.cwd(), webBuild.cwd);
      cleanups.push(() => runtime.dispose());
      const child = spawn("bun", ["--bun", join(process.cwd(), "apps/web/node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], {
        cwd: runtime.cwd, env: { ...webRuntimeEnv(runtime.root), NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
      });
      const diagnostics = captureWebDiagnostics(child);
      cleanups.push(() => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve()); child.kill("SIGTERM");
      }));
      const proxy = await startWebProxy(`http://127.0.0.1:${nextPort}`, `http://127.0.0.1:${apiPort}`);
      cleanups.push(() => proxy.stop());
      await probeHttp(`${proxy.url}/login`, { diagnostics, expectedStatus: 200 });
      urls.push(proxy.url);
    }
    for (const [index, url] of urls.entries()) {
      const marker = index ? "second" : "first";
      const response = await fetch(`${url}/api/probe?x=1`, { headers: { origin: url, cookie: "session=owned" } });
      expect(response.headers.get("set-cookie")).toContain(`marker=${marker}`);
      expect(await response.text()).toBe(`${marker}:/probe?x=1:${url}:session=owned`);
      expect((await fetch(`${url}/login`)).status).toBe(200);
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});
