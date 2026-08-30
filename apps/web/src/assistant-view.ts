import { createElement } from "react";
import { LivePanel } from "./live-panel";
export const AssistantView = () => createElement(LivePanel, { mode: "assistant" });
export function renderAssistantStatus(active: boolean): string { return `<main><h1>Asistente</h1><p role="status">${active ? "Activo" : "Inactivo"}</p><p>Los horarios son contexto informativo; un asistente activo opera las 24 horas.</p></main>`; }
