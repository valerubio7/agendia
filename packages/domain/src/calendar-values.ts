import { z } from "zod";

/** @internal Gregorian midnight reconstruction; astronomical year 0 is needed for IANA BCE projection. */
export function calendarMs(year: number, month: number, day: number): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.getTime();
}

/** Parse a four-digit positive Gregorian date to UTC midnight milliseconds, or undefined if invalid. */
export function parseCalendarDateMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match && Number(match[1]) >= 1 ? calendarMs(Number(match[1]), Number(match[2]), Number(match[3])) : undefined;
}

/**
 * Parse an explicit-offset ISO instant to exact epoch milliseconds, or undefined if invalid.
 * Validate calendar components before reconstruction; nonzero sub-millisecond digits cannot be lost.
 */
export function parseInstantMs(value: unknown): number | undefined {
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

/** Validated YYYY-MM-DD, preserving the raw string; external year 0000 is not accepted. */
export const CalendarDateSchema = z.string().refine((value) => parseCalendarDateMs(value) !== undefined, {
  message: "Expected a valid positive-year Gregorian date (YYYY-MM-DD)",
});

/** Validated explicit-offset instant, preserving the raw offset and exact-millisecond fraction. */
export const InstantSchema = z.string().refine((value) => parseInstantMs(value) !== undefined, {
  message: "Expected a valid explicit-offset ISO instant with exact millisecond precision",
});

/** Positive half-open [start, end) interval ordered by actual instants, not ISO text. Unknown keys are stripped. */
export const OrderedInstantIntervalSchema = z.object({
  start: InstantSchema,
  end: InstantSchema,
}).refine((interval) => {
  const start = parseInstantMs(interval.start);
  const end = parseInstantMs(interval.end);
  return start !== undefined && end !== undefined && end > start;
}, { message: "Interval end must be after start", path: ["end"] });

export type CalendarDate = z.infer<typeof CalendarDateSchema>;
export type Instant = z.infer<typeof InstantSchema>;
export type OrderedInstantInterval = z.infer<typeof OrderedInstantIntervalSchema>;
