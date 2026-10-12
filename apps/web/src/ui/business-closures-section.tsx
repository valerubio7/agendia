import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, type BusinessClosure, type BusinessClosureRequest } from "../api-client";
import { convertArgentinaClosureTime, formatArgentinaClosureDate, formatArgentinaClosureInstant } from "./argentina-closure-time";

export type ClosureReadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; closures: BusinessClosure[]; pending: boolean; warning: boolean };

export function BusinessClosuresSection({ state, retryAction, createAction }: {
  state: ClosureReadState; retryAction: () => Promise<void>;
  createAction: (input: BusinessClosureRequest, signal: AbortSignal) => Promise<boolean>;
}) {
  const kindId = useId();
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<"date" | "interval">("date");
  const [date, setDate] = useState("");
  const [wall, setWall] = useState({ start: "", end: "" });
  const [choice, setChoice] = useState({ start: "", end: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState<HTMLFormElement | "opener" | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => {
    if (editing) form.current?.querySelector<HTMLSelectElement>("select")?.focus();
  }, [editing]);
  const retryButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  const section = useRef<HTMLElement>(null);
  const pending = saving || state.status === "loading" || (state.status === "ready" && state.pending);
  useEffect(() => {
    if (!focus || pending || request.current) return;
    setFocus(null);
    const target = focus === "opener" ? opener.current : focus === form.current ? saveButton.current : null;
    if (target?.isConnected && !target.disabled && section.current?.contains(target)) target.focus();
  }, [focus, pending, editing]);
  useEffect(() => {
    if (pending || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = retryButton.current ?? heading.current;
    if (target?.isConnected && section.current?.contains(target) &&
      !(target instanceof HTMLButtonElement && target.disabled)) target.focus();
  }, [state, pending]);
  const retry = () => {
    if (pending) return;
    restoreFocus.current = true;
    void retryAction();
  };
  const close = () => {
    setEditing(false);
    setError("");
    setFocus("opener");
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || request.current || state.status !== "ready") return;
    const submitted = event.currentTarget;
    let input: BusinessClosureRequest;
    if (kind === "date") {
      // Validate the calendar day with the strict converter, but send the day unchanged.
      if (!convertArgentinaClosureTime(`${date}T12:00`).ok) {
        setError("Usá una fecha válida.");
        return;
      }
      input = { kind, date };
    } else {
      const instants: string[] = [];
      for (const field of ["start", "end"] as const) {
        const result = convertArgentinaClosureTime(wall[field]);
        if (result.ok === false) {
          setError(result.error === "nonexistent_wall_time" ? "Esa hora no existe en Argentina." : "Usá una fecha y hora válidas.");
          return;
        }
        const candidate = result.candidates.length === 1 ? result.candidates[0]
          : result.candidates.find(value => value.instant === choice[field]);
        if (!candidate) { setError("Elegí una de las horas repetidas para cada extremo."); return; }
        instants.push(candidate.instant);
      }
      if (new Date(instants[1]!).getTime() <= new Date(instants[0]!).getTime()) {
        setError("El fin debe ser posterior al inicio.");
        return;
      }
      input = { kind, start: instants[0]!, end: instants[1]! };
    }
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError("");
    setFocus(null);
    const current = () => request.current === controller && !controller.signal.aborted && submitted === form.current && submitted.isConnected;
    try {
      if (await createAction(input, controller.signal)) {
        if (current()) close();
      }
    } catch (cause) {
      if (current()) { setError(api.errorMessage(cause)); setFocus(submitted); }
    } finally {
      if (request.current === controller) { request.current = null; setSaving(false); }
    }
  };
  return <section ref={section} className="services-empty" aria-labelledby="business-closures-title" aria-busy={pending}>
    <h2 ref={heading} id="business-closures-title" tabIndex={-1}>Cierres del negocio</h2>
    <p>Se aplican a todo el negocio. Las fechas y horas se muestran en Argentina.</p>
    {state.status === "loading" && <p role="status">Cargando cierres…</p>}
    {state.status === "ready" && pending && <p role="status">{saving ? "Guardando cierre…" : "Actualizando cierres…"}</p>}
    {state.status === "ready" && state.warning && <p role="alert">
      No se pudo actualizar la lista de cierres. Los datos visibles pueden estar desactualizados.
    </p>}
    {(state.status === "error" || state.status === "loading" || state.warning) && <>
      {state.status === "error" && <p role="alert">{state.message}</p>}
      <button ref={retryButton} type="button" disabled={pending} onClick={retry}>Volver a cargar cierres</button>
    </>}
    {state.status === "ready" && !state.warning &&
      <button type="button" disabled={pending} onClick={retry}>Actualizar cierres</button>}
    {state.status === "ready" && <button ref={opener} type="button" disabled={pending || editing} onClick={() => {
      if (request.current) return;
      setKind("date"); setDate(""); setWall({ start: "", end: "" }); setChoice({ start: "", end: "" });
      setError(""); setFocus(null); setEditing(true);
    }}>Crear cierre</button>}
    {editing && <form ref={form} className="services-form" aria-label="Crear cierre" aria-busy={pending} onSubmit={save}>
      <p>Se aplica a todo el negocio. Las horas corresponden a America/Argentina/Buenos_Aires.</p>
      <label htmlFor={kindId}>Tipo de cierre</label>
      <select id={kindId} value={kind} disabled={pending} onChange={event => {
        if (request.current) return;
        setKind(event.target.value as typeof kind); setChoice({ start: "", end: "" }); setError("");
      }}><option value="date">Día completo</option><option value="interval">Intervalo</option></select>
      {kind === "date" ? <label>Fecha<input type="date" required disabled={pending} value={date}
        onChange={event => { if (!request.current) { setDate(event.target.value); setError(""); } }} /></label> :
        (["start", "end"] as const).map(field => {
          const result = convertArgentinaClosureTime(wall[field]);
          return <div key={field}>
            <label>{field === "start" ? "Desde (Argentina)" : "Hasta (Argentina)"}
              <input type="datetime-local" step="0.001" required disabled={pending} value={wall[field]} onChange={event => {
                if (request.current) return;
                setWall(value => ({ ...value, [field]: event.target.value }));
                setChoice(value => ({ ...value, [field]: "" })); setError("");
              }} /></label>
            {result.ok && result.candidates.length > 1 && <fieldset disabled={pending}>
              <legend>{field === "start" ? "Elegí el inicio" : "Elegí el fin"}: hora repetida</legend>
              {result.candidates.map(candidate => <label key={candidate.instant}>
                <input type="radio" name={`closure-${field}`} required checked={choice[field] === candidate.instant}
                  onChange={() => {
                    if (request.current) return;
                    setChoice(value => ({ ...value, [field]: candidate.instant })); setError("");
                  }} />
                {formatArgentinaClosureInstant(candidate.instant)} — desplazamiento {candidate.offsetSeconds} segundos
              </label>)}
            </fieldset>}
          </div>;
        })}
      {error && <p role="alert">{error}</p>}
      <div className="services-form-actions">
        <button ref={saveButton} type="submit" disabled={pending}>Guardar cierre</button>
        <button type="button" disabled={pending} onClick={() => { if (!request.current) close(); }}>Cancelar cierre</button>
      </div>
    </form>}
    {state.status === "ready" && (state.closures.length === 0 ?
      <p>No hay cierres guardados. El horario semanal sigue siendo la referencia de atención.</p> :
      <ul className="services-list">
        {state.closures.map(closure => <li key={closure.id} className="services-item" data-closure-id={closure.id}>
          {closure.kind === "date" ? <p>Día completo: {formatArgentinaClosureDate(closure.date)}</p> : <>
            <p>Desde: {formatArgentinaClosureInstant(closure.start)}</p>
            <p>Hasta: {formatArgentinaClosureInstant(closure.end)}</p>
          </>}
        </li>)}
      </ul>)}
  </section>;
}
