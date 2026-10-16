import { expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureWebDiagnostics, createWebRuntime, probeHttp, webRuntimeEnv, warmWebRoutes, webRuntimeRoutes } from "../e2e/support/web-runtime.ts";

const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null,
  });
}

test("unique owned projects isolate cache, Next types and generated configuration", async () => {
  const repo = process.cwd();
  const shared = join(repo, "apps/web/next-env.d.ts");
  const before = await digest(shared);
  const configHash = await digest(join(repo, "apps/web/tsconfig.json"));
  const sharedLock = await lstat(join(repo, "apps/web/.next/dev/lock")).catch(() => undefined);
  const runtimes: Awaited<ReturnType<typeof createWebRuntime>>[] = [];
  try {
    runtimes.push(await createWebRuntime(repo), await createWebRuntime(repo));
    const [a, b] = runtimes;
    expect(a!.root).not.toBe(b!.root);
    expect(a!.cwd).not.toBe(join(repo, "apps/web"));
    for (const runtime of runtimes) {
      for (const path of ["app", "src", "tsconfig.json", "next.config.ts"])
        expect((await lstat(join(runtime.cwd, path))).isSymbolicLink()).toBe(false);
      for (const path of [".next", "next-env.d.ts", ".env", ".env.local"])
        await expect(access(join(runtime.cwd, path))).rejects.toThrow();
      await mkdir(join(runtime.cwd, ".next/dev/types"), { recursive: true });
      await writeFile(join(runtime.cwd, ".next/dev/lock"), "owned lock");
      await writeFile(join(runtime.cwd, ".next/dev/types/routes.d.ts"), "owned routes");
      await writeFile(join(runtime.cwd, "next-env.d.ts"), "owned generated types");
      await writeFile(join(runtime.cwd, "tsconfig.json"), "owned generated config");
    }
    expect(await digest(shared)).toBe(before);
    expect(await digest(join(repo, "apps/web/tsconfig.json"))).toBe(configHash);
    if (sharedLock) {
      const after = await lstat(join(repo, "apps/web/.next/dev/lock"));
      expect([after.ino, after.mtimeMs, after.size]).toEqual([sharedLock.ino, sharedLock.mtimeMs, sharedLock.size]);
    }
    expect(await readFile(join(b!.cwd, "next-env.d.ts"), "utf8")).toBe("owned generated types");
  } finally {
    for (const runtime of runtimes) {
      await runtime.dispose();
      await runtime.dispose();
      await expect(access(runtime.root)).rejects.toThrow();
    }
  }
});

