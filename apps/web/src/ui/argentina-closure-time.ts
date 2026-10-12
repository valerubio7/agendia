const argentinaInstant = new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
  hourCycle: "h23", timeZoneName: "longOffset",
});

export type ArgentinaClosureTimeCandidate = { instant: string; offsetSeconds: number };
export type ArgentinaClosureTimeResult =
  | { ok: true; candidates: ArgentinaClosureTimeCandidate[] }
  | { ok: false; error: "invalid_wall_time" | "nonexistent_wall_time"; candidates: [] };

const argentinaWall = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Argentina/Buenos_Aires", calendar: "gregory", numberingSystem: "latn",
  era: "short", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const dayMs = 86400000;

function utcCalendarMs(year: number, month: number, day: number): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.getTime() : undefined;
}

function argentinaOffsetMs(instant: number): number {
  const parts = argentinaWall.formatToParts(instant);
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find(value => value.type === name)!.value);
  const year = parts.find(value => value.type === "era")!.value === "BC" ? 1 - part("year") : part("year");
  const local = utcCalendarMs(year, part("month"), part("day"))!
    + ((part("hour") * 60 + part("minute")) * 60 + part("second")) * 1000;
  return local - Math.floor(instant / 1000) * 1000;
}

/** Strict datetime-local input; callers must explicitly choose when candidates has more than one entry. */
export function convertArgentinaClosureTime(value: string): ArgentinaClosureTimeResult {
  const invalid: ArgentinaClosureTimeResult = { ok: false, error: "invalid_wall_time", candidates: [] };
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match || Number(match[1]) < 1) return invalid;
  const midnight = utcCalendarMs(Number(match[1]), Number(match[2]), Number(match[3]));
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  if (midnight === undefined || hour > 23 || minute > 59 || second > 59) return invalid;
  const wall = midnight + ((hour * 60 + minute) * 60 + second) * 1000
    + Number((match[7] ?? "").padEnd(3, "0"));

  // Buenos Aires offsets fit this physical window and transitions are more than a day apart.
  // Sampling each day gathers both sides; inverse projection below rejects gaps and false candidates.
  const offsets = new Set<number>();
  for (let day = -2; day <= 3; day++) offsets.add(argentinaOffsetMs(midnight + day * dayMs));
  const candidates: ArgentinaClosureTimeCandidate[] = [];
  for (const offset of offsets) {
    const instantMs = wall - offset;
    if (argentinaOffsetMs(instantMs) !== offset) continue;
    let instant = new Date(instantMs).toISOString();
    if (!/^\d{4}-/.test(instant)) {
      // Local year 9999 can project to UTC 10000. Use the actual minute offset to stay API-representable.
      if (offset % 60000 !== 0 || Math.abs(offset) > (23 * 60 + 59) * 60000) return invalid;
      const minutes = Math.abs(offset) / 60000;
      const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      instant = `${new Date(wall).toISOString().slice(0, -1)}${zone}`;
    }
    // Second-based historical offsets remain exact in Z serialization, not rounded to minutes.
    candidates.push({ instant, offsetSeconds: offset / 1000 });
  }
  candidates.sort((a, b) => new Date(a.instant).getTime() - new Date(b.instant).getTime());
  return candidates.length ? { ok: true, candidates }
    : { ok: false, error: "nonexistent_wall_time", candidates: [] };
}

/** Project a stored instant for datetime-local without ambient timezone or precision loss. */
export function projectArgentinaClosureTime(raw: string): string {
  const instant = new Date(raw).getTime();
  const wall = new Date(instant + argentinaOffsetMs(instant));
  return wall.toISOString().slice(0, -1);
}

// Stored date closures already name an Argentina day, not a UTC instant.
export function formatArgentinaClosureDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

export function formatArgentinaClosureInstant(raw: string): string {
  const parts = argentinaInstant.formatToParts(new Date(raw));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
  return `${part("day")}/${part("month")}/${part("year")}, ${part("hour")}:${part("minute")}:${part("second")}.${part("fractionalSecond")} (Argentina, ${part("timeZoneName")})`;
}
