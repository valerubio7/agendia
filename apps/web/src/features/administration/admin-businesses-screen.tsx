"use client";

import { useRef, useState } from "react";
import type { Business, Registration, ResponseTiming } from "../../api/api-client";
// The domain barrel also exports server-only administration code.
import { MAX_REPLY_DELAY_SECONDS, MAX_INACTIVITY_RESET_SECONDS, ReplyPacingSchema } from "../../../../../packages/domain/src/messaging/reply-pacing.ts";

type AdminBusinessesScreenProps = {
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

type PendingAction =
  | { kind: "instructions" }
  | { kind: "registration"; registrationId: string }
  | { kind: "status"; businessId: string }
  | { kind: "delete"; businessId: string };

const timestampFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
  hourCycle: "h23",
});

function formatTimestamp(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : timestampFormatter.format(date);
}

export const formatActivityTimestamp = (value: string | null) =>
  formatTimestamp(value, "Sin actividad");

const formatCreatedTimestamp = (value: string) =>
  formatTimestamp(value, "Fecha no disponible");

const businessStatusLabels: Record<Business["status"], string> = {
  active: "Activo",
  suspended: "Suspendido",
};
const agentStatusLabels: Record<Business["agentStatus"], string> = {
  active: "Activo",
  inactive: "Inactivo",
};
const whatsappStatusLabels: Record<Business["whatsappStatus"], string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
  link_required: "Requiere vinculación",
  error: "Error de conexión",
};

