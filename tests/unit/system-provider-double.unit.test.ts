import { expect, test } from "bun:test";
import { DeterministicBaileysSystemDouble } from "../e2e/support/providers.ts";

// Drive the double's own microtasks and timers, without real sleeps or Bun fake timers.
async function scheduled(run: (clock: {
  flush: () => Promise<void>;
  fire: () => Promise<void>;
  timers: Map<number, { callback: () => unknown; ms: number }>;
}) => Promise<void>) {
  const original = { setTimeout, clearTimeout, queueMicrotask };
  const microtasks: Array<() => unknown> = [];
  const timers = new Map<number, { callback: () => unknown; ms: number }>();
  let sequence = 0;
  globalThis.queueMicrotask = (callback) => { microtasks.push(callback); };
  globalThis.setTimeout = ((callback: () => unknown, ms: number) => {
    timers.set(++sequence, { callback, ms });
    return sequence;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const flush = async () => {
    while (microtasks.length) await microtasks.shift()!();
    // Drain promise continuations after the QR listener completes.
    await Promise.resolve();
    await Promise.resolve();
  };
  try {
    await run({ timers, flush, fire: async () => {
      await flush();
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        await timer.callback();
      }
      await flush();
    } });
  } finally {
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    globalThis.queueMicrotask = original.queueMicrotask;
  }
}

function provider() {
  const double = new DeterministicBaileysSystemDouble();
  double.active = true;
  return double;
}

test("a selected initial socket retains its QR until explicitly opened", async () => {
  await scheduled(async (clock) => {
    const double = provider();
    double.holdSocket(1);
    double.factory({} as Parameters<typeof double.factory>[0]);
    const socket = double.sockets[0]!;
    const events: Record<string, unknown>[] = [];
    socket.ev.on("connection.update", (event) => { events.push(event); });
    await clock.fire();
    expect(events).toEqual([{ qr: "deterministic-qr-1" }]);
    expect(clock.timers.size).toBe(0);
    let ready = false;
    void socket.ready.then(() => { ready = true; });
    await clock.flush();
    expect(ready).toBe(false);
    await Promise.all([double.openSocket(1), double.openSocket(1)]);
    await socket.ready;
    expect(events).toEqual([{ qr: "deterministic-qr-1" }, { connection: "open" }]);
    expect(ready).toBe(true);
    await double.openSocket(1);
    expect(events).toHaveLength(2);
    expect(clock.timers.size).toBe(0);
    socket.end();
  });
});

test("default and later recovery sockets still auto-open at 750ms", async () => {
  await scheduled(async (clock) => {
    const double = provider();
    double.holdSocket(1);
    for (let index = 1; index <= 3; index++) {
      double.factory({} as Parameters<typeof double.factory>[0]);
      const socket = double.sockets[index - 1]!;
      const events: Record<string, unknown>[] = [];
      socket.ev.on("connection.update", (event) => { events.push(event); });
      await clock.flush();
      expect(events).toEqual([{ qr: `deterministic-qr-${index}` }]);
      if (index === 1) {
        expect(clock.timers.size).toBe(0);
        await double.openSocket(index);
      } else {
        expect([...clock.timers.values()].map((timer) => timer.ms)).toEqual([750]);
        await clock.fire();
      }
      await socket.ready;
      expect(events).toEqual([{ qr: `deterministic-qr-${index}` }, { connection: "open" }]);
      socket.end();
    }
    expect(clock.timers.size).toBe(0);
  });
});

test("explicit opening waits for QR and async open listeners exactly once", async () => {
  await scheduled(async (clock) => {
    const double = provider();
    double.holdSocket(1);
    double.factory({} as Parameters<typeof double.factory>[0]);
    const socket = double.sockets[0]!;
    const events: string[] = [];
    let finishQr!: () => void;
    let finishOpen!: () => void;
    const qr = new Promise<void>((resolve) => { finishQr = resolve; });
    const opened = new Promise<void>((resolve) => { finishOpen = resolve; });
    socket.ev.on("connection.update", async (event) => {
      events.push(event.qr ? "qr" : "open");
      await (event.qr ? qr : opened);
    });
    let ready = false;
    void socket.ready.then(() => { ready = true; });
    const opening = Promise.all([double.openSocket(1), double.openSocket(1)]);
    const flushing = clock.flush();
    expect(events).toEqual(["qr"]);
    expect(ready).toBe(false);
    finishQr();
    await flushing;
    expect(events).toEqual(["qr", "open"]);
    expect(ready).toBe(false);
    finishOpen();
    await opening;
    await socket.ready;
    expect(ready).toBe(true);
    expect(clock.timers.size).toBe(0);
    socket.end();
  });
});

test("missing, unregistered and ended sockets fail clearly", async () => {
  await scheduled(async (clock) => {
    const double = provider();
    await expect(double.openSocket(1)).rejects.toThrow("socket unavailable: 1");
    expect(() => double.holdSocket(0)).toThrow("new socket index required");
    double.holdSocket(1);
    double.factory({} as Parameters<typeof double.factory>[0]);
    const socket = double.sockets[0]!;
    expect(() => double.holdSocket(1)).toThrow("new socket index required");
    await expect(double.openSocket(1)).rejects.toThrow("socket listener unavailable: 1");
    const events: Record<string, unknown>[] = [];
    socket.ev.on("connection.update", (event) => { events.push(event); });
    socket.end();
    socket.end();
    await clock.fire();
    socket.transientClose();
    await expect(double.openSocket(1)).rejects.toThrow("socket ended: 1");
    await expect(socket.emit("connection.update", { connection: "open" })).rejects.toThrow("socket ended: 1");
    expect(events).toEqual([]);
    expect(clock.timers.size).toBe(0);
  });
});

test("ending an automatic socket cancels its pending timer and events", async () => {
  await scheduled(async (clock) => {
    const double = provider();
    double.factory({} as Parameters<typeof double.factory>[0]);
    const socket = double.sockets[0]!;
    const events: Record<string, unknown>[] = [];
    socket.ev.on("connection.update", (event) => { events.push(event); });
    await clock.flush();
    expect(clock.timers.size).toBe(1);
    socket.end();
    expect(clock.timers.size).toBe(0);
    await clock.fire();
    socket.transientClose();
    expect(events).toEqual([{ qr: "deterministic-qr-1" }]);
  });
});

test("ending while QR is pending prevents requested opening", async () => {
  await scheduled(async (clock) => {
    const double = provider();
    double.holdSocket(1);
    double.factory({} as Parameters<typeof double.factory>[0]);
    const socket = double.sockets[0]!;
    const events: Record<string, unknown>[] = [];
    let finishQr!: () => void;
    const qr = new Promise<void>((resolve) => { finishQr = resolve; });
    socket.ev.on("connection.update", async (event) => { events.push(event); await qr; });
    const opening = double.openSocket(1).catch((error: unknown) => error);
    const flushing = clock.flush();
    socket.end();
    finishQr();
    await flushing;
    expect(await opening).toMatchObject({ message: "socket ended: 1" });
    expect(events).toEqual([{ qr: "deterministic-qr-1" }]);
    expect(clock.timers.size).toBe(0);
  });
});
