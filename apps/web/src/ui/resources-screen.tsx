import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Resource, type ResourceInput, type Service } from "../api-client";

const days = [
  [1, "Lunes"], [2, "Martes"], [3, "Miércoles"], [4, "Jueves"],
  [5, "Viernes"], [6, "Sábado"], [0, "Domingo"],
] as const;
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
type DraftSpan = { id: number; start: string; end: string };
const parseClock = (value: string, end: boolean) => {
  if (end && value === "24:00") return 1440;
  if (value.length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return -1;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
};

type LifecycleAction = Resource["status"] | "retire";

export function ResourcesScreen({ resources, services, onSave, onRefresh, onLifecycle }: {
  resources: readonly Resource[];
  services: readonly Service[];
  onSave: (id: string | null, body: ResourceInput, signal: AbortSignal) => Promise<boolean>;
  onRefresh: (signal: AbortSignal) => Promise<void>;
  onLifecycle: (id: string, action: LifecycleAction, signal: AbortSignal) => Promise<boolean>;
}) {
  const [confirmation, setConfirmation] = useState<{ resource: Resource; action: "suspended" | "retire" } | null>(null);
  const [lifecycleError, setLifecycleError] = useState("");
  const cancelButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const lifecycleButtons = useRef(new Map<string, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const focusReturn = useRef<{ opener?: HTMLButtonElement; key?: string } | null>(null);
  useEffect(() => { if (confirmation) cancelButton.current?.focus(); }, [confirmation]);
  const [editing, setEditing] = useState<Resource | null>(null);
  const [schedule, setSchedule] = useState<Record<number, DraftSpan[]>>({});
  const spanId = useRef(0);
  const [scheduleEdited, setScheduleEdited] = useState(false);
  const changeSpan = (day: number, id: number, field: "start" | "end", value: string) => {
    setScheduleEdited(true);
    setSchedule(current => ({ ...current, [day]: (current[day] ?? []).map(span =>
      span.id === id ? { ...span, [field]: value } : span) }));
  };
  const [pending, setPending] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => { if (revision > 0 && !focusReturn.current) nameInput.current?.focus(); }, [revision]);
  useEffect(() => {
    if (pending || refreshPending || confirmation || !focusReturn.current) return;
    const target = focusReturn.current;
    const button = target.opener ?? (target.key ? lifecycleButtons.current.get(target.key) : undefined);
    if (button?.isConnected && !button.disabled) button.focus();
    else heading.current?.focus();
    focusReturn.current = null;
  }, [pending, refreshPending, confirmation, revision]);
  const lifecycle = async (resource: Resource, action: LifecycleAction) => {
    if (request.current || !resources.some(owned => owned.id === resource.id)) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setLifecycleError("");
    setError("");
    setNotice("");
    try {
      const refreshed = await onLifecycle(resource.id, action, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      setRefreshWarning(!refreshed);
      setNotice(action === "retire" ? "Recurso retirado" : action === "active" ? "Recurso reactivado" : "Recurso suspendido");
      focusReturn.current = action === "retire" ? {} : { key: `${resource.id}:${action === "active" ? "suspended" : "active"}` };
      setConfirmation(null);
      setEditing(null);
      setSchedule({});
      setScheduleEdited(false);
      setRevision(value => value + 1);
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setLifecycleError(api.errorMessage(cause));
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  };
  const cancelLifecycle = () => {
    if (request.current) return;
    focusReturn.current = opener.current ? { opener: opener.current } : {};
    setConfirmation(null);
    setLifecycleError("");
  };
  const selectResource = (resource: Resource | null) => {
    if (request.current) return;
    setEditing(resource);
    setScheduleEdited(false);
    setSchedule(Object.fromEntries(days.map(([day]) => [day,
      (resource?.weeklySchedule[day] ?? []).map(span => ({
        id: spanId.current++, start: clock(span.startMinute), end: clock(span.endMinute),
      })),
    ])));
    setError("");
    setNotice("");
    setRevision(value => value + 1);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request.current) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name") ?? "").trim();
    const rawDescription = String(fields.get("description") ?? "");
    const description = editing && rawDescription === editing.description
      ? rawDescription : rawDescription.trim();
    const preserveDescription = editing !== null && rawDescription === editing.description;
    if (!name) { setError("Ingresá un nombre para el recurso."); return; }
    const weeklySchedule: ResourceInput["weeklySchedule"] = {};
    for (const [day, label] of days) {
      const spans = [];
      for (const span of schedule[day] ?? []) {
        const startMinute = parseClock(span.start, false), endMinute = parseClock(span.end, true);
        if (startMinute < 0 || endMinute < 0 || startMinute === endMinute) {
          setError(`${label}: ingresá horas HH:mm distintas; 24:00 solo puede ser el fin.`);
          return;
        }
        spans.push({ startMinute, endMinute });
      }
      if (spans.length) weeklySchedule[day] = spans;
    }
    const selectedServices = fields.getAll("serviceIds").map(String);
    const serviceIds = editing && selectedServices.length === editing.serviceIds.length
      && editing.serviceIds.every(id => selectedServices.includes(id)) ? editing.serviceIds : selectedServices;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const refreshed = await onSave(editing?.id ?? null, {
        name, ...(description || preserveDescription ? { description } : {}),
        serviceIds,
        weeklySchedule: !scheduleEdited && editing ? editing.weeklySchedule : weeklySchedule,
      }, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      setRefreshWarning(!refreshed);
      setNotice(editing ? "Recurso actualizado" : "Recurso creado");
      setEditing(null);
      setSchedule({});
      setScheduleEdited(false);
      setRevision(value => value + 1);
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setError(api.errorMessage(cause));
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  };
  const refresh = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setRefreshPending(true);
    try {
      await onRefresh(controller.signal);
      if (!controller.signal.aborted && request.current === controller) setRefreshWarning(false);
    } catch {
      // Keep the saved warning; do not repeat POST or PUT.
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        request.current = null;
        setRefreshPending(false);
      }
    }
  };
  const serviceById = new Map(services.map(service => [service.id, service]));
  return (
    <main className="resources-screen" aria-labelledby="resources-title">
      <header className="resources-header">
        <h1 id="resources-title" ref={heading} tabIndex={-1}>Recursos</h1>
        <p>Consultá los recursos de tu negocio, sus servicios asignados y horarios semanales.</p>
      </header>
      <form className="resources-form" key={`${editing?.id ?? "create"}-${revision}`}
        aria-labelledby="resource-form-title" aria-busy={pending} onSubmit={submit}>
        <h2 id="resource-form-title">{editing ? "Editar recurso" : "Crear recurso"}</h2>
        <fieldset disabled={pending || refreshPending || !!confirmation}>
          <label htmlFor="resource-name">Nombre</label>
          <input ref={nameInput} id="resource-name" name="name" required defaultValue={editing?.name ?? ""} />
          <label htmlFor="resource-description">Descripción (opcional)</label>
          <textarea id="resource-description" name="description" defaultValue={editing?.description ?? ""} />
          <fieldset className="resources-picker">
            <legend>Servicios asignados</legend>
            <p>Podés dejar el recurso sin servicios asignados.</p>
            {services.map(service => <label key={service.id}>
              <input type="checkbox" name="serviceIds" value={service.id}
                defaultChecked={editing?.serviceIds.includes(service.id) ?? false} />
              {service.name}{service.status === "suspended" ? " (suspendido)" : ""}
            </label>)}
          </fieldset>
          <fieldset className="resources-hours">
            <legend>Horario semanal</legend>
            <p>Sin franjas no podrá recibir reservas. Usá HH:mm; 24:00 solo para el fin.
              Si el fin es anterior al inicio, continúa al día siguiente. El estado se conserva.</p>
            {days.map(([day, label]) => <fieldset key={day} className="resources-hours-day">
              <legend>{label}</legend>
              {(schedule[day] ?? []).length === 0 && <p>Sin franjas</p>}
              {(schedule[day] ?? []).map((span, index) => <div key={span.id} className="resources-hours-row">
                <label>Inicio {label} {index + 1}
                  <input type="text" inputMode="text" placeholder="HH:mm" value={span.start}
                    onChange={event => changeSpan(day, span.id, "start", event.target.value)} />
                </label>
                <label>Fin {label} {index + 1}
                  <input type="text" inputMode="text" placeholder="HH:mm" value={span.end}
                    onChange={event => changeSpan(day, span.id, "end", event.target.value)} />
                </label>
                <button type="button" aria-label={`Quitar franja ${label} ${index + 1}`}
                  onClick={() => {
                    setScheduleEdited(true);
                    setSchedule(current => ({ ...current,
                      [day]: (current[day] ?? []).filter(row => row.id !== span.id) }));
                  }}>Quitar franja</button>
              </div>)}
              <button type="button" aria-label={`Agregar franja ${label}`}
                onClick={() => {
                  const row = { id: spanId.current++, start: "", end: "" };
                  setScheduleEdited(true);
                  setSchedule(current => ({ ...current, [day]: [...(current[day] ?? []), row] }));
                }}>Agregar franja</button>
            </fieldset>)}
          </fieldset>
          <div className="resources-form-actions">
            <button type="submit">{pending ? "Guardando…" : editing ? "Guardar cambios" : "Crear recurso"}</button>
            {editing && <button type="button" onClick={() => selectResource(null)}>Cancelar edición</button>}
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </form>
      {confirmation && <section className="resources-confirmation" role="region" aria-label="Confirmar acción sobre recurso" aria-busy={pending}>
        <h2>{confirmation.action === "retire" ? "Retirar" : "Suspender"} {confirmation.resource.name}</h2>
        <p>{confirmation.action === "retire"
          ? "Se quitará del catálogo y se conservará el historial. Puede rechazarse si tiene asignaciones futuras."
          : "No será elegible para nuevas reservas. Los turnos existentes no se cancelan."}</p>
        <div className="resources-form-actions">
          <button ref={cancelButton} type="button" disabled={pending} onClick={cancelLifecycle}>Cancelar</button>
          <button type="button" disabled={pending} onClick={() => void lifecycle(confirmation.resource, confirmation.action)}>
            {pending ? "Procesando…" : confirmation.action === "retire" ? "Confirmar retiro" : "Confirmar suspensión"}
          </button>
        </div>
      </section>}
      {lifecycleError && <p role="alert">{lifecycleError}</p>}
      {refreshWarning && <section aria-label="Actualización del catálogo" aria-busy={refreshPending}>
        <p role="alert">El cambio se guardó, pero no pudimos actualizar el catálogo. Reintentá la actualización.</p>
        <button type="button" disabled={pending || refreshPending || !!confirmation} onClick={() => void refresh()}>
          {refreshPending ? "Actualizando catálogo…" : "Actualizar catálogo"}
        </button>
      </section>}
      {resources.length === 0 ? (
        <section className="resources-empty" aria-labelledby="resources-empty-title">
          <h2 id="resources-empty-title">Todavía no hay recursos</h2>
          <p>Los recursos de tu negocio aparecerán acá con su estado, servicios y horarios.</p>
        </section>
      ) : (
        <>
          <p className="resources-schedule-note">Las franjas corresponden al día en que empiezan y pueden continuar al día siguiente.
            No representan turnos disponibles ni incluyen cierres por fecha.</p>
          <ul className="resources-list" aria-label="Catálogo de recursos">
            {resources.map(resource => (
              <li className="resources-item" key={resource.id}>
                <div className="resources-summary">
                  <h2>{resource.name}</h2>
                  <span className="resources-status" data-status={resource.status}>
                    {resource.status === "active" ? "Activo" : "Suspendido"}
                  </span>
                  {resource.description && <p className="resources-description">{resource.description}</p>}
                  <div className="resources-form-actions">
                    <button type="button" disabled={pending || refreshPending || !!confirmation} onClick={() => selectResource(resource)}
                      aria-label={`Editar ${resource.name}`}>Editar</button>
                    <button type="button" disabled={pending || refreshPending || !!confirmation}
                      ref={node => {
                        const key = `${resource.id}:${resource.status === "active" ? "suspended" : "active"}`;
                        if (node) lifecycleButtons.current.set(key, node); else lifecycleButtons.current.delete(key);
                      }} onClick={event => {
                        if (request.current) return;
                        if (resource.status === "suspended") void lifecycle(resource, "active");
                        else { opener.current = event.currentTarget; setLifecycleError(""); setConfirmation({ resource, action: "suspended" }); }
                      }}>{resource.status === "active" ? "Suspender" : "Reactivar"}</button>
                    <button type="button" disabled={pending || refreshPending || !!confirmation} onClick={event => {
                      if (request.current) return;
                      opener.current = event.currentTarget;
                      setLifecycleError("");
                      setConfirmation({ resource, action: "retire" });
                    }}>Retirar</button>
                  </div>
                  <h3>Servicios asignados</h3>
                  {resource.serviceIds.length === 0 ? <p>Sin servicios asignados</p> : (
                    <div className="resources-services">
                      {resource.serviceIds.map(id => {
                        const service = serviceById.get(id);
                        return <p key={id}>{service
                          ? `${service.name}${service.status === "suspended" ? " (suspendido)" : ""}`
                          : `Servicio no disponible en el catálogo (ID: ${id})`}</p>;
                      })}
                    </div>
                  )}
                </div>
                <section className="resources-schedule" aria-label={`Horario semanal de ${resource.name}`}>
                  <h3>Horario semanal</h3>
                  <dl className="resources-week">
                    {days.map(([day, label]) => (
                      <div key={day}>
                        <dt>{label}</dt>
                        <dd>{resource.weeklySchedule[day]?.map(span =>
                          `${clock(span.startMinute)}–${clock(span.endMinute)}${span.endMinute < span.startMinute ? " (día siguiente)" : ""}`
                        ).join(" · ") || "Sin franjas"}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
