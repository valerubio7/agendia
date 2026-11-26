import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Resource, type ResourceInput, type Service } from "../../api/api-client";
import { useOutsideDismiss } from "../../components/dialog-dismiss";

import {
  ControlledWeeklyScheduleEditor, scheduleDays, formatScheduleClock, serializeScheduleDraft,
  type WeeklyScheduleDraft,
} from "../../components/weekly-schedule-editor";
import "./resources.css";

type LifecycleAction = Resource["status"] | "retire";
const icons = {
  briefcase: "M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 12h18M5 6h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z",
  plus: "M12 5v14M5 12h14", arrow: "M5 12h14m-6-6 6 6-6 6", close: "m6 6 12 12M18 6 6 18",
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2", check: "m5 12 4 4L19 6",
  pencil: "m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z",
  trash: "M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3M10 10v7m4-7v7",
  down: "m6 9 6 6 6-6",
};
function Icon({ name }: { name: keyof typeof icons }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join("").toLocaleUpperCase("es-AR");
const spanText = ({ startMinute, endMinute }: { startMinute: number; endMinute: number }, compact = false) => {
  const clock = (minute: number) => compact ? formatScheduleClock(minute).replace(/^0(?=\d)/, "") : formatScheduleClock(minute);
  return `${clock(startMinute)}–${clock(endMinute)}${endMinute < startMinute ? " (día siguiente)" : ""}`;
};
function habitualHours(weekly: Resource["weeklySchedule"]) {
  const groups: { first: number; last: number; text: string }[] = [];
  const days = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  scheduleDays.forEach(([day], index) => {
    const text = weekly[day]?.map(span => spanText(span, true)).join(" / ");
    if (!text) return;
    const prev = groups.at(-1);
    if (prev?.text === text && prev.last === index - 1) prev.last = index;
    else groups.push({ first: index, last: index, text });
  });
  return groups.map(({ first, last, text }) => `${days[first]}${first === last ? "" : `–${days[last]}`} · ${text}`).join("; ");
}

export function ResourcesScreen({ resources, services, onSave, onRefresh, onLifecycle }: {
  resources: readonly Resource[];
  services: readonly Service[];
  onSave: (id: string | null, body: ResourceInput, signal: AbortSignal) => Promise<boolean>;
  onRefresh: (signal: AbortSignal) => Promise<void>;
  onLifecycle: (id: string, action: LifecycleAction, signal: AbortSignal) => Promise<boolean>;
}) {
  const [confirmation, setConfirmation] = useState<{ resource: Resource; action: "suspended" | "retire" } | null>(null);
  const [lifecycleError, setLifecycleError] = useState("");
  const [panel, setPanel] = useState<"detail" | "edit" | "create" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = resources.find(resource => resource.id === selectedId);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const confirmOpener = useRef<HTMLButtonElement | null>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusReturn = useRef<{ button?: HTMLButtonElement | null; status?: boolean } | null>(null);
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
  const hoursEditor = useRef<HTMLDetailsElement>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => {
    if (!panel) { dialog.current?.close(); return; }
    if (!dialog.current?.open) dialog.current?.showModal();
    if (!focusReturn.current) (panel === "detail" ? closeButton : nameInput).current?.focus({ preventScroll: true });
  }, [panel, revision]);
  useEffect(() => {
    if (!confirmation) { confirmDialog.current?.close(); return; }
    if (!confirmDialog.current?.open) confirmDialog.current?.showModal();
    cancelButton.current?.focus();
  }, [confirmation]);
  useEffect(() => {
    if (pending || refreshPending || confirmation || !focusReturn.current) return;
    const target = focusReturn.current;
    const button = target.status ? statusButton.current : target.button;
    if (button?.isConnected && !button.disabled) button.focus();
    else heading.current?.focus();
    focusReturn.current = null;
  }, [pending, refreshPending, confirmation, panel, revision]);
  const resetDraft = (resource: Resource | null) => {
    setEditing(resource);
    setScheduleEdited(false);
    setSchedule(Object.fromEntries(scheduleDays.map(([day]) => [day,
      (resource?.weeklySchedule[day] ?? []).map(span => ({
        id: spanId.current++, start: formatScheduleClock(span.startMinute), end: formatScheduleClock(span.endMinute),
      })),
    ])));
    setRevision(value => value + 1);
  };
  const closePanel = () => {
    if (request.current) return;
    focusReturn.current = { button: opener.current };
    setPanel(null);
    setSelectedId(null);
    resetDraft(null);
    setError("");
    setLifecycleError("");
  };
  const openEditor = (resource: Resource | null) => {
    if (request.current) return;
    resetDraft(resource);
    setPanel(resource ? "edit" : "create");
    setError("");
    setLifecycleError("");
    setNotice("");
  };
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
      focusReturn.current = action === "retire" ? {} : { status: true };
      setConfirmation(null);
      if (action === "retire") {
        setPanel(null);
        setSelectedId(null);
      }
      resetDraft(action === "retire" ? null : resource);
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
    focusReturn.current = { button: confirmOpener.current };
    setConfirmation(null);
    setLifecycleError("");
  };
  const backdrop = useOutsideDismiss(closePanel);
  const confirmBackdrop = useOutsideDismiss(cancelLifecycle);
  const confirm = (resource: Resource, action: "suspended" | "retire", button: HTMLButtonElement) => {
    if (request.current) return;
    confirmOpener.current = button;
    setLifecycleError("");
    setConfirmation({ resource, action });
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
      if (hoursEditor.current && !hoursEditor.current.open) {
        hoursEditor.current.open = true;
        hoursEditor.current.querySelector("summary")?.focus();
      }
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
      focusReturn.current = { button: opener.current };
      setPanel(null);
      setSelectedId(null);
      resetDraft(null);
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
  const serviceName = (service: Service) => `${service.name}${service.status === "suspended" ? " (suspendido)" : ""}`;
  const locked = pending || refreshPending || !!confirmation;
  const newButton = (className: string) => <button className={className} type="button" aria-haspopup="dialog" disabled={locked}
    onClick={event => { opener.current = event.currentTarget; openEditor(null); }}><Icon name="plus" /> Nuevo recurso</button>;
  const feedback = <>
    {notice && <p role="status">{notice}</p>}
    {refreshWarning && <section aria-label="Actualización del catálogo" aria-busy={refreshPending}>
      <p role="alert">El cambio se guardó, pero no pudimos actualizar el catálogo. Reintentá la actualización.</p>
      <button className="rd-button" type="button" disabled={locked} onClick={() => void refresh()}>
        {refreshPending ? "Actualizando catálogo…" : "Actualizar catálogo"}
      </button>
    </section>}
  </>;
  return (
    <main className="resource-directory" aria-labelledby="resources-title">
      <header className="rd-topbar">
        <h1 id="resources-title" ref={heading} tabIndex={-1}>Recursos</h1>
        {newButton("rd-new")}
      </header>
      {!panel && (notice || refreshWarning) && <div className="rd-feedback">{feedback}</div>}
      {resources.length ? <ul className="rd-grid" role="list" aria-label="Catálogo de recursos">
        {resources.map(resource => <li key={resource.id}>
          <button className="rd-tile" data-status={resource.status} type="button" aria-label={`Ver ${resource.name}`}
            aria-haspopup="dialog" disabled={locked} onClick={event => {
              opener.current = event.currentTarget;
              setSelectedId(resource.id);
              setNotice("");
              setPanel("detail");
            }}>
            <span className="rd-arrow"><Icon name="arrow" /></span>
            <span className="rd-identity"><span className="rd-symbol" aria-hidden="true">{initials(resource.name)}</span>
              <span className="rd-tile-info"><strong>{resource.name}</strong><small>{resource.description || "Sin descripción"}</small></span></span>
            <span className="rd-tile-hours"><Icon name="clock" /><span>{habitualHours(resource.weeklySchedule) || "Horario sin definir"}</span></span>
            {resource.status === "suspended" && <span className="rd-flag">Suspendido</span>}
          </button>
        </li>)}
      </ul> : <section className="rd-empty" aria-labelledby="resources-empty-title">
        <Icon name="briefcase" /><h2 id="resources-empty-title">Todavía no hay recursos</h2>
        <p>Agregá el primer recurso para comenzar.</p>{newButton("rd-button")}
      </section>}

      <dialog ref={dialog} className="rd-dialog" aria-labelledby="rd-title" {...backdrop}
        onCancel={event => { event.preventDefault(); closePanel(); }}>
        <header className="rd-head">
          <span className="rd-dialog-icon"><Icon name="briefcase" /></span>
          <h2 id="rd-title">{panel === "detail" ? "Recurso" : panel === "edit" ? "Editar recurso" : "Nuevo recurso"}</h2>
          <button ref={closeButton} className="rd-close" type="button" aria-label="Cerrar ventana" disabled={locked} onClick={closePanel}><Icon name="close" /></button>
        </header>
        {panel === "detail" && selected && <>
          <div className="rd-body"><div className="rd-view">
            <div className="rd-hero">
              <span className="rd-symbol" aria-hidden="true">{initials(selected.name)}</span>
              <div className="rd-headline"><h3>{selected.name}</h3>
                {selected.description && <p className="resources-description">{selected.description}</p>}
              </div>
            </div>
            <div className="rd-facts">
              <div><span className="rd-caption">Estado</span><strong className="rd-status" data-status={selected.status}>
                {selected.status === "active" ? "Activo" : "Suspendido"}</strong></div>
              <details><summary><span className="rd-caption">Disponibilidad habitual <Icon name="down" /></span>
                <strong>{habitualHours(selected.weeklySchedule) || "Sin definir"}</strong></summary>
                <section className="rd-week" aria-label={`Horario semanal de ${selected.name}`}>
                  <dl className="resources-week">{scheduleDays.map(([day, label]) => <div key={day}>
                    <dt>{label}</dt><dd>{selected.weeklySchedule[day]?.map(span => spanText(span)).join(" · ") || "Sin franjas"}</dd>
                  </div>)}</dl>
                  <p>Las franjas corresponden al día en que empiezan. No representan turnos disponibles ni incluyen cierres por fecha.</p>
                </section>
              </details>
            </div>
            <section className="rd-service-view"><h4>Servicios asignados</h4>
              <div className="rd-tags">{selected.serviceIds.length ? selected.serviceIds.map(id => {
                const service = serviceById.get(id);
                return <span key={id}>{service ? serviceName(service) : `Servicio no disponible en el catálogo (ID: ${id})`}</span>;
              }) : <p>Sin servicios asignados</p>}</div>
            </section>
          </div>{refreshWarning && <div className="rd-feedback">{feedback}</div>}</div>
          <footer className="rd-footer">
            <button className="rd-button" type="button" disabled={locked} onClick={closePanel}>Cerrar</button>
            <button className="rd-button rd-primary" type="button" disabled={locked} onClick={() => openEditor(selected)}><Icon name="pencil" /> Editar recurso</button>
          </footer>
        </>}
        {(panel === "edit" || panel === "create") && <form key={revision} aria-labelledby="rd-title" aria-busy={pending} onSubmit={submit}>
          <div className="rd-body">
            <fieldset disabled={locked}>
              <div className="rd-field">
                <label htmlFor="resource-name">Nombre</label>
                <input ref={nameInput} id="resource-name" name="name" required placeholder="Ej. Juan, Cancha 1 o Máquina A" defaultValue={editing?.name ?? ""} />
              </div>
              <div className="rd-field">
                <label htmlFor="resource-description">Descripción (opcional)</label>
                <textarea id="resource-description" name="description" rows={2} placeholder="Especialidad o uso del recurso" defaultValue={editing?.description ?? ""} />
              </div>
              <details ref={hoursEditor} className="rd-hours-edit">
                <summary><span>Disponibilidad habitual</span><span>{scheduleEdited ? "Cambios sin guardar" : (editing && habitualHours(editing.weeklySchedule)) || "Sin definir"}<Icon name="down" /></span></summary>
                <ControlledWeeklyScheduleEditor value={schedule} onChange={changeSchedule} disabled={locked} />
              </details>
              <fieldset className="rd-picker">
                <legend>Servicios asignados</legend>
                {services.length ? <div className="rd-choices">{services.map(service => <label key={service.id}>
                  <span>{serviceName(service)}</span><input type="checkbox" name="serviceIds" value={service.id}
                    defaultChecked={editing?.serviceIds.includes(service.id) ?? false} />
                </label>)}</div> : <p>No hay servicios para asignar.</p>}
              </fieldset>
              {selected && <div className="rd-lifecycle">
                <button ref={statusButton} className="rd-button" type="button" onClick={event => selected.status === "suspended"
                  ? void lifecycle(selected, "active") : confirm(selected, "suspended", event.currentTarget)}>
                  <Icon name={selected.status === "suspended" ? "check" : "clock"} /> {selected.status === "active" ? "Suspender" : "Reactivar"}
                </button>
                <button className="rd-button rd-danger" type="button" onClick={event => confirm(selected, "retire", event.currentTarget)}><Icon name="trash" /> Retirar</button>
              </div>}
            </fieldset>
            {(notice || refreshWarning) && <div className="rd-feedback">{feedback}</div>}
          </div>
          {(error || (!confirmation && lifecycleError)) && <p className="rd-form-error" role="alert">{error || lifecycleError}</p>}
          <footer className="rd-footer">
            <button className="rd-button" type="button" disabled={locked} onClick={() => {
              if (request.current) return;
              if (!selected) { closePanel(); return; }
              setPanel("detail");
              resetDraft(null);
            }}>{editing ? "Cancelar edición" : "Cancelar"}</button>
            <button className="rd-button rd-primary" type="submit" disabled={locked}><Icon name="check" />{pending ? "Guardando…" : editing ? "Guardar cambios" : "Crear recurso"}</button>
          </footer>
        </form>}
      </dialog>
      <dialog ref={confirmDialog} className="rd-dialog rd-confirm" aria-labelledby="rd-confirm-title" {...confirmBackdrop}
        onCancel={event => { event.preventDefault(); cancelLifecycle(); }}>
        {confirmation && <section className="resources-confirmation" aria-label="Confirmar acción sobre recurso" aria-busy={pending}>
          <h2 id="rd-confirm-title">{confirmation.action === "retire" ? "Retirar" : "Suspender"} {confirmation.resource.name}</h2>
          <p>{confirmation.action === "retire"
            ? "Se quitará del catálogo y se conservará el historial. Puede rechazarse si tiene asignaciones futuras."
            : "No será elegible para nuevas reservas. Los turnos existentes no se cancelan."}</p>
          {lifecycleError && <p role="alert">{lifecycleError}</p>}
          <div className="rd-lifecycle">
            <button ref={cancelButton} className="rd-button" type="button" disabled={pending} onClick={cancelLifecycle}>Cancelar</button>
            <button className="rd-button rd-danger" type="button" disabled={pending} onClick={() => void lifecycle(confirmation.resource, confirmation.action)}>
              {pending ? "Procesando…" : confirmation.action === "retire" ? "Confirmar retiro" : "Confirmar suspensión"}
            </button>
          </div>
        </section>}
      </dialog>
    </main>
  );
}
