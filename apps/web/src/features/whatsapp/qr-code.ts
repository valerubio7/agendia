import { toDataURL } from "qrcode";

const QR_IMAGE_WIDTH = 384;

export function renderWhatsAppQrDataUrl(payload: string) {
  return toDataURL(payload, {
    type: "image/png",
    width: QR_IMAGE_WIDTH,
    margin: 4,
    errorCorrectionLevel: "M",
  });
}
