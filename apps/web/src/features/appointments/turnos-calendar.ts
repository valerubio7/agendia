const zone = "America/Argentina/Buenos_Aires";
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
});
export const turnoStates = {
  confirmed: "Confirmado", cancelled: "Cancelado", done: "Completado", no_show: "Ausente",
} as const;
export const turnoMoney = (value: number) => new Intl.NumberFormat("es-AR", {
  style: "currency", currency: "ARS",
}).format(value);
export const turnoTime = (value: number) => new Intl.DateTimeFormat("es-AR", {
  timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(value);
export const dateLabel = (date: string) => new Intl.DateTimeFormat("es-AR", {
  timeZone: "UTC", weekday: "short", day: "numeric", month: "long", year: "numeric",
}).format(new Date(`${date}T12:00:00Z`));

export function argentinaDate(ms = Date.now()): string {
  const parts = dateFormatter.formatToParts(ms);
  const get = (name: string) => parts.find(part => part.type === name)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDays(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
export function shiftMonth(date: string, count: number): string {
  const value = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + count);
  return value.toISOString().slice(0, 10);
}
export function monthDays(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`, next = shiftMonth(first, 1);
  const days = [];
  for (let day = first; day < next; day = addDays(day, 1)) days.push(day);
  return days;
}

// Find the first instant of a local date, including midnight gaps and folds.
// A fixed -03 offset is wrong for Argentina's historical DST transitions.
function dayStart(date: string): number {
  const midpoint = Date.parse(`${date}T12:00:00Z`);
  let low = midpoint - 48 * 3600000, high = midpoint + 48 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (argentinaDate(middle) < date) low = middle + 1;
    else high = middle;
  }
  return low;
}
export function dayBounds(date: string): { from: string; to: string } {
  return { from: new Date(dayStart(date)).toISOString(), to: new Date(dayStart(addDays(date, 1))).toISOString() };
}
export function calendarRows<T extends { id: string; startMs: number }>(rows: T[], date: string): T[] {
  return rows.filter(row => argentinaDate(row.startMs) === date)
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}
