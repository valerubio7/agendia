import { describe, expect, test } from "bun:test";
import {
  MIN_RECONNECT_INTERVAL_MS,
  createReconnectThrottle,
} from "../../apps/whatsapp-manager/src/index.ts";

describe("WhatsApp manager reconnect throttle", () => {
  test("enforces a minimum reconnect interval of 15 seconds", () => {
    let now = 1_000;
    let calls = 0;
    const throttle = createReconnectThrottle({
      intervalMs: 1_000,
      now: () => now,
      run: async () => {
        calls += 1;
      },
    });

    expect(MIN_RECONNECT_INTERVAL_MS).toBe(15_000);
    expect(throttle.snapshot()).toEqual({
      running: false,
      nextAt: now + MIN_RECONNECT_INTERVAL_MS,
    });
    now += MIN_RECONNECT_INTERVAL_MS - 1;
    expect(throttle.tryRun()).toBe(false);
    expect(calls).toBe(0);
  });

  test("serializes reconnects and schedules the next attempt after completion", async () => {
    let now = 0;
    let calls = 0;
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const throttle = createReconnectThrottle({
      intervalMs: 5_000,
      now: () => now,
      run: () => {
        calls += 1;
        return pending;
      },
    });

    now = MIN_RECONNECT_INTERVAL_MS;
    expect(throttle.tryRun()).toBe(true);
    expect(calls).toBe(1);
    now = MIN_RECONNECT_INTERVAL_MS * 2;
    expect(throttle.tryRun()).toBe(false);
    expect(calls).toBe(1);
    expect(throttle.snapshot()).toEqual({ running: true, nextAt: 15_000 });

    complete();
    await pending;
    expect(throttle.snapshot()).toEqual({ running: false, nextAt: 45_000 });
    now = 44_999;
    expect(throttle.tryRun()).toBe(false);
    now = 45_000;
    expect(throttle.tryRun()).toBe(true);
    expect(calls).toBe(2);
  });
});
