import { z } from "zod";
import { calendarMs, parseCalendarDateMs as parseDate, parseInstantMs as parseInstant } from "../business-calendar/values.ts";
import { BusinessClosureInputSchema, type BusinessClosureInput } from "../business-calendar/calendar.ts";

const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;
const MINUTE_MS = 60_000;
const DAY_MS = DAY_MINUTES * MINUTE_MS;
const WEEK_MS = WEEK_MINUTES * MINUTE_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;

const SpanSchema = z.object({
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1440),
}).refine((span) => span.startMinute !== span.endMinute);

/** Sunday=0 through Saturday=6. Omitted/empty days are off. End < start is overnight; 1440 is midnight. */
export const WeeklyScheduleSchema = z.object({
  0: z.array(SpanSchema).optional(),
  1: z.array(SpanSchema).optional(),
  2: z.array(SpanSchema).optional(),
  3: z.array(SpanSchema).optional(),
  4: z.array(SpanSchema).optional(),
  5: z.array(SpanSchema).optional(),
  6: z.array(SpanSchema).optional(),
}).strict();

export type WeeklySchedule = z.infer<typeof WeeklyScheduleSchema>;
export interface WeeklyOpenInterval {
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Effective sorted half-open union in Sunday-based week minutes; wrap spans are split at the week boundary. */
export function normalizeWeeklySchedule(schedule: WeeklySchedule): WeeklyOpenInterval[] {
  const valid = WeeklyScheduleSchema.parse(schedule);
  const intervals: WeeklyOpenInterval[] = [];
  for (let day = 0; day < 7; day++) {
    for (const span of valid[day as keyof WeeklySchedule] ?? []) {
      const startMinute = day * DAY_MINUTES + span.startMinute;
      const endMinute = day * DAY_MINUTES + span.endMinute
        + (span.endMinute < span.startMinute ? DAY_MINUTES : 0);
      intervals.push({ startMinute, endMinute: Math.min(endMinute, WEEK_MINUTES) });
      if (endMinute > WEEK_MINUTES) intervals.push({ startMinute: 0, endMinute: endMinute - WEEK_MINUTES });
    }
  }
  intervals.sort((a, b) => a.startMinute - b.startMinute);
  const union: WeeklyOpenInterval[] = [];
  for (const interval of intervals) {
    const previous = union.at(-1);
    if (previous && interval.startMinute <= previous.endMinute) {
      union[union.length - 1] = { startMinute: previous.startMinute, endMinute: Math.max(previous.endMinute, interval.endMinute) };
    } else union.push(interval);
  }
  return union;
}

/** Pure recurring-hours containment, including off-days and week-wrap; never truncates resource hours. */
export function isResourceScheduleWithinBusiness(resource: WeeklySchedule, business: WeeklySchedule): boolean {
  if (!WeeklyScheduleSchema.safeParse(resource).success || !WeeklyScheduleSchema.safeParse(business).success) return false;
  const businessUnion = normalizeWeeklySchedule(business);
  return normalizeWeeklySchedule(resource).every((interval) => businessUnion.some((opening) =>
    opening.startMinute <= interval.startMinute && interval.endMinute <= opening.endMinute,
  ));
}

export interface InstantInterval {
  readonly start: string;
  readonly end: string;
}

export interface AvailabilityInput {
  readonly start: string;
  readonly durationMinutes: number;
  readonly businessHours: WeeklySchedule;
  readonly resourceHours: WeeklySchedule;
  readonly closedDates?: readonly string[];
  readonly closedIntervals?: readonly InstantInterval[];
  /** Caller filters to Confirmed bookings for the selected resource, with only authorized self-exclusions. */
  readonly busyIntervals?: readonly InstantInterval[];
}

const argentina = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Argentina/Buenos_Aires",
  calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
  era: "short", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function offsetAt(instant: number): number {
  const parts = argentina.formatToParts(instant);
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === name)!.value);
  // Intl uses era years; Date's setUTCFullYear uses astronomical years (1 BC = 0).
  const year = parts.find((entry) => entry.type === "era")!.value === "BC" ? 1 - part("year") : part("year");
  const local = calendarMs(year, part("month"), part("day"))!
    + ((part("hour") * 60 + part("minute")) * 60 + part("second")) * 1000;
  return local - Math.floor(instant / 1000) * 1000;
}

