import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { RegisterScreen } from "../../apps/web/src/features/auth/register-screen";
import { AdminBusinessesScreen } from "../../apps/web/src/features/administration/admin-businesses-screen";
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
    setStatusAction: async () => true,
  }));
  expect(html).toContain("Suspender");
  expect(html).not.toContain("Renombrar");
  expect(html).not.toContain("Cambiar contraseña");
  expect(html).not.toContain('name="password"');
  expect(html).not.toContain('name="name"');
});
test("admin shows pending registrations and accessible decision actions", () => {
  const html = renderToStaticMarkup(createElement(AdminBusinessesScreen, {
    businesses: [], registrations: [{ id: "a", name: "Negocio", email: "a@example.test", createdAt: "2026-01-01T00:00:00Z" }],
    responseTiming: { responseTiming: { initialDelaySeconds: 0, activeDelaySeconds: 0, inactivityResetSeconds: 60 } },
    notice: "", error: "", refreshWarning: true, refreshPending: false,
    retryRefreshAction: () => {}, decideAction: async () => true, saveResponseTimingAction: async () => true,
    setStatusAction: async () => true,
  }));
  expect(html).toContain("a@example.test");
  expect(html).toContain('aria-label="Aprobar Negocio"');
  expect(html).toContain('aria-label="Rechazar Negocio"');
  expect(html).toContain('role="alert"');
  expect(html).toContain("Reintentar consulta");
  expect(html).not.toContain("Nuevo negocio");
});
