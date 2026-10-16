import { describe, expect, test } from "bun:test";
import { AiOutboxDispatcher, type JobPublisher } from "../../apps/whatsapp-manager/src/ai-outbox-dispatcher.ts";
import type { createRuntimePools } from "@agendia/db";

const row = (publish_attempts = 1) => ({
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", stable_key: "ai:source-1",
  payload: { businessId: "tenant", messageId: "source-1", correlationId: "replaced" }, publish_attempts,
});
function fixture(rows = [row()]) {
  const claims: unknown[][] = [], completed: unknown[][] = [], released: unknown[][] = [];
  const repo = {
    claimAiOutbox: async (...args: unknown[]) => { claims.push(args); return rows; },
    completeAiOutbox: async (...args: unknown[]) => { completed.push(args); return 1; },
    releaseAiOutbox: async (...args: unknown[]) => { released.push(args); },
  };
  const pools = { manager: { run: async (_: unknown, fn: (r: typeof repo) => unknown) => fn(repo) } } as unknown as ReturnType<typeof createRuntimePools>;
  return { pools, rows, claims, completed, released };
}

describe("AI outbox publication versus generation retries", () => {
  test("publishes exact identity/payload with bounded generation retries and completes its claim", async () => {
    const h = fixture(), sent: unknown[][] = [];
    const publisher: JobPublisher = { send: async (...args) => { sent.push(args); return row().id; } };
    expect(await new AiOutboxDispatcher(h.pools, publisher, { queueName: "isolated", batchSize: 3, claimTtlMs: 123 }).dispatchBatch()).toBe(1);
    expect(sent).toEqual([["isolated", { businessId: "tenant", messageId: "source-1", correlationId: "ai:source-1" }, {
      id: row().id, singletonKey: row().stable_key, retryLimit: 2, retryDelay: 5, retryBackoff: true,
    }]]);
    const token = h.claims[0]![0];
    expect(token).toEqual(expect.any(String));
    expect(h.claims).toEqual([[token, 3, 123]]);
    expect(h.completed).toEqual([[row().id, token]]);
    expect(h.released).toEqual([]);
    expect(h.rows[0]!.payload.correlationId).toBe("replaced");
  });

  test("duplicate publication acknowledgement still completes, with default queue and claim settings", async () => {
    const h = fixture(), names: string[] = [];
    expect(await new AiOutboxDispatcher(h.pools, { send: async name => { names.push(name); return null; } }).dispatchBatch()).toBe(1);
    expect(names).toEqual(["ai-generate"]);
    expect(h.claims[0]!.slice(1)).toEqual([20, 30_000]);
    expect(h.completed).toHaveLength(1);
    expect(h.released).toEqual([]);
  });

  test("publication failures retain independent exponential retryBaseMs and capped release delays", async () => {
    for (const [attempt, base, delay] of [[1, 1000, 1000], [3, 17, 68], [99, 1000, 60_000]] as const) {
      const h = fixture([row(attempt)]);
      expect(await new AiOutboxDispatcher(h.pools, { send: async () => { throw new Error("broker unavailable"); } }, { retryBaseMs: base }).dispatchBatch()).toBe(0);
      expect(h.completed).toEqual([]);
      expect(h.released).toEqual([[row().id, h.claims[0]![0], delay]]);
    }
  });
});