/** Visit linear wall-clock segments, splitting at IANA transitions (including skipped/repeated local time). */
function everyLocalSegment(start: number, end: number, accept: (localStart: number, localEnd: number, offset: number) => boolean): boolean {
  let cursor = start;
  while (cursor < end) {
    const offset = offsetAt(cursor);
    let next = Math.min(cursor + DAY_MS, end);
    if (offsetAt(next - 1) !== offset) {
      // Buenos Aires transitions are isolated by more than a day; locate the first changed millisecond.
      let low = cursor;
      let high = next - 1;
      while (high - low > 1) {
        const middle = low + Math.floor((high - low) / 2);
        if (offsetAt(middle) === offset) low = middle;
        else high = middle;
      }
      next = high;
    }
    if (!accept(cursor + offset, next + offset, offset)) return false;
    cursor = next;
  }
  return true;
}

export interface ArgentinaDayGridStart {
  readonly start: string;
  readonly startMs: number;
}

/**
 * Pure advisory candidate starts on a positive four-digit Gregorian Argentina date.
 * Invalid dates fail closed with a frozen empty grid. Missing wall quarters are skipped;
 * repeated quarters retain both actual instants. No hours, duration, lead or booking
 * policy is applied: callers must validate the entire proposed interval separately.
 */
export function materializeArgentinaDayGrid(date: string): readonly ArgentinaDayGridStart[] {
  const midnight = parseDate(date);
  if (midnight === undefined) return Object.freeze([]);
  const quarterMs = 15 * MINUTE_MS;
  const grid: ArgentinaDayGridStart[] = [];
  // Buenos Aires offsets fit comfortably within this bounded physical window,
  // including BCE projection beside year 0001 and UTC year 10000 beside local 9999.
  everyLocalSegment(midnight - 2 * DAY_MS, midnight + 3 * DAY_MS, (localStart, localEnd, offset) => {
    const first = Math.max(midnight, localStart);
    const end = Math.min(midnight + DAY_MS, localEnd);
    for (let wall = midnight + Math.ceil((first - midnight) / quarterMs) * quarterMs; wall < end; wall += quarterMs) {
      const startMs = wall - offset;
      let start = new Date(startMs).toISOString();
      if (!/^\d{4}-/.test(start)) {
        // The final local 9999 evening maps to UTC year 10000. Preserve the
        // positive-four-digit raw instant contract using the IANA-derived offset.
        // That boundary's offset is whole minutes; historical second offsets
        // instead retain their exact UTC seconds in the ordinary ISO path above.
        const minutes = Math.abs(offset) / MINUTE_MS;
        const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
        const remainder = String(minutes % 60).padStart(2, "0");
        start = `${new Date(wall).toISOString().slice(0, 19)}${offset < 0 ? "-" : "+"}${hours}:${remainder}`;
      }
      grid.push(Object.freeze({ start, startMs }));
    }
    return true;
  });
  grid.sort((a, b) => a.startMs - b.startMs);
  return Object.freeze(grid);
}

function fitsWeekly(start: number, end: number, union: WeeklyOpenInterval[]): boolean {
  if (union.length === 1 && union[0]!.startMinute === 0 && union[0]!.endMinute === WEEK_MINUTES) return true;
  // A non-full union reaches a gap within a recurring week, so even enormous durations stop early.
  return everyLocalSegment(start, end, (localStart, localEnd) => {
    const position = ((localStart + 4 * DAY_MS) % WEEK_MS + WEEK_MS) % WEEK_MS;
    const length = localEnd - localStart;
    const copies = [-1, 0, 1].flatMap((week) => union.map((opening) => ({
      start: opening.startMinute * MINUTE_MS + week * WEEK_MS,
      end: opening.endMinute * MINUTE_MS + week * WEEK_MS,
    })));
    copies.sort((a, b) => a.start - b.start);
    let coveredUntil = position;
    for (const opening of copies) {
      if (opening.start > coveredUntil) break;
      if (opening.end > coveredUntil) coveredUntil = opening.end;
      if (coveredUntil >= position + length) return true;
    }
    return false;
  });
}

