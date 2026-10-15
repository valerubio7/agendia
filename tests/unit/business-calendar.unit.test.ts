import { expect, test } from "bun:test";
import { BusinessClosureInputSchema, isStructurallyAvailable } from "@agendia/domain";

test("global closure inputs reuse strict date/instant rules and preserve raw values", () => {
  for (const date of ["0001-01-01", "2028-02-29", "9999-12-31"])
    expect(BusinessClosureInputSchema.parse({ kind: "date", date })).toEqual({ kind: "date", date });
  const interval = { kind: "interval" as const, start: "0001-01-01T00:00:00.001000+23:59", end: "0001-01-01T00:00:00.002000+23:59" };
  expect(BusinessClosureInputSchema.parse(interval)).toEqual(interval);
  expect(BusinessClosureInputSchema.safeParse({ kind: "interval", start: "2028-01-01T10:00:00+03:00", end: "2028-01-01T09:00:00Z" }).success).toBe(true);
  for (const value of [
    { kind: "date", date: "0000-01-01" }, { kind: "date", date: "2027-02-29" },
    { kind: "date", date: "2028-13-01" }, { kind: "date", date: "2028-01-01", resourceId: "unknown" },
    { kind: "interval", start: "2028-01-01T00:00:00", end: "2028-01-01T01:00:00Z" },
    ...["2028-01-01T00:00:00.0001Z", "2028-02-30T00:00:00Z", "0000-01-01T00:00:00Z", "2028-01-01T00:00:00+24:00"].map(start => ({ kind: "interval", start, end: "2029-01-01T00:00:00Z" })),
    { kind: "interval", start: "2028-01-01T10:00:00+03:00", end: "2028-01-01T07:00:00Z" },
    { kind: "interval", start: "2028-01-01T10:00:00Z", end: "2028-01-01T09:00:00Z" },
  ]) expect(BusinessClosureInputSchema.safeParse(value).success).toBe(false);
});

test("caller applies global union to both resources, overnight dates and half-open adjacency", () => {
  const hours = { 0: [{ startMinute: 1380, endMinute: 60 }] };
  const input = { start: "2028-01-02T23:45:00-03:00", durationMinutes: 30, businessHours: hours, resourceHours: hours };
  const resources = [
    { id: "a", busyIntervals: [] },
    { id: "b", busyIntervals: [{ start: "2028-01-02T23:00:00-03:00", end: "2028-01-02T23:45:00-03:00" }] },
  ];
  for (const resource of resources) {
    const selected = { ...input, busyIntervals: resource.busyIntervals };
    expect(isStructurallyAvailable({ ...selected, closedDates: ["2028-01-03"] })).toBe(false);
    expect(isStructurallyAvailable({ ...selected, durationMinutes: 15, closedDates: ["2028-01-03"] })).toBe(true);
    const closedIntervals = [
      { start: "2028-01-03T00:15:00-03:00", end: "2028-01-03T00:30:00-03:00" },
      { start: "2028-01-03T00:20:00-03:00", end: "2028-01-03T00:45:00-03:00" },
    ];
    expect(isStructurallyAvailable({ ...selected, closedIntervals })).toBe(true);
    expect(isStructurallyAvailable({ ...selected, durationMinutes: 45, closedIntervals })).toBe(false);
  }
});
