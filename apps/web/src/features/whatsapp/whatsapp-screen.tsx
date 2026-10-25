import type { ReactNode } from "react";
import type { WhatsAppStatus } from "../../api/api-client";

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
  linking: {
    label: "Vinculando",
    explanation:
      "La vinculación está en curso. Podés recuperar el QR temporal para completar la verificación.",
  },
  reconnecting: {
    label: "Reconectando",
    explanation:
      "Estamos intentando restablecer la conexión del canal. Podés recuperar el QR disponible si necesitás volver a vincularlo.",
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
        className="whatsapp-heading"
        data-ui="whatsapp-hero"
        aria-labelledby="whatsapp-title"
      >
        <h1 id="whatsapp-title">WhatsApp</h1>
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
                <strong>Verificación completa</strong>
                <p>El canal real de WhatsApp quedó vinculado a agendIA.</p>
              </div>
            ) : (
              <div className="whatsapp-scan-target__placeholder">
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

          <p className="whatsapp-security-note">
            El QR es temporal y no expone credenciales persistentes.
          </p>

          <button
            type="button"
            disabled={!statusDetails.known || connected || linking}
            onClick={linkAction}
          >
            {buttonLabel}
          </button>

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

        </section>
      </div>
    </main>
  );
}
