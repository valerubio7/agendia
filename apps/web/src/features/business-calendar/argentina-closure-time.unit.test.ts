import { describe, expect, test } from "bun:test";
import { parseInstantMs } from "../../../../../packages/domain/src/business-calendar/values";
import * as argentina from "./argentina-closure-time";

test("projects stored instants to exact Argentina datetime-local values", () => {
  for (const [raw, wall] of [
    ["2035-01-02T02:04:05.006+02:00", "2035-01-01T21:04:05.006"],
    ["2008-01-07T13:00:05.123+02:00", "2008-01-07T09:00:05.123"],
    ["0001-01-01T03:53:48.123Z", "0001-01-01T00:00:00.123"],
    ["2008-03-16T01:45:00.123Z", "2008-03-15T23:45:00.123"],
    ["2008-03-16T02:45:00.123Z", "2008-03-15T23:45:00.123"],
    ["9999-12-31T23:59:59.999-03:00", "9999-12-31T23:59:59.999"],
  ]) {
    expect(argentina.projectArgentinaClosureTime(raw!)).toBe(wall!);
    const converted = argentina.convertArgentinaClosureTime(wall!);
    expect(converted.ok).toBe(true);
    if (converted.ok) expect(converted.candidates.some(value =>
      new Date(value.instant).getTime() === new Date(raw!).getTime())).toBe(true);
  }
});

const convert = (value: string) => argentina.convertArgentinaClosureTime(value);
const candidate = (instant: string, offsetSeconds: number) => ({ instant, offsetSeconds });

describe("Argentina closure wall time conversion", () => {
  test("converts modern local minutes without ambient timezone parsing", () => {
    expect(convert("2026-06-01T09:00")).toEqual({ ok: true, candidates: [
      candidate("2026-06-01T12:00:00.000Z", -10800),
    ] });
  });

  test("uses historical IANA offsets and preserves the existing formatter", () => {
    expect(convert("2008-01-07T09:00")).toEqual({ ok: true, candidates: [
      candidate("2008-01-07T11:00:00.000Z", -7200),
    ] });
    expect(argentina.formatArgentinaClosureInstant("2008-01-07T11:00:00Z"))
      .toBe("07/01/2008, 09:00:00.000 (Argentina, GMT-02:00)");
    expect(argentina.formatArgentinaClosureDate("2026-06-01")).toBe("01/06/2026");
  });

  test("retains optional seconds and exact millisecond fractions", () => {
    for (const [suffix, fraction] of [["", "000"], [".1", "100"], [".12", "120"], [".123", "123"]]) {
      expect(convert(`2024-02-29T23:59:58${suffix}`)).toEqual({ ok: true, candidates: [
        candidate(`2024-03-01T02:59:58.${fraction}Z`, -10800),
      ] });
    }
  });

  test("rejects malformed, out-of-range and normalized calendar/time fields", () => {
    for (const value of ["", "2026-02-29T09:00", "2024-02-30T09:00", "1900-02-29T09:00",
      "0000-01-01T00:00", "10000-01-01T00:00", "2026-13-01T09:00", "2026-01-00T09:00",
      "2026-06-01T24:00", "2026-06-01T09:60", "2026-06-01T09:00:60",
      "2026-06-01T09:00:00.0001", "2026-06-01T09:00:00.1230", "2026-06-01T09:00.123",
      "2026-06-01T09:00Z", "2026-06-01T09:00-03:00", " 2026-06-01T09:00", "2026-06-01"]) {
      expect(convert(value)).toEqual({ ok: false, error: "invalid_wall_time", candidates: [] });
    }
    expect(convert("2000-02-29T09:00").ok).toBe(true);
  });

  // Actual gap/fold dates also covered by packages/domain/src/appointments/availability.unit.test.ts.
  test("rejects the skipped midnight hour rather than shifting it", () => {
    expect(convert("2007-12-30T00:30")).toEqual({ ok: false, error: "nonexistent_wall_time", candidates: [] });
    expect(convert("2007-12-30T01:00")).toEqual({ ok: true, candidates: [
      candidate("2007-12-30T03:00:00.000Z", -7200),
    ] });
  });

  test("exposes both repeated-hour candidates in instant order, never chooses one", () => {
    expect(convert("2008-03-15T23:45:00.123")).toEqual({ ok: true, candidates: [
      candidate("2008-03-16T01:45:00.123Z", -7200),
      candidate("2008-03-16T02:45:00.123Z", -10800),
    ] });
  });

  test("serializes second offsets and final-year instants within the exact API contract", () => {
    for (const [wall, instant, offset] of [
      ["0001-01-01T00:00:00.123", "0001-01-01T03:53:48.123Z", -14028],
      ["9999-12-31T23:59:59.999", "9999-12-31T23:59:59.999-03:00", -10800],
    ] as const) {
      const result = convert(wall);
      expect(result).toEqual({ ok: true, candidates: [candidate(instant, offset)] });
      if (result.ok) expect(parseInstantMs(result.candidates[0]!.instant)).toBe(parseInstantMs(instant));
    }
  });
});
