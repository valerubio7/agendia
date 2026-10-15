import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Resource, type ResourceInput, type Service } from "../api-client";

import {
  ControlledWeeklyScheduleEditor, scheduleDays, formatScheduleClock, serializeScheduleDraft,
  type WeeklyScheduleDraft,
} from "./weekly-schedule-editor";

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
  const [schedule, setSchedule] = useState<WeeklyScheduleDraft>({});
  const spanId = useRef(0);
  const [scheduleEdited, setScheduleEdited] = useState(false);
  const changeSchedule = (value: WeeklyScheduleDraft) => {
    setScheduleEdited(true);
    setSchedule(Object.fromEntries(scheduleDays.map(([day]) => [day,
      (value[day] ?? []).map(span => span.id === -1 ? { ...span, id: spanId.current++ } : span),
    ])));
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
    setSchedule(Object.fromEntries(scheduleDays.map(([day]) => [day,
      (resource?.weeklySchedule[day] ?? []).map(span => ({
        id: spanId.current++, start: formatScheduleClock(span.startMinute), end: formatScheduleClock(span.endMinute),
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
    const weeklySchedule = serializeScheduleDraft(schedule);
    if ("invalidDay" in weeklySchedule) {
      const label = scheduleDays.find(([day]) => day === weeklySchedule.invalidDay)![1];
      setError(`${label}: ingresá horas HH:mm distintas; 24:00 solo puede ser el fin.`);
      return;
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
          <ControlledWeeklyScheduleEditor value={schedule} onChange={changeSchedule}
            disabled={pending || refreshPending || !!confirmation} />
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
                    {scheduleDays.map(([day, label]) => (
                      <div key={day}>
                        <dt>{label}</dt>
                        <dd>{resource.weeklySchedule[day]?.map(span =>
                          `${formatScheduleClock(span.startMinute)}–${formatScheduleClock(span.endMinute)}${span.endMinute < span.startMinute ? " (día siguiente)" : ""}`
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
