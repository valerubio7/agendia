import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Service, type ServiceInput } from "../api-client";

const priceFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  currencyDisplay: "code",
  minimumFractionDigits: 2,
  maximumFractionDigits: 20,
});

export function ServicesScreen({ services, onSave, onRefresh }: {
  services: readonly Service[];
  onSave: (id: string | null, body: ServiceInput, signal: AbortSignal) => Promise<boolean>;
  onRefresh: (signal: AbortSignal) => Promise<void>;
}) {
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
  const selectService = (service: Service | null) => {
    if (request.current) return;
    setEditing(service);
    setError("");
    setNotice("");
    setRevision(value => value + 1);
  };
  useEffect(() => {
    if (revision > 0) nameInput.current?.focus();
  }, [revision]);
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
        <h1 id="services-title">Servicios</h1>
        <p>Consultá los servicios de tu negocio, sus tiempos y precios.</p>
      </header>
      <form className="services-form" key={`${editing?.id ?? "create"}-${revision}`}
        aria-labelledby="service-form-title" aria-busy={pending} onSubmit={submit}>
        <h2 id="service-form-title">{editing ? "Editar servicio" : "Crear servicio"}</h2>
        <fieldset disabled={pending || refreshPending}>
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
      {refreshWarning && <section aria-label="Actualización del catálogo" aria-busy={refreshPending}>
        <p role="alert">El servicio se guardó, pero no pudimos actualizar el catálogo. Reintentá la actualización.</p>
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
              <button type="button" disabled={pending || refreshPending} aria-label={`Editar ${service.name}`}
                onClick={() => selectService(service)}>Editar</button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
