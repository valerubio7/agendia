import { expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import type { SQLWrapper } from "drizzle-orm";
import { PostgresRepositories } from "./repositories.ts";

const turn = (sequence: number, closesGroup = false) => ({
  id: `message-${sequence}`,
  sequence: String(sequence),
  direction: "inbound" as const,
  raw_text: `input-${sequence}`,
  processing_state: closesGroup ? "ai_failed" : "pending",
  closes_group: closesGroup,
});

async function loadGroup(turns: ReturnType<typeof turn>[], latest: ReturnType<typeof turn>) {
  // Match loadAiMessage's five sequential reads without a database or SQL parser.
  const responses = [
    [{
      id: latest.id,
      business_id: "business-a",
      sequence: latest.sequence,
      conversation_id: "conversation-a",
      connection_id: "connection-a",
      raw_text: latest.raw_text,
    }],
    [{ display_name: "Business A" }],
    [{ style: "helpful" }],
    turns,
    [],
  ];
  let calls = 0;
  const db = drizzle.mock();
  const nativeExecute = db.execute.bind(db);
  const execute = spyOn(db, "execute").mockImplementation(<TRow extends Record<string, unknown>>(statement: SQLWrapper | string) => {
    const response = responses[calls++];
    if (!response) throw new Error("Unexpected SQL read");
    const query = nativeExecute<TRow>(statement);
    spyOn(query, "execute").mockResolvedValue(Object.assign(response, {
      count: response.length, command: "SELECT", columns: [],
      statement: { name: "", string: "", types: [], columns: [] }, state: { status: "I", pid: 0, secret: 0 },
    }) as unknown as Awaited<ReturnType<typeof query.execute>>);
    return query;
  });
  const repository = new PostgresRepositories(db);
  const loaded = await repository.loadAiMessage(latest.id, true);
  execute.mockRestore();
  expect(calls).toBe(5);
  expect(loaded).not.toBeNull();
  return loaded!;
}

test("loads the exact current group after 200000 historical closures without an argument limit", async () => {
  const closures = Array.from({ length: 200_000 }, (_, index) => turn(index + 1, true));
  const latest = turn(200_001);
  const futureClosure = turn(200_002, true);
  const futureInput = turn(200_003);
  const turns = [...closures, latest, futureClosure, futureInput];
  const loaded = await loadGroup(turns, latest);
  expect(loaded.currentGroup).toEqual([latest]);
  expect(loaded.turns === turns).toBe(true);
  expect(loaded.raw_text).toBe(latest.raw_text);
});

test("preserves all current inbound inputs when no earlier closure exists", async () => {
  const first = turn(1);
  const latest = turn(2);
  const loaded = await loadGroup([first, latest, turn(3, true)], latest);
  expect(loaded.currentGroup).toEqual([first, latest]);
});
