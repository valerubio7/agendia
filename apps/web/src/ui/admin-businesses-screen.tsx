"use client";

import { useRef, useState, type FormEvent } from "react";
import type { Business } from "../api-client";

type CreateBusinessInput = {
  name: string;
  userEmail: string;
  initialPassword: string;
};

type AdminBusinessesScreenProps = {
  businesses: Business[];
  notice: string;
  error: string;
  createAction: (input: CreateBusinessInput) => Promise<boolean>;
  renameAction: (id: string, name: string) => Promise<boolean>;
  replacePasswordAction: (id: string, password: string) => Promise<boolean>;
  setStatusAction: (
    id: string,
    status: "active" | "suspended",
  ) => Promise<boolean>;
};

type PendingAction =
  | { kind: "create" }
  | { kind: "rename" | "password" | "status"; businessId: string };

const timestampFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
  hourCycle: "h23",
});

function formatTimestamp(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : timestampFormatter.format(date);
}

export const formatActivityTimestamp = (value: string | null) =>
  formatTimestamp(value, "Sin actividad");

const formatCreatedTimestamp = (value: string) =>
  formatTimestamp(value, "Fecha no disponible");

const businessStatusLabels: Record<Business["status"], string> = {
  active: "Activo",
  suspended: "Suspendido",
};

