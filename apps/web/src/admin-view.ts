import { createElement } from "react";
import { LivePanel } from "./live-panel";
export const AdminView = () => createElement(LivePanel, { mode: "admin" });

export type AdminRole = "platform_admin" | "business_user";
export interface BusinessProjection { id: string; name: string; status: "active" | "suspended"; assistantStatus: "active" | "inactive"; whatsappStatus: "connected" | "disconnected" | "link_required" | "error"; createdAt: string; lastTechnicalActivityAt: string | null; }
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
const label = { active: "Activo", inactive: "Inactivo", suspended: "Suspendido", connected: "Conectado", disconnected: "Desconectado", link_required: "Requiere vinculación", error: "Error" } as const;

export function renderAdminDashboard(role: AdminRole, businesses: readonly BusinessProjection[]): string {
  if (role !== "platform_admin") return '<main><p role="alert">No tenés acceso al panel administrativo.</p></main>';
  const rows = businesses.map((business) => `<tr><td>${escapeHtml(business.name)}</td><td>${label[business.status]}</td><td>${label[business.assistantStatus]}</td><td>${label[business.whatsappStatus]}</td><td>${escapeHtml(business.createdAt)}</td><td>${escapeHtml(business.lastTechnicalActivityAt ?? "Sin actividad")}</td></tr>`).join("");
  return `<main><h1>Negocios</h1><p>Supervisión operativa sin acceso a conversaciones ni secretos.</p><table><thead><tr><th>Nombre</th><th>Negocio</th><th>Asistente</th><th>WhatsApp</th><th>Creación</th><th>Última actividad</th></tr></thead><tbody>${rows}</tbody></table></main>`;
}