test("owned runtime disposal requests bounded retries for transient filesystem races", async () => {
  const runtime = await createWebRuntime(process.cwd());
  const remove = filesystem.rm;
  const cleanup = spyOn(filesystem, "rm").mockImplementation(async (path, options) => {
    if (path === runtime.root) {
      expect(options).toMatchObject({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    await remove(path, options);
  });
  try {
    await runtime.dispose();
    await expect(access(runtime.root)).rejects.toThrow();
  } finally {
    cleanup.mockRestore();
    await remove(runtime.root, { recursive: true, force: true });
  }
});

test("hung fetch has a total deadline even when it ignores abort", async () => {
  const started = Date.now();
  const signals: AbortSignal[] = [];
  await expect(probeHttp("http://localhost:1234", {
    timeoutMs: 50, attemptMs: 10, intervalMs: 1,
    fetcher: (_url, { signal }) => { signals.push(signal); return new Promise(() => {}); },
  })).rejects.toThrow("Readiness timeout");
  expect(Date.now() - started).toBeLessThan(500);
  expect(signals.length).toBeGreaterThan(0);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test("child exit interrupts an in-flight readiness probe", async () => {
  const web = child();
  const diagnostics = captureWebDiagnostics(web);
  const pending = probeHttp("http://localhost:1234", {
    timeoutMs: 500, attemptMs: 400, diagnostics,
    fetcher: () => new Promise(() => {}),
  });
  web.stderr.emit("data", "startup compilation failed");
  web.emit("exit", 23, null);
  await expect(pending).rejects.toThrow("exit code=23");
});

test("spawn errors, signal exits and late probes retain bounded sanitized diagnostics", async () => {
  const web = child();
  const diagnostics = captureWebDiagnostics(web);
  web.stderr.emit("data", "\u001b[31mError: compilation failed\u001b[0m\n");
  web.stderr.emit("data", "https://user:password@example.test/x?token=private\nAuthorization: Bearer secret\nCookie: session=hidden\nAPI_KEY=keyvalue\n");
  web.stderr.emit("data", "SECRET_TOKEN=");
  web.stderr.emit("data", "split-secret\n");
  expect(diagnostics.logs.join("")).toContain("compilation failed");
  expect(diagnostics.logs.join("")).not.toMatch(/password|private|Bearer secret|hidden|keyvalue|split-secret|\u001b/);
  for (let i = 0; i < 100; i++) web.stdout.emit("data", "x".repeat(1000));
  web.emit("error", new Error("spawn ENOENT token=private"));
  const text = diagnostics.logs.join("");
  expect(text.length).toBeLessThanOrEqual(8192);
  expect(text).not.toMatch(/password|private|Bearer secret|hidden|keyvalue|\u001b/);
  const spawnError = await probeHttp("http://localhost:1234", { diagnostics }).catch((error: Error) => error);
  expect(spawnError).toBeInstanceOf(Error);
  expect((spawnError as Error).message).toContain("spawn ENOENT");
  expect((spawnError as Error).message).not.toContain("private");
  expect((spawnError as Error).message.length).toBeLessThan(9500);
  const signaled = child();
  const signalDiagnostics = captureWebDiagnostics(signaled);
  signaled.emit("exit", null, "SIGTERM");
  await expect(probeHttp("http://localhost:1234", { diagnostics: signalDiagnostics })).rejects.toThrow("SIGTERM");
});

test("readiness keeps retrying 5xx and network failures, accepts non-5xx", async () => {
  let calls = 0;
  await probeHttp("http://localhost:1234", {
    timeoutMs: 200, attemptMs: 20, intervalMs: 1,
    fetcher: async () => {
      calls++;
      if (calls === 1) throw new Error("connection refused");
      return new Response(null, { status: calls === 2 ? 503 : 401 });
    },
  });
  expect(calls).toBe(3);
});

test("route warming drains each cold response before requesting the next route", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    release = () => { controller.enqueue(new Uint8Array([1])); controller.close(); };
  } });
  const firstResponse = new Response(body);
  let firstRequested!: () => void;
  const requested = new Promise<void>((resolve) => { firstRequested = resolve; });
  const warming = warmWebRoutes("http://localhost:1234", {
    timeoutMs: 200, intervalMs: 1,
    fetcher: async (url) => {
      calls.push(url);
      firstRequested();
      return calls.length === 1 ? firstResponse : new Response(null);
    },
  });
  await requested;
  await Promise.resolve();
  expect(calls).toEqual(["http://localhost:1234/"]);
  release();
  await warming;
  expect(calls).toEqual(webRuntimeRoutes.map((route) => `http://localhost:1234${route}`));
  expect(firstResponse.bodyUsed).toBe(true);
});

test("route warming rejects missing routes and bounds hanging response bodies", async () => {
  const web = child(), diagnostics = captureWebDiagnostics(web);
  web.stderr.emit("data", "Error: cold compile failed token=hidden");
  await expect(warmWebRoutes("http://localhost:1234", {
    timeoutMs: 30, intervalMs: 1, diagnostics,
    fetcher: async () => new Response(null, { status: 404 }),
  })).rejects.toThrow("HTTP 404");
  let signal: AbortSignal | undefined;
  const error = await warmWebRoutes("http://localhost:1234", {
    timeoutMs: 30, diagnostics,
    fetcher: async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start() {} }));
    },
  }).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("cold compile failed");
  expect((error as Error).message).not.toContain("hidden");
  expect(signal?.aborted).toBe(true);
});

test("runtime environment excludes inherited secrets and shared runtime overrides", () => {
  const env = webRuntimeEnv("/owned/runtime", "http://127.0.0.1:1234");
  expect(env.HOME).toBe("/owned/runtime");
  expect(env.XDG_CACHE_HOME).toBe("/owned/runtime/cache");
  expect(env.AGENDIA_API_ORIGIN).toBe("http://127.0.0.1:1234");
  for (const key of ["DATABASE_URL", "DEEPSEEK_API_KEY", "NODE_OPTIONS", "NEXT_PRIVATE_DEV_DIR"])
    expect(key in env).toBe(false);
});

test("timeout includes sanitized child output and last HTTP status", async () => {
  const web = child();
  const diagnostics = captureWebDiagnostics(web);
  web.stderr.emit("data", "Error: missing source file token=hidden");
  const error = await probeHttp("http://localhost:1234", {
    timeoutMs: 30, attemptMs: 10, intervalMs: 1, diagnostics,
    fetcher: async () => new Response(null, { status: 503 }),
  }).catch((error: Error) => error);
  expect((error as Error).message).toContain("HTTP 503");
  expect((error as Error).message).toContain("missing source file");
  expect((error as Error).message).not.toContain("hidden");
  expect(diagnostics.logs.join("")).toContain("missing source file");
  expect(diagnostics.logs.join("")).not.toContain("hidden");
});
