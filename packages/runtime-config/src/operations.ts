import { createServer, type Server } from "node:http";

export const HEARTBEAT_CADENCE_MS = 30_000;
export const HEARTBEAT_STALE_MS = 60_000;
const sensitiveKey = /(?:secret|password|token|authorization|auth|cookie|credential|session|database(?:url)?|jid|qr|message|text|ciphertext|key|body|prompt|response)/i;
const sensitiveValue = /(?:postgres(?:ql)?:\/\/|@s\.whatsapp\.net|^data:image\/|^\+?[1-9]\d{7,14}$)/i;
type RedactedValue = string | number | boolean | null | RedactedValue[] | { [key: string]: RedactedValue };

export function redactOperationsValue(value: unknown, key = ""): RedactedValue {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return sensitiveValue.test(value) ? "[REDACTED]" : value;
  if (Array.isArray(value)) return value.map((item) => redactOperationsValue(item));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactOperationsValue(item, name)]));
  return value === null || typeof value === "number" || typeof value === "boolean" ? value : String(value);
}

export function serializeOperationalLog(input: { level: "info" | "warn" | "error"; service: string; environment: string; releaseDigest: string; instanceId: string; code: string; details?: unknown }): string {
  return JSON.stringify({ timestamp: new Date().toISOString(), level: input.level, service: input.service, environment: input.environment, release_digest: input.releaseDigest, instance_id: input.instanceId, code: input.code, ...(input.details === undefined ? {} : { details: redactOperationsValue(input.details) }) });
}

export function createHeartbeat(options: { write: () => Promise<void>; now?: () => number; cadenceMs?: number }) {
  const now = options.now ?? Date.now;
  const cadenceMs = options.cadenceMs ?? HEARTBEAT_CADENCE_MS;
  let lastSeen = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = async () => { await options.write(); lastSeen = now(); };
  return {
    start: async () => { await tick(); timer = setInterval(() => void tick(), cadenceMs); },
    tick,
    stop: () => { if (timer) clearInterval(timer); timer = undefined; },
    isFresh: (at = now()) => lastSeen > 0 && at - lastSeen <= HEARTBEAT_STALE_MS,
  };
}

export function createDurableReadiness(options: { persistDraining: () => Promise<void> }) {
  let draining = false;
  return {
    ready: () => draining ? { ready: false as const, code: "draining" } : { ready: true as const, code: "ready" },
    markUnready: () => {
      draining = true;
      return options.persistDraining();
    },
  };
}

export function createLoopbackProbe(options: { ready: () => { ready: boolean; code: string }; port?: number }) {
  let server: Server | undefined;
  return {
    start: () => new Promise<void>((resolve) => { server = createServer((request, response) => { const state = request.url === "/live" ? { ready: true, code: "live" } : request.url === "/ready" ? options.ready() : undefined; response.writeHead(state ? (state.ready ? 200 : 503) : 404, { "content-type": "application/json" }); response.end(JSON.stringify(state ?? { code: "not_found" })); }).listen({ host: "127.0.0.1", port: options.port ?? 9090 }, resolve); }),
    stop: () => new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()),
  };
}

type DrainOptions = {
  timeoutMs: number;
  markUnready: () => Promise<void>;
  stopIntake: () => Promise<void>;
  stopTimers: () => Promise<void>;
  stopProbe: () => Promise<void>;
  stopRuntime: () => Promise<void>;
  releaseLocks: () => Promise<void>;
  awaitInFlightLockCleanup: () => Promise<void>;
  closePools: () => Promise<void>;
  onTimeout?: () => void;
};

export function createDrain(options: DrainOptions) {
  let draining: Promise<void> | undefined;
  const bounded = async (work: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("shutdown.timeout")), options.timeoutMs); })]);
      return true;
    } catch {
      options.onTimeout?.();
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const mandatory = async (work: () => Promise<void>) => { try { await work(); } catch { return; } };
  return () => draining ??= (async () => {
    await mandatory(options.markUnready);
    await mandatory(options.stopIntake);
    await mandatory(options.stopTimers);
    await mandatory(options.stopProbe);
    await bounded(options.stopRuntime);
    await mandatory(options.releaseLocks);
    await mandatory(options.awaitInFlightLockCleanup);
    await mandatory(options.closePools);
  })();
}
