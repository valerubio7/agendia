import type { BusinessCalendar } from "../api-client";

const weekdays = [
  [1, "Lunes"], [2, "Martes"], [3, "Miércoles"], [4, "Jueves"],
  [5, "Viernes"], [6, "Sábado"], [0, "Domingo"],
] as const;
const time = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function BusinessCalendarScreen({ weeklySchedule }: BusinessCalendar) {
  const allOff = weeklySchedule !== null && weekdays.every(([day]) => !weeklySchedule[day]?.length);
  return (
    <main className="services-screen" aria-labelledby="business-calendar-title">
      <header className="services-header">
        <h1 id="business-calendar-title">Horario del negocio</h1>
        <p>Consultá el horario semanal guardado para tu negocio.</p>
      </header>
      <section className="services-empty" aria-label="Horario semanal">
        {weeklySchedule === null ? <>
          <h2>Horario sin configurar</h2>
          <p>Todavía no hay un horario semanal guardado.</p>
        </> : <>
          <h2>{allOff ? "Todos los días sin atención" : "Horario semanal guardado"}</h2>
          {allOff && <p>El horario está guardado sin franjas de atención.</p>}
          <dl className="resources-week">
            {weekdays.map(([day, label]) => <div key={day}>
              <dt>{label}</dt>
              <dd>{weeklySchedule[day]?.length ? weeklySchedule[day]!.map((span, index) =>
                <p key={index}>{time(span.startMinute)} – {time(span.endMinute)}{span.endMinute < span.startMinute ? " (día siguiente)" : ""}</p>
              ) : "Sin atención"}</dd>
            </div>)}
          </dl>
        </>}
      </section>
    </main>
  );
}
