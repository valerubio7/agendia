import type { ReactNode } from "react";
import type { WhatsAppStatus } from "../api-client";

type WhatsAppScreenProps = {
  status: WhatsAppStatus | null | undefined;
  feedback: ReactNode;
  qrDataUrl: string | null;
  linking: boolean;
  linkAction: () => void;
};

type WhatsAppStatusView = {
  key: WhatsAppStatus["status"] | "unknown";
  label: string;
  explanation: string;
  known: boolean;
};

const statusContent: Record<
  WhatsAppStatus["status"],
  { label: string; explanation: string }
> = {
  connected: {
    label: "Conectado",
    explanation:
      "El canal fue verificado y está conectado con agendIA para recibir conversaciones.",
  },
  disconnected: {
    label: "Desconectado",
    explanation:
      "El canal no está conectado en este momento. Podés iniciar una nueva verificación con un código temporal.",
  },
  link_required: {
    label: "Requiere vinculación",
    explanation:
      "WhatsApp necesita una vinculación antes de que agendIA pueda usar este canal de atención.",
  },
  error: {
    label: "Error de conexión",
    explanation:
      "No pudimos confirmar la conexión del canal. Podés solicitar una nueva vinculación para volver a verificarlo.",
  },
};

const unknownStatusContent = {
  label: "Estado no disponible",
  explanation:
    "No pudimos interpretar el estado actual del canal. Recargá la pantalla para volver a consultarlo.",
};

export function resolveWhatsAppStatusView(
  status: string | null | undefined,
): WhatsAppStatusView {
  if (status && Object.hasOwn(statusContent, status)) {
    const key = status as WhatsAppStatus["status"];
    return { key, ...statusContent[key], known: true };
  }

  return { key: "unknown", ...unknownStatusContent, known: false };
}

const whatsappDateFormatter = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatWhatsAppDate(value?: string | null) {
  if (!value) return "Sin registrar";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin registrar";

  try {
    return whatsappDateFormatter.format(date);
  } catch {
    return "Sin registrar";
  }
}

