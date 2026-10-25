import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiClient, ApiError, type WhatsAppStatus } from "../../api/api-client";
import { resolveWhatsAppStatusView, WhatsAppScreen } from "./whatsapp-screen";

describe("resolveWhatsAppStatusView", () => {
  test.each([
    ["connected", "Conectado"],
    ["link_required", "Requiere vinculación"],
    ["disconnected", "Desconectado"],
    ["error", "Error de conexión"],
  ])("preserves the known channel state %s", (status, label) => {
    expect(resolveWhatsAppStatusView(status)).toMatchObject({
      key: status, label, known: true,
    });
  });

  test.each([
    ["linking", "Vinculando"],
    ["reconnecting", "Reconectando"],
  ])("recognizes the runtime state %s", (status, label) => {
    const view = resolveWhatsAppStatusView(status);
    expect(view).toMatchObject({ key: status, label, known: true });
    expect(view.explanation).toContain("QR");
  });

  test.each([undefined, null, "", "connecting"])(
    "falls back safely for an unavailable state: %p",
    (status) => {
      const view = resolveWhatsAppStatusView(status);
      expect(view).toMatchObject({
        key: "unknown", label: "Estado no disponible", known: false,
      });
      expect(view.explanation.trim().length).toBeGreaterThan(0);
    },
  );
});

describe("WhatsApp recovery action", () => {
  test.each(["link_required", "disconnected", "error", "linking", "reconnecting"])(
    "allows recovery from %s unless a request is pending",
    (status) => {
      for (const linking of [false, true]) {
        const html = renderToStaticMarkup(createElement(WhatsAppScreen, {
          status: { status: status as WhatsAppStatus["status"] },
          feedback: null, qrDataUrl: null, linking, linkAction: () => {},
        }));
        const button = html.match(/<button\b[^>]*>[^<]*<\/button>/)?.[0];
        expect(button).toBeDefined();
        expect(button!.includes('disabled=""')).toBe(linking);
        expect(button).toContain(linking ? "Esperando conexión…" : "Vincular WhatsApp");
      }
    },
  );

  test.each(["connected", "connecting"])("keeps %s disabled", (status) => {
    const html = renderToStaticMarkup(createElement(WhatsAppScreen, {
      status: { status: status as WhatsAppStatus["status"] },
      feedback: null, qrDataUrl: null, linking: false, linkAction: () => {},
    }));
    expect(html).toContain('<button type="button" disabled="">');
    expect(html).toContain(status === "connected" ? "WhatsApp vinculado" : "Estado no disponible");
  });
});

describe("WhatsApp QR request feedback", () => {
  test.each([
    [202, { status: "linking" }],
    [409, { code: "CONFLICT", message: "WhatsApp connection already linked" }],
  ] as const)("retrieves a delayed QR after a resumable POST response (%s)", async (status, body) => {
    const methods: string[] = [];
    const delays: number[] = [];
    const client = new ApiClient(async (path, init) => {
      expect(path).toBe("/api/me/whatsapp/link");
      methods.push(init!.method!);
      if (init?.method === "POST") return Response.json(body, { status });
      expect(init?.cache).toBe("no-store");
      return methods.length === 2
        ? Response.json({ code: "NOT_FOUND" }, { status: 404 })
        : Response.json({ qr: "current-qr" });
    });
    await expect(client.requestOrResumeWhatsAppLink({
      attempts: 2, intervalMs: 125, sleep: async ms => { delays.push(ms); },
    })).resolves.toEqual({ qr: "current-qr" });
    expect(methods).toEqual(["POST", "GET", "GET"]);
    expect(delays).toEqual([125]);
  });

  test.each([
    ["Activate the assistant before linking WhatsApp", "Activá el asistente antes de vincular WhatsApp."],
    ["Unknown conflict with private backend details", "Los datos cambiaron. Recargá y volvé a intentar."],
  ])("rejects %s promptly without polling or leaking backend text", async (message, feedback) => {
    const calls: string[] = [];
    const delays: number[] = [];
    const client = new ApiClient(async (path, init) => {
      calls.push(`${init?.method} ${path}`);
      return Response.json({ code: "CONFLICT", message }, { status: 409 });
    });
    const failure = await client.requestOrResumeWhatsAppLink({
      attempts: 2, intervalMs: 0, sleep: async ms => { delays.push(ms); },
    }).catch(error => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(client.errorMessage(failure)).toBe(feedback);
    expect(calls).toEqual(["POST /api/me/whatsapp/link"]);
    expect(delays).toEqual([]);
    // The same backend text from other API calls retains generic conflict feedback.
    await expect(client.requestWhatsAppLink()).rejects.toMatchObject({ code: "CONFLICT", status: 409, message });
    expect(client.errorMessage(new ApiError("CONFLICT", message, 409)))
      .toBe("Los datos cambiaron. Recargá y volvé a intentar.");
  });

  test("keeps QR polling bounded after an accepted request", async () => {
    const methods: string[] = [];
    const client = new ApiClient(async (_path, init) => {
      methods.push(init!.method!);
      return init?.method === "POST"
        ? Response.json({ status: "linking" }, { status: 202 })
        : Response.json({ code: "NOT_FOUND" }, { status: 404 });
    });
    await expect(client.requestOrResumeWhatsAppLink({ attempts: 3, intervalMs: 0 }))
      .rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(methods).toEqual(["POST", "GET", "GET", "GET"]);
  });

  test("preserves auth, network and abort failures without QR recovery", async () => {
    for (const failure of [
      new ApiError("UNAUTHENTICATED", "expired", 401),
      new ApiError("FORBIDDEN", "denied", 403),
      new Error("network unavailable"),
      new DOMException("Aborted", "AbortError"),
    ]) {
      const controller = new AbortController();
      const methods: string[] = [];
      const client = new ApiClient(async (_path, init) => {
        methods.push(init!.method!);
        expect(init?.signal).toBe(controller.signal);
        throw failure;
      });
      await expect(client.requestOrResumeWhatsAppLink({ signal: controller.signal }))
        .rejects.toBe(failure);
      expect(methods).toEqual(["POST"]);
    }
  });
});
