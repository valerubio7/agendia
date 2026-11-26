import { expect, test } from "bun:test";
import { argentinaDate, addDays, monthDays, shiftMonth, dayBounds, calendarRows } from "./turnos-calendar";
import { agendaDates, stepAgendaDate, agendaAvailability } from "./agenda-calendar";
import type { AppointmentRecord, Resource } from "../../api/api-client";

test("Turnos dates use Argentina rather than the host day", () => {
  expect(argentinaDate(Date.parse("2026-01-01T02:59:59Z"))).toBe("2025-12-31");
  expect(argentinaDate(Date.parse("2026-01-01T03:00:00Z"))).toBe("2026-01-01");
  expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  expect(addDays("2025-12-31", 7)).toBe("2026-01-07");
  expect(addDays("2026-01-07", -7)).toBe("2025-12-31");
  expect(shiftMonth("2024-01-31", 1)).toBe("2024-02-01");
  expect(shiftMonth("2025-12-04", 1)).toBe("2026-01-01");
  expect(monthDays("2024-02-20")).toHaveLength(29);
});

test("Argentina day bounds follow IANA daylight savings and exclude next day", () => {
  const modern = dayBounds("2026-01-01");
  expect(modern).toEqual({ from: "2026-01-01T03:00:00.000Z", to: "2026-01-02T03:00:00.000Z" });
  const spring = dayBounds("2007-12-30");
  expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe(23 * 3600000);
  const autumn = dayBounds("2008-03-15");
  expect(Date.parse(autumn.to) - Date.parse(autumn.from)).toBe(25 * 3600000);
  const rows = [
    { id: "b", startMs: Date.parse(modern.from), state: "cancelled" },
    { id: "a", startMs: Date.parse(modern.from), state: "confirmed" },
    { id: "c", startMs: Date.parse(modern.to), state: "confirmed" },
  ];
  expect(calendarRows(rows, "2026-01-01").map(row => row.id)).toEqual(["a", "b"]);
  expect(rows[0]?.id).toBe("b");
});

test("Agenda keeps Monday-based strips and the full 42-cell month, and clamps month navigation", () => {
  expect(agendaDates("2026-11-17", "day")).toEqual(agendaDates("2026-11-17", "week"));
  expect(agendaDates("2026-11-17", "week")).toEqual([
    "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22",
  ]);
  const month = agendaDates("2026-11-17", "month");
  expect([month[0], month.length, month.at(-1)]).toEqual(["2026-10-26", 42, "2026-12-06"]);
  expect(stepAgendaDate("2026-11-17", "day", -1)).toBe("2026-11-16");
  expect(stepAgendaDate("2026-11-17", "week", 1)).toBe("2026-11-24");
  expect(stepAgendaDate("2024-01-31", "month", 1)).toBe("2024-02-29");
});

test("Agenda free intervals honor resource hours, closures and confirmed occupancy including overnight", () => {
  const date = "2026-11-17";
  const weeklySchedule = { 1: [{ startMinute: 1380, endMinute: 120 }], 2: [{ startMinute: 540, endMinute: 720 }] };
  const resource = (id: string): Resource => ({ id, name: id, status: "active", description: null, serviceIds: [], weeklySchedule });
  const row = (state: AppointmentRecord["state"], start: string, end: string) => ({
    state, startMs: Date.parse(start), endMs: Date.parse(end), terms: { resourceId: "a" },
  });
  const rows = [row("confirmed", "2026-11-17T02:30:00Z", "2026-11-17T04:00:00Z"),
    row("cancelled", "2026-11-17T12:00:00Z", "2026-11-17T15:00:00Z"),
    row("confirmed", "2026-11-17T12:00:00Z", "2026-11-17T12:30:00Z")];
  const closures = [{ id: "c", kind: "interval", start: "2026-11-17T13:00:00Z", end: "2026-11-17T13:30:00Z" }] as const;
  expect(agendaAvailability(date, { weeklySchedule }, closures, [resource("a")], rows)).toEqual({
    gaps: [{ start: 60, end: 120 }, { start: 570, end: 600 }, { start: 630, end: 720 }], utilization: 33,
  });
  expect(agendaAvailability(date, { weeklySchedule }, closures, [resource("a"), resource("b")], rows).gaps).toEqual([
    { start: 0, end: 120 }, { start: 540, end: 600 }, { start: 630, end: 720 },
  ]);
  expect(agendaAvailability(date, { weeklySchedule: null }, [], [resource("a")], rows).gaps).toEqual([]);
  expect(agendaAvailability(date, { weeklySchedule }, [{ id: "closed", kind: "date", date }], [resource("a")], rows).gaps).toEqual([]);
});
