import { describe, expect, test } from "bun:test";
import {
  CalendarDateSchema,
  InstantSchema,
  OrderedInstantIntervalSchema,
  parseCalendarDateMs,
  parseInstantMs,
} from "../index.ts";

describe("shared calendar dates", () => {
  test("preserves valid Gregorian dates including leap days and early positive years", () => {
    for (const value of ["2024-02-29", "2000-02-29", "2026-04-30", "0001-01-01", "0099-12-31"]) {
      expect(CalendarDateSchema.parse(value)).toBe(value);
      expect(parseCalendarDateMs(value)).toBe(Date.parse(`${value}T00:00:00Z`));
    }
    expect(parseCalendarDateMs("0001-01-01")).toBe(-62135596800000);
  });

  test("rejects invalid days, months, zero years, prose, whitespace and non-strings", () => {
    for (const value of [
      "2026-02-30", "2023-02-29", "1900-02-29", "2026-04-31", "2026-01-00",
      "2026-00-01", "2026-13-01", "0000-01-01", "2026-1-01", "10000-01-01",
      " 2026-01-01", "2026-01-01 ", "January 1, 2026", "2026-01-01T00:00:00Z",
      "", null, undefined, 20260101, {}, [],
    ]) {
      expect(CalendarDateSchema.safeParse(value).success).toBe(false);
      expect(parseCalendarDateMs(value)).toBeUndefined();
    }
  });
});

describe("shared explicit instants", () => {
  test("preserves raw offsets and fractions while comparing exact milliseconds", () => {
    const cases: [string, number][] = [
      ["2026-06-01T12:00:00Z", 1780315200000],
      ["2026-06-01T09:00:00-03:00", 1780315200000],
      ["2026-06-01T17:30:00+05:30", 1780315200000],
      ["2026-06-01T12:00:00.1Z", 1780315200100],
      ["2026-06-01T12:00:00.12Z", 1780315200120],
      ["2026-06-01T12:00:00.123000Z", 1780315200123],
      ["2026-06-01T12:00:00.0000-00:00", 1780315200000],
      ["0001-01-01T00:08:48Z", -62135596272000],
      ["2024-02-29T23:59:59.999Z", 1709251199999],
    ];
    for (const [value, milliseconds] of cases) {
      expect(InstantSchema.parse(value)).toBe(value);
      expect(parseInstantMs(value)).toBe(milliseconds);
    }
  });

  test("rejects missing offsets, invalid components, lossy fractions and trailing junk", () => {
    for (const value of [
      "2026-06-01T12:00:00", "2026-06-01", "2026-06-01 12:00:00Z",
      "2026-06-01T12:00Z", "2026-06-01T12:00:00z", "2026-06-01T12:00:00+0300",
      "2026-06-01T12:00:00+24:00", "2026-06-01T12:00:00-03:60",
      "2026-02-30T12:00:00Z", "1900-02-29T12:00:00Z", "0000-01-01T00:00:00Z",
      "2026-13-01T12:00:00Z", "2026-06-01T24:00:00Z", "2026-06-01T12:60:00Z",
      "2026-06-01T12:00:60Z", "2026-06-01T12:00:00.Z", "2026-06-01T12:00:00.1231Z",
      "2026-06-01T12:00:00.0000001Z", "2026-06-01T12:00:00Zjunk",
      " 2026-06-01T12:00:00Z", "2026-06-01T12:00:00Z ", "tomorrow", null, undefined, 0, {}, [],
    ]) {
      expect(InstantSchema.safeParse(value).success).toBe(false);
      expect(parseInstantMs(value)).toBeUndefined();
    }
  });
});

describe("ordered half-open instant intervals", () => {
  test("preserves endpoints and permits shared boundaries of adjacent intervals", () => {
    const first = { start: "2026-06-01T09:00:00-03:00", end: "2026-06-01T12:30:00Z" };
    const second = { start: first.end, end: "2026-06-01T12:30:00.001Z" };
    expect(OrderedInstantIntervalSchema.parse(first)).toEqual(first);
    expect(OrderedInstantIntervalSchema.parse(second)).toEqual(second);
    // Like other domain input objects, unknown keys are stripped, not persisted.
    expect(OrderedInstantIntervalSchema.parse({ ...first, extra: true })).toEqual(first);
  });

  test("orders actual instants rather than lexical local times", () => {
    expect(OrderedInstantIntervalSchema.safeParse({
      start: "2026-06-01T12:00:00+02:00", end: "2026-06-01T11:00:00Z",
    }).success).toBe(true);
    expect(OrderedInstantIntervalSchema.safeParse({
      start: "2026-06-01T10:00:00Z", end: "2026-06-01T11:00:00+02:00",
    }).success).toBe(false);
  });

  test("rejects zero or reversed lengths including equal instants in different offsets", () => {
    for (const end of ["2026-06-01T12:00:00Z", "2026-06-01T09:00:00-03:00", "2026-06-01T11:59:59.999Z"]) {
      expect(OrderedInstantIntervalSchema.safeParse({ start: "2026-06-01T12:00:00Z", end }).success).toBe(false);
    }
  });

  test("rejects malformed or missing nested values and non-object inputs", () => {
    const valid = "2026-06-01T12:00:00Z";
    for (const value of [
      { start: "invalid", end: valid }, { start: valid, end: "2026-02-30T13:00:00Z" },
      { start: valid, end: "2026-06-01T13:00:00" }, { start: 0, end: valid },
      { start: valid, end: null }, { start: valid }, { end: valid }, {}, null, [], valid,
    ]) expect(OrderedInstantIntervalSchema.safeParse(value).success).toBe(false);
  });
});
