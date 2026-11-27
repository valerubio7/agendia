import Link from "next/link";
import type { AppointmentRecord } from "../../api/api-client";
import { AgendaIcon } from "./agenda-view";
import { calendarRows, dateLabel, turnoTime } from "./turnos-calendar";

const weekday = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", weekday: "long" });
const month = new Intl.DateTimeFormat("es-AR", { timeZone: "UTC", month: "short" });
const states = { confirmed: "Confirmado", done: "Finalizado", no_show: "Ausente", cancelled: "Cancelado" } as const;

export function BusinessHome({ today, now, rows, pending, stale, error, locked, select, refresh }: {
  today: string;
  now: number;
  rows: AppointmentRecord[];
  pending: boolean;
  stale: boolean;
  error: string;
  locked: boolean;
  select: (id: string) => void;
  refresh: () => void;
}) {
  const day = new Date(`${today}T12:00:00Z`);
  const appointments = calendarRows(rows, today);
  const confirmed = appointments.filter(row => row.state === "confirmed");
  const next = confirmed.find(row => row.startMs >= now);
  const available = !pending && !stale && !error;
  const appointmentText = (row: AppointmentRecord, includeResource = false) => <span className="business-home__person">
    <strong>{row.client.name}</strong>
    <small>{row.terms.serviceName}{includeResource && ` · ${row.terms.resourceName}`}</small>
  </span>;
  const appointmentTime = (row: AppointmentRecord) => <time dateTime={row.startsAt}>{turnoTime(row.startMs)}</time>;

  return <div className="business-home">
    <aside className="business-home__summary" aria-label="Resumen del día">
      <time className="business-home__date" dateTime={today} aria-label={dateLabel(today)}>
        <strong>{today.slice(-2)}</strong>
        <span className="business-home__date-words"><span>{weekday.format(day)}</span><span>{month.format(day).replace(/\.$/, "")} {day.getUTCFullYear()}</span></span>
      </time>
      {(available || appointments.length > 0) && <div className="business-home__counts">
        <p><strong>{appointments.length}</strong> {appointments.length === 1 ? "turno hoy" : "turnos hoy"}</p>
        <p><strong>{confirmed.length}</strong> confirmados</p>
        <p><strong>{appointments.filter(row => row.state === "done").length}</strong> finalizados</p>
      </div>}
      <Link className="business-home__agenda" href="/turnos">
        <span><AgendaIcon name="calendar" />Ver agenda completa</span><span><AgendaIcon name="arrow" /></span>
      </Link>
    </aside>
    <div className="business-home__sheet">
      <section className="business-home__upcoming" aria-labelledby="business-home-next" aria-busy={pending || undefined}>
        <h2 id="business-home-next">Próximo turno</h2>
        {next ? <button type="button" className="business-home__next" disabled={locked} onClick={() => select(next.id)} aria-haspopup="dialog" aria-controls="turnos-dialog">
          <span className="business-home__confirmed">Confirmado</span>
          <span className="business-home__next-body">{appointmentTime(next)}{appointmentText(next, true)}</span>
          <AgendaIcon name="arrow" />
        </button> : !pending && (available || error) && <div className="business-home__next business-home__next--empty"><div className="business-home__next-body">
          <span className="business-home__dash" aria-hidden="true">—</span>
          <span className="business-home__person"><strong>{available ? "Sin turnos próximos" : "Próximo turno no disponible"}</strong>
            {available && <small>No hay reservas confirmadas pendientes.</small>}</span>
        </div></div>}
      </section>
      <section className="business-home__today" aria-label="Turnos de hoy" aria-busy={pending || undefined}>
        <header><h2>Hoy</h2><button type="button" disabled={locked || pending} onClick={refresh}>Actualizar turnos</button></header>
        {!pending && stale && !error && appointments.length > 0 && <p role="status">La lista de hoy todavía no está actualizada.</p>}
        {error && <p role="alert">{error}</p>}
        {appointments.length > 0 ? <ul aria-label={`Turnos ${today}`}>
          {appointments.map(row => <li key={row.id}>
            <button type="button" className="business-home__row" disabled={locked} onClick={() => select(row.id)} aria-haspopup="dialog" aria-controls="turnos-dialog">
              {appointmentTime(row)}<span className="business-home__dot" data-state={row.state} data-origin={row.origin} aria-hidden="true" />
              {appointmentText(row)}<span className="business-home__resource">{row.terms.resourceName}</span>
              <span className="business-home__state" data-state={row.state}>{states[row.state]}</span><AgendaIcon name="arrow" />
            </button>
          </li>)}
        </ul> : available && <p><strong>No hay turnos para hoy.</strong> Podés crear uno con «Nuevo turno».</p>}
      </section>
    </div>
  </div>;
}
