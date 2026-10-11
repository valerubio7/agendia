const argentinaInstant = new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
  hourCycle: "h23", timeZoneName: "longOffset",
});

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
