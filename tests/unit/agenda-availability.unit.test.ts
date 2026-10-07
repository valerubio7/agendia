import { describe, expect, test } from "bun:test";
import {
  WeeklyScheduleSchema,
  normalizeWeeklySchedule,
  isResourceScheduleWithinBusiness,
  isStructurallyAvailable,
  isNewStartAllowed,
  type AvailabilityInput,
  type WeeklySchedule,
} from "../../packages/domain/src/index.ts";

const span = (startMinute: number, endMinute: number) => ({ startMinute, endMinute });
const monday: WeeklySchedule = { 1: [span(540, 720), span(780, 1080)] };
const allWeek: WeeklySchedule = Object.fromEntries(
  Array.from({ length: 7 }, (_, day) => [day, [span(0, 1440)]]),
);
const request = (changes: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  start: "2026-06-01T09:00:00-03:00",
  durationMinutes: 30,
  businessHours: monday,
  resourceHours: monday,
  ...changes,
});

describe("weekly schedule representation and containment", () => {
  test("allows omitted/empty off-days, multiple spans and all-day hours", () => {
    expect(WeeklyScheduleSchema.safeParse({}).success).toBe(true);
    expect(WeeklyScheduleSchema.safeParse({ 0: [], 1: [span(0, 1440)] }).success).toBe(true);
    expect(WeeklyScheduleSchema.safeParse(monday).success).toBe(true);
  });

  test("rejects invalid days and minute spans rather than truncating", () => {
    for (const schedule of [
      { 7: [span(0, 60)] }, { monday: [] }, { 1: [span(60, 60)] },
      { 1: [span(-1, 60)] }, { 1: [span(1440, 60)] },
      { 1: [span(0, 1441)] }, { 1: [span(0.5, 60)] },
    ]) expect(WeeklyScheduleSchema.safeParse(schedule).success).toBe(false);
  });

  test("normalizes overlap and adjacency, but preserves real pauses", () => {
    expect(normalizeWeeklySchedule({ 1: [span(600, 720), span(540, 600), span(700, 780), span(800, 900)] }))
      .toEqual([{ startMinute: 1980, endMinute: 2220 }, { startMinute: 2240, endMinute: 2340 }]);
  });

  test("contains effective unions, overnight week-wrap and empty schedules", () => {
    const business: WeeklySchedule = { 0: [span(0, 120)], 6: [span(1320, 1440)] };
    expect(isResourceScheduleWithinBusiness({ 6: [span(1380, 60)] }, business)).toBe(true);
    expect(isResourceScheduleWithinBusiness({ 6: [span(1380, 180)] }, business)).toBe(false);
    expect(isResourceScheduleWithinBusiness({ 0: [span(1380, 120)] }, { 0: [span(1380, 1440)], 1: [span(0, 120)] })).toBe(true);
    expect(isResourceScheduleWithinBusiness({}, {})).toBe(true);
    expect(isResourceScheduleWithinBusiness(monday, {})).toBe(false);
    expect(isResourceScheduleWithinBusiness(allWeek, allWeek)).toBe(true);
    expect(isResourceScheduleWithinBusiness(allWeek, monday)).toBe(false);
    expect(isResourceScheduleWithinBusiness({ 7: [] } as WeeklySchedule, allWeek)).toBe(false);
  });
});