export function WhatsAppScreen({
  status,
  feedback,
  qrDataUrl,
  linking,
  linkAction,
}: WhatsAppScreenProps) {
  const statusDetails = resolveWhatsAppStatusView(status?.status);
  const connected = statusDetails.key === "connected";
  const linkedNumber = status?.linkedNumber?.trim();
  const buttonLabel = statusDetails.known
    ? connected
      ? "WhatsApp vinculado"
      : linking
        ? "Esperando conexión…"
        : "Vincular WhatsApp"
    : "Estado no disponible";

  return (
    <main className="whatsapp-screen" data-ui="whatsapp-screen">
      <section
        className="whatsapp-hero"
        data-ui="whatsapp-hero"
        aria-labelledby="whatsapp-title"
      >
        <div className="whatsapp-hero__copy">
          <p className="whatsapp-hero__eyebrow">Canal de atención</p>
          <h1 id="whatsapp-title">
            Tu negocio, a una conversación de distancia.
          </h1>
          <p>
            Conectá el canal real de WhatsApp para que agendIA pueda atender
            desde el mismo lugar donde tus clientes ya escriben.
          </p>
        </div>

        <div
          className="whatsapp-bridge"
          aria-label="Puente de conexión entre agendIA y WhatsApp"
        >
          <div className="whatsapp-bridge__header">
            <span>Canal seguro</span>
            <span>Puente de señal</span>
          </div>
          <div className="whatsapp-bridge__stage" aria-hidden="true">
            <div className="whatsapp-bridge__node whatsapp-bridge__node--agendia">
              <span>agend</span>
              <strong>IA</strong>
            </div>
            <div className="whatsapp-bridge__signal">
              <i />
              <i />
              <i />
              <span />
            </div>
            <div className="whatsapp-bridge__node whatsapp-bridge__node--whatsapp">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M16 4.25A11.25 11.25 0 0 0 6.2 21l-1.45 6.25 6.35-1.4A11.25 11.25 0 1 0 16 4.25Zm0 2.2a9.05 9.05 0 1 1-4.55 16.87l-.36-.2-3.35.74.76-3.25-.23-.37A9.05 9.05 0 0 1 16 6.45Z" />
                <path d="M12.4 10.55c.22-.5.45-.52.78-.53h.66c.2 0 .43.08.57.42.17.4.7 1.7.76 1.82.06.13.1.27.02.42-.08.16-.13.25-.26.4-.13.14-.27.3-.39.4-.13.12-.26.25-.11.5.14.25.64 1.05 1.38 1.7.95.85 1.75 1.11 2 1.24.25.12.4.1.54-.07.15-.18.64-.75.81-1 .17-.25.34-.2.58-.12.23.09 1.48.7 1.73.83.25.12.42.19.48.29.06.1.06.58-.13 1.13-.19.54-1.1 1.04-1.52 1.1-.39.06-.9.1-1.45-.08-.34-.1-.78-.25-1.34-.5-.56-.24-2.46-.9-4.19-2.45-1.45-1.3-2.43-2.9-2.7-3.4-.27-.5-.03-1.27.2-1.72.2-.4.42-.65.6-.83Z" />
              </svg>
              <span>WhatsApp</span>
            </div>
          </div>
          <p>Un puente preparado para llevar la atención al canal correcto.</p>
        </div>
      </section>

      <div className="whatsapp-feedback" aria-label="Mensajes de vinculación">
        {feedback}
      </div>

      <div className="whatsapp-workspace">
        <div className="whatsapp-channel-overview">
          <section
            className="whatsapp-status"
            data-ui="whatsapp-status"
            data-status={statusDetails.key}
            aria-labelledby="whatsapp-status-title"
          >
            <div className="whatsapp-status__heading">
              <div>
                <p>Estado actual</p>
                <h2 id="whatsapp-status-title">Conexión del canal</h2>
              </div>
              <p
                className="whatsapp-status__badge"
                role="status"
                aria-label={`Estado actual del canal: ${statusDetails.label}`}
              >
                <span aria-hidden="true" />
                {statusDetails.label}
              </p>
            </div>
            <p className="whatsapp-status__explanation">
              {statusDetails.explanation}
            </p>
          </section>

          <section
            className="whatsapp-metadata"
            aria-labelledby="whatsapp-metadata-title"
          >
            <div className="whatsapp-metadata__heading">
              <p>Datos verificados</p>
              <h2 id="whatsapp-metadata-title">Información del vínculo</h2>
            </div>
            <dl data-ui="whatsapp-metadata">
              <div>
                <dt>Número vinculado</dt>
                <dd>
                  {linkedNumber ? (
                    <bdi>{linkedNumber}</bdi>
                  ) : connected ? (
                    "No informado por WhatsApp"
                  ) : (
                    "Sin número vinculado"
                  )}
                </dd>
              </div>
              <div>
                <dt>Vinculado desde</dt>
                <dd>{formatWhatsAppDate(status?.linkedAt)}</dd>
              </div>
              <div>
                <dt>Última conexión</dt>
                <dd>{formatWhatsAppDate(status?.lastConnectedAt)}</dd>
              </div>
            </dl>
          </section>
        </div>

        <section
          className="whatsapp-link-panel"
          data-ui="whatsapp-link-panel"
          aria-labelledby="whatsapp-link-title"
        >
          <div className="whatsapp-link-panel__header">
            <p>Verificación del canal</p>
            <h2 id="whatsapp-link-title">
              {connected ? "Canal vinculado" : "Conectá con un código temporal"}
            </h2>
          </div>

          <div
            className={`whatsapp-scan-target${
              qrDataUrl ? " whatsapp-scan-target--ready" : ""
            }${connected ? " whatsapp-scan-target--connected" : ""}`}
          >
            {qrDataUrl ? (
              <figure>
                <img
                  src={qrDataUrl}
                  alt="Código QR temporal de WhatsApp"
                  aria-label="Código QR temporal de WhatsApp"
                  width={384}
                  height={384}
                />
                <figcaption>
                  Escaneá este código desde la sección Dispositivos vinculados
                  de WhatsApp.
                </figcaption>
              </figure>
            ) : connected ? (
              <div className="whatsapp-scan-target__confirmation">
                <span aria-hidden="true">✓</span>
                <strong>Verificación completa</strong>
                <p>El canal real de WhatsApp quedó vinculado a agendIA.</p>
              </div>
            ) : (
              <div className="whatsapp-scan-target__placeholder">
                <span aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <strong>
                  {linking
                    ? "Preparando el código temporal"
                    : "QR aún no solicitado"}
                </strong>
                <p>
                  {linking
                    ? "Esperá mientras verificamos la solicitud de vinculación."
                    : "El código real aparecerá acá cuando inicies la vinculación."}
                </p>
              </div>
            )}
          </div>

          <ol className="whatsapp-link-steps" aria-label="Pasos para vincular">
            <li>
              <span>01</span>
              <p>
                <strong>Solicitá el QR</strong>
                <small>Generamos un código temporal para este vínculo.</small>
              </p>
            </li>
            <li>
              <span>02</span>
              <p>
                <strong>Escanealo desde WhatsApp</strong>
                <small>Usá la opción Dispositivos vinculados de la app.</small>
              </p>
            </li>
            <li>
              <span>03</span>
              <p>
                <strong>Esperá la verificación</strong>
                <small>
                  Confirmamos la conexión real antes de darla por verificada.
                </small>
              </p>
            </li>
          </ol>

          <p className="whatsapp-security-note">
            <span aria-hidden="true">◇</span>
            El QR es temporal y no expone credenciales persistentes.
          </p>

          <button
            type="button"
            disabled={!statusDetails.known || connected || linking}
            onClick={linkAction}
          >
            {buttonLabel}
          </button>
        </section>
      </div>
    </main>
  );
}