export function AdminBusinessesScreen({
  businesses, responseTiming, saveResponseTimingAction, notice, error,
  refreshWarning, refreshPending, retryRefreshAction, registrations, decideAction,
  setStatusAction, deleteBusinessAction,
}: AdminBusinessesScreenProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [failedAction, setFailedAction] = useState<PendingAction | null>(null);
  const [instructionsValidationError, setInstructionsValidationError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Business["status"]>("all");
  const [workspace, setWorkspace] = useState<"businesses" | "ai">("businesses");
  const pendingRef = useRef(false);
  const anyPending = pendingAction !== null || refreshPending;
  const activeCount = businesses.filter(business => business.status === "active").length;
  const suspendedCount = businesses.filter(business => business.status === "suspended").length;
  const matchesFilter = (business: Business) =>
    (statusFilter === "all" || business.status === statusFilter) &&
    business.name.toLocaleLowerCase("es-AR").includes(query.trim().toLocaleLowerCase("es-AR"));
  const visibleBusinesses = businesses.filter(matchesFilter);

  const runAction = async (action: PendingAction, work: () => Promise<boolean>) => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setFailedAction(null);
    setPendingAction(action);
    try {
      const succeeded = await work();
      setFailedAction(succeeded ? null : action);
      return succeeded;
    } finally {
      pendingRef.current = false;
      setPendingAction(null);
    }
  };
  const changeStatus = async (business: Business) => {
    const nextStatus = business.status === "active" ? "suspended" : "active";
    await runAction({ kind: "status", businessId: business.id }, () => setStatusAction(business.id, nextStatus));
  };

  return (
    <main className="admin-screen" data-ui="admin-screen">
      <header className="admin-page-heading">
        <h1>Administración</h1>
      </header>
      <div className="admin-workspaces" role="tablist" aria-label="Espacios de administración"
        onKeyDown={event => {
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = tabs.indexOf(event.target as HTMLButtonElement);
          if (current < 0) return;
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
            : event.key === "ArrowRight" ? (current + 1) % tabs.length
            : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length : -1;
          if (next < 0) return;
          event.preventDefault();
          tabs[next]?.click();
          tabs[next]?.focus();
        }}>
        <button id="admin-businesses-tab" role="tab" type="button" aria-selected={workspace === "businesses"}
          aria-controls="admin-businesses-panel" tabIndex={workspace === "businesses" ? 0 : -1}
          onClick={() => setWorkspace("businesses")}>Negocios</button>
        <button id="admin-ai-tab" role="tab" type="button" aria-selected={workspace === "ai"}
          aria-controls="admin-ai-panel" tabIndex={workspace === "ai" ? 0 : -1}
          onClick={() => setWorkspace("ai")}>Configuración de IA</button>
      </div>

      <div className="admin-feedback" aria-label="Estado de la operación">
        {notice && <p role="status">{notice}</p>}
        {refreshWarning && <>
          <p role="alert">No se pudo actualizar la información. Reintentá solo la consulta.</p>
          <button type="button" disabled={anyPending} onClick={retryRefreshAction}>Reintentar consulta</button>
        </>}
      </div>

      <section id="admin-businesses-panel" className="admin-workspace" role="tabpanel" aria-labelledby="admin-businesses-tab" hidden={workspace !== "businesses"}>
      <div className="admin-section-heading admin-directory-title">
        <div><h2>Negocios <span className="admin-count">{businesses.length}</span></h2>
          <p>{businesses.length === 1 ? "1 negocio registrado" : `${businesses.length} negocios registrados`}</p></div>
      </div>
      <section aria-labelledby="registration-title">
        <h2 id="registration-title">Solicitudes pendientes</h2>
        {registrations === null ? <p>No se pudieron cargar las solicitudes pendientes.</p> : registrations.length === 0 ? <p>No hay solicitudes pendientes.</p> : <ul>{registrations.map(row => <li key={row.id}>
          <p><strong>{row.name}</strong> · {row.email} · {formatCreatedTimestamp(row.createdAt)} UTC</p>
          <button type="button" disabled={anyPending} aria-label={`Aprobar ${row.name}`} onClick={() => void runAction({ kind: "registration", registrationId: row.id }, () => decideAction(row.id, "approve"))}>Aprobar</button>{" "}
          <button type="button" disabled={anyPending} aria-label={`Rechazar ${row.name}`} onClick={() => void runAction({ kind: "registration", registrationId: row.id }, () => decideAction(row.id, "reject"))}>Rechazar</button>
          {failedAction?.kind === "registration" && failedAction.registrationId === row.id && error && <p role="alert">{error}</p>}
        </li>)}</ul>}
      </section>

      <section className="admin-inventory" data-ui="admin-inventory" aria-labelledby="admin-inventory-title">
        <h2 id="admin-inventory-title" className="admin-visually-hidden">Directorio de negocios</h2>
        <div className="admin-toolbar">
          <label className="admin-search">Buscar negocio
            <input type="search" value={query} onChange={event => setQuery(event.target.value)} disabled={anyPending} placeholder="Buscar por nombre…" />
          </label>
          <label className="admin-filter">Estado operativo
            <select value={statusFilter} disabled={anyPending} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}>
              <option value="all">Todos ({businesses.length})</option>
              <option value="active">Activos ({activeCount})</option>
              <option value="suspended">Suspendidos ({suspendedCount})</option>
            </select>
          </label>
        </div>
        <p className="admin-results" role="status">{visibleBusinesses.length} de {businesses.length} negocios</p>
        <div className="admin-directory-heading admin-directory-grid" aria-hidden="true">
          <span>Negocio</span><span>Operación</span><span>Agente</span><span>WhatsApp</span><span>Gestión</span>
        </div>
        <ul className="admin-directory">
          {businesses.map(business => {
            const rowPending = pendingAction !== null && "businessId" in pendingAction && pendingAction.businessId === business.id;
            const rowFailure = failedAction !== null && "businessId" in failedAction && failedAction.businessId === business.id ? failedAction : null;
            return <li key={business.id} hidden={!matchesFilter(business)}>
              <details className="admin-management">
                <summary className="admin-directory-grid">
                  <strong className="admin-business-name">{business.name}</strong>
                  <span className="admin-directory-state"><small>Operación</small><span className={`admin-status admin-status--business-${business.status}`}>{businessStatusLabels[business.status]}</span></span>
                  <span className="admin-directory-state"><small>Agente</small><span className={`admin-status admin-status--agent-${business.agentStatus}`}>{agentStatusLabels[business.agentStatus]}</span></span>
                  <span className="admin-directory-state"><small>WhatsApp</small><span className={`admin-status admin-status--whatsapp-${business.whatsappStatus}`}>{whatsappStatusLabels[business.whatsappStatus]}</span></span>
                  <span className="admin-manage-label">Gestionar <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></span>
                </summary>
                <div className="admin-management__panel">
                  <div className="admin-access-action">
                    <div><h3>Estado operativo</h3><p>Este negocio está <strong>{business.status === "active" ? "activo" : "suspendido"}</strong>.</p></div>
                    <button className={business.status === "active" ? "admin-danger" : ""} type="button" disabled={anyPending} onClick={() => void changeStatus(business)}>
                      {rowPending && pendingAction.kind === "status" ? business.status === "active" ? "Suspendiendo…" : "Reactivando…" : business.status === "active" ? "Suspender" : "Reactivar"}
                    </button>
                  </div>
                  <button className="admin-danger" type="button" disabled={anyPending} aria-label={`Eliminar ${business.name}`}
                    onClick={() => {
                      if (pendingRef.current || !window.confirm(`¿Eliminar ${business.name}? Esta acción es irreversible y borrará los datos del negocio del sistema activo. El historial de auditoría y las copias anteriores pueden conservar datos. Los mensajes ya entregados fuera de Agendia no se borrarán.`)) return;
                      void runAction({ kind: "delete", businessId: business.id }, () => deleteBusinessAction(business.id));
                    }}>
                    {rowPending && pendingAction.kind === "delete" ? "Eliminando…" : "Eliminar"}
                  </button>
                  <dl className="admin-technical-details">
                    <div><dt>Alta · UTC</dt><dd>{formatCreatedTimestamp(business.createdAt)}</dd></div>
                    <div><dt>Última actividad técnica · UTC</dt><dd>{formatActivityTimestamp(business.lastTechnicalActivityAt)}</dd></div>
                  </dl>
                  {rowFailure && error && <div className="admin-context-error" role="alert">
                    <strong>{rowFailure.kind === "delete" ? `No se pudo eliminar ${business.name}.` : `No se pudo actualizar el estado de ${business.name}.`}</strong>
                    <span>{error}</span>
                  </div>}
                </div>
              </details>
            </li>;
          })}
        </ul>
        {visibleBusinesses.length === 0 && <div className="admin-empty">
          <h3>{businesses.length === 0 ? "Tu primer negocio empieza acá" : "No hay negocios con estos filtros"}</h3>
          <p>{businesses.length === 0 ? "Los negocios aparecen al aprobar solicitudes." : "Probá con otro nombre o volvé a ver el directorio completo."}</p>
          {businesses.length > 0 && <button className="admin-secondary" type="button" disabled={anyPending} onClick={() => { setQuery(""); setStatusFilter("all"); }}>Limpiar filtros</button>}
        </div>}
      </section>

      </section>

      <section id="admin-ai-panel" className="admin-workspace admin-instructions" role="tabpanel" aria-labelledby="admin-ai-tab" hidden={workspace !== "ai"}>
        <div className="admin-directory-title"><h2>Configuración de IA</h2><p>Tiempos de respuesta para todos los negocios.</p></div>
        <form onSubmit={async event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const parsed = ReplyPacingSchema.safeParse(Object.fromEntries(
            ["initialDelaySeconds", "activeDelaySeconds", "inactivityResetSeconds"].map(key => {
              const value = form.get(key);
              return [key, value === null || value === "" ? NaN : Number(value)];
            }),
          ));
          setInstructionsValidationError(parsed.success ? "" : "Ingresá tiempos enteros dentro de los límites indicados.");
          if (!parsed.success) return;
          await runAction({ kind: "instructions" }, () => saveResponseTimingAction(parsed.data));
        }} aria-busy={pendingAction?.kind === "instructions"}>
          <fieldset className="admin-pacing">
            <legend>Tiempos de respuesta para todos los negocios</legend>
            <p>Las esperas se expresan en segundos. Cero significa respuesta inmediata. Los cambios no modifican las esperas ya programadas.</p>
            <div className="admin-pacing__fields">
              <label>Espera inicial (segundos)
                <input name="initialDelaySeconds" type="number" required min={0} max={MAX_REPLY_DELAY_SECONDS} step={1} defaultValue={responseTiming.responseTiming.initialDelaySeconds} disabled={anyPending} aria-describedby="platform-initial-help" />
                <small id="platform-initial-help">Antes de la primera respuesta o después de un período de inactividad. Entre 0 y 86400 segundos.</small>
              </label>
              <label>Espera activa (segundos)
                <input name="activeDelaySeconds" type="number" required min={0} max={MAX_REPLY_DELAY_SECONDS} step={1} defaultValue={responseTiming.responseTiming.activeDelaySeconds} disabled={anyPending} aria-describedby="platform-active-help" />
                <small id="platform-active-help">Durante una conversación en curso. Entre 0 y 86400 segundos.</small>
              </label>
              <label>Reinicio por inactividad (segundos)
                <input name="inactivityResetSeconds" type="number" required min={1} max={MAX_INACTIVITY_RESET_SECONDS} step={1} defaultValue={responseTiming.responseTiming.inactivityResetSeconds} disabled={anyPending} aria-describedby="platform-inactivity-help" />
                <small id="platform-inactivity-help">Si la inactividad supera este tiempo, vuelve a aplicarse la espera inicial. Entre 1 y 604800 segundos.</small>
              </label>
            </div>
          </fieldset>
          <div className="admin-form-footer">
            <div className="admin-save-feedback">
              {notice && <p>{notice}</p>}
              {instructionsValidationError && <p role="alert">{instructionsValidationError}</p>}
              {failedAction?.kind === "instructions" && <p role="alert">{error}</p>}
            </div>
            <button type="submit" disabled={anyPending}>{pendingAction?.kind === "instructions" ? "Guardando…" : "Guardar configuración"}</button>
          </div>
        </form>
      </section>
    </main>
  );
}
