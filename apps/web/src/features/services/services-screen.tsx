import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Service, type ServiceCategory, type ServiceInput } from "../../api/api-client";
import { useOutsideDismiss } from "../../components/dialog-dismiss";
import "./services.css";

const price = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 0, maximumFractionDigits: 20 });
const icons = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  arrow: "M5 12h14m-6-6 6 6-6 6", plus: "M12 5v14M5 12h14", sliders: "M4 7h16M4 17h16M9 3v8M15 13v8",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2", close: "M18 6 6 18M6 6l12 12", check: "m4 12 5 5L20 6",
  briefcase: "M5 7h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18",
  pencil: "m4 20 4.3-.9L20 7.4a2.1 2.1 0 0 0-3-3L5.3 16.1zM14.8 6.6l3 3", trash: "M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3",
};
function Icon({ name }: { name: keyof typeof icons }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

type LifecycleAction = Service["status"] | "retire";
type Panel = "new" | "detail" | "edit" | "categories";

export function ServicesScreen({ services, categories, onCategory, onSave, onRefresh, onLifecycle }: {
  services: readonly Service[];
  categories: readonly ServiceCategory[];
  onCategory: (operation: { kind: "create"; name: string } | { kind: "delete"; id: string }, signal: AbortSignal) => Promise<boolean | null>;
  onSave: (id: string | null, body: ServiceInput, signal: AbortSignal) => Promise<boolean | null>;
  onRefresh: (signal: AbortSignal) => Promise<boolean>;
  onLifecycle: (id: string, action: LifecycleAction, signal: AbortSignal) => Promise<boolean | null>;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [categoryConfirmation, setCategoryConfirmation] = useState<ServiceCategory | null>(null);
  const [confirmation, setConfirmation] = useState<{ service: Service; action: "suspended" | "retire" } | null>(null);
  const [categoryError, setCategoryError] = useState("");
  const [categoryNotice, setCategoryNotice] = useState("");
  const [lifecycleError, setLifecycleError] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const categoryInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const panelOpener = useRef<HTMLButtonElement>(null);
  const panelClose = useRef<HTMLButtonElement>(null);
  const confirmationOpener = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const servicesHeading = useRef<HTMLHeadingElement>(null);
  const focusReturn = useRef<HTMLElement | "status" | null>(null);
  const confirming = !!(confirmation || categoryConfirmation);
  const busy = pending || refreshPending;
  const selected = services.find(service => service.id === serviceId);
  const editing = panel === "edit" ? selected : undefined;
  const names = new Map(categories.map(category => [category.id, category.name]));
  const categoryOf = (service: Service) => service.categoryId && names.has(service.categoryId) ? service.categoryId : "";
  const hasUnassigned = services.some(service => !categoryOf(service));
  const currentFilter = (filter === "" ? hasUnassigned : filter !== null && names.has(filter)) ? filter : null;
  const visibleServices = currentFilter === null ? services : services.filter(service => categoryOf(service) === currentFilter);
  const categoryName = (service: Service) => names.get(categoryOf(service)) ?? "Sin categoría";

  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => {
    const surface = dialog.current;
    if (!surface) return;
    if (!panel) { if (surface.open) surface.close(); return; }
    if (!surface.open) surface.showModal();
    (panel === "categories" ? categoryInput : panel === "detail" ? panelClose : nameInput).current?.focus({ preventScroll: true });
  }, [panel]);
  useEffect(() => { if (confirming) cancelButton.current?.focus(); }, [confirming]);
  useEffect(() => {
    if (busy || confirming || !focusReturn.current) return;
    const control = focusReturn.current === "status" ? statusButton.current : focusReturn.current;
    (control?.isConnected ? control : panel ? panelClose.current : servicesHeading.current)?.focus({ preventScroll: true });
    focusReturn.current = null;
  }, [busy, confirming, panel]);

  const openPanel = (next: Panel, opener: HTMLButtonElement, service?: Service) => {
    if (request.current) return;
    panelOpener.current = opener;
    setServiceId(service?.id ?? null);
    setError(""); setLifecycleError(""); setCategoryError("");
    if (!refreshWarning) { setNotice(""); setCategoryNotice(""); }
    setPanel(next);
  };
  const closePanel = () => {
    if (request.current) return;
    if (confirming) {
      focusReturn.current = confirmationOpener.current;
      setConfirmation(null); setCategoryConfirmation(null);
      setLifecycleError(""); setCategoryError("");
    } else {
      focusReturn.current = panelOpener.current;
      setPanel(null);
    }
  };
  const backdrop = useOutsideDismiss(closePanel);
  const categoryAction = async (operation: { kind: "create"; name: string } | { kind: "delete"; id: string }, form?: HTMLFormElement) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setCategoryError("");
    setCategoryNotice("");
    try {
      const refreshed = await onCategory(operation, controller.signal);
      if (refreshed === null || controller.signal.aborted || request.current !== controller) return;
      setRefreshWarning(!refreshed);
      setNotice("");
      setCategoryNotice(operation.kind === "create" ? "Categoría creada" : "Categoría eliminada");
      if (operation.kind === "delete") {
        setCategoryConfirmation(null);
        if (filter === operation.id) setFilter(null);
      } else form?.reset();
      focusReturn.current = categoryInput.current;
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setCategoryError(api.errorMessage(cause));
    } finally {
      if (!controller.signal.aborted && request.current === controller) { request.current = null; setPending(false); }
    }
  };
  const lifecycle = async (service: Service, action: LifecycleAction) => {
    if (request.current || !services.some(owned => owned.id === service.id)) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setLifecycleError("");
    setError("");
    setNotice("");
    setCategoryNotice("");
    try {
      const refreshed = await onLifecycle(service.id, action, controller.signal);
      if (refreshed === null || controller.signal.aborted || request.current !== controller) return;
      setRefreshWarning(!refreshed);
      setNotice(action === "retire" ? "Servicio retirado" : action === "active" ? "Servicio reactivado" : "Servicio suspendido");
      setConfirmation(null);
      focusReturn.current = action === "retire" ? servicesHeading.current : "status";
      if (action === "retire") setPanel(null);
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setLifecycleError(api.errorMessage(cause));
    } finally {
      if (!controller.signal.aborted && request.current === controller) { request.current = null; setPending(false); }
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request.current || (panel === "edit" && !editing)) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get("name") ?? "").trim();
    const description = String(fields.get("description") ?? "").trim();
    const durationText = String(fields.get("durationMinutes") ?? "").trim();
    const priceText = String(fields.get("priceArs") ?? "").trim();
    const durationMinutes = Number(durationText);
    const priceArs = Number(priceText);
    if (!name || !durationText || !Number.isInteger(durationMinutes) || durationMinutes < 5 ||
      durationMinutes % 5 !== 0 || !priceText || !Number.isFinite(priceArs) || priceArs < 0) {
      setError("Revisá el nombre, la duración en múltiplos de 5 y el precio no negativo.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    setNotice("");
    setCategoryNotice("");
    try {
      const refreshed = await onSave(editing?.id ?? null, { name, description, durationMinutes, priceArs, categoryId: String(fields.get("categoryId") ?? "") || null }, controller.signal);
      if (refreshed === null || controller.signal.aborted || request.current !== controller) return;
      setRefreshWarning(!refreshed);
      setNotice(editing ? "Servicio actualizado" : "Servicio creado");
      focusReturn.current = panelOpener.current;
      setPanel(null);
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) setError(api.errorMessage(cause));
    } finally {
      if (!controller.signal.aborted && request.current === controller) { request.current = null; setPending(false); }
    }
  };
  const refresh = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setRefreshPending(true);
    try {
      const refreshed = await onRefresh(controller.signal);
      if (refreshed && !controller.signal.aborted && request.current === controller) setRefreshWarning(false);
    } catch {
      // Keep the committed-save warning and offer another GET-only attempt.
    } finally {
      if (!controller.signal.aborted && request.current === controller) { request.current = null; setRefreshPending(false); }
    }
  };

  const editor = panel === "new" || panel === "edit";
  const title = confirmation ? `${confirmation.action === "retire" ? "Retirar" : "Suspender"} ${confirmation.service.name}`
    : categoryConfirmation ? `Eliminar ${categoryConfirmation.name}` : panel === "categories" ? "Categorías"
      : panel === "detail" ? "Servicio" : editing ? "Editar servicio" : "Nuevo servicio";
  const warning = refreshWarning && <section className="service-warning" aria-label="Actualización del catálogo" aria-busy={refreshPending}>
    <p role="alert">{categoryNotice ? "La categoría se actualizó, pero no pudimos actualizar el catálogo. Reintentá la actualización." : notice === "Servicio retirado"
      ? "El servicio se retiró, pero no pudimos actualizar el catálogo. Reintentá la actualización."
      : "El servicio se guardó, pero no pudimos actualizar el catálogo. Reintentá la actualización."}</p>
    <button className="service-button" type="button" disabled={busy} onClick={() => void refresh()}>{refreshPending ? "Actualizando catálogo…" : "Actualizar catálogo"}</button>
  </section>;
  const filters = [{ id: null, name: "Todas" }, ...categories, ...(hasUnassigned ? [{ id: "", name: "Sin categoría" }] : [])];
  return (
    <main className="services-screen">
      <header className="services-header">
        <h1 ref={servicesHeading} tabIndex={-1}>Servicios</h1>
        <button className="service-new" type="button" disabled={busy} onClick={event => openPanel("new", event.currentTarget)}><Icon name="plus" /> Nuevo servicio</button>
      </header>
      <div className="services-filters">
        <div className="service-chips" role="group" aria-label="Filtrar por categoría">
          {filters.map(({ id, name }) => <button className="service-chip" key={id ?? "all"} type="button" aria-pressed={id === currentFilter} onClick={() => setFilter(id)}>{name}</button>)}
        </div>
        <button className="service-manage" type="button" disabled={busy} onClick={event => openPanel("categories", event.currentTarget)}><Icon name="sliders" /> Categorías</button>
      </div>
      {!panel && warning}
      {!panel && (notice || categoryNotice) && <p className="service-notice" role="status">{notice || categoryNotice}</p>}
      {visibleServices.length ? <ul className="services-list" role="list" aria-label="Catálogo de servicios">
        {visibleServices.map(service => <li key={service.id}>
          <button className="service-tile" data-paused={service.status === "suspended"} type="button" disabled={busy} aria-label={`Ver servicio ${service.name}`}
            onClick={event => openPanel("detail", event.currentTarget, service)}>
            <span className="service-tile-head"><span className="service-tag">{categoryName(service)}</span><span className="service-arrow"><Icon name="arrow" /></span></span>
            <span className="service-tile-main"><strong role="heading" aria-level={2}>{service.name}</strong><span>{service.description || "Sin descripción"}</span></span>
            <span className="service-tile-foot"><span><small>Precio</small><b>{price.format(service.priceArs)}</b></span><span><small>Duración</small><b>{service.durationMinutes} min</b></span></span>
            {service.status === "suspended" && <span className="service-paused"><Icon name="clock" /> Pausado</span>}
          </button>
        </li>)}
      </ul> : <section className="service-empty">
        <Icon name="grid" /><h2>Sin servicios</h2><p>{services.length ? "No hay servicios en esta categoría." : "Agregá un servicio para empezar."}</p>
        <button className="service-button" type="button" disabled={busy} onClick={event => openPanel("new", event.currentTarget)}><Icon name="plus" /> Crear servicio</button>
      </section>}
      <dialog ref={dialog} className="service-dialog" aria-labelledby="service-panel-title" {...backdrop}
        onCancel={event => { event.preventDefault(); closePanel(); }}>
        {panel && <><header className="service-panel-head">
          <span><Icon name={panel === "categories" ? "sliders" : "grid"} /></span><h2 id="service-panel-title">{title}</h2>
          <button ref={panelClose} className="service-panel-close" type="button" aria-label="Cerrar panel" disabled={busy} onClick={closePanel}><Icon name="close" /></button>
        </header>
        <div className="service-panel-body">
          <hr />
          {!confirming && warning}
          {panel === "detail" && selected && <div className="service-view">
            <div className="service-view-tags"><span className="service-tag">{categoryName(selected)}</span><span className="service-state" data-paused={selected.status === "suspended"}>{selected.status === "active" ? "Activo" : "Pausado"}</span></div>
            <h3>{selected.name}</h3>{selected.description && <p>{selected.description}</p>}
            <dl className="service-view-facts">
              <div><Icon name="clock" /><dt>Duración</dt><dd>{selected.durationMinutes} min</dd></div>
              <div><Icon name="briefcase" /><dt>Precio</dt><dd>{price.format(selected.priceArs)}</dd></div>
            </dl>
          </div>}
          {editor && <form id="service-editor" className="service-editor" aria-labelledby="service-panel-title" aria-busy={pending} onSubmit={submit} hidden={confirming}>
            <fieldset disabled={busy || confirming}>
              <label>Nombre del servicio<input ref={nameInput} name="name" required placeholder="Ej. Corte y peinado" defaultValue={editing?.name ?? ""} /></label>
              <label>Categoría<select name="categoryId" defaultValue={editing?.categoryId ?? ""}>
                <option value="">Sin categoría</option>
                {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select></label>
              <div className="service-form-grid">
                <label>Duración (minutos)<input name="durationMinutes" type="number" min="5" step="5" required defaultValue={editing?.durationMinutes ?? 15} title="Usá múltiplos de 5 minutos" /></label>
                <label>Precio (ARS)<input name="priceArs" type="number" min="0" step="any" required defaultValue={editing?.priceArs ?? 0} /></label>
              </div>
              <label>Descripción<textarea name="description" rows={3} placeholder="Descripción breve" defaultValue={editing?.description ?? ""} /></label>
              {editing && <div className="service-lifecycle">
                <button ref={statusButton} className="service-button" type="button" onClick={event => {
                  setLifecycleError("");
                  if (editing.status === "suspended") void lifecycle(editing, "active");
                  else { confirmationOpener.current = event.currentTarget; setConfirmation({ service: editing, action: "suspended" }); }
                }}><Icon name={editing.status === "active" ? "clock" : "check"} /> {editing.status === "active" ? "Pausar servicio" : "Reactivar servicio"}</button>
                <button className="service-button service-danger" type="button" onClick={event => {
                  confirmationOpener.current = event.currentTarget; setLifecycleError(""); setConfirmation({ service: editing, action: "retire" });
                }}><Icon name="trash" /> Retirar</button>
              </div>}
            </fieldset>
            {(error || lifecycleError) && !confirming && <p className="service-error" role="alert">{error || lifecycleError}</p>}
            {notice && <p className="service-notice" role="status">{notice}</p>}
          </form>}
          {panel === "categories" && <div hidden={confirming}>
            <ul className="service-category-list">{categories.map(category => <li key={category.id}><span>{category.name}</span>
              <button type="button" aria-label={`Eliminar categoría ${category.name}`} disabled={busy} onClick={event => {
                confirmationOpener.current = event.currentTarget; setCategoryError(""); setCategoryConfirmation(category);
              }}><Icon name="trash" /></button>
            </li>)}</ul>
            {!categories.length && <p>No hay categorías todavía.</p>}
            <form aria-label="Crear categoría" aria-busy={pending} onSubmit={event => {
              event.preventDefault();
              const form = event.currentTarget;
              const name = String(new FormData(form).get("categoryName") ?? "").trim();
              if (name) void categoryAction({ kind: "create", name }, form);
            }}>
              <fieldset className="service-category-add" disabled={busy || confirming}>
                <input ref={categoryInput} name="categoryName" required placeholder="Nueva categoría" aria-label="Nueva categoría" />
                <button className="service-button service-primary" type="submit"><Icon name="plus" /> Agregar</button>
              </fieldset>
              {!confirming && categoryError && <p className="service-error" role="alert">{categoryError}</p>}
              {categoryNotice && <p className="service-notice" role="status">{categoryNotice}</p>}
            </form>
          </div>}
          {confirmation && <section aria-label="Confirmar acción" aria-busy={pending}>
            <p>{confirmation.action === "retire"
              ? "Quedará oculto del catálogo. El historial se conserva. El retiro puede estar bloqueado por turnos futuros."
              : "No se ofrecerá para nuevos turnos. No cancela los turnos existentes."}</p>
            {lifecycleError && <p className="service-error" role="alert">{lifecycleError}</p>}
          </section>}
          {categoryConfirmation && <section aria-label="Confirmar eliminación de categoría" aria-busy={pending}>
            <p>Los servicios se conservan y quedan sin categoría.</p>
            {categoryError && <p className="service-error" role="alert">{categoryError}</p>}
          </section>}
        </div>
        <footer key={confirming ? "confirm" : panel} className="service-panel-footer">
          {confirming ? <>
            <button ref={cancelButton} className="service-button" type="button" disabled={busy} onClick={closePanel}>Cancelar</button>
            <button className="service-button service-danger" type="button" disabled={busy} onClick={() => {
              if (confirmation) void lifecycle(confirmation.service, confirmation.action);
              else if (categoryConfirmation) void categoryAction({ kind: "delete", id: categoryConfirmation.id });
            }}>{categoryConfirmation ? "Confirmar eliminación" : confirmation?.action === "retire" ? "Confirmar retiro" : "Confirmar suspensión"}</button>
          </> : panel === "categories" ? <button className="service-button service-primary" type="button" disabled={busy} onClick={closePanel}>Listo</button>
            : panel === "detail" ? <>
              <button className="service-button" type="button" disabled={busy} onClick={closePanel}>Cerrar</button>
              <button className="service-button service-primary" type="button" disabled={busy || !selected} onClick={() => { setError(""); setPanel("edit"); }}><Icon name="pencil" /> Editar servicio</button>
            </> : <>
              <button className="service-button" type="button" disabled={busy} onClick={() => { if (editing) setPanel("detail"); else closePanel(); }}>Cancelar</button>
              <button className="service-button service-primary" type="submit" form="service-editor" disabled={busy || (panel === "edit" && !editing)}><Icon name="check" /> {pending ? "Guardando…" : "Guardar servicio"}</button>
            </>}
        </footer></>}
      </dialog>
    </main>
  );
}
