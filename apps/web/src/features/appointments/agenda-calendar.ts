import { normalizeWeeklySchedule } from "@agendia/domain/agenda-availability";
import type { AppointmentRecord, BusinessCalendar, BusinessClosure, Resource, WeeklySchedule } from "../../api/api-client";
import { addDays, dayBounds, monthDays, shiftMonth, turnoTime } from "./turnos-calendar";

export type AgendaView = "day" | "week" | "month";
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
export function agendaDates(date: string, view: AgendaView) {
  const first = view === "month" ? `${date.slice(0, 7)}-01` : date;
  const monday = addDays(first, -((weekday(first) + 6) % 7));
  return Array.from({ length: view === "month" ? 42 : 7 }, (_, index) => addDays(monday, index));
}

export function stepAgendaDate(date: string, view: AgendaView, direction: -1 | 1) {
  if (view !== "month") return addDays(date, direction * (view === "week" ? 7 : 1));
  const first = shiftMonth(date, direction);
  return addDays(first, Math.min(Number(date.slice(8)), monthDays(first).length) - 1);
}

export type AgendaSchedule = { calendar: BusinessCalendar; resources: Resource[]; closures: BusinessClosure[] };
type Interval = { start: number; end: number };
type Occupancy = Pick<AppointmentRecord, "state" | "startMs" | "endMs"> & { terms: Pick<AppointmentRecord["terms"], "resourceId"> };
const minutes = (intervals: Interval[]) => intervals.reduce((total, { start, end }) => total + end - start, 0);
const intersect = (a: Interval, b: Interval) => ({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) });
const nonempty = ({ start, end }: Interval) => start < end;
function subtract(open: Interval[], blocked: Interval[]) {
  return blocked.reduce((remaining, block) => remaining.flatMap(interval => {
    if (!nonempty(intersect(interval, block))) return [interval];
    return [{ ...interval, end: block.start }, { ...interval, start: block.end }].filter(nonempty);
  }), open);
}
function union(intervals: Interval[]) {
  const merged: Interval[] = [];
  for (const interval of intervals.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

export function agendaAvailability(date: string, calendar: BusinessCalendar, closures: readonly BusinessClosure[], resources: Resource[], rows: Occupancy[]) {
  if (!calendar.weeklySchedule || closures.some(closure => closure.kind === "date" && closure.date === date)) {
    return { gaps: [], utilization: 0 };
  }
  const dayMinute = weekday(date) * 1440;
  const hours = (schedule: WeeklySchedule) => normalizeWeeklySchedule(schedule)
    .map(({ startMinute, endMinute }) => intersect({ start: startMinute - dayMinute, end: endMinute - dayMinute }, { start: 0, end: 1440 }))
    .filter(nonempty);
  const bounds = dayBounds(date), from = Date.parse(bounds.from), to = Date.parse(bounds.to);
  const wallMinute = (instant: number) => {
    if (instant <= from) return 0;
    if (instant >= to) return 1440;
    const [hour, minute] = turnoTime(instant).split(":").map(Number);
    return hour! * 60 + minute!;
  };
  const wallInterval = (start: number, end: number): Interval => ({ start: wallMinute(start), end: wallMinute(end) });
  const business = subtract(hours(calendar.weeklySchedule), closures.flatMap(closure => closure.kind === "interval"
    ? [wallInterval(Date.parse(closure.start), Date.parse(closure.end))].filter(nonempty) : []));
  let capacity = 0, available = 0;
  const gaps = resources.filter(resource => resource.status === "active").flatMap(resource => {
    const openings = hours(resource.weeklySchedule).flatMap(open => business.map(block => intersect(open, block)).filter(nonempty));
    const busy = rows.filter(row => row.state === "confirmed" && resource.id === row.terms.resourceId && row.startMs < to && row.endMs > from)
      .map(row => wallInterval(row.startMs, row.endMs)).filter(nonempty);
    const free = subtract(openings, busy);
    capacity += minutes(openings);
    available += minutes(free);
    return free;
  });
  return { gaps: union(gaps), utilization: capacity ? Math.round((capacity - available) / capacity * 100) : 0 };
}

export const agendaFormat = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("es-AR", { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
export const agendaMinute = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const agendaDuration = (total: number) => {
  const hours = Math.floor(total / 60), remaining = total % 60;
  return [hours ? `${hours} h` : "", remaining || !hours ? `${remaining} min` : ""].filter(Boolean).join(" ");
};
export const agendaFreeMinutes = minutes;
