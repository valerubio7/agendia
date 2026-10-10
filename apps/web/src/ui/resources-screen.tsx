import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Resource, type ResourceInput, type Service } from "../api-client";

const days = [
  [1, "Lunes"], [2, "Martes"], [3, "Miércoles"], [4, "Jueves"],
  [5, "Viernes"], [6, "Sábado"], [0, "Domingo"],
] as const;
const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function ResourcesScreen({ resources, services, onSave, onRefresh }: {
  resources: readonly Resource[];
  services: readonly Service[];
  onSave: (id: string | null, body: ResourceInput, signal: AbortSignal) => Promise<boolean>;
  onRefresh: (signal: AbortSignal) => Promise<void>;
}) {
  const [editing, setEditing] = useState<Resource | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => { if (revision > 0) nameInput.current?.focus(); }, [revision]);
  const selectResource = (resource: Resource | null) => {
    if (request.current) return;
    setEditing(resource);
    setError("");
    setNotice("");
    setRevision(value => value + 1);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request.current) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name") ?? "").trim();
    const description = String(fields.get("description") ?? "").trim();
    if (!name) { setError("Ingresá un nombre para el recurso."); return; }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const refreshed = await onSave(editing?.id ?? null, {
        name, ...(description ? { description } : {}),
        serviceIds: fields.getAll("serviceIds").map(String),
        weeklySchedule: editing?.weeklySchedule ?? {},
      }, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      setRefreshWarning(!refreshed);
      setNotice(editing ? "Recurso actualizado" : "Recurso creado");
      setEditing(null);
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
        <h1 id="resources-title">Recursos</h1>
        <p>Consultá los recursos de tu negocio, sus servicios asignados y horarios semanales.</p>
      </header>
      <form className="resources-form" key={`${editing?.id ?? "create"}-${revision}`}
        aria-labelledby="resource-form-title" aria-busy={pending} onSubmit={submit}>
        <h2 id="resource-form-title">{editing ? "Editar recurso" : "Crear recurso"}</h2>
        <fieldset disabled={pending || refreshPending}>
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
          <p>{editing ? "Los horarios y el estado actuales se conservan."
            : "Se creará sin horarios configurados. No podrá recibir reservas hasta configurar horarios más adelante."}</p>
          <div className="resources-form-actions">
            <button type="submit">{pending ? "Guardando…" : editing ? "Guardar cambios" : "Crear recurso"}</button>
            {editing && <button type="button" onClick={() => selectResource(null)}>Cancelar edición</button>}
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </form>
      {refreshWarning && <section aria-label="Actualización del catálogo" aria-busy={refreshPending}>
        <p role="alert">El recurso se guardó, pero no pudimos actualizar el catálogo. Reintentá la actualización.</p>
        <button type="button" disabled={pending || refreshPending} onClick={() => void refresh()}>
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
                  <button type="button" disabled={pending || refreshPending} onClick={() => selectResource(resource)}
                    aria-label={`Editar ${resource.name}`}>Editar</button>
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
