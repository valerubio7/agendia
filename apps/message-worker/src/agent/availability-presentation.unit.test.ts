import { describe, expect, test } from "bun:test";
import { presentAvailability } from "./availability-presentation.ts";
import { canonicalAgentDate, AGENT_CALENDAR_TIME_ZONE } from "./tools.ts";

const slot = (time: string, resourceId = "a", date = "2026-10-29") => {
  const startsAt = `${date}T${time}:00-03:00`;
  return { startsAt, resourceId, presentation: canonicalAgentDate(startsAt, AGENT_CALENDAR_TIME_ZONE) };
};

describe("availability presentation", () => {
  test("compresses actual quarter-hour starts from 12 to 16 without losing source items", () => {
    const items = Array.from({ length: 17 }, (_, i) => slot(`${String(12 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`));
    const result = presentAvailability({ items, hasMore: false });
    expect(result.items).toEqual(items);
    expect(result.hasMore).toBe(false);
    expect(result.startGroups).toEqual([{ first: 0, last: 16 }]);
  });
  test("deduplicates starts and never spans gaps, resources or dates", () => {
    const items = [slot("12:00"), slot("12:00", "b"), slot("12:15"), slot("12:45"), slot("13:00", "b"), slot("13:15", "b"), slot("13:30", "b"), slot("13:45", "b", "2026-10-30")];
    expect(presentAvailability({ items, hasMore: true })).toEqual({ items, hasMore: true,
      startGroups: [{ first: 0, last: 2 }, { first: 3, last: 3 }, { first: 4, last: 6 }, { first: 7, last: 7 }] });
  });
  test("does not bridge real daylight-saving jumps or repeated local times", () => {
    const zone = "America/New_York";
    const items = ["2024-03-10T06:45:00Z", "2024-03-10T07:00:00Z", "2024-11-03T05:45:00Z", "2024-11-03T06:00:00Z"]
      .map(startsAt => ({ startsAt, resourceId: "a", presentation: canonicalAgentDate(startsAt, zone) }));
    expect(items.map(item => item.presentation?.localTime)).toEqual(["01:45", "03:00", "01:45", "01:00"]);
    expect(presentAvailability({ items, hasMore: false })).toEqual({ items, hasMore: false,
      startGroups: [{ first: 0, last: 0 }, { first: 1, last: 1 }, { first: 2, last: 2 }, { first: 3, last: 3 }] });
  });
  test("empty and sparse results stay explicit", () => {
    expect(presentAvailability({ items: [], hasMore: false }).startGroups).toEqual([]);
    expect(presentAvailability({ items: [slot("09:00"), slot("10:00")], hasMore: false }).startGroups)
      .toEqual([{ first: 0, last: 0 }, { first: 1, last: 1 }]);
  });
});
