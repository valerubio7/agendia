"use client";

import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Business, Registration, ResponseTiming } from "../../api/api-client";
import { useOutsideDismiss } from "../../components/dialog-dismiss";
import { MAX_REPLY_DELAY_SECONDS, MAX_INACTIVITY_RESET_SECONDS, ReplyPacingSchema } from "../../../../../packages/domain/src/messaging/reply-pacing.ts";
import { AdminIcon } from "./admin-icons";

type Props = {
  businesses: Business[];
  responseTiming: ResponseTiming;
  saveResponseTimingAction: (timing: ResponseTiming["responseTiming"]) => Promise<boolean>;
  notice: string;
  error: string;
  refreshWarning: boolean;
  refreshPending: boolean;
  retryRefreshAction: () => void;
  registrations: Registration[] | null;
  decideAction: (id: string, decision: "approve" | "reject") => Promise<boolean>;
  setStatusAction: (id: string, status: "active" | "suspended") => Promise<boolean>;
  deleteBusinessAction: (id: string) => Promise<boolean>;
};

type View = { kind: "request" | "business"; id: string } | { kind: "timing" };
type Confirmation = { title: string; text: string; label: string; danger: boolean; action: () => Promise<boolean> };
const timestampFormatter = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC", hourCycle: "h23" });
function timestamp(value: string | null, fallback: string) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? timestampFormatter.format(date) : fallback;
}
export const formatActivityTimestamp = (value: string | null) => timestamp(value, "Sin actividad");
const formatCreated = (value: string) => timestamp(value, "Fecha no disponible");
const labels = { active: "Activo", suspended: "Suspendido", inactive: "Inactivo", connected: "Conectado", disconnected: "Desconectado", link_required: "Sin vincular", error: "Error" };
function Status({ value, operation = false }: { value: keyof typeof labels; operation?: boolean }) {
  return <span className={`adm-status${operation ? ` admin-status--business-${value}` : ""}`} data-status={value}>{labels[value]}</span>;
}
function Avatar({ name, warm = false }: { name: string; warm?: boolean }) {
  return <span className={`adm-avatar${warm ? " coral" : ""}`} aria-hidden="true">{name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join("").toUpperCase()}</span>;
}
function Meta({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="adm-modal-meta">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
const timingFields = [
  ["initialDelaySeconds", "Espera inicial", 0, MAX_REPLY_DELAY_SECONDS, "Antes de la primera respuesta o después de un período de inactividad."],
  ["activeDelaySeconds", "Espera activa", 0, MAX_REPLY_DELAY_SECONDS, "Durante una conversación en curso."],
  ["inactivityResetSeconds", "Reinicio por inactividad", 1, MAX_INACTIVITY_RESET_SECONDS, "Si la inactividad supera este tiempo, vuelve a aplicarse la espera inicial."],
] as const;
function timingValue(seconds: number) {
  if (seconds === 0) return "Inmediata";
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function AdminBusinessesScreen(props: Props) {
  const path = usePathname();
  return <AdminScreenContent {...props} section={path === "/solicitudes" ? "requests" : path === "/ajustes" ? "settings" : "businesses"} />;
}

export function AdminScreenContent({ section, businesses, responseTiming, saveResponseTimingAction, notice, error, refreshWarning, refreshPending,
  retryRefreshAction, registrations, decideAction, setStatusAction, deleteBusinessAction }: Props & { section: "requests" | "businesses" | "settings" }) {
  const [view, setView] = useState<View | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Business["status"]>("all");
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const safeAction = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const busy = pending || refreshPending;
  const request = view?.kind === "request" ? registrations?.find(row => row.id === view.id) : undefined;
  const business = view?.kind === "business" ? businesses.find(row => row.id === view.id) : undefined;
  const timing = responseTiming.responseTiming;
  const active = businesses.filter(row => row.status === "active").length;
  const visible = businesses.filter(row => (filter === "all" || row.status === filter) && row.name.toLocaleLowerCase("es-AR").includes(query.trim().toLocaleLowerCase("es-AR")));
  const filters = [["all", "Todos", businesses.length], ["active", "Activos", active], ["suspended", "Suspendidos", businesses.length - active]] as const;
  const opened = view !== null || confirmation !== null;
  useLayoutEffect(() => {
    if (!opened) return;
    const element = dialog.current!;
    if (!element.open) element.showModal();
    safeAction.current?.focus();
  }, [opened, confirmation]);

  function begin(target: HTMLElement, details: View | null, next: Confirmation | null = null) {
    opener.current = target;
    setFailure("");
    setView(details);
    setConfirmation(next);
  }
  function close() {
    dialog.current?.close();
    setConfirmation(null);
    setView(null);
    opener.current?.focus();
    if (!opener.current?.isConnected || document.activeElement !== opener.current) heading.current?.focus();
  }
  async function run(action: () => Promise<boolean>, message: string) {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setPending(true);
    setFailure("");
    try {
      if (await action()) close();
      else setFailure(message);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  function decide(row: Registration, decision: "approve" | "reject"): Confirmation {
    const approve = decision === "approve";
    return { title: approve ? "¿Aprobar solicitud?" : "¿Rechazar solicitud?", label: approve ? "Aprobar solicitud" : "Rechazar solicitud", danger: !approve,
      text: approve ? `Se creará el negocio ${row.name} y se habilitará el acceso con el correo registrado.` : `La solicitud de ${row.name} será rechazada.`,
      action: () => decideAction(row.id, decision) };
  }
  function changeStatus(row: Business): Confirmation {
    const suspend = row.status === "active";
    return { title: suspend ? "¿Suspender este negocio?" : "¿Reactivar este negocio?", label: suspend ? "Suspender negocio" : "Reactivar negocio", danger: suspend,
      text: suspend ? `Se bloqueará la operación de ${row.name} hasta que se reactive. Sus datos se conservarán.` : `${row.name} volverá a operar con sus datos existentes.`,
      action: () => setStatusAction(row.id, suspend ? "suspended" : "active") };
  }
  function remove(row: Business): Confirmation {
    return { title: "Eliminar negocio definitivamente", label: "Eliminar definitivamente", danger: true,
      text: `Esta acción es irreversible y borrará los datos de ${row.name} del sistema activo. El historial de auditoría y las copias anteriores pueden conservar datos. Los mensajes ya entregados fuera de Agendia no se borrarán.`,
      action: () => deleteBusinessAction(row.id) };
  }
  function saveTiming(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = ReplyPacingSchema.safeParse(Object.fromEntries(timingFields.map(([key]) => {
      const value = form.get(key);
      return [key, value === null || value === "" ? NaN : Number(value)];
    })));
    if (!parsed.success) setFailure("Ingresá tiempos enteros dentro de los límites indicados.");
    else void run(() => saveResponseTimingAction(parsed.data), "No se pudieron guardar los tiempos.");
  }
  const title = section === "requests" ? "Solicitudes pendientes" : section === "settings" ? "Ajustes" : "Negocios";
  const dialogTitle = confirmation?.title ?? (view?.kind === "request" ? "Solicitud de alta" : view?.kind === "business" ? "Información del negocio" : "Tiempos de respuesta");
  const dismiss = () => {
    if (!inFlight.current && confirmation && view) { setFailure(""); setConfirmation(null); }
    else close();
  };
  const backdrop = useOutsideDismiss(dismiss);

  return <main className={`adm-app adm-${section}`} data-ui="admin-screen">
    <header className="adm-titlebar"><div><h1 ref={heading} tabIndex={-1}>{title}</h1>
      {section === "businesses" && <p>Cuentas registradas y estado operativo</p>}</div>
      {section === "requests" && registrations !== null && <span className="adm-count-pill">{registrations.length} {registrations.length === 1 ? "pendiente" : "pendientes"}</span>}
    </header>
    <div className="admin-feedback" aria-label="Estado de la operación">
      {notice && <p role="status">{notice}</p>}
      {!opened && pending && <p role="status">Procesando…</p>}
      {!opened && failure && <p role="alert">{error || failure}</p>}
      {refreshWarning && <><p role="alert">No se pudo actualizar la información. Reintentá solo la consulta.</p>
        <button type="button" disabled={busy} onClick={retryRefreshAction}>Reintentar consulta</button></>}
    </div>

    {section === "requests" && <section className="adm-review-sheet" aria-label="Solicitudes pendientes">
      {registrations?.length ? registrations.map(row => <div className="adm-review-row" key={row.id}>
        <button className="adm-review-person" type="button" aria-label={`Ver solicitud de ${row.name}`} disabled={busy}
          onClick={event => begin(event.currentTarget, { kind: "request", id: row.id })}>
          <Avatar name={row.name} warm /><span><strong>{row.name}</strong><small>{row.email}</small></span>
        </button><time className="adm-review-date" dateTime={row.createdAt}>{formatCreated(row.createdAt)} UTC</time>
        <div className="adm-review-actions">
          <button type="button" className="danger" aria-label={`Rechazar ${row.name}`} disabled={busy} onClick={event => begin(event.currentTarget, null, decide(row, "reject"))}>Rechazar</button>
          <button type="button" className="primary" aria-label={`Aprobar ${row.name}`} disabled={busy} onClick={event => begin(event.currentTarget, null, decide(row, "approve"))}><AdminIcon name="check" />Aprobar</button>
        </div>
      </div>) : <div className="adm-review-empty"><AdminIcon name={registrations === null ? "alert" : "check"} />
        <strong>{registrations === null ? "No se pudieron cargar las solicitudes pendientes." : "No hay solicitudes pendientes"}</strong>
        {registrations !== null && <span>Las nuevas solicitudes aparecerán acá.</span>}</div>}
    </section>}

    {section === "businesses" && <section className="adm-inventory" data-ui="admin-inventory" aria-label="Directorio de negocios">
      <div className="adm-directory-tools"><div className="adm-filter-row" role="group" aria-label="Estado operativo">
        {filters.map(([id, label, count]) => <button type="button" key={id} disabled={busy} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label} ({count})</button>)}
      </div><label className="adm-search"><AdminIcon name="search" /><input aria-label="Buscar negocio" placeholder="Buscar negocio" type="search" disabled={busy} value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <p className="adm-list-count" role="status">{visible.length} de {businesses.length} negocios</p>
      <div className="adm-table">
        <div className="adm-table-head" aria-hidden="true"><span>Negocio</span><span>Operación</span><span>Agente IA</span><span>WhatsApp</span><span /></div>
        <ul className="admin-directory" aria-label="Negocios registrados">
          {visible.map(row => <li key={row.id}><button className="adm-table-row" type="button" disabled={busy} aria-label={`Información del negocio: ${row.name}`}
            onClick={event => begin(event.currentTarget, { kind: "business", id: row.id })}>
            <span className="adm-table-person"><Avatar name={row.name} /><span><strong>{row.name}</strong><small className="adm-list-activity">{formatActivityTimestamp(row.lastTechnicalActivityAt)}{row.lastTechnicalActivityAt && " UTC"}</small></span></span>
            <span><Status value={row.status} operation /></span><span className="adm-table-extra"><Status value={row.agentStatus} /></span><span className="adm-table-extra"><Status value={row.whatsappStatus} /></span><AdminIcon name="arrow" />
          </button></li>)}
        </ul>
        {!visible.length && <div className="adm-empty"><AdminIcon name="search" /><strong>{businesses.length ? "Sin coincidencias" : "Aún no hay negocios"}</strong>
          <span>{businesses.length ? "Probá otra búsqueda o cambiá el filtro." : "Los negocios aparecen al aprobar solicitudes."}</span>
          {(query || filter !== "all") && <button type="button" disabled={busy} onClick={() => { setQuery(""); setFilter("all"); }}>Limpiar filtros</button>}</div>}
      </div>
    </section>}

    {section === "settings" && <section className="adm-settings-compact" aria-labelledby="adm-settings-heading">
      <header><div><h2 id="adm-settings-heading">Tiempos de respuesta</h2><p>Configuración global</p></div>
        <button type="button" disabled={busy} onClick={event => begin(event.currentTarget, { kind: "timing" })}><AdminIcon name="pencil" />Editar</button></header>
      <dl>{timingFields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{timingValue(timing[key])}</dd></div>)}</dl>
    </section>}

    {opened && <dialog ref={dialog} className={confirmation ? "adm-confirm" : "adm-dialog"} role={confirmation ? "alertdialog" : undefined}
      aria-labelledby="adm-dialog-title" aria-describedby={confirmation ? "adm-confirm-copy" : undefined} {...backdrop}
      onCancel={event => { event.preventDefault(); dismiss(); }}>
      {confirmation ? <>
        <div className={`adm-dialog-icon${confirmation.danger ? " coral" : ""}`}><AdminIcon name={confirmation.danger ? "alert" : "check"} /></div>
        <h2 id="adm-dialog-title">{dialogTitle}</h2><p id="adm-confirm-copy">{confirmation.text}</p>
      </> : <header className="adm-dialog-head"><span className={`adm-dialog-icon${request ? " coral" : ""}`}><AdminIcon name={request ? "users" : business ? "briefcase" : "sliders"} /></span>
        <h2 id="adm-dialog-title">{dialogTitle}</h2><button type="button" className="adm-dialog-close" ref={safeAction} aria-label="Cerrar" onClick={close}><AdminIcon name="x" /></button></header>}
      {!confirmation && <div className="adm-dialog-body">
        {(request || business) && <div className="adm-modal-intro"><Avatar name={(request ?? business)!.name} warm={!!request} /><div><strong>{(request ?? business)!.name}</strong>{request && <small>{request.email}</small>}</div></div>}
        {request && <><Meta rows={[["Estado", "En revisión"], ["Fecha de solicitud", `${formatCreated(request.createdAt)} UTC`]]} />
          <p className="adm-caption">Podés aprobar la solicitud para crear el negocio o rechazarla. Ambas decisiones requieren confirmación.</p></>}
        {business && <><Meta rows={[["Estado operativo", <Status value={business.status} operation />], ["Asistente IA", <Status value={business.agentStatus} />], ["WhatsApp", <Status value={business.whatsappStatus} />],
          ["Alta · UTC", formatCreated(business.createdAt)], ["Última actividad técnica · UTC", formatActivityTimestamp(business.lastTechnicalActivityAt)]]} />
          <div className="adm-danger-zone"><div><strong>Eliminar negocio</strong><p>Esta acción es irreversible y retira los datos activos. Se conserva la auditoría histórica.</p></div>
            <button type="button" className="danger" aria-label={`Eliminar ${business.name}`} disabled={busy} onClick={() => setConfirmation(remove(business))}><AdminIcon name="trash" />Eliminar</button></div></>}
        {view?.kind === "timing" && <form id="adm-timing-form" className="adm-timing-form" aria-busy={pending} onSubmit={saveTiming}>
          {timingFields.map(([key, label, min, max, help]) => <div className="adm-timing-input" key={key}>
            <label htmlFor={key}>{label} (s)</label>
            <input id={key} name={key} type="number" min={min} max={max} step={1} required defaultValue={timing[key]} disabled={busy} aria-describedby={`${key}-help`} />
            <small id={`${key}-help`}>{help} Entre {min} y {max} segundos.</small></div>)}
          <p className="adm-timing-note">Los valores se expresan en segundos. Cero significa respuesta inmediata. Los cambios no modifican las esperas ya programadas.</p>
        </form>}
      </div>}
      {failure && <p className="adm-dialog-error" role="alert">{failure}{error && error !== failure && ` ${error}`}</p>}
      <footer className="adm-dialog-footer">
        <button type="button" ref={confirmation ? safeAction : undefined} onClick={dismiss}>{!pending && (confirmation || view?.kind === "timing") ? "Cancelar" : "Cerrar"}</button>
        {confirmation ? <button type="button" className={confirmation.danger ? "danger-solid" : "primary"} disabled={busy} onClick={() => void run(confirmation.action, "No se pudo completar la operación.")}>
          {pending ? "Procesando…" : confirmation.label}</button> : <>
          {request && <><button type="button" className="danger" disabled={busy} onClick={() => setConfirmation(decide(request, "reject"))}>Rechazar</button>
            <button type="button" className="primary" disabled={busy} onClick={() => setConfirmation(decide(request, "approve"))}><AdminIcon name="check" />Aprobar</button></>}
          {business && <button type="button" className={business.status === "active" ? "danger" : "primary"} disabled={busy} onClick={() => setConfirmation(changeStatus(business))}>
            <AdminIcon name={business.status === "active" ? "block" : "check"} />{business.status === "active" ? "Suspender negocio" : "Reactivar negocio"}</button>}
          {view?.kind === "timing" && <button type="submit" form="adm-timing-form" className="primary" disabled={busy}><AdminIcon name="check" />{pending ? "Guardando…" : "Guardar cambios"}</button>}
        </>}
      </footer>
    </dialog>}
  </main>;
}
