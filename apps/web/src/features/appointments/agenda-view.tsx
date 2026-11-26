import type { AppointmentRecord } from "../../api/api-client";
import { agendaAvailability, agendaDates, agendaDuration, agendaFormat, agendaFreeMinutes, agendaMinute, stepAgendaDate, type AgendaSchedule, type AgendaView } from "./agenda-calendar";
import { calendarRows, turnoStates, turnoTime } from "./turnos-calendar";
import "./agenda.css";

const cap = (text: string) => text[0]?.toUpperCase() + text.slice(1);
const weekday = (date: string) => agendaFormat(date, { weekday: "long" });
const month = (date: string) => agendaFormat(date, { month: "long", year: "numeric" });
const shortDate = (date: string) => agendaFormat(date, { day: "numeric", month: "short" });
const longDate = (date: string) => agendaFormat(date, { weekday: "long", day: "numeric", month: "long" });
const countLabel = (count: number) => `${count} ${count === 1 ? "turno" : "turnos"}`;

const icons = {
  prev: "m15 18-6-6 6-6", next: "m9 18 6-6-6-6", arrow: "M5 12h14m-6-6 6 6-6 6", plus: "M12 5v14M5 12h14",
  calendar: "M19 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2ZM16 3v4M8 3v4M3 10h18M8 14h3M8 18h6",
  info: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 16v-4m0-4h.01",
};
export function AgendaIcon({ name }: { name: keyof typeof icons }) {
  return <svg className="ag-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

function EditorialHead({ title, subtitle, count, singular = false }: { title: string; subtitle: string; count: number | null; singular?: boolean }) {
  return <header className="ag-editorial-head"><div><h2>{title}</h2><p>{subtitle}</p></div>
    <div className="ag-head-fact"><strong className="ag-num">{count ?? "—"}</strong>{singular && count === 1 ? "turno" : "turnos"}</div></header>;
}

function AppointmentButton({ row, layout, locked, select }: { row: AppointmentRecord; layout: AgendaView; locked: boolean; select: (id: string) => void }) {
  const person = row.client.name;
  const status = row.state === "done" ? "Finalizado" : row.state === "no_show" ? "No asistió" : turnoStates[row.state];
  const time = <time dateTime={row.startsAt} className={layout === "day" ? "ag-flat-time ag-num" : "ag-num"}>{turnoTime(row.startMs)}</time>;
  const client = <><strong>{person}</strong><small>{row.terms.serviceName}{(layout === "day" || row.state === "cancelled") && ` · ${status}`}</small></>;
  const className = layout === "day" ? "ag-flat-row" : layout === "week" ? "ag-week-appt" : "ag-month-item-new";
  return <button type="button" className={className} disabled={locked} onClick={() => select(row.id)} aria-haspopup="dialog" aria-controls="turnos-dialog"
    aria-label={layout === "day" ? `Abrir turno de ${person}, ${turnoTime(row.startMs)}${row.state === "cancelled" ? ", Cancelado" : ""}` : undefined}>
    {time}{layout === "day" ? <><span className={`ag-flat-dot ${row.state === "no_show" ? "miss" : row.state}`} aria-hidden="true" /><span className="ag-flat-client">{client}</span>
      <span className="ag-flat-resource">{row.terms.resourceName}</span><AgendaIcon name="arrow" /></>
      : layout === "week" ? client : <span>{client}</span>}
  </button>;
}

type Props = {
  date: string; today: string; view: AgendaView; rows: AppointmentRecord[]; schedule: AgendaSchedule | null;
  locked: boolean; pending: boolean; listReady: boolean; availabilityReady: boolean; select: (id: string) => void;
  setDate: (date: string) => void; setView: (view: AgendaView) => void;
  resource: string; setResource: (id: string) => void;
};
export function AgendaViewContent({ date, today, view, rows, schedule, locked, pending, listReady, availabilityReady, select, setDate, setView, resource, setResource }: Props) {
  const days = agendaDates(date, view);
  const resources = schedule?.resources.filter(item => item.status === "active") ?? [];
  const filtered = rows.filter(row => !resource || row.terms.resourceId === resource);
  const active = filtered.filter(row => row.state !== "cancelled");
  // Bookings are listed by start date, but occupancy uses all overlapping records.
  const visible = (day: string) => calendarRows(active, day);
  const booked = visible(date);
  const unavailable = !schedule || !listReady || !availabilityReady;
  const availability = (day: string) => unavailable ? null : agendaAvailability(day, schedule.calendar, schedule.closures,
    resource ? resources.filter(item => item.id === resource) : resources, filtered);
  const gaps = view === "week" ? [] : availability(date)?.gaps ?? [];
  const weekLabel = `${shortDate(days[0]!)} — ${shortDate(days[6]!)}`;
  const toolbarDate = view === "day" ? longDate(date) : view === "week"
    ? `${shortDate(days[0]!)} — ${agendaFormat(days[6]!, { day: "numeric", month: "short", year: "numeric" })}` : month(date);
  const closed = schedule?.closures.some(closure => closure.kind === "date" && closure.date === date);
  const renderAppointment = (row: AppointmentRecord, layout = view) => <AppointmentButton key={row.id} {...{ row, layout, locked, select }} />;
  const cancelled = (view === "week" ? days : [date]).flatMap(day => calendarRows(filtered.filter(row => row.state === "cancelled"), day));
  return <div className="agenda-studio" aria-busy={pending || undefined}>
    <div className="ag-masthead"><div className="ag-view-switch" role="group" aria-label="Vista de agenda">
      {([["day", "Día"], ["week", "Semana"], ["month", "Mes"]] as const).map(([mode, label]) =>
        <button type="button" key={mode} className={view === mode ? "active" : undefined} aria-pressed={view === mode} disabled={locked} onClick={() => setView(mode)}>{label}</button>)}
    </div></div>
    <div className="ag-toolbar">
      <div className="ag-toolbar-date" role="group" aria-label="Navegar calendario">
        <button type="button" className="ag-today" disabled={locked} onClick={() => setDate(today)}>{view === "day" ? "Hoy" : view === "week" ? "Esta semana" : "Este mes"}</button>
        <button type="button" className="ag-nav-prev" aria-label="Anterior" disabled={locked} onClick={() => setDate(stepAgendaDate(date, view, -1))}><AgendaIcon name="prev" /></button>
        <span className="ag-selected-date">{cap(toolbarDate)}</span>
        <label className="ag-datepick"><AgendaIcon name="calendar" /><span>Elegir fecha</span><input type="date" min="0002-01-01" max="9998-12-31"
          aria-label="Elegir fecha de la agenda" value={date} disabled={locked} onClick={event => event.currentTarget.showPicker?.()}
          onChange={event => { if (event.currentTarget.value && event.currentTarget.validity.valid) setDate(event.currentTarget.value); }} /></label>
        <button type="button" className="ag-nav-next" aria-label="Siguiente" disabled={locked} onClick={() => setDate(stepAgendaDate(date, view, 1))}><AgendaIcon name="next" /></button>
      </div>
      <div className="ag-prof-buttons" role="group" aria-label="Filtrar por recurso">
        {[{ id: "", name: "Todos" }, ...resources].map(item => <button type="button" key={item.id} disabled={locked} aria-pressed={resource === item.id}
          className={`ag-prof-button${resource === item.id ? " active" : ""}`} onClick={() => setResource(item.id)}>{item.name}</button>)}
      </div>
    </div>
    {view === "day" && <>
      <div className="ag-week-strip" role="group" aria-label="Días de la semana">{days.map(day =>
        <button type="button" className={`ag-strip-day${date === day ? " active" : ""}`} key={day} aria-current={date === day ? "date" : "false"}
          disabled={locked} onClick={() => setDate(day)}><span>{agendaFormat(day, { weekday: "short" }).replace(".", "")}</span>
          <strong className="ag-num">{Number(day.slice(8))}</strong><small>{listReady ? countLabel(visible(day).length) : "—"}</small></button>)}
      </div>
      <section className="ag-main-surface" aria-label="Turnos del día">
        <EditorialHead title={weekday(date)} subtitle={agendaFormat(date, { day: "numeric", month: "long" })} count={listReady ? booked.length : null} singular />
        {closed && <div className="ag-closure"><AgendaIcon name="info" />Cierre del negocio</div>}
        <div className="ag-day-layout"><div className="ag-day-appointments">{booked.length ? booked.map(row => renderAppointment(row))
          : listReady && <p className="ag-flat-empty">No hay turnos para este día.</p>}</div>
          <aside className="ag-day-available"><div className="ag-avail-display"><span>Tiempo disponible</span><strong>{unavailable ? "—" : agendaDuration(agendaFreeMinutes(gaps))}</strong>
            {!unavailable && <small>{gaps.length} {gaps.length === 1 ? "intervalo libre" : "intervalos libres"}</small>}</div>
            <div className="ag-avail-body"><h3>Horarios libres</h3>{!unavailable && (gaps.length ? gaps.map(({ start, end }) =>
              <div className="ag-avail-line" key={start}><time className="ag-num">{agendaMinute(start)} — {agendaMinute(end)}</time><span>{agendaDuration(end - start)}</span></div>)
              : <p className="ag-avail-empty">No hay intervalos libres para mostrar.</p>)}</div></aside>
        </div>
      </section>
    </>}
    {view === "week" && <section className="ag-main-surface" aria-label="Vista semanal">
      <EditorialHead title="Semana" subtitle={weekLabel} count={listReady ? days.reduce((sum, day) => sum + visible(day).length, 0) : null} />
      <div className="ag-week-scroll" tabIndex={0} aria-label="Días de la semana"><div className="ag-week-seven">{days.map(day => {
        const records = visible(day), opening = availability(day);
        return <div className={`ag-week-col${day === date ? " selected" : ""}`} key={day}>
          <button type="button" className="ag-week-col-head" aria-label={`Abrir ${agendaFormat(day, { weekday: "long", day: "numeric" })}`} disabled={locked}
            onClick={() => { setDate(day); setView("day"); }}><span>{weekday(day)}</span><strong className="ag-num">{Number(day.slice(8))}</strong><small>{listReady ? countLabel(records.length) : "—"}</small></button>
          {opening && <div className="ag-util-track" role="meter" aria-label="Ocupación aproximada" aria-valuemin={0} aria-valuemax={100} aria-valuenow={opening.utilization}><i style={{ width: `${opening.utilization}%` }} /></div>}
          <div className="ag-week-col-appointments" role="group" aria-label={`Turnos ${day}`}>
            {records.length ? records.map(row => renderAppointment(row)) : listReady && <div className="ag-week-nothing">Sin reservas</div>}
          </div>
          <div className="ag-week-bottom">{opening ? `${agendaDuration(agendaFreeMinutes(opening.gaps))} libres` : "Sin datos de disponibilidad"}</div>
        </div>;
      })}</div></div>
    </section>}
    {view === "month" && <section className="ag-main-surface" aria-label="Vista mensual">
      <EditorialHead title={cap(month(date))} subtitle="Calendario mensual" count={listReady ? days.filter(day => day.slice(0, 7) === date.slice(0, 7)).reduce((sum, day) => sum + visible(day).length, 0) : null} />
      <div className="ag-month-layout"><div className="ag-month-calendar" role="group" aria-label="Días del mes">
        {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map(label => <div className="ag-month-weekday-new" key={label}>{label}</div>)}
        {days.map(day => {
          const count = listReady ? visible(day).length : 0;
          const classes = ["ag-month-day-new", day.slice(0, 7) !== date.slice(0, 7) && "muted", day === date && "selected", count > 0 && "has-bookings", count >= 4 && "busy"].filter(Boolean).join(" ");
          return <button type="button" className={classes} key={day} aria-label={listReady ? `${longDate(day)}: ${countLabel(count)}` : longDate(day)} aria-pressed={day === date}
            disabled={locked} onClick={() => setDate(day)}><strong className="ag-num">{Number(day.slice(8))}</strong>{count > 0 ? <>
              <span className="ag-month-bookings"><small>{countLabel(count)}</small><b className="ag-num">{count}</b></span>
              <span className="ag-month-mark"><span style={{ width: `${Math.max(26, Math.min(100, count * 22))}%` }} /></span></>
              : listReady && <span className="ag-month-no-events" />}</button>;
        })}
      </div><aside className="ag-month-detail-new"><div className="ag-month-detail-date"><span>{weekday(date)}</span><strong className="ag-num">{Number(date.slice(8))}</strong><small>{month(date)}</small></div>
        <h3 className="ag-month-detail-head">{listReady ? countLabel(booked.length) : "Turnos"}</h3>{booked.length ? booked.map(row => renderAppointment(row)) : listReady && <p className="ag-avail-empty">No hay turnos registrados.</p>}
        <div className="ag-month-avail-new"><h3>Horarios libres</h3>{!unavailable && (gaps.length ? gaps.slice(0, 5).map(({ start, end }) =>
          <div className="ag-month-compact-gap" key={start}><span>{agendaMinute(start)} — {agendaMinute(end)}</span><span>{agendaDuration(end - start)}</span></div>)
          : <p>No hay intervalos libres visibles.</p>)}</div>
      </aside></div>
    </section>}
    {!!cancelled.length && <details className="ag-cancelled"><summary>Turnos cancelados{listReady && ` (${cancelled.length})`}</summary>
      {cancelled.map(row => renderAppointment(row, "day"))}</details>}
  </div>;
}
