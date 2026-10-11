import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BusinessCalendar, WeeklySchedule } from "../api-client";
import { ControlledWeeklyScheduleEditor, formatScheduleClock, scheduleDays,
  serializeScheduleDraft, type WeeklyScheduleDraft } from "./weekly-schedule-editor";

const weekdays = [
  [1, "Lunes"], [2, "Martes"], [3, "Miércoles"], [4, "Jueves"],
  [5, "Viernes"], [6, "Sábado"], [0, "Domingo"],
] as const;
const time = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function BusinessCalendarScreen({ weeklySchedule, pending, error, notice, warning,
  saveAction, retryAction, clearFeedback,
}: BusinessCalendar & {
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
  const form = useRef<HTMLFormElement>(null);
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
    if (editing) form.current?.querySelector<HTMLElement>("input, button")?.focus();
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
  const begin = () => {
    if (pending || requestPending.current) return;
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
      setValidationError(`Usá horas HH:mm distintas para ${scheduleDays.find(([day]) => day === serialized.invalidDay)![1]}.`);
      return;
    }
    requestPending.current = true;
    setValidationError("");
    try {
      if (await saveAction(edited ? serialized : weeklySchedule ?? {})) {
        if (alive.current) close();
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
  const allOff = weeklySchedule !== null && weekdays.every(([day]) => !weeklySchedule[day]?.length);
  return (
    <main className="services-screen" aria-labelledby="business-calendar-title">
      <header className="services-header">
        <h1 id="business-calendar-title">Horario del negocio</h1>
        <p>Consultá el horario semanal guardado para tu negocio.</p>
        <button ref={opener} type="button" disabled={pending || editing} onClick={begin}>Editar horario</button>
      </header>
      {editing && <form ref={form} className="services-form" aria-label="Editar horario" aria-busy={pending} onSubmit={save}>
        <ControlledWeeklyScheduleEditor value={draft} disabled={pending}
          helpText="Sin franjas no habrá atención ese día. Usá HH:mm; 24:00 solo para el fin. Si el fin es anterior al inicio, continúa al día siguiente."
          onChange={value => {
            if (pending || requestPending.current) return;
            const allocated: WeeklyScheduleDraft = {};
            for (const [day] of scheduleDays) allocated[day] = (value[day] ?? []).map(span =>
              span.id === -1 ? { ...span, id: nextId.current++ } : span);
            setDraft(allocated);
            setEdited(true);
            setValidationError("");
          }} />
        <div className="services-form-actions">
          <button ref={saveButton} type="submit" disabled={pending}>Guardar horario</button>
          <button type="button" disabled={pending} onClick={() => {
            if (!requestPending.current) { clearFeedback(); close(); }
          }}>Cancelar</button>
        </div>
      </form>}
      {(validationError || error) && <p role="alert">{validationError || error}</p>}
      {notice && <p role="status">{notice}</p>}
      {warning && <section className="services-refresh-warning" aria-label="Actualizar horario">
        <p role="alert">El horario está guardado, pero no se pudo actualizar la vista.</p>
        <button type="button" disabled={pending || editing} onClick={() => void retry()}>Actualizar horario</button>
      </section>}
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
