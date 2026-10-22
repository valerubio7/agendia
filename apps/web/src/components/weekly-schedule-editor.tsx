import type { WeeklySchedule } from "../api/api-client";

export const scheduleDays = [
  [1, "Lunes"], [2, "Martes"], [3, "Miércoles"], [4, "Jueves"],
  [5, "Viernes"], [6, "Sábado"], [0, "Domingo"],
] as const;
export type ScheduleDay = (typeof scheduleDays)[number][0];
export type ScheduleDraftSpan = { id: number; start: string; end: string };
export type WeeklyScheduleDraft = Partial<Record<ScheduleDay, ScheduleDraftSpan[]>>;
export const formatScheduleClock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export const parseScheduleClock = (value: string, end: boolean) => {
  if (end && value === "24:00") return 1440;
  if (value.length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return -1;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
};

export function serializeScheduleDraft(draft: WeeklyScheduleDraft): WeeklySchedule | { invalidDay: ScheduleDay } {
  const weeklySchedule: WeeklySchedule = {};
  for (const [day] of scheduleDays) {
    const spans = [];
    for (const span of draft[day] ?? []) {
      const startMinute = parseScheduleClock(span.start, false), endMinute = parseScheduleClock(span.end, true);
      if (startMinute < 0 || endMinute < 0 || startMinute === endMinute) return { invalidDay: day };
      spans.push({ startMinute, endMinute });
    }
    if (spans.length) weeklySchedule[day] = spans;
  }
  return weeklySchedule;
}

export function ControlledWeeklyScheduleEditor({ value, onChange, disabled, helpText =
  "Sin franjas no podrá recibir reservas. Usá HH:mm; 24:00 solo para el fin. Si el fin es anterior al inicio, continúa al día siguiente. El estado se conserva.",
}: {
  value: WeeklyScheduleDraft;
  // The owner allocates stable IDs for newly added rows (id -1).
  onChange: (value: WeeklyScheduleDraft) => void;
  disabled: boolean;
  helpText?: string;
}) {
  const changeSpan = (day: ScheduleDay, id: number, field: "start" | "end", text: string) => {
    onChange({ ...value, [day]: (value[day] ?? []).map(span =>
      span.id === id ? { ...span, [field]: text } : span) });
  };
  return (
    <fieldset className="resources-hours" disabled={disabled}>
      <legend>Horario semanal</legend>
      <p>{helpText}</p>
      {scheduleDays.map(([day, label]) => <fieldset key={day} className="resources-hours-day">
        <legend>{label}</legend>
        {(value[day] ?? []).length === 0 && <p>Sin franjas</p>}
        {(value[day] ?? []).map((span, index) => <div key={span.id} className="resources-hours-row">
          <label>Inicio {label} {index + 1}
            <input type="text" inputMode="text" placeholder="HH:mm" value={span.start}
              onChange={event => changeSpan(day, span.id, "start", event.target.value)} />
          </label>
          <label>Fin {label} {index + 1}
            <input type="text" inputMode="text" placeholder="HH:mm" value={span.end}
              onChange={event => changeSpan(day, span.id, "end", event.target.value)} />
          </label>
          <button type="button" aria-label={`Quitar franja ${label} ${index + 1}`}
            onClick={() => onChange({ ...value,
              [day]: (value[day] ?? []).filter(row => row.id !== span.id) })}>Quitar franja</button>
        </div>)}
        <button type="button" aria-label={`Agregar franja ${label}`}
          onClick={() => onChange({ ...value,
            [day]: [...(value[day] ?? []), { id: -1, start: "", end: "" }] })}>Agregar franja</button>
      </fieldset>)}
    </fieldset>
  );
}
