import type { WhatsAppStatus } from "../../api/api-client";

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
