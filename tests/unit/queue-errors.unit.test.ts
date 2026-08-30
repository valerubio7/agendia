import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { containQueueErrors } from "@agendia/db";

test("queue errors are contained and logged without error details", () => {
  const emitter = new EventEmitter();
  const lines: string[] = [];
  const hostileError = {
    databaseUrl: "postgres://worker:database-password@localhost/agendia",
    queue: "ai-generate",
    job: { payload: "private customer message" },
    stack: "secret stack trace",
    toJSON: () => {
      throw new Error("the queue error argument was serialized");
    },
  };

  containQueueErrors(emitter, "message-worker", (line) => lines.push(line));

  expect(emitter.listenerCount("error")).toBe(1);
  expect(() => emitter.emit("error", hostileError)).not.toThrow();
  expect(lines).toEqual([
    JSON.stringify({ code: "queue.error", component: "message-worker" }),
  ]);
  expect(lines[0]).not.toContain("postgres://");
  expect(lines[0]).not.toContain("database-password");
  expect(lines[0]).not.toContain("ai-generate");
  expect(lines[0]).not.toContain("private customer message");
  expect(lines[0]).not.toContain("secret stack trace");
});

test("queue error containment rejects components outside the allowlist", () => {
  const emitter = new EventEmitter();

  expect(() =>
    containQueueErrors(emitter, "api" as never, () => undefined),
  ).toThrow("Unsupported queue error component");
  expect(emitter.listenerCount("error")).toBe(0);
});