describe("pure structural availability", () => {
  test("accepts exact fits and rejects pause-crossing, overruns and off-days", () => {
    expect(isStructurallyAvailable(request({ durationMinutes: 180 }))).toBe(true);
    expect(isStructurallyAvailable(request({ durationMinutes: 195 }))).toBe(false);
    expect(isStructurallyAvailable(request({ start: "2026-06-01T11:45:00-03:00" }))).toBe(false);
    expect(isStructurallyAvailable(request({ start: "2026-06-02T09:00:00-03:00" }))).toBe(false);
    expect(isStructurallyAvailable(request({ resourceHours: {} }))).toBe(false);
    expect(isStructurallyAvailable(request({ businessHours: {} }))).toBe(false);
  });

  test("a full local day ends exactly at midnight without occupying the next closed date", () => {
    const hours = { 1: [span(0, 1440)] };
    const fullDay = request({
      start: "2026-06-01T00:00:00-03:00", durationMinutes: 1440,
      businessHours: hours, resourceHours: hours, closedDates: ["2026-06-02"],
    });
    expect(isStructurallyAvailable(fullDay)).toBe(true);
    expect(isStructurallyAvailable({ ...fullDay, durationMinutes: 1455 })).toBe(false);
  });

  test("overlapping/adjacent opening spans form a continuous union in both schedules", () => {
    const hours = { 1: [span(540, 600), span(600, 720), span(700, 780)] };
    expect(isStructurallyAvailable(request({ businessHours: hours, resourceHours: hours, durationMinutes: 240 }))).toBe(true);
    expect(isStructurallyAvailable(request({ businessHours: hours, durationMinutes: 240 }))).toBe(false);
  });

  test("supports overnight Sunday to Monday and half-open closed dates", () => {
    const hours = { 0: [span(1380, 120)] };
    const overnight = request({ start: "2026-05-31T23:00:00-03:00", businessHours: hours, resourceHours: hours });
    expect(isStructurallyAvailable({ ...overnight, durationMinutes: 180 })).toBe(true);
    expect(isStructurallyAvailable({ ...overnight, durationMinutes: 195 })).toBe(false);
    expect(isStructurallyAvailable({ ...overnight, durationMinutes: 60, closedDates: ["2026-06-01"] })).toBe(true);
    expect(isStructurallyAvailable({ ...overnight, durationMinutes: 75, closedDates: ["2026-06-01"] })).toBe(false);
    expect(isStructurallyAvailable({ ...overnight, closedDates: ["2026-05-31"] })).toBe(false);
  });

  test("caller supplies only selected-resource confirmed busy intervals; adjacency is free", () => {
    const busy = { start: "2026-06-01T09:30:00-03:00", end: "2026-06-01T10:00:00-03:00" };
    expect(isStructurallyAvailable(request({ busyIntervals: [busy] }))).toBe(true);
    expect(isStructurallyAvailable(request({ durationMinutes: 45, busyIntervals: [busy] }))).toBe(false);
    expect(isStructurallyAvailable(request({ start: busy.end, busyIntervals: [busy] }))).toBe(true);
    // Other-resource bookings and an authorized self-exclusion never enter this input.
    expect(isStructurallyAvailable(request())).toBe(true);
  });

  test("global closures use the same half-open interval contract", () => {
    const closure = { start: "2026-06-01T09:30:00-03:00", end: "2026-06-01T10:00:00-03:00" };
    expect(isStructurallyAvailable(request({ closedIntervals: [closure] }))).toBe(true);
    expect(isStructurallyAvailable(request({ durationMinutes: 45, closedIntervals: [closure] }))).toBe(false);
  });

  test("rejects malformed calendar dates, instants, raw fractions and off-grid starts", () => {
    for (const start of [
      "2026-02-30T09:00:00-03:00", "2026-06-01T09:00:00", "2026-06-01",
      "2026-06-01T24:00:00-03:00", "2026-06-01T09:00:60-03:00",
      "2026-06-01T09:00:01-03:00", "2026-06-01T09:01:00-03:00",
      "2026-06-01T09:00:00.0000001-03:00", "2026-06-01T09:00:00.001-03:00",
      "2026-06-01T09:00:00+24:00", "0000-01-01T00:08:48Z", "not-a-date",
    ]) expect(isStructurallyAvailable(request({ start, businessHours: allWeek, resourceHours: allWeek }))).toBe(false);
    expect(isStructurallyAvailable(request({ start: "2026-06-01T09:00:00.0000-03:00" }))).toBe(true);
  });

  test("invalid durations, schedules, closure dates and intervals safely reject", () => {
    for (const durationMinutes of [0, -15, 16, 15.5, NaN, Infinity, Number.MAX_VALUE]) {
      expect(isStructurallyAvailable(request({ durationMinutes }))).toBe(false);
    }
    for (const closedDates of [["2026-02-30"], ["2026-13-01"], ["0000-12-31"], ["2026-06-01T00:00:00Z"]]) {
      expect(isStructurallyAvailable(request({ closedDates }))).toBe(false);
    }
    for (const interval of [
      { start: "invalid", end: "invalid" },
      { start: "2026-06-01T12:00:00.0000001Z", end: "2026-06-01T13:00:00Z" },
      { start: "2026-02-30T09:00:00Z", end: "2026-03-01T09:00:00Z" },
      { start: "2026-06-01T12:00:00Z", end: "2026-06-01T12:00:00Z" },
      { start: "2026-06-01T13:00:00Z", end: "2026-06-01T12:00:00Z" },
    ]) {
      expect(isStructurallyAvailable(request({ busyIntervals: [interval] }))).toBe(false);
      expect(isStructurallyAvailable(request({ closedIntervals: [interval] }))).toBe(false);
    }
    expect(isStructurallyAvailable(request({ resourceHours: { 1: [span(60, 60)] } }))).toBe(false);
  });

  test("projects instants with Argentina IANA rules, independently of input offset", () => {
    expect(isStructurallyAvailable(request({ start: "2026-06-01T12:00:00Z" }))).toBe(true);
    expect(isStructurallyAvailable(request({ start: "2026-06-01T09:00:00Z" }))).toBe(false);
    // Buenos Aires used UTC-02 in January 2008, not today's UTC-03.
    expect(isStructurallyAvailable(request({ start: "2008-01-07T11:00:00Z" }))).toBe(true);
    expect(isStructurallyAvailable(request({ start: "2008-01-07T10:00:00Z" }))).toBe(false);
  });

  test("preserves the local BCE weekday when a CE instant crosses the era boundary", () => {
    const start = "0001-01-01T00:08:48Z";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires", calendar: "gregory",
      numberingSystem: "latn", hourCycle: "h23", era: "short",
      year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(start));
    const local = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    expect(local).toMatchObject({
      era: "BC", year: "1", month: "12", day: "31", weekday: "Sunday",
      hour: "20", minute: "15", second: "00",
    });
    const sunday = { 0: [span(1200, 1260)] };
    const mondayEvening = { 1: [span(1200, 1260)] };
    const boundary = request({ start, durationMinutes: 15, businessHours: sunday, resourceHours: sunday });
    expect(isStructurallyAvailable(boundary)).toBe(true);
    expect(isStructurallyAvailable({ ...boundary, businessHours: mondayEvening, resourceHours: mondayEvening })).toBe(false);
  });

  test("uses IANA transition segments rather than assuming a fixed elapsed/local duration", () => {
    const hours = { 6: [span(1380, 120)] };
    const crossing = request({
      start: "2007-12-29T23:45:00-03:00",
      businessHours: hours,
      resourceHours: hours,
    });
    // At local midnight Buenos Aires advanced to 01:00 (UTC-02).
    expect(isStructurallyAvailable({ ...crossing, durationMinutes: 75 })).toBe(true);
    expect(isStructurallyAvailable({ ...crossing, durationMinutes: 90 })).toBe(false);
    expect(isStructurallyAvailable({ ...crossing, closedDates: ["2007-12-30"] })).toBe(false);
    expect(isStructurallyAvailable({ ...crossing, durationMinutes: 15, closedDates: ["2007-12-30"] })).toBe(true);
    // March's rollback repeats Saturday's 23:00 hour before Sunday starts.
    const rollback = request({
      start: "2008-03-15T23:45:00-02:00", durationMinutes: 75,
      businessHours: { 6: [span(1380, 1440)] },
      resourceHours: { 6: [span(1380, 1440)] },
    });
    expect(isStructurallyAvailable({ ...rollback, closedDates: ["2008-03-16"] })).toBe(true);
    expect(isStructurallyAvailable({ ...rollback, durationMinutes: 90 })).toBe(false);
    expect(isStructurallyAvailable({ ...rollback, closedDates: ["2008-03-15"] })).toBe(false);
  });

  test("has no future horizon or duration cap and avoids enumerating fully open weeks", () => {
    const unrestricted = request({ start: "9000-01-01T09:00:00-03:00", businessHours: allWeek, resourceHours: allWeek });
    expect(isStructurallyAvailable(unrestricted)).toBe(true);
    expect(isStructurallyAvailable({ ...unrestricted, durationMinutes: 100_000_005 })).toBe(true);
    expect(isStructurallyAvailable({ ...unrestricted, durationMinutes: 100_000_005, closedDates: ["9001-01-01"] })).toBe(false);
    expect(isStructurallyAvailable({ ...unrestricted, durationMinutes: 100_000_005, closedDates: ["8999-01-01"] })).toBe(true);
    expect(isNewStartAllowed(unrestricted, "2026-06-01T08:00:00-03:00")).toBe(true);
    expect(isStructurallyAvailable(request({ durationMinutes: 100_000_005 }))).toBe(false);
    expect(isStructurallyAvailable({ ...unrestricted, durationMinutes: Number.MAX_SAFE_INTEGER })).toBe(false);
  });
});

describe("injected-clock new-start gate", () => {
  test("allows exactly one hour, rejects earlier, and keeps structural edits independent", () => {
    const now = "2026-06-01T08:00:00-03:00";
    expect(isNewStartAllowed(request(), now)).toBe(true);
    expect(isNewStartAllowed(request(), "2026-06-01T08:00:00.001-03:00")).toBe(false);
    expect(isStructurallyAvailable(request())).toBe(true);
    expect(isNewStartAllowed(request(), "2026-06-01T08:30:00-03:00")).toBe(false);
    expect(isNewStartAllowed(request(), "invalid")).toBe(false);
    expect(isNewStartAllowed(request(), "2026-06-01T08:00:00.0000001-03:00")).toBe(false);
    expect(isNewStartAllowed(request({ start: "2026-06-01T09:01:00-03:00" }), now)).toBe(false);
    expect(isNewStartAllowed(request(), "2026-02-30T08:00:00-03:00")).toBe(false);
  });
});
