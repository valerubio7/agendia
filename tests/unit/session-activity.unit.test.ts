import { describe, expect, test } from "bun:test";
import { startSessionActivity } from "../../apps/web/src/shell/session-activity";

describe("human session activity", () => {
  test("retries on the next trusted activity after a failed send without overlapping requests", async () => {
    const handlers = new Map<string, EventListener>();
    const target = { addEventListener: (type: string, fn: EventListener) => handlers.set(type, fn), removeEventListener: (type: string) => handlers.delete(type) };
    let calls = 0;
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_, reject) => { rejectFirst = reject; });
    const stop = startSessionActivity(target, () => ++calls === 1 ? first : Promise.resolve(), () => 100000);
    const activity = () => handlers.get("keydown")!({ isTrusted: true } as Event);
    activity();
    activity();
    expect(calls).toBe(1);
    rejectFirst(new Error("network unavailable"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toBe(1); // Failure alone never starts a retry.
    activity();
    expect(calls).toBe(2);
    await new Promise<void>(resolve => setImmediate(resolve));
    activity();
    expect(calls).toBe(2); // A successful send still throttles later activity.
    stop();
  });
  test("only trusted input sends activity; timers and synthetic events do not", async () => {
    const handlers = new Map<string, EventListener>();
    const target = { addEventListener: (type: string, fn: EventListener) => handlers.set(type, fn), removeEventListener: (type: string) => handlers.delete(type) };
    let now = 100000, calls = 0;
    const stop = startSessionActivity(target, async () => { calls++; }, () => now);
    expect(calls).toBe(0);
    handlers.get("pointerdown")!({ isTrusted: false } as Event);
    expect(calls).toBe(0);
    handlers.get("keydown")!({ isTrusted: true } as Event);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toBe(1);
    handlers.get("pointerdown")!({ isTrusted: true } as Event);
    expect(calls).toBe(1);
    now += 60000;
    expect(calls).toBe(1);
    handlers.get("pointerdown")!({ isTrusted: true } as Event);
    expect(calls).toBe(2);
    stop();
    expect(handlers.size).toBe(0);
  });
});
