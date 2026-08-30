import { createElement } from "react";
import { LivePanel } from "./live-panel";
export const WhatsAppView = () => createElement(LivePanel, { mode: "whatsapp" });

type PanelInput = {
  access: "active" | "suspended";
  status: "connected" | "disconnected" | "link_required" | "error";
  qr: string | null;
  error?: string;
};

const labels: Record<PanelInput["status"], string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
  link_required: "Requiere vinculación",
  error: "Error de conexión",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

export function renderWhatsAppPanel(input: PanelInput): string {
  if (input.access === "suspended") {
    return '<main><h1>WhatsApp</h1><p role="alert">Tu sesión no está disponible porque el negocio está suspendido.</p><a href="/">Iniciar sesión</a></main>';
  }
  const error = input.error ? `<p role="alert">${escapeHtml(input.error)}</p>` : "";
  const qr = input.qr ? `<section aria-label="Código temporal"><code>${escapeHtml(input.qr)}</code><p>Este código temporal expira en pocos minutos.</p></section>` : "";
  const disabled = input.status === "connected" ? " disabled" : "";
  return `<main><h1>WhatsApp</h1><p role="status">${labels[input.status]}</p>${error}${qr}<button type="button"${disabled}>Vincular WhatsApp</button></main>`;
}
