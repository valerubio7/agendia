import type { ReactNode } from "react";
import type { WhatsAppStatus } from "../../api/api-client";
import { IntegrationIcon, IntegrationPanel } from "../agent-settings/integration-panel";
import { resolveWhatsAppStatusView } from "./whatsapp-status";
import "./whatsapp-screen.css";

type WhatsAppScreenProps = {
  status: WhatsAppStatus | null | undefined;
  feedback: ReactNode;
  qrDataUrl: string | null;
  linking: boolean;
  linkAction: () => void;
};

const steps = ["Abrí WhatsApp en tu teléfono.", "Entrá en Dispositivos vinculados.", "Escaneá el código QR para vincular tu cuenta."];
const whatsappDateFormatter = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" });

function formatWhatsAppDate(value?: string | null) {
  if (!value) return "Sin registrar";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Sin registrar" : whatsappDateFormatter.format(date);
}

export function WhatsAppScreen(props: WhatsAppScreenProps) {
  return <IntegrationPanel kind="whatsapp">{() => <WhatsAppPanelContent {...props} />}</IntegrationPanel>;
}

export function WhatsAppPanelContent({ status, feedback, qrDataUrl, linking, linkAction }: WhatsAppScreenProps) {
  const view = resolveWhatsAppStatusView(status?.status);
  const connected = view.key === "connected";
  const pending = linking || view.key === "linking";
  const number = status?.linkedNumber?.trim();
  const offline = view.key === "link_required" || view.key === "disconnected";
  const title = connected ? "WhatsApp conectado" : pending ? "Listo para vincular" : offline ? "Sin conexión" : view.label;
  const summary = connected ? <bdi>{number || "Número no informado por WhatsApp"}</bdi>
    : qrDataUrl ? "Esperando que escanees el código"
      : linking ? "Preparando el código temporal" : offline ? "Vinculá tu número para atender desde el asistente" : view.explanation;
  const buttonLabel = !view.known ? "Estado no disponible" : connected ? "WhatsApp vinculado" : linking ? "Esperando conexión…" : "Vincular WhatsApp";

  return <div className="integration-body">
    <hr />
    <div className="wa-panel-status" data-ui="whatsapp-status" data-status={view.key}>
      <span className="wa-panel-symbol"><IntegrationIcon name={connected ? "check" : "message"} /></span>
      <span className="wa-panel-summary"><strong>{title}</strong><span>{summary}</span></span>
      <span className="wa-panel-indicator" role="status">{view.label}</span>
    </div>
    <div data-ui="whatsapp-link-panel">
      {connected ? <p className="wa-panel-note"><IntegrationIcon name="check" />La línea está vinculada y disponible para el asistente cuando esté activo.</p> : <>
        <ol className="wa-panel-steps" aria-label="Pasos para vincular" role="list">
          {steps.map((step, index) => <li key={step}><b aria-hidden="true">{index + 1}</b>{step}</li>)}
        </ol>
        {qrDataUrl && <figure className="wa-panel-qr">
          <img src={qrDataUrl} width={140} height={140} alt="Código QR temporal de WhatsApp" />
          <figcaption><strong>Código QR temporal</strong><span>Escanealo desde Dispositivos vinculados de WhatsApp.</span></figcaption>
        </figure>}
      </>}
      {(connected || number || status?.linkedAt || status?.lastConnectedAt) && <details className="wa-panel-metadata">
        <summary>Información del vínculo</summary>
        <dl data-ui="whatsapp-metadata">
          <div><dt>Número vinculado</dt><dd><bdi>{number || "No informado por WhatsApp"}</bdi></dd></div>
          <div><dt>Vinculado desde</dt><dd>{formatWhatsAppDate(status?.linkedAt)}</dd></div>
          <div><dt>Última conexión</dt><dd>{formatWhatsAppDate(status?.lastConnectedAt)}</dd></div>
        </dl>
      </details>}
      <div className="wa-panel-lower">
        <div className="wa-panel-annotation">
          <small>{connected ? "Canal verificado por WhatsApp." : "El QR es temporal y no expone credenciales persistentes."}</small>
          {feedback}
        </div>
        <button type="button" className={`integration-button ${connected ? "wa-panel-confirmed" : "integration-primary"}`} disabled={!view.known || connected || linking} onClick={linkAction}>
          {!connected && <IntegrationIcon name={qrDataUrl ? "check" : "message"} />}{buttonLabel}
        </button>
      </div>
    </div>
  </div>;
}
