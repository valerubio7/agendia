import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BusinessCalendar, BusinessClosureRequest, WeeklySchedule } from "../../api/api-client";
import { BusinessClosuresSection, type ClosureReadState } from "./business-closures-section";
import { formatScheduleClock, scheduleDays, serializeScheduleDraft, type ScheduleDay,
  type WeeklyScheduleDraft } from "../../components/weekly-schedule-editor";
import { CalendarDialog, CalendarIcon } from "./calendar-dialog";
import "./business-calendar.css";

export function BusinessCalendarScreen({ weeklySchedule, pending, error, notice, warning,
  saveAction, retryAction, clearFeedback, closures, retryClosures, createClosure, updateClosure, deleteClosure,
}: BusinessCalendar & {
  closures: ClosureReadState; retryClosures: () => Promise<void>;
  createClosure: (input: BusinessClosureRequest, signal: AbortSignal) => Promise<boolean>;
  updateClosure: (id: string, input: BusinessClosureRequest, signal: AbortSignal) => Promise<boolean>;
  deleteClosure: (id: string, signal: AbortSignal) => Promise<boolean>;
  pending: boolean; error: string; notice: string; warning: boolean;
  saveAction: (schedule: WeeklySchedule) => Promise<boolean>;
  retryAction: () => Promise<boolean>;
  clearFeedback: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WeeklyScheduleDraft>({});
  const [edited, setEdited] = useState(false);
  const [validationError, setValidationError] = useState("");
  const nextId = useRef(0);
  const requestPending = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);
  const activeTab = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [day, setDay] = useState<ScheduleDay>(1);
  const saveButton = useRef<HTMLButtonElement>(null);
  const focusGeneration = useRef(0);
  const [failedSaveFocus, setFailedSaveFocus] = useState<{ generation: number; form: HTMLFormElement } | null>(null);
  const invalidateSaveFocus = () => {
    focusGeneration.current++;
    setFailedSaveFocus(null);
  };
  const restoreFocus = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      focusGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (editing) activeTab.current?.focus({ preventScroll: true });
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      opener.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (!failedSaveFocus || pending) return;
    setFailedSaveFocus(null);
    const target = saveButton.current;
    if (alive.current && editing && error && !requestPending.current &&
      failedSaveFocus.generation === focusGeneration.current && failedSaveFocus.form === form.current &&
      target?.isConnected && !target.disabled && failedSaveFocus.form.contains(target)) target.focus();
  }, [failedSaveFocus, pending, editing, error]);
  const begin = (trigger: HTMLButtonElement, initialDay: ScheduleDay = 1) => {
    if (pending || requestPending.current) return;
    opener.current = trigger;
    setDay(initialDay);
    invalidateSaveFocus();
    const hydrated: WeeklyScheduleDraft = {};
    for (const [day] of scheduleDays) hydrated[day] = (weeklySchedule?.[day] ?? []).map(span => ({
      id: nextId.current++, start: formatScheduleClock(span.startMinute), end: formatScheduleClock(span.endMinute),
    }));
    setDraft(hydrated);
    setEdited(false);
    setValidationError("");
    clearFeedback();
    setEditing(true);
  };
  const close = () => {
    if (requestPending.current) return;
    clearFeedback();
    finish();
  };
  const finish = () => {
    invalidateSaveFocus();
    restoreFocus.current = true;
    setEditing(false);
    setDraft({});
    setValidationError("");
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || requestPending.current) return;
    invalidateSaveFocus();
    const submittedForm = event.currentTarget;
    const generation = focusGeneration.current;
    const serialized = serializeScheduleDraft(draft);
    if ("invalidDay" in serialized) {
      setDay(serialized.invalidDay);
      setValidationError(`Usá horas HH:mm distintas para ${scheduleDays.find(([day]) => day === serialized.invalidDay)![1]}.`);
      return;
    }
    requestPending.current = true;
    setValidationError("");
    try {
      if (await saveAction(edited ? serialized : weeklySchedule ?? {})) {
        if (alive.current) finish();
      } else if (alive.current && requestPending.current && generation === focusGeneration.current &&
        submittedForm === form.current && submittedForm.isConnected) {
        // Failure keeps the form open; focus only after React enables the submitted Save.
        setFailedSaveFocus({ generation, form: submittedForm });
      }
    } finally { requestPending.current = false; }
  };
  const retry = async () => {
    if (pending || requestPending.current) return;
    invalidateSaveFocus();
    requestPending.current = true;
    try { await retryAction(); } finally { requestPending.current = false; }
  };
  const allOff = weeklySchedule !== null && scheduleDays.every(([id]) => !weeklySchedule[id]?.length);
  const label = scheduleDays.find(([id]) => id === day)![1];
  const spans = draft[day] ?? [];
  const updateSpans = (rows: typeof spans) => {
    if (pending || requestPending.current) return;
    setDraft({ ...draft, [day]: rows });
    setEdited(true);
    setValidationError("");
  };
  const changeSpan = (id: number, field: "start" | "end", value: string) =>
    updateSpans(spans.map(span => span.id === id ? { ...span, [field]: value } : span));
  return <main className="hours-studio" aria-labelledby="business-calendar-title">
    <div className="calendar-weekly">
      <header className="hours-heading">
        <h1 id="business-calendar-title">Horarios</h1>
        <button className="hours-primary" type="button" disabled={pending || editing} onClick={event => begin(event.currentTarget)}>
          <CalendarIcon name="pencil" /> Editar horario
        </button>
      </header>
      {!editing && error && <p className="hours-feedback" role="alert">{error}</p>}
      {notice && <p className="hours-feedback" role="status">{notice}</p>}
      {warning && <section className="hours-feedback" aria-label="Actualizar horario">
        <p role="alert">El horario está guardado, pero no se pudo actualizar la vista.</p>
        <button className="hours-button" type="button" disabled={pending || editing} onClick={() => void retry()}>Actualizar horario</button>
      </section>}
      <section className="hours-week-lines" aria-label="Horario semanal">
        <h2 className={weeklySchedule && !allOff ? "hours-sr-only" : "hours-feedback"}>
          {weeklySchedule === null ? "Horario sin configurar" : allOff ? "Todos los días sin atención" : "Horario semanal guardado"}
        </h2>
        {weeklySchedule === null ? <p className="hours-feedback">Todavía no hay un horario semanal guardado.</p> : <>
          <div className="hours-axis" aria-hidden="true"><div className="hours-axis-labels">
            {[0, 360, 720, 1080, 1440].map(minute => <span key={minute}>{formatScheduleClock(minute)}</span>)}
          </div></div>
          {scheduleDays.map(([id, name]) => {
            const saved = weeklySchedule[id] ?? [];
            return <button key={id} className={`hours-day-line${saved.length ? "" : " is-closed"}`} type="button"
              aria-label={`Editar horario de ${name}`} aria-describedby={`hours-day-${id}`} disabled={pending || editing}
              onClick={event => begin(event.currentTarget, id)}>
              <span className="hours-day-label"><strong>{name}</strong>{!saved.length && <small>Sin atención</small>}</span>
              <span className="hours-timeline" aria-hidden="true">{saved.map(({ startMinute, endMinute }, index) =>
                <i key={index} className="hours-bar" style={{ left: `${100 * startMinute / 1440}%`,
                  width: `${100 * ((endMinute < startMinute ? 1440 : endMinute) - startMinute) / 1440}%` }} />)}</span>
              <span className="hours-time-copy" id={`hours-day-${id}`}>{saved.length ? saved.map((span, index) =>
                <span key={index}>{formatScheduleClock(span.startMinute)} — {formatScheduleClock(span.endMinute)}{span.endMinute < span.startMinute ? " · día siguiente" : ""}</span>) : "Cerrado"}</span>
              <CalendarIcon name="arrow" />
            </button>;
          })}
        </>}
      </section>
      {editing && <CalendarDialog title="Editar horario" icon="clock" pending={pending} onDismiss={close}>
        <form ref={form} aria-label="Editar horario" aria-busy={pending} onSubmit={save}>
          <div className="hours-dialog-content">
            <nav className="hours-tabs" aria-label="Elegir día">
              {scheduleDays.map(([id, name]) => <button key={id} type="button" className="hours-tab" aria-label={name}
                ref={day === id ? activeTab : null} aria-pressed={day === id} disabled={pending} onClick={() => setDay(id)}>
                <span>{name.slice(0, 3)}</span><small>{draft[id]?.length || "—"}</small>
              </button>)}
            </nav>
            <fieldset className="hours-draft" disabled={pending}>
              <legend className="hours-sr-only">Horario semanal</legend>
              <div className="hours-editor-topline">
                <div><h3>{label}</h3><p>{spans.length ? `${spans.length} ${spans.length === 1 ? "franja" : "franjas"} de atención` : "Sin atención"}</p></div>
                <button type="button" className="hours-editor-add" aria-label={`Agregar franja ${label}`}
                  onClick={() => updateSpans([...spans, { id: nextId.current++, start: "", end: "" }])}>
                  <CalendarIcon name="plus" /> Agregar franja
                </button>
              </div>
              <div className="hours-span-list">{spans.length ? spans.map((span, index) => <div key={span.id} className="hours-span-row">
                <label className="hours-time-field">Desde <input aria-label={`Inicio ${label} ${index + 1}`} placeholder="HH:mm"
                  value={span.start} onChange={event => changeSpan(span.id, "start", event.target.value)} /></label>
                <div className="hours-time-field">
                  <label>Hasta <input aria-label={`Fin ${label} ${index + 1}`} placeholder="HH:mm" value={span.end}
                    onChange={event => changeSpan(span.id, "end", event.target.value)} /></label>
                  <label className="hours-end-option"><input type="checkbox" checked={span.end === "24:00"}
                    onChange={event => changeSpan(span.id, "end", event.target.checked ? "24:00" : "00:00")} /> Termina a las 24:00</label>
                </div>
                <button type="button" className="hours-span-remove" aria-label={`Quitar franja ${label} ${index + 1}`}
                  onClick={() => updateSpans(spans.filter(row => row.id !== span.id))}><CalendarIcon name="trash" /></button>
              </div>) : <div className="hours-off-message"><strong>Sin franjas de atención</strong><p>Agregá una franja para habilitar este día.</p></div>}</div>
            </fieldset>
            <p className="hours-edit-note"><CalendarIcon name="info" />
              Podés cargar varias franjas por día. Si la hora de fin es anterior a la de inicio, se interpreta como atención hasta el día siguiente. La aplicación valida conflictos con recursos y turnos confirmados al guardar.
            </p>
            <div className="hours-error">{(validationError || error) && <p role="alert">{validationError || error}</p>}</div>
          </div>
          <footer className="hours-dialog-footer">
            <button className="hours-button" type="button" disabled={pending} onClick={close}>Cancelar</button>
            <button ref={saveButton} className="hours-button primary" type="submit" disabled={pending}><CalendarIcon name="check" /> Guardar horario</button>
          </footer>
        </form>
      </CalendarDialog>}
    </div>
    <BusinessClosuresSection state={closures} retryAction={retryClosures} createAction={createClosure}
      updateAction={updateClosure} deleteAction={deleteClosure} />
  </main>;
}
