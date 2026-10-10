import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Service, type ServiceInput } from "../api-client";

const priceFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  currencyDisplay: "code",
  minimumFractionDigits: 2,
  maximumFractionDigits: 20,
});

type LifecycleAction = Service["status"] | "retire";

export function ServicesScreen({ services, onSave, onRefresh, onLifecycle }: {
  services: readonly Service[];
  onSave: (id: string | null, body: ServiceInput, signal: AbortSignal) => Promise<boolean>;
  onRefresh: (signal: AbortSignal) => Promise<void>;
  onLifecycle: (id: string, action: LifecycleAction, signal: AbortSignal) => Promise<boolean>;
}) {
  const [confirmation, setConfirmation] = useState<{ service: Service; action: "suspended" | "retire" } | null>(null);
  const [lifecycleError, setLifecycleError] = useState("");
  const cancelButton = useRef<HTMLButtonElement>(null);
  const actionButton = useRef<HTMLButtonElement | null>(null);
  const lifecycleButtons = useRef(new Map<string, HTMLButtonElement>());
  const servicesHeading = useRef<HTMLHeadingElement>(null);
  const focusReturn = useRef<{ opener?: HTMLButtonElement; key?: string } | null>(null);
  useEffect(() => { if (confirmation) cancelButton.current?.focus(); }, [confirmation]);
  const [editing, setEditing] = useState<Service | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { request.current?.abort(); }, []);
  const lifecycle = async (service: Service, action: LifecycleAction) => {
    if (request.current || !services.some(owned => owned.id === service.id)) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setLifecycleError("");
    setError("");
    setNotice("");
    try {
      const refreshed = await onLifecycle(service.id, action, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      setRefreshWarning(!refreshed);
      setNotice(action === "retire" ? "Servicio retirado" : action === "active" ? "Servicio reactivado" : "Servicio suspendido");
      focusReturn.current = action === "retire" ? {} : { key: `${service.id}:${action === "active" ? "suspended" : "active"}` };
      setConfirmation(null);
      setEditing(null);
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
    focusReturn.current = actionButton.current ? { opener: actionButton.current } : {};
    setConfirmation(null);
    setLifecycleError("");
  };
  const selectService = (service: Service | null) => {
    if (request.current) return;
    setEditing(service);
    setError("");
    setNotice("");
    setRevision(value => value + 1);
  };
  useEffect(() => {
    if (revision > 0 && !focusReturn.current) nameInput.current?.focus();
  }, [revision]);
  useEffect(() => {
    if (pending || refreshPending || confirmation || !focusReturn.current) return;
    const target = focusReturn.current;
    const button = target.opener ?? (target.key ? lifecycleButtons.current.get(target.key) : undefined);
    if (button?.isConnected && !button.disabled) button.focus();
    else servicesHeading.current?.focus();
    focusReturn.current = null;
  }, [pending, refreshPending, confirmation, revision]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const name = String(fields.get("name") ?? "").trim();
    const description = String(fields.get("description") ?? "").trim();
    const durationText = String(fields.get("durationMinutes") ?? "").trim();
    const priceText = String(fields.get("priceArs") ?? "").trim();
    const durationMinutes = Number(durationText);
    const priceArs = Number(priceText);
    if (!name || !durationText || !Number.isInteger(durationMinutes) || durationMinutes < 15 ||
      durationMinutes % 15 !== 0 || !priceText || !Number.isFinite(priceArs) || priceArs < 0) {
      setError("Revisá el nombre, la duración en múltiplos de 15 y el precio no negativo.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const refreshed = await onSave(editing?.id ?? null, { name, description, durationMinutes, priceArs }, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      setRefreshWarning(!refreshed);
      setNotice(editing ? "Servicio actualizado" : "Servicio creado");
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
      // Keep the committed-save warning and offer another GET-only attempt.
    } finally {
      if (!controller.signal.aborted && request.current === controller) {
        request.current = null;
        setRefreshPending(false);
      }
    }
  };
  return (
    <main className="services-screen" aria-labelledby="services-title">
      <header className="services-header">
        <h1 ref={servicesHeading} tabIndex={-1} id="services-title">Servicios</h1>
        <p>Consultá los servicios de tu negocio, sus tiempos y precios.</p>
      </header>
      <form className="services-form" key={`${editing?.id ?? "create"}-${revision}`}
        aria-labelledby="service-form-title" aria-busy={pending} onSubmit={submit}>
        <h2 id="service-form-title">{editing ? "Editar servicio" : "Crear servicio"}</h2>
        <fieldset disabled={pending || refreshPending || !!confirmation}>
          <label htmlFor="service-name">Nombre</label>
          <input ref={nameInput} id="service-name" name="name" required defaultValue={editing?.name ?? ""} />
          <label htmlFor="service-description">Descripción (opcional)</label>
          <textarea id="service-description" name="description" defaultValue={editing?.description ?? ""} />
          <div className="services-form-terms">
            <div>
              <label htmlFor="service-duration">Duración (minutos)</label>
              <input id="service-duration" name="durationMinutes" type="number" min="15" step="15" required
                defaultValue={editing?.durationMinutes ?? 15} aria-describedby="service-duration-help" />
              <small id="service-duration-help">Usá múltiplos de 15 minutos.</small>
            </div>
            <div>
              <label htmlFor="service-price">Precio (ARS)</label>
              <input id="service-price" name="priceArs" type="number" min="0" step="any" required
                defaultValue={editing?.priceArs ?? 0} />
            </div>
          </div>
          <div className="services-form-actions">
            <button type="submit">{pending ? "Guardando…" : editing ? "Guardar cambios" : "Crear servicio"}</button>
            {editing && <button type="button" onClick={() => selectService(null)}>Cancelar edición</button>}
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </form>
      {confirmation && <section className="services-confirmation" aria-label="Confirmar acción" aria-busy={pending}>
        <h2>{confirmation.action === "retire" ? "Retirar" : "Suspender"} {confirmation.service.name}</h2>
        <p>{confirmation.action === "retire"
          ? "Quedará oculto del catálogo. El historial se conserva. El retiro puede estar bloqueado por turnos futuros."
          : "No se ofrecerá para nuevos turnos. No cancela los turnos existentes."}</p>
        <div className="services-form-actions">
          <button ref={cancelButton} type="button" disabled={pending} onClick={cancelLifecycle}>Cancelar</button>
          <button type="button" disabled={pending} onClick={() => void lifecycle(confirmation.service, confirmation.action)}>
            {confirmation.action === "retire" ? "Confirmar retiro" : "Confirmar suspensión"}
          </button>
        </div>
        {lifecycleError && <p role="alert">{lifecycleError}</p>}
      </section>}
      {!confirmation && lifecycleError && <p role="alert">{lifecycleError}</p>}
      {refreshWarning && <section aria-label="Actualización del catálogo" aria-busy={refreshPending}>
        <p role="alert">{notice === "Servicio retirado"
          ? "El servicio se retiró, pero no pudimos actualizar el catálogo. Reintentá la actualización."
          : "El servicio se guardó, pero no pudimos actualizar el catálogo. Reintentá la actualización."}</p>
        <button type="button" disabled={pending || refreshPending} onClick={() => void refresh()}>
          {refreshPending ? "Actualizando catálogo…" : "Actualizar catálogo"}
        </button>
      </section>}
      {services.length === 0 ? (
        <section className="services-empty" aria-labelledby="services-empty-title">
          <h2 id="services-empty-title">Todavía no hay servicios</h2>
          <p>Los servicios de tu negocio aparecerán acá con su duración, precio y estado.</p>
        </section>
      ) : (
        <ul className="services-list" aria-label="Catálogo de servicios">
          {services.map((service) => (
            <li className="services-item" key={service.id}>
              <div className="services-summary">
                <h2>{service.name}</h2>
                <span className="services-status" data-status={service.status}>
                  {service.status === "active" ? "Activo" : "Suspendido"}
                </span>
                {service.description && <p className="services-description">{service.description}</p>}
              </div>
              <dl className="services-terms">
                <div><dt>Duración</dt><dd>{service.durationMinutes} min</dd></div>
                <div><dt>Precio</dt><dd>{priceFormatter.format(service.priceArs)}</dd></div>
              </dl>
              <div className="services-item-actions">
                <button type="button" disabled={pending || refreshPending || !!confirmation} aria-label={`Editar ${service.name}`}
                  onClick={() => selectService(service)}>Editar</button>
                {([service.status === "active" ? "suspended" : "active", "retire"] as const).map(action => {
                  const label = action === "retire" ? "Retirar" : action === "active" ? "Reactivar" : "Suspender";
                  return <button key={action} type="button" ref={button => {
                    const key = `${service.id}:${action}`;
                    if (button) lifecycleButtons.current.set(key, button);
                    else lifecycleButtons.current.delete(key);
                  }} disabled={pending || refreshPending || !!confirmation}
                    aria-label={`${label} ${service.name}`} onClick={event => {
                      actionButton.current = event.currentTarget;
                      setLifecycleError("");
                      if (action === "active") void lifecycle(service, action);
                      else setConfirmation({ service, action });
                    }}>{label}</button>;
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
