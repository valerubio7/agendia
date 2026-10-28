import type { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Copy only source/assets; never follow links or traverse env/cache/generated files.
async function copySources(from: string, to: string, extensions: RegExp) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const source = join(from, entry.name), target = join(to, entry.name);
    if (entry.isDirectory()) await copySources(source, target, extensions);
    else if (entry.isFile() && extensions.test(entry.name)) await copyFile(source, target);
  }
}

export async function createWebRuntime(repo: string) {
  const root = await mkdtemp(join(tmpdir(), "agendia-web-e2e-"));
  const cwd = join(root, "apps/web");
  // Ownership is captured, not supplied to cleanup by a caller.
  const dispose = () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    await mkdir(cwd, { recursive: true });
    for (const name of ["package.json", "tsconfig.json", "next.config.ts"])
      await copyFile(join(repo, "apps/web", name), join(cwd, name));
    for (const name of ["app", "src"])
      await copySources(join(repo, "apps/web", name), join(cwd, name), /\.(?:ts|tsx|css)$/);
    await copySources(join(repo, "apps/web/public"), join(cwd, "public"), /\.(?:svg|png|jpg|webp|ico|ttf|woff2?)$/);
    for (const name of ["domain", "contracts"]) {
      const target = join(root, "packages", name);
      await mkdir(target, { recursive: true });
      await copyFile(join(repo, "packages", name, "package.json"), join(target, "package.json"));
      await copySources(join(repo, "packages", name, "src"), join(target, "src"), /\.ts$/);
    }
    // Dependency links are intended for reads, not enforced immutable.
    // Next-writable project files are owned copies; never chmod shared dependencies.
    for (const [target, source] of [
      [join(root, "node_modules"), join(repo, "node_modules")],
      [join(cwd, "node_modules"), join(repo, "apps/web/node_modules")],
    ]) {
      await mkdir(dirname(target!), { recursive: true });
      await symlink(source!, target!, "dir");
    }
    return { root, cwd, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function webRuntimeEnv(root: string, apiOrigin: string): NodeJS.ProcessEnv {
  // Do not forward provider/DB secrets or real Next runtime overrides.
  return {
    PATH: process.env.PATH,
    NODE_ENV: "development",
    HOME: root,
    TMPDIR: root,
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_CONFIG_HOME: join(root, "config"),
    NEXT_TELEMETRY_DISABLED: "1",
    AGENDIA_API_ORIGIN: apiOrigin,
  };
}

function sanitize(text: string) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*:[^\r\n]*/gi, "[redacted header]")
    .replace(/\b[\w-]*(?:password|secret|token|key)[\w-]*\s*[=:]\s*[^\s,;]+/gi, "[redacted]");
}

type DiagnosticChild = Pick<EventEmitter, "on"> & {
  stdout: Pick<EventEmitter, "on"> | null;
  stderr: Pick<EventEmitter, "on"> | null;
  exitCode: number | null;
};
export function captureWebDiagnostics(child: DiagnosticChild) {
  const logs: string[] = [];
  let raw = "", failure: string | undefined;
  let notify!: (failure: string) => void;
  const failed = new Promise<string>((resolve) => { notify = resolve; });
  const append = (chunk: unknown) => {
    // Retain the bounded startup head so noisy subsequent output cannot erase the cause.
    raw = (raw + String(chunk).slice(0, 8192)).slice(0, 8192);
    logs.splice(0, logs.length, sanitize(raw).slice(0, 8192));
  };
  const fail = (message: string) => {
    failure ??= sanitize(message).slice(0, 512);
    notify(failure);
  };
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", append);
  child.on("error", (error: Error) => fail(`child error: ${error.message}`));
  child.on("exit", (code, signal) => fail(`child exit code=${code} signal=${signal}`));
  if (child.exitCode !== null) fail(`child exit code=${child.exitCode}`);
  return { logs, failed, failure: () => failure };
}

export const webRuntimeRoutes = [
  "/", "/login", "/admin/login", "/businesses", "/profile", "/turnos", "/agent", "/business-calendar",
  "/clients", "/resources", "/services", "/whatsapp",
] as const;

interface WarmOptions extends Omit<ProbeOptions, "fetcher"> {
  fetcher?: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
}
export async function warmWebRoutes(url: string, options: WarmOptions = {}) {
  const { fetcher = fetch, timeoutMs = 60_000 } = options;
  const deadline = Date.now() + timeoutMs;
  // Compile every static fixture page before browser HMR clients connect.
  // Sequential, fully drained GETs avoid overlapping cold compilations.
  for (const route of webRuntimeRoutes) {
    const remaining = Math.max(0, deadline - Date.now());
    await probeHttp(new URL(route, url).href, {
      ...options, timeoutMs: remaining, attemptMs: remaining, expectedStatus: 200,
      fetcher: async (target, init) => {
        const response = await fetcher(target, init);
        if (response.status === 200) await response.arrayBuffer();
        else await response.body?.cancel();
        return response;
      },
    });
  }
}

type Diagnostics = ReturnType<typeof captureWebDiagnostics>;
interface ProbeOptions {
  timeoutMs?: number;
  attemptMs?: number;
  intervalMs?: number;
  expectedStatus?: number;
  fetcher?: (url: string, options: { signal: AbortSignal }) => Promise<Pick<Response, "status">>;
  diagnostics?: Diagnostics;
}
export async function probeHttp(url: string, options: ProbeOptions = {}) {
  const { timeoutMs = 60_000, attemptMs = 2_000, intervalMs = 100,
    fetcher = fetch, diagnostics } = options;
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  const failure = (reason: string) => new Error(
    `${reason}: ${sanitize(url).slice(0, 512)}; last=${sanitize(last).slice(0, 512)}\n${diagnostics?.logs.join("") ?? ""}`,
  );
  const exited = diagnostics?.failed;
  while (Date.now() < deadline) {
    if (diagnostics?.failure()) throw failure(diagnostics.failure()!);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(undefined); },
          Math.min(attemptMs, deadline - Date.now()));
      });
      // The explicit race also bounds injected/buggy fetchers that ignore AbortSignal.
      const response = await Promise.race([
        fetcher(url, { signal: controller.signal }), timedOut,
        ...(exited ? [exited] : []),
      ]);
      if (typeof response === "string") throw failure(response);
      if (response && (options.expectedStatus === undefined
        ? response.status < 500 : response.status === options.expectedStatus)) return true;
      last = response ? `HTTP ${response.status}` : "probe timed out";
    } catch (error) {
      if (diagnostics?.failure()) throw failure(diagnostics.failure()!);
      last = error instanceof Error ? error.message : "fetch failed";
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(intervalMs, deadline - Date.now()))));
  }
  throw failure("Readiness timeout");
}
