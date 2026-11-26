import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { AppointmentRecord } from "../../apps/web/src/api/api-client";
import { BusinessHome } from "../../apps/web/src/features/appointments/business-home";
import { TurnosScreen } from "../../apps/web/src/features/appointments/turnos-screen";
import { AuthenticatedShell } from "../../apps/web/src/shell/authenticated-shell";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement } = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const { PathnameContext } = webRequire("next/dist/shared/lib/hooks-client-context.shared-runtime");

function panelAt(path: string) {
  return renderToStaticMarkup(createElement(PathnameContext.Provider, { value: path },
    createElement(AuthenticatedShell, { variant: "business", activeHref: "/turnos", logoutPending: false, logoutAction() {} },
      createElement(TurnosScreen, { disabled: false, sessionActive: () => true }),
    ),
  ));
}

test("Inicio names the active page and does not report an empty day while waiting for real data", () => {
  const html = panelAt("/inicio");
  expect(html).toMatch(/aria-current="page"[^>]*href="\/inicio"/);
  expect(html).toContain('href="/profile"');
  expect(html).toContain('aria-label="Turnos de hoy"');
  expect(html).toContain("Próximo turno");
  expect(html).not.toContain("La lista de hoy todavía no está actualizada.");
  expect(html).not.toContain("Actualizando turnos…");
  expect(html).not.toContain("No hay turnos para hoy");
  expect(html).not.toContain("Vista de agenda");
});

test("Agenda opens in Día with the reference date controls and preserves booking and refresh", () => {
  const html = panelAt("/turnos");
  expect(html).toMatch(/aria-current="page"[^>]*href="\/turnos"/);
  expect(html).toContain('aria-label="Vista de agenda"');
  expect(html).toMatch(/aria-pressed="true"[^>]*>Día</);
  expect(html).toContain('aria-label="Elegir fecha de la agenda"');
  expect(html).toContain('aria-label="Días de la semana"');
  expect(html).toContain('aria-label="Turnos del día"');
  expect(html).toContain("Nuevo turno");
  expect(html).toContain("Actualizar turnos");
});

test("Inicio only shows Argentina's current day, using the booking's saved terms", () => {
  const row = (name: string, startsAt: string, state: AppointmentRecord["state"]): AppointmentRecord => ({
    id: name, client: { id: name, name: `${name} Prueba`, phone: "" },
    startsAt, startMs: Date.parse(startsAt), endMs: Date.parse(startsAt) + 1_800_000,
    terms: { serviceId: "service", serviceName: "Consulta", resourceId: "resource", resourceName: "Consultorio", durationMinutes: 30, priceArs: 0 },
    state, origin: "manual", notes: null, customerResourcePreference: null,
  });
  const html = renderToStaticMarkup(createElement(BusinessHome, {
    today: "2026-11-19", now: Date.parse("2026-11-19T03:00:00Z"),
    rows: [row("Confirmada", "2026-11-19T14:00:00Z", "confirmed"), row("Cancelada", "2026-11-19T13:00:00Z", "cancelled"), row("Ayer", "2026-11-19T02:45:00Z", "confirmed")],
    pending: false, stale: false, error: "", locked: false, select() {}, refresh() {},
  }));
  expect(html).not.toContain("Ayer Prueba");
  expect(html.split('aria-label="Turnos de hoy"')[0]).toContain("Confirmada Prueba");
  expect(html.indexOf("Cancelada Prueba")).toBeLessThan(html.lastIndexOf("Confirmada Prueba"));
  expect(html).toContain("Consulta · Consultorio");
});

test.each([false, true])("with an unverified day, Inicio keeps the layout and only disables refresh while reading (%s)", (pending) => {
  const html = renderToStaticMarkup(createElement(BusinessHome, {
    today: "2026-11-19", now: Date.parse("2026-11-19T03:00:00Z"), rows: [],
    pending, stale: true, error: "", locked: false, select() {}, refresh() {},
  }));
  expect(html).not.toContain("No hay turnos para hoy");
  expect(html).not.toContain("Sin turnos próximos");
  expect(html).not.toContain("business-home__counts");
  expect(html).not.toMatch(/Consultando la agenda…|Actualizando turnos…/);
  if (pending) {
    expect(html).toMatch(/aria-label="Turnos de hoy" aria-busy="true"/);
    expect(html).toContain('disabled="">Actualizar turnos');
  } else {
    expect(html).toContain('<button type="button">Actualizar turnos');
  }
});
