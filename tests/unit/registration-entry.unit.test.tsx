import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { RegisterScreen } from "../../apps/web/src/features/auth/register-screen";
import { AdminBusinessesScreen } from "../../apps/web/src/features/administration/admin-businesses-screen";
import { ApiClient } from "../../apps/web/src/api/api-client";
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
test("registration exposes labelled required fields and pending feedback", () => {
  const html = renderToStaticMarkup(createElement(RegisterScreen, { pending: true, feedback: null, submitAction: () => {} }));
  for (const name of ["name", "email", "password"]) expect(html).toContain(`name="${name}"`);
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain("Enviando…");
  expect(html).toContain('disabled=""');
});
test("registration requires a password confirmation", () => {
  const html = renderToStaticMarkup(createElement(RegisterScreen, { pending: false, feedback: null, submitAction: () => {} }));
  expect(html).toContain('name="passwordConfirmation"');
  expect(html).toContain("Repetir contraseña");
});
test("registration shares the login visual layout", () => {
  const html = renderToStaticMarkup(createElement(RegisterScreen, { pending: false, feedback: null, submitAction: () => {} }));
  expect(html).toContain('data-ui="login-story"');
});
test("completed registration shows approval feedback without a busy submission", () => {
  const html = renderToStaticMarkup(createElement(RegisterScreen, { pending: false, success: true,
    feedback: createElement("p", { role: "status" }, "Solicitud enviada. Esperá la aprobación antes de iniciar sesión."), submitAction: () => {} }));
  expect(html).toContain('role="status"');
  expect(html).toContain("Esperá la aprobación");
  expect(html).toContain('aria-busy="false"');
  expect(html).not.toContain("Enviando…");
  expect(html).toContain('disabled=""');
});
test("admin business management offers status but no name or password editing", () => {
  const html = renderToStaticMarkup(createElement(AdminBusinessesScreen, {
    businesses: [{ id: "a", name: "Negocio", status: "active", agentStatus: "inactive", whatsappStatus: "disconnected", createdAt: "2026-01-01T00:00:00Z", lastTechnicalActivityAt: null }],
    registrations: [], responseTiming: { responseTiming: { initialDelaySeconds: 0, activeDelaySeconds: 0, inactivityResetSeconds: 60 } },
    notice: "", error: "", refreshWarning: false, refreshPending: false,
    retryRefreshAction: () => {}, decideAction: async () => true, saveResponseTimingAction: async () => true,
    setStatusAction: async () => true, deleteBusinessAction: async () => true,
  }));
  expect(html).toContain("Suspender");
  expect(html).toContain('aria-label="Eliminar Negocio"');
  expect(html).not.toContain("Renombrar");
  expect(html).not.toContain("Cambiar contraseña");
  expect(html).not.toContain('name="password"');
  expect(html).not.toContain('name="name"');
});
test("admin deletion uses authenticated encoded DELETE and propagates errors without replay", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  let fail = false;
  const client = new ApiClient(async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith("/login")) return Response.json({ csrfToken: "csrf" });
    if (path.endsWith("/session")) return Response.json({ identityId: "a", role: "platform_admin", businessId: null });
    return fail ? Response.json({ code: "FORBIDDEN" }, { status: 403 }) : Response.json({ deleted: true });
  });
  await client.login("admin@example.test", "password", true);
  const signal = new AbortController().signal;
  await client.deleteBusiness("id/a", signal);
  expect(calls.at(-1)?.path).toBe("/api/admin/businesses/id%2Fa");
  expect(calls.at(-1)?.init).toMatchObject({ method: "DELETE", credentials: "include", signal });
  expect(calls.at(-1)?.init?.body).toBeUndefined();
  expect(new Headers(calls.at(-1)?.init?.headers).get("x-csrf-token")).toBe("csrf");
  fail = true;
  const before = calls.length;
  await expect(client.deleteBusiness("id/a", signal)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(calls.length).toBe(before + 1);
  expect(client.errorMessage(new Error())).toBe("No se pudo completar la operación.");
});
test("admin shows pending registrations and accessible decision actions", () => {
  const html = renderToStaticMarkup(createElement(AdminBusinessesScreen, {
    businesses: [], registrations: [{ id: "a", name: "Negocio", email: "a@example.test", createdAt: "2026-01-01T00:00:00Z" }],
    responseTiming: { responseTiming: { initialDelaySeconds: 0, activeDelaySeconds: 0, inactivityResetSeconds: 60 } },
    notice: "", error: "", refreshWarning: true, refreshPending: false,
    retryRefreshAction: () => {}, decideAction: async () => true, saveResponseTimingAction: async () => true,
    setStatusAction: async () => true, deleteBusinessAction: async () => true,
  }));
  expect(html).toContain("a@example.test");
  expect(html).toContain('aria-label="Aprobar Negocio"');
  expect(html).toContain('aria-label="Rechazar Negocio"');
  expect(html).toContain('role="alert"');
  expect(html).toContain("Reintentar consulta");
  expect(html).not.toContain("Nuevo negocio");
});
