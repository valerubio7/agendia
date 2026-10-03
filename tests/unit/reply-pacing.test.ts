import { describe, expect, test } from "bun:test";
import { replyDeadline } from "../../packages/db/src/reply-pacing.ts";

describe("persisted reply deadline policy", () => {
  const now = new Date("2026-01-01T23:59:00Z");
  test("initial, including inbound activity before any sent reply", () => {
    expect(replyDeadline(now, null, now, null).getTime() - now.getTime()).toBe(600_000);
  });
  test("active and strict one-hour reset boundary", () => {
    const sent = new Date(now.getTime() - 7_200_000);
    for (const [gap, delay] of [[0, 90_000], [3_600_000, 90_000], [3_600_001, 600_000]] as const) {
      expect(replyDeadline(now, sent, new Date(now.getTime() - gap), null).getTime() - now.getTime()).toBe(delay);
    }
  });
  test("an existing burst never slides, even when its deadline passed", () => {
    const due = new Date(now.getTime() - 1);
    expect(replyDeadline(now, null, null, due)).toEqual(due);
  });
});