const assistantStatusLabels: Record<Business["assistantStatus"], string> = {
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
  businesses,
  notice,
  error,
  createAction,
  renameAction,
  replacePasswordAction,
  setStatusAction,
}: AdminBusinessesScreenProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [failedAction, setFailedAction] = useState<PendingAction | null>(null);
  const pendingRef = useRef(false);
  const anyPending = pendingAction !== null;

  const runAction = async (
    action: PendingAction,
    work: () => Promise<boolean>,
  ) => {
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

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const succeeded = await runAction({ kind: "create" }, () =>
      createAction({
        name: String(form.get("name")),
        userEmail: String(form.get("userEmail")),
        initialPassword: String(form.get("initialPassword")),
      }),
    );
    if (succeeded) formElement.reset();
  };

  const submitRename =
    (business: Business) => async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const succeeded = await runAction(
        { kind: "rename", businessId: business.id },
        () => renameAction(business.id, String(form.get("name"))),
      );
      if (succeeded) formElement.reset();
    };

  const submitPassword =
    (business: Business) => async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const succeeded = await runAction(
        { kind: "password", businessId: business.id },
        () => replacePasswordAction(business.id, String(form.get("password"))),
      );
      if (succeeded) formElement.reset();
    };

  const changeStatus = async (business: Business) => {
    const nextStatus = business.status === "active" ? "suspended" : "active";
    await runAction({ kind: "status", businessId: business.id }, () =>
      setStatusAction(business.id, nextStatus),
    );
  };

  return (
    <main className="admin-screen" data-ui="admin-screen">
      <section
        className="admin-hero"
        data-ui="admin-hero"
        aria-labelledby="admin-title"
      >
        <div className="admin-hero__copy">
          <p className="admin-hero__eyebrow">Operación de plataforma</p>
          <h1 id="admin-title">Cada negocio, bajo control.</h1>
          <p>
            Supervisá la operación de cada cuenta desde un registro central, sin
            acceder a conversaciones ni exponer secretos.
          </p>
        </div>

        <div
          className="admin-registry-map"
          aria-label="El registro organiza la supervisión por Negocio, Estado y Canales"
        >
          <header>
            <span>Registro operativo</span>
            <span aria-hidden="true">AG / IA</span>
          </header>
          <div className="admin-registry-map__track" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <ol>
            <li>
              <span>01</span>
              <strong>Negocio</strong>
              <small>Identidad registrada</small>
            </li>
            <li>
              <span>02</span>
              <strong>Estado</strong>
              <small>Acceso operativo</small>
            </li>
            <li>
              <span>03</span>
              <strong>Canales</strong>
              <small>Asistente y WhatsApp</small>
            </li>
          </ol>
        </div>
      </section>

      <div className="admin-feedback" aria-label="Estado de la operación">
        {notice && <p role="status">{notice}</p>}
      </div>

      <section
        className="admin-create"
        data-ui="admin-create"
        aria-labelledby="admin-create-title"
      >
        <header className="admin-section-heading">
          <div>
            <p>Alta controlada</p>
            <h2 id="admin-create-title">Incorporar un negocio</h2>
          </div>
          <span>01 / REGISTRO</span>
        </header>
        <form
          onSubmit={submitCreate}
          aria-busy={pendingAction?.kind === "create"}
        >
          <label>
            Nombre
            <input
              name="name"
              type="text"
              required
              maxLength={160}
              pattern={".*\\S.*"}
              title="Ingresá un nombre de hasta 160 caracteres que incluya al menos un carácter no vacío."
              disabled={anyPending}
            />
          </label>
          <label>
            Correo del usuario
            <input
              name="userEmail"
              type="email"
              required
              disabled={anyPending}
            />
          </label>
          <label>
            Contraseña inicial
            <input
              name="initialPassword"
              type="password"
              required
              minLength={16}
              disabled={anyPending}
            />
          </label>
          <button type="submit" disabled={anyPending}>
            {pendingAction?.kind === "create" ? "Creando…" : "Crear negocio"}
          </button>
        </form>
        {failedAction?.kind === "create" && error && (
          <div className="admin-context-error" role="alert">
            <strong>No se pudo crear el negocio.</strong>
            <span>{error}</span>
          </div>
        )}
      </section>

      <section
        className="admin-inventory"
        data-ui="admin-inventory"
        aria-labelledby="admin-inventory-title"
      >
        <header className="admin-section-heading">
          <div>
            <p>Directorio operativo</p>
            <h2 id="admin-inventory-title">Negocios registrados</h2>
          </div>
          <span>02 / INVENTARIO</span>
        </header>

        <div className="admin-table-frame">
          <table>
            <thead>
              <tr>
                <th scope="col">Negocio</th>
                <th scope="col">Operación</th>
                <th scope="col">Asistente</th>
                <th scope="col">WhatsApp</th>
                <th scope="col">Alta</th>
                <th scope="col">Última actividad técnica</th>
                <th scope="col">Gestión</th>
              </tr>
            </thead>
            <tbody>
              {businesses.length === 0 ? (
                <tr className="admin-table__empty">
                  <td colSpan={7}>Todavía no hay negocios registrados.</td>
                </tr>
              ) : (
                businesses.map((business) => {
                  const rowPending =
                    pendingAction !== null &&
                    "businessId" in pendingAction &&
                    pendingAction.businessId === business.id;
                  const statusPending =
                    rowPending && pendingAction.kind === "status";
                  const rowFailure =
                    failedAction !== null &&
                    "businessId" in failedAction &&
                    failedAction.businessId === business.id
                      ? failedAction
                      : null;
                  return (
                    <tr key={business.id}>
                      <td data-label="Negocio">
                        <strong className="admin-business-name">
                          {business.name}
                        </strong>
                      </td>
                      <td data-label="Operación">
                        <span
                          className={`admin-status admin-status--business-${business.status}`}
                        >
                          {businessStatusLabels[business.status]}
                        </span>
                      </td>
                      <td data-label="Asistente">
                        <span
                          className={`admin-status admin-status--assistant-${business.assistantStatus}`}
                        >
                          {assistantStatusLabels[business.assistantStatus]}
                        </span>
                      </td>
                      <td data-label="WhatsApp">
                        <span
                          className={`admin-status admin-status--whatsapp-${business.whatsappStatus}`}
                        >
                          {whatsappStatusLabels[business.whatsappStatus]}
                        </span>
                      </td>
                      <td data-label="Alta" className="admin-timestamp">
                        {formatCreatedTimestamp(business.createdAt)}
                      </td>
                      <td
                        data-label="Última actividad técnica"
                        className="admin-timestamp"
                      >
                        {formatActivityTimestamp(
                          business.lastTechnicalActivityAt,
                        )}
                      </td>
                      <td
                        data-label="Gestión"
                        className="admin-management-cell"
                      >
                        <details className="admin-management">
                          <summary>Gestionar</summary>
                          <div className="admin-management__panel">
                            <form
                              onSubmit={submitRename(business)}
                              aria-busy={
                                rowPending && pendingAction.kind === "rename"
                              }
                            >
                              <label>
                                Nombre de {business.name}
                                <input
                                  name="name"
                                  type="text"
                                  defaultValue={business.name}
                                  required
                                  maxLength={160}
                                  pattern={".*\\S.*"}
                                  title="Ingresá un nombre de hasta 160 caracteres que incluya al menos un carácter no vacío."
                                  disabled={anyPending}
                                />
                              </label>
                              <button type="submit" disabled={anyPending}>
                                {rowPending && pendingAction.kind === "rename"
                                  ? "Renombrando…"
                                  : "Renombrar"}
                              </button>
                            </form>
                            <form
                              onSubmit={submitPassword(business)}
                              aria-busy={
                                rowPending && pendingAction.kind === "password"
                              }
                            >
                              <label>
                                Nueva contraseña de {business.name}
                                <input
                                  name="password"
                                  type="password"
                                  required
                                  minLength={16}
                                  disabled={anyPending}
                                />
                              </label>
                              <button type="submit" disabled={anyPending}>
                                {rowPending && pendingAction.kind === "password"
                                  ? "Actualizando…"
                                  : "Cambiar contraseña"}
                              </button>
                            </form>
                            <button
                              className="admin-management__status-action"
                              type="button"
                              disabled={anyPending}
                              onClick={() => void changeStatus(business)}
                            >
                              {statusPending
                                ? business.status === "active"
                                  ? "Suspendiendo…"
                                  : "Reactivando…"
                                : business.status === "active"
                                  ? "Suspender"
                                  : "Reactivar"}
                            </button>
                            {rowFailure && error && (
                              <div className="admin-context-error" role="alert">
                                <strong>
                                  {rowFailure.kind === "rename"
                                    ? `No se pudo renombrar ${business.name}.`
                                    : rowFailure.kind === "password"
                                      ? `No se pudo cambiar la contraseña de ${business.name}.`
                                      : `No se pudo actualizar el estado de ${business.name}.`}
                                </strong>
                                <span>{error}</span>
                              </div>
                            )}
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
