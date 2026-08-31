import { describe, expect, test } from "bun:test";
import { resolveWhatsAppStatusView } from "../../apps/web/src/ui/whatsapp-screen";

describe("resolveWhatsAppStatusView", () => {
  test("preserves known channel states", () => {
    expect(resolveWhatsAppStatusView("connected")).toMatchObject({
      key: "connected",
      label: "Conectado",
      known: true,
    });
    expect(resolveWhatsAppStatusView("link_required")).toMatchObject({
      key: "link_required",
      label: "Requiere vinculación",
      known: true,
    });
  });

  test.each([undefined, null, "", "connecting"])(
    "falls back safely for an unavailable state: %p",
    (status) => {
      const view = resolveWhatsAppStatusView(status);

      expect(view).toMatchObject({
        key: "unknown",
        label: "Estado no disponible",
        known: false,
      });
      expect(view.explanation.trim().length).toBeGreaterThan(0);
    },
  );
});
