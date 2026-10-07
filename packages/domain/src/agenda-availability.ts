import { z } from "zod";

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

function calendarMs(year: number, month: number, day: number): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.getTime();
}

function parseDate(value: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match && Number(match[1]) >= 1 ? calendarMs(Number(match[1]), Number(match[2]), Number(match[3])) : undefined;
}

// Explicit ISO offsets only. Validate before Date parsing so invalid days and sub-ms precision cannot normalize away.
function parseInstant(value: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number(match[1]) < 1) return undefined;
  const date = calendarMs(Number(match[1]), Number(match[2]), Number(match[3]));
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  if (date === undefined || hour > 23 || minute > 59 || second > 59 || /[1-9]/.test(fraction.slice(3))) return undefined;
  const zone = match[8]!;
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return undefined;
    offset = (hours * 60 + minutes) * (zone[0] === "+" ? 1 : -1);
  }
  return date + ((hour * 60 + minute - offset) * 60 + second) * 1000
    + Number(fraction.slice(0, 3).padEnd(3, "0"));
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
function everyLocalSegment(start: number, end: number, accept: (localStart: number, localEnd: number) => boolean): boolean {
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
    if (!accept(cursor + offset, next + offset)) return false;
    cursor = next;
  }
  return true;
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

/** Half-open availability in Argentina local time. No clock/lead-time, eligibility, ownership or state policy is inferred. */
export function isStructurallyAvailable(input: AvailabilityInput): boolean {
  const start = parseInstant(input.start);
  const duration = input.durationMinutes;
  if (start === undefined || !Number.isSafeInteger(duration) || duration <= 0 || duration % 15 !== 0) return false;
  const end = start + duration * MINUTE_MS;
  if (!Number.isSafeInteger(end) || end > MAX_DATE_MS || end <= start) return false;
  const localStart = start + offsetAt(start);
  if (localStart % (15 * MINUTE_MS) !== 0) return false;
  if (!WeeklyScheduleSchema.safeParse(input.businessHours).success || !WeeklyScheduleSchema.safeParse(input.resourceHours).success) return false;
  if (!fitsWeekly(start, end, normalizeWeeklySchedule(input.businessHours))
    || !fitsWeekly(start, end, normalizeWeeklySchedule(input.resourceHours))) return false;
  if (!avoidsIntervals(start, end, input.busyIntervals ?? []) || !avoidsIntervals(start, end, input.closedIntervals ?? [])) return false;
  for (const closedDate of input.closedDates ?? []) {
    const midnight = parseDate(closedDate);
    if (midnight === undefined) return false;
    // Only inspect the physical window around this date, not every day of a potentially huge appointment.
    const windowStart = Math.max(start, midnight - 2 * DAY_MS);
    const windowEnd = Math.min(end, midnight + 3 * DAY_MS);
    if (!everyLocalSegment(windowStart, windowEnd, (a, b) => !(a < midnight + DAY_MS && midnight < b))) return false;
  }
  return true;
}

/** New bookings/new-start reschedules require >= one hour from injected now; unchanged-start edits use structural checking alone. */
export function isNewStartAllowed(input: AvailabilityInput, now: string): boolean {
  const clock = parseInstant(now);
  const start = parseInstant(input.start);
  return clock !== undefined && start !== undefined && start - clock >= 60 * MINUTE_MS
    && isStructurallyAvailable(input);
}
