import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import type { AppointmentRecord, Service } from "../../apps/web/src/api/api-client";
import { TurnosBookingForm } from "../../apps/web/src/features/appointments/turnos-booking-form";
import { TurnosDetail } from "../../apps/web/src/features/appointments/turnos-detail";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement } = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
const now = Date.parse("2026-11-19T02:30:00Z");
const common = { disabled: false, now, mutate: async () => false, error: "" };

test("booking offers labeled client modes and native service choices, with Argentina's date", () => {
  const services = [
    { id: "s1", name: "Consulta", durationMinutes: 30, priceArs: 2000, status: "active" },
    { id: "s2", name: "Archivado", durationMinutes: 60, priceArs: 0, status: "archived" },
  ] as Service[];
  const html = renderToStaticMarkup(createElement(TurnosBookingForm, {
    ...common, appointment: null, services, resources: [], sessionActive: () => true, cancel() {},
  }));
  expect(html).toMatch(/aria-pressed="true"[^>]*>Cliente registrado/);
  expect(html).toMatch(/aria-pressed="false"[^>]*>Nuevo cliente/);
  expect(html).toMatch(/type="radio"[^>]*value="s1"|value="s1"[^>]*type="radio"/);
  expect(html).toContain("30 min");
  expect(html).not.toContain("Archivado");
  expect(html).toMatch(/type="date"[^>]*value="2026-11-18"/);
  expect(html).not.toContain("Confirmar turno");
});

test("detail labels the saved schedule and does not offer mutations for a closed booking", () => {
  const row: AppointmentRecord = {
    id: "a", client: { id: "c", firstName: "Clara", lastName: "López", phone: "+5491111111111" },
    startsAt: "2026-11-19T02:45:00Z", startMs: now + 900_000, endMs: now + 2_700_000,
    terms: { serviceId: "s", serviceName: "Consulta histórica", resourceId: "r", resourceName: "Consultorio", durationMinutes: 30, priceArs: 2000 },
    state: "done", origin: "manual", notes: "Traer estudios", customerResourcePreference: null,
  };
  const html = renderToStaticMarkup(createElement(TurnosDetail, { ...common, row, change() {} }));
  expect(html).toMatch(/<time dateTime="2026-11-19T02:45:00Z"[^>]*>23:45<\/time>/);
  expect(html).toContain("Consulta histórica");
  expect(html).toContain("Traer estudios");
  expect(html).not.toContain("<button");
});