function avoidsIntervals(start: number, end: number, intervals: readonly InstantInterval[]): boolean {
  for (const interval of intervals) {
    const blockedStart = parseInstant(interval.start);
    const blockedEnd = parseInstant(interval.end);
    if (blockedStart === undefined || blockedEnd === undefined || blockedEnd <= blockedStart) return false;
    if (start < blockedEnd && blockedStart < end) return false;
  }
  return true;
}

export interface EpochInterval { readonly startMs: number; readonly endMs: number }
function validEpochInterval(interval: EpochInterval): boolean {
  return interval !== null && typeof interval === "object"
    && Number.isSafeInteger(interval.startMs) && Number.isSafeInteger(interval.endMs)
    && interval.startMs >= -MAX_DATE_MS && interval.endMs <= MAX_DATE_MS && interval.endMs > interval.startMs;
}
/** Exact whole-interval Argentina IANA containment, without booking grid/lead/eligibility policy. */
export function isEpochIntervalWithinWeeklySchedule(interval: EpochInterval, schedule: WeeklySchedule): boolean {
  return validEpochInterval(interval) && WeeklyScheduleSchema.safeParse(schedule).success
    && fitsWeekly(interval.startMs, interval.endMs, normalizeWeeklySchedule(schedule));
}
function avoidsDates(start: number, end: number, dates: readonly string[]): boolean {
  for (const closedDate of dates) {
    const midnight = parseDate(closedDate);
    if (midnight === undefined) return false;
    // Only inspect the physical window around this date, not every day of a potentially huge appointment.
    const windowStart = Math.max(start, midnight - 2 * DAY_MS);
    const windowEnd = Math.min(end, midnight + 3 * DAY_MS);
    if (!everyLocalSegment(windowStart, windowEnd, (a, b) => !(a < midnight + DAY_MS && midnight < b))) return false;
  }
  return true;
}
/** Closure-only physical overlap; never consults weekly hours, grid, lead time or catalog state. */
export function isEpochIntervalOpenForClosures(interval: EpochInterval, closures: readonly BusinessClosureInput[]): boolean {
  if (!validEpochInterval(interval) || !Array.isArray(closures)) return false;
  return closures.every(closure => {
    const parsed = BusinessClosureInputSchema.safeParse(closure);
    if (!parsed.success) return false;
    return parsed.data.kind === "date" ? avoidsDates(interval.startMs, interval.endMs, [parsed.data.date])
      : avoidsIntervals(interval.startMs, interval.endMs, [parsed.data]);
  });
}

/** Half-open availability in Argentina local time. No clock/lead-time, eligibility, ownership or state policy is inferred. */
export function isStructurallyAvailable(input: AvailabilityInput): boolean {
  const start = parseInstant(input.start);
  const duration = input.durationMinutes;
  if (start === undefined || !Number.isSafeInteger(duration) || duration <= 0 || duration % 15 !== 0) return false;
  const end = start + duration * MINUTE_MS;
  if (!Number.isSafeInteger(end) || end > MAX_DATE_MS || end <= start) return false;
  const localStart = start + offsetAt(start);
  if (localStart % (15 * MINUTE_MS) !== 0) return false;
  if (!isEpochIntervalWithinWeeklySchedule({ startMs: start, endMs: end }, input.businessHours)
    || !isEpochIntervalWithinWeeklySchedule({ startMs: start, endMs: end }, input.resourceHours)) return false;
  if (!avoidsIntervals(start, end, input.busyIntervals ?? []) || !avoidsIntervals(start, end, input.closedIntervals ?? [])) return false;
  return avoidsDates(start, end, input.closedDates ?? []);
}

/** New bookings/new-start reschedules require >= one hour from injected now; unchanged-start edits use structural checking alone. */
export function isNewStartAllowed(input: AvailabilityInput, now: string): boolean {
  const clock = parseInstant(now);
  const start = parseInstant(input.start);
  return clock !== undefined && start !== undefined && start - clock >= 60 * MINUTE_MS
    && isStructurallyAvailable(input);
}
