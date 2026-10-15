import { expect, test } from "bun:test";
import { argentinaDate, addDays, monthDays, shiftMonth, dayBounds, calendarRows } from "../../apps/web/src/ui/turnos-calendar";

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
