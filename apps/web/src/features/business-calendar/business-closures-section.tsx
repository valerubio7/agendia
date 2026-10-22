import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, type BusinessClosure, type BusinessClosureRequest } from "../../api/api-client";
import { convertArgentinaClosureTime, formatArgentinaClosureDate, formatArgentinaClosureInstant,
  projectArgentinaClosureTime } from "./argentina-closure-time";

export type ClosureReadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; closures: BusinessClosure[]; pending: boolean; warning: boolean };

type ClosureFocus = "opener" | "save" | "delete-confirm" | "heading" | { id: string; action: "edit" | "delete" };

export function BusinessClosuresSection({ state, retryAction, createAction, updateAction, deleteAction }: {
  state: ClosureReadState; retryAction: () => Promise<void>;
  createAction: (input: BusinessClosureRequest, signal: AbortSignal) => Promise<boolean>;
  updateAction: (id: string, input: BusinessClosureRequest, signal: AbortSignal) => Promise<boolean>;
  deleteAction: (id: string, signal: AbortSignal) => Promise<boolean>;
}) {
  const kindId = useId();
  const [editing, setEditing] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [original, setOriginal] = useState<Extract<BusinessClosure, { kind: "interval" }> | null>(null);
  const [changed, setChanged] = useState({ start: false, end: false });
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const deleteConfirm = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const [kind, setKind] = useState<"date" | "interval">("date");
  const [date, setDate] = useState("");
  const [wall, setWall] = useState({ start: "", end: "" });
  const [choice, setChoice] = useState({ start: "", end: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState<{ generation: number; target: ClosureFocus } | null>(null);
  const scheduleFocus = (target: ClosureFocus) => setFocus({ generation: generation.current, target });
  const form = useRef<HTMLFormElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; request.current?.abort(); request.current = null; }, []);
  useEffect(() => {
    if (editing) form.current?.querySelector<HTMLSelectElement>("select")?.focus();
  }, [editing]);
  useEffect(() => {
    if (confirmation) deleteCancel.current?.focus();
  }, [confirmation]);
  const retryButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  const section = useRef<HTMLElement>(null);
  const pending = saving || state.status === "loading" || (state.status === "ready" && state.pending);
  useEffect(() => {
    if (!focus || pending || request.current) return;
    setFocus(null);
    if (focus.generation !== generation.current) return;
    const destination = focus.target;
    let target: HTMLButtonElement | HTMLHeadingElement | null;
    if (typeof destination === "object") {
      target = Array.from(section.current?.querySelectorAll<HTMLButtonElement>("button[data-closure-action]") ?? [])
        .find(button => button.dataset.closureAction === destination.action &&
          button.closest("[data-closure-id]")?.getAttribute("data-closure-id") === destination.id) ?? heading.current;
    } else target = destination === "opener" ? opener.current : destination === "save" ? saveButton.current
      : destination === "delete-confirm" ? deleteConfirm.current : heading.current;
    if (target?.isConnected && section.current?.contains(target) &&
      !(target instanceof HTMLButtonElement && target.disabled)) target.focus();
  }, [focus, pending, editing, confirmation]);
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
    generation.current++;
    setEditing(false);
    setOriginal(null);
    setError("");
    scheduleFocus(editId ? { id: editId, action: "edit" } : "opener");
    setEditId(null);
  };
  const begin = (closure?: BusinessClosure) => {
    if (pending || request.current || editing || confirmation) return;
    generation.current++;
    setEditId(closure?.id ?? null);
    setKind(closure?.kind ?? "date");
    setDate(closure?.kind === "date" ? closure.date : "");
    setOriginal(closure?.kind === "interval" ? closure : null);
    setWall(closure?.kind === "interval" ? {
      start: projectArgentinaClosureTime(closure.start), end: projectArgentinaClosureTime(closure.end),
    } : { start: "", end: "" });
    setChanged({ start: false, end: false });
    setChoice({ start: "", end: "" });
    setError(""); setFocus(null); setEditing(true);
  };
  const cancelDelete = () => {
    if (pending || request.current || !confirmation) return;
    generation.current++;
    scheduleFocus({ id: confirmation, action: "delete" });
    setConfirmation(null); setError("");
  };
  const remove = async () => {
    if (pending || request.current || !confirmation || state.status !== "ready") return;
    const id = confirmation;
    const successor = state.closures.find(row => row.id !== id);
    const submitted = section.current;
    const attempt = generation.current;
    const controller = new AbortController();
    request.current = controller;
    setSaving(true); setError(""); setFocus(null);
    const current = () => request.current === controller && !controller.signal.aborted &&
      generation.current === attempt && submitted === section.current && submitted?.isConnected;
    try {
      if (await deleteAction(id, controller.signal) && current()) {
        generation.current++;
        setConfirmation(null);
        scheduleFocus(successor ? { id: successor.id, action: "edit" } : "heading");
      }
    } catch (cause) {
      if (current()) { setError(api.errorMessage(cause)); scheduleFocus("delete-confirm"); }
    } finally {
      if (request.current === controller) { request.current = null; setSaving(false); }
    }
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
        // Preserve each untouched endpoint independently, including raw offset and precision.
        if (original && !changed[field]) { instants.push(original[field]); continue; }
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
    const attempt = generation.current;
    const current = () => request.current === controller && !controller.signal.aborted &&
      generation.current === attempt && submitted === form.current && submitted.isConnected;
    try {
      const committed = editId ? await updateAction(editId, input, controller.signal) : await createAction(input, controller.signal);
      if (committed) {
        if (current()) close();
      }
    } catch (cause) {
      if (current()) { setError(api.errorMessage(cause)); scheduleFocus("save"); }
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
    {state.status === "ready" && <button ref={opener} type="button" disabled={pending || editing || !!confirmation}
      onClick={() => begin()}>Crear cierre</button>}
    {editing && <form ref={form} className="services-form" aria-label={editId ? "Editar cierre" : "Crear cierre"} aria-busy={pending} onSubmit={save}>
      <p>Se aplica a todo el negocio. Las horas corresponden a America/Argentina/Buenos_Aires.</p>
      <label htmlFor={kindId}>Tipo de cierre</label>
      <select id={kindId} value={kind} disabled={pending} onChange={event => {
        if (request.current) return;
        setKind(event.target.value as typeof kind);
        setOriginal(null); setDate(""); setWall({ start: "", end: "" });
        setChanged({ start: false, end: false }); setChoice({ start: "", end: "" }); setError("");
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
                setChanged(value => ({ ...value, [field]: true }));
                setChoice(value => ({ ...value, [field]: "" })); setError("");
              }} /></label>
            {(!original || changed[field]) && result.ok && result.candidates.length > 1 && <fieldset disabled={pending}>
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
          <div className="services-form-actions">
            <button type="button" data-closure-action="edit" disabled={pending || editing || !!confirmation}
              onClick={() => begin(closure)}>Editar cierre</button>
            <button type="button" data-closure-action="delete" disabled={pending || editing || !!confirmation}
              onClick={() => {
                if (request.current || pending || editing || confirmation) return;
                generation.current++; setError(""); setFocus(null); setConfirmation(closure.id);
              }}>Eliminar cierre</button>
          </div>
          {confirmation === closure.id && <div role="group" aria-label="Confirmar eliminación del cierre">
            <p>Eliminar este cierre vuelve a permitir atención según el horario semanal. No cancela ni modifica turnos existentes.</p>
            {error && <p role="alert">{error}</p>}
            <div className="services-form-actions">
              <button ref={deleteConfirm} type="button" disabled={pending} onClick={() => void remove()}>Confirmar eliminación</button>
              <button ref={deleteCancel} type="button" disabled={pending} onClick={cancelDelete}>Cancelar eliminación</button>
            </div>
          </div>}
        </li>)}
      </ul>)}
  </section>;
}
