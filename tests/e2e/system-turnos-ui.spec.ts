import { expect, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

// Stop this focused transaction at its first unexpected failure.
test.describe.configure({ mode: "serial" });

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

async function provision(admin: Page, business: Page, system: { webUrl: string; admin: { email: string; password: string } }, suffix: string) {
  const email = `${suffix}@example.test`, password = "turnos isolated password";
  await login(admin, system.webUrl, system.admin.email, system.admin.password);
  await expect(admin).toHaveURL(/\/businesses$/);
  await admin.getByLabel("Nombre", { exact: true }).fill(`Turnos ${suffix}`);
  await admin.getByLabel("Correo del usuario", { exact: true }).fill(email);
  await admin.getByLabel("Contraseña inicial", { exact: true }).fill(password);
  await admin.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(admin.getByRole("cell", { name: `Turnos ${suffix}`, exact: true })).toBeVisible();
  await login(business, system.webUrl, email, password);
  await expect(business).toHaveURL(/\/profile$/);
  const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
  expect(csrf).toBeTruthy();
  const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
  const create = async (path: string, data: object) => {
    const response = await business.request.post(`${system.webUrl}/api/me/${path}`, { headers, data });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const read = async (path: string) => {
    const response = await business.request.get(`${system.webUrl}/api/me/${path}`);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const full = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
  const calendar = await business.request.put(`${system.webUrl}/api/me/business-calendar`, { headers, data: { weeklySchedule: full } });
  expect(calendar.status()).toBe(200);
  const client = await create("clients", { firstName: "Clara", lastName: "López", phone: "+5491123456777" });
  const service = await create("services", { name: "Servicio de prueba", durationMinutes: 30, priceArs: 0 });
  const resource = await create("resources", { name: "Recurso de prueba", serviceIds: [service.id], weeklySchedule: full });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + 2 * 86400000));
  const offers = await read(`appointments/availability?${new URLSearchParams({ serviceId: service.id, resourceId: resource.id, date })}`);
  const offer = offers.find((slot: { startMs: number }) => slot.startMs >= Date.parse(`${date}T10:00:00-03:00`));
  expect(offer).toBeDefined();
  return { email, password, headers, create, read, client, service, resource, date, offers, offer };
}

test("Turnos navigation and real manual booking lifecycle", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const password = "turnos tenant password", email = "turnos@example.test";
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  await page.getByLabel("Nombre", { exact: true }).fill("Estudio Turnos");
  await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
  await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Estudio Turnos", exact: true })).toBeVisible();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    await login(business, system.webUrl, email, password);
    await expect(business).toHaveURL(/\/profile$/);
    const navigation = business.getByRole("navigation", { name: "Navegación del negocio", exact: true });
    await expect(navigation.getByRole("link").first()).toHaveText("Turnos");
    await navigation.getByRole("link", { name: "Turnos", exact: true }).click();
    await expect(business.getByRole("heading", { name: "Turnos", exact: true })).toBeVisible();
    await expect(business.getByRole("button", { name: "Hoy", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(business.getByText("No hay turnos para esta fecha.", { exact: true })).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("turnos-empty-desktop.png"), fullPage: true });
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
    const create = async (path: string, data: object) => {
      const response = await business.request.post(`${system.webUrl}/api/me/${path}`, { headers, data });
      expect(response.status()).toBe(201);
      return response.json();
    };
    const read = async (path: string) => {
      const response = await business.request.get(`${system.webUrl}/api/me/${path}`);
      expect(response.status()).toBe(200);
      return response.json();
    };
    const full = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
    const calendar = await business.request.put(`${system.webUrl}/api/me/business-calendar`, { headers, data: { weeklySchedule: full } });
    expect(calendar.status()).toBe(200);
    const client = await create("clients", { firstName: "Ana", lastName: "Pérez", phone: "+5491123456789" });
    const service = await create("services", { name: "Consulta original", durationMinutes: 30, priceArs: 1250.5 });
    const alternative = await create("services", { name: "Consulta distinta", durationMinutes: 45, priceArs: 5000 });
    const resource = await create("resources", { name: "Profesional uno", serviceIds: [service.id, alternative.id], weeklySchedule: full });
    const otherResource = await create("resources", { name: "Profesional dos", serviceIds: [service.id, alternative.id], weeklySchedule: full });
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + 7 * 86400000));
    const offers = await read(`appointments/availability?${new URLSearchParams({ serviceId: service.id, resourceId: resource.id, date })}`);
    const offer = offers.find((slot: { startMs: number }) => slot.startMs >= Date.parse(`${date}T10:00:00-03:00`));
    expect(offer).toBeDefined();
    const counts = { POST: 0, PATCH: 0, clientPOST: 0 };
    business.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/me/appointments" && request.method() === "POST") counts.POST++;
      if (path.startsWith("/api/me/appointments/") && request.method() === "PATCH") counts.PATCH++;
      if (path === "/api/me/clients" && request.method() === "POST") counts.clientPOST++;
    });
    const screen = business.getByRole("main");
    const openCreate = async () => {
      await screen.getByRole("button", { name: "Nuevo turno", exact: true }).click();
      const form = screen.getByRole("form", { name: "Crear turno", exact: true });
      await expect(form).toBeVisible();
      await expect(form.getByLabel("Origen del cliente", { exact: true })).toBeFocused();
      return form;
    };
    const chooseSlot = async (form: ReturnType<Page["getByRole"]>, resourceValue: string, start: string, serviceValue = service.id) => {
      await form.getByLabel("Servicio", { exact: true }).selectOption(serviceValue);
      await form.getByLabel("Recurso", { exact: true }).selectOption(resourceValue);
      await form.getByLabel("Fecha", { exact: true }).fill(date);
      await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
      await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
      await form.getByLabel("Horario disponible", { exact: true }).selectOption(start);
    };
    const form = await openCreate();
    await form.getByLabel("Buscar cliente por nombre o teléfono", { exact: true }).fill("Ana");
    await form.getByRole("button", { name: "Buscar cliente", exact: true }).click();
    await form.getByRole("list", { name: "Resultados de clientes", exact: true }).getByRole("button", { name: /Ana Pérez/ }).click();
    await chooseSlot(form, resource.id, offer.start);
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const confirm = form.getByRole("button", { name: "Confirmar turno", exact: true });
    await expect(confirm).toBeFocused();
    expect(counts.POST).toBe(0);
    await business.screenshot({ path: testInfo.outputPath("turnos-create-confirmation.png"), fullPage: true });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await business.route("**/api/me/appointments", async route => {
      if (route.request().method() === "POST") { await held; await route.continue(); }
      else await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
    });
    await business.route("**/api/me/appointments?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    const committed = business.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/appointments"));
    await confirm.click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await form.evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(counts.POST).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("turnos-create-pending.png"), fullPage: true });
    release();
    const response = await committed;
    expect(response.status()).toBe(201);
    const saved = await response.json();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByRole("heading", { name: "Ana Pérez", exact: true })).toBeFocused();
    await expect(screen.getByText("Turno guardado", { exact: true })).toBeVisible();
    await expect(screen.getByText("El turno se guardó, pero no pudimos actualizar la lista.", { exact: true })).toBeVisible();
    expect(counts.POST).toBe(1);
    await business.unroute("**/api/me/appointments");
    await business.unroute("**/api/me/appointments?*");
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(screen.getByText("El turno se guardó, pero no pudimos actualizar la lista.", { exact: true })).toHaveCount(0);
    expect(counts.POST).toBe(1);
    expect((await read(`appointments/${saved.id}`)).client.id).toBe(client.id);
    expect(counts.clientPOST).toBe(0);

    // Same start on another resource remains a separate chronological row.
    const newForm = await openCreate();
    await newForm.getByLabel("Origen del cliente", { exact: true }).selectOption("new");
    await newForm.getByLabel("Nombre", { exact: true }).fill("Bruno");
    await newForm.getByLabel("Apellido", { exact: true }).fill("Díaz");
    await newForm.getByLabel("Teléfono", { exact: true }).fill("11 23456788");
    await chooseSlot(newForm, otherResource.id, offer.start);
    await newForm.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const newSaved = business.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/appointments"));
    await newForm.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    expect((await newSaved).status()).toBe(201);
    await expect(detail.getByRole("heading", { name: "Bruno Díaz", exact: true })).toBeVisible();
    const ownedClients = await read("clients");
    expect(ownedClients).toHaveLength(2);
    expect(ownedClients.find((row: { firstName: string }) => row.firstName === "Bruno").phone).toBe("+5491123456788");
    expect(counts.clientPOST).toBe(0);
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByRole("button", { name: "Siguiente", exact: true }).click();
    const dayList = screen.getByRole("list", { name: `Turnos ${date}`, exact: true });
    await expect(dayList.getByRole("listitem")).toHaveCount(2);
    await expect(dayList.getByText("Profesional uno", { exact: true })).toHaveCount(0);
    await dayList.getByRole("button", { name: /Ana Pérez/ }).click();
    await expect(detail.getByText("Profesional uno", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Marcar completado", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Marcar ausente", exact: true })).toBeDisabled();

    const updateService = await business.request.put(`${system.webUrl}/api/me/services/${service.id}`, {
      headers, data: { name: "Consulta actual", durationMinutes: 60, priceArs: 9000 },
    });
    expect(updateService.status()).toBe(200);
    await detail.getByRole("button", { name: "Modificar turno", exact: true }).click();
    const changeForm = screen.getByRole("form", { name: "Modificar turno", exact: true });
    await changeForm.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(changeForm.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    const later = offers.find((slot: { startMs: number }) => slot.startMs >= offer.endMs);
    await changeForm.getByLabel("Horario disponible", { exact: true }).selectOption(later.start);
    await expect(changeForm.getByRole("region", { name: "Condiciones ofrecidas", exact: true })).toContainText("30 min");
    await changeForm.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const changed = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}`));
    await changeForm.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    expect((await changed).status()).toBe(200);
    const rescheduled = await read(`appointments/${saved.id}`);
    expect(rescheduled.startMs).toBe(later.startMs);
    expect(rescheduled.terms).toEqual(saved.terms);
    await detail.getByRole("button", { name: "Modificar turno", exact: true }).click();
    await chooseSlot(changeForm, resource.id, later.start, alternative.id);
    await expect(changeForm.getByRole("region", { name: "Condiciones ofrecidas", exact: true })).toContainText("45 min");
    await changeForm.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const serviceChanged = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}`));
    await changeForm.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    expect((await serviceChanged).status()).toBe(200);
    expect((await read(`appointments/${saved.id}`)).terms.serviceId).toBe(alternative.id);
    await expect(detail.getByText("Consulta distinta", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    const notesForm = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
    await expect(notesForm.getByLabel("Notas del turno", { exact: true })).toBeFocused();
    await notesForm.getByLabel("Notas del turno", { exact: true }).fill("Llegar con estudios");
    const notesSaved = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}/notes`));
    await notesForm.getByRole("button", { name: "Guardar notas", exact: true }).click();
    expect((await notesSaved).status()).toBe(200);
    await expect(detail.getByText("Llegar con estudios", { exact: true })).toBeVisible();
    const beforeCancel = counts.PATCH;
    const cancel = detail.getByRole("button", { name: "Cancelar turno", exact: true });
    await cancel.click();
    await expect(detail.getByRole("button", { name: "Volver sin cambiar", exact: true })).toBeFocused();
    await detail.getByRole("button", { name: "Volver sin cambiar", exact: true }).click();
    await expect(cancel).toBeFocused();
    expect(counts.PATCH).toBe(beforeCancel);
    await cancel.click();
    const cancelled = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}/state`));
    await detail.getByRole("button", { name: "Confirmar estado", exact: true }).click();
    expect((await cancelled).status()).toBe(200);
    await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toHaveCount(0);
    await expect(dayList.getByRole("listitem")).toHaveCount(2);
    await expect(dayList.getByText("Cancelado", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Mes", exact: true }).click();
    const month = screen.getByRole("group", { name: "Días del mes", exact: true });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (date.slice(0, 7) !== today.slice(0, 7)) await screen.getByRole("button", { name: "Siguiente", exact: true }).click();
    await month.getByRole("button", { name: `${Number(date.slice(-2))} 2 turnos`, exact: true }).click();
    await expect(dayList.getByRole("listitem")).toHaveCount(2);
    await business.screenshot({ path: testInfo.outputPath("turnos-month-desktop.png"), fullPage: true });
    await business.setViewportSize({ width: 360, height: 900 });
    await business.screenshot({ path: testInfo.outputPath("turnos-month-mobile.png"), fullPage: true });
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await business.reload();
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByRole("button", { name: "Siguiente", exact: true }).click();
    await dayList.getByRole("button", { name: /Ana Pérez/ }).click();
    await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
    await expect(detail.getByText("Llegar con estudios", { exact: true })).toBeVisible();
    expect(counts.clientPOST).toBe(0);
  } finally { await context.close(); }
});

test("Turnos real atomic conflicts and changed quotes preserve the draft", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const setup = await provision(page, business, system, "turnos-conflicts");
    const { client, service, resource, date, offer, offers, headers, read } = setup;
    await business.goto(`${system.webUrl}/turnos`);
    const screen = business.getByRole("main");
    await screen.getByRole("button", { name: "Nuevo turno", exact: true }).click();
    const form = screen.getByRole("form", { name: "Crear turno", exact: true });
    await form.getByLabel("Origen del cliente", { exact: true }).selectOption("new");
    await form.getByLabel("Nombre", { exact: true }).fill("Nueva");
    await form.getByLabel("Apellido", { exact: true }).fill("Persona");
    await form.getByLabel("Teléfono", { exact: true }).fill(client.phone);
    await form.getByLabel("Servicio", { exact: true }).selectOption(service.id);
    await form.getByLabel("Recurso", { exact: true }).selectOption(resource.id);
    await form.getByLabel("Fecha", { exact: true }).fill(date);
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await form.getByLabel("Horario disponible", { exact: true }).selectOption(offer.start);
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const confirm = form.getByRole("button", { name: "Confirmar turno", exact: true });
    const postResponse = () => business.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/appointments"));
    const duplicateClient = postResponse();
    await confirm.click();
    expect((await duplicateClient).status()).toBe(409);
    await expect(form.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
    await expect(confirm).toBeEnabled();
    await expect(confirm).toBeFocused();
    await expect(form.getByLabel("Teléfono", { exact: true })).toHaveValue(client.phone);
    expect(await read("clients")).toHaveLength(1);
    expect(await read("appointments")).toHaveLength(0);
    await business.screenshot({ path: testInfo.outputPath("turnos-atomic-client-conflict.png"), fullPage: true });
    await form.getByRole("button", { name: "Volver al formulario", exact: true }).click();
    await form.getByLabel("Teléfono", { exact: true }).fill("11 23456776");
    await expect(form.getByLabel("Horario disponible", { exact: true })).toHaveValue("");
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await form.getByLabel("Horario disponible", { exact: true }).selectOption(offer.start);
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    // Occupy the previously offered slot through the actual API, not a mocked 409.
    const occupied = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    const capacityConflict = postResponse();
    await confirm.click();
    expect((await capacityConflict).status()).toBe(409);
    expect(await read("clients")).toHaveLength(1);
    expect(await read("appointments")).toHaveLength(1);
    expect((await read(`appointments/${occupied.id}`)).startMs).toBe(offer.startMs);
    await expect(confirm).toBeFocused();
    await form.getByRole("button", { name: "Volver al formulario", exact: true }).click();
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    const later = offers.find((slot: { startMs: number }) => slot.startMs >= offer.endMs);
    await form.getByLabel("Horario disponible", { exact: true }).selectOption(later.start);
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const changedTerms = await business.request.put(`${system.webUrl}/api/me/services/${service.id}`, {
      headers, data: { name: service.name, durationMinutes: 45, priceArs: 3000 },
    });
    expect(changedTerms.status()).toBe(200);
    const quoteConflict = postResponse();
    await confirm.click();
    expect((await quoteConflict).status()).toBe(409);
    expect(await read("clients")).toHaveLength(1);
    expect(await read("appointments")).toHaveLength(1);
    await expect(form.getByLabel("Horario disponible", { exact: true })).toHaveValue(later.start);
    await expect(confirm).toBeFocused();
    await business.screenshot({ path: testInfo.outputPath("turnos-real-quote-conflict.png"), fullPage: true });
    await form.getByRole("button", { name: "Volver al formulario", exact: true }).click();
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await form.getByLabel("Horario disponible", { exact: true }).selectOption(later.start);
    await expect(form.getByRole("region", { name: "Condiciones ofrecidas", exact: true })).toContainText("45 min");
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const fresh = postResponse();
    await confirm.click();
    const freshResponse = await fresh;
    expect(freshResponse.status()).toBe(201);
    const newSaved = await freshResponse.json();
    expect(newSaved.terms.durationMinutes).toBe(45);
    expect(newSaved.terms.priceArs).toBe(3000);
    expect(await read("clients")).toHaveLength(2);
    expect(await read("appointments")).toHaveLength(2);
    await business.reload();
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    const dayList = screen.getByRole("list", { name: `Turnos ${date}`, exact: true });
    await expect(dayList.getByRole("listitem")).toHaveCount(2);
    await dayList.getByRole("button", { name: /Nueva Persona/ }).click();
    await expect(screen.getByRole("region", { name: "Detalle del turno", exact: true })).toContainText("45 min");
  } finally { await context.close(); }
});

test("Turnos mounted read recovery, stale availability, session ownership and unknown outcomes", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const setup = await provision(page, business, system, "turnos-ownership");
    const { client, service, resource, date, offer } = setup;
    const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    let listGET = 0, post = 0;
    business.on("request", request => {
      if (new URL(request.url()).pathname === "/api/me/appointments") {
        if (request.method() === "GET") listGET++;
        if (request.method() === "POST") post++;
      }
    });
    await business.route("**/api/me/appointments?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await business.goto(`${system.webUrl}/turnos`);
    const screen = business.getByRole("main");
    await expect(screen.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await business.unroute("**/api/me/appointments?*");
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(screen.getByRole("alert")).toHaveCount(0);
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    const dayList = screen.getByRole("list", { name: `Turnos ${date}`, exact: true });
    await dayList.getByRole("button", { name: /Clara López/ }).click();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByRole("heading", { name: "Clara López", exact: true })).toBeFocused();
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    const notes = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
    await notes.getByLabel("Notas del turno", { exact: true }).fill("Guardado antes del GET");
    let patch = 0;
    business.on("request", request => { if (request.method() === "PATCH") patch++; });
    await business.route(`**/api/me/appointments/${saved.id}`, async route => {
      if (route.request().method() === "GET") await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
      else await route.continue();
    });
    const noteResponse = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}/notes`));
    await notes.getByRole("button", { name: "Guardar notas", exact: true }).click();
    expect((await noteResponse).status()).toBe(200);
    await expect(detail.getByText("Guardado antes del GET", { exact: true })).toBeVisible();
    await expect(screen.getByText("El turno se guardó, pero no pudimos actualizar el detalle.", { exact: true })).toBeVisible();
    expect(patch).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("turnos-saved-detail-refresh-warning.png"), fullPage: true });
    await business.unroute(`**/api/me/appointments/${saved.id}`);
    await screen.getByRole("button", { name: "Actualizar detalle", exact: true }).click();
    await expect(screen.getByText("El turno se guardó, pero no pudimos actualizar el detalle.", { exact: true })).toHaveCount(0);
    expect(patch).toBe(1);

    let releaseList!: () => void;
    const heldList = new Promise<void>(resolve => { releaseList = resolve; });
    await business.route("**/api/me/appointments?*", async route => { await heldList; await route.continue(); });
    const beforeGET = listGET;
    const refresh = screen.getByRole("button", { name: "Actualizar turnos", exact: true });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await refresh.evaluate(element => { (element as HTMLButtonElement).click(); });
    expect(listGET).toBe(beforeGET + 1);
    await expect(dayList.getByRole("listitem")).toHaveCount(1);
    releaseList();
    await expect(refresh).toBeEnabled();
    await business.unroute("**/api/me/appointments?*");

    await screen.getByRole("button", { name: "Nuevo turno", exact: true }).click();
    const form = screen.getByRole("form", { name: "Crear turno", exact: true });
    await form.getByLabel("Origen del cliente", { exact: true }).selectOption("new");
    await form.getByLabel("Nombre", { exact: true }).fill("Incierta");
    await form.getByLabel("Apellido", { exact: true }).fill("Persona");
    await form.getByLabel("Teléfono", { exact: true }).fill("11 23456775");
    await form.getByLabel("Servicio", { exact: true }).selectOption(service.id);
    await form.getByLabel("Recurso", { exact: true }).selectOption(resource.id);
    await form.getByLabel("Fecha", { exact: true }).fill(date);
    let releaseSlots!: () => void;
    const heldSlots = new Promise<void>(resolve => { releaseSlots = resolve; });
    await business.route("**/api/me/appointments/availability?*", async route => { await heldSlots; await route.continue(); });
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toBeVisible();
    const nextDate = new Date(`${date}T12:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    await form.getByLabel("Fecha", { exact: true }).fill(nextDate.toISOString().slice(0, 10));
    releaseSlots();
    await expect(form.getByLabel("Horario disponible", { exact: true })).toHaveValue("");
    await expect(form.getByLabel("Horario disponible", { exact: true }).locator("option")).toHaveCount(1);
    await business.unroute("**/api/me/appointments/availability?*");
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await form.getByLabel("Horario disponible", { exact: true }).selectOption({ index: 1 });
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    let lostCreate: { key: string; body: object } | null = null;
    await business.route("**/api/me/appointments", async route => {
      lostCreate = { key: route.request().headers()["x-appointment-operation-key"]!, body: route.request().postDataJSON() };
      await route.abort("failed");
    });
    await form.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("El turno podría haberse guardado");
    await expect(form.getByRole("button", { name: "Confirmar turno", exact: true })).toBeDisabled();
    expect(post).toBe(1);
    await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toBeVisible();
    const newTurn = screen.getByRole("button", { name: "Nuevo turno", exact: true });
    const uncertaintyWarning = screen.locator(':scope > [role="alert"]').filter({ hasText: "El turno podría haberse guardado" });
    await expect(newTurn).toBeDisabled(); // An ambiguous write must not be bypassed by opening a fresh form.
    await newTurn.evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await expect(form.getByRole("button", { name: "Confirmar turno", exact: true })).toBeDisabled();
    await business.screenshot({ path: testInfo.outputPath("turnos-unknown-network-outcome.png"), fullPage: true });
    await business.unroute("**/api/me/appointments");
    const appointmentListRoute = /\/api\/me\/appointments(?:\?.*)?$/;
    await business.route(appointmentListRoute, route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(screen.getByText("Actualizando turnos…", { exact: true })).toHaveCount(0);
    await expect(uncertaintyWarning).toBeVisible();
    await expect(newTurn).toBeDisabled();
    await business.unroute(appointmentListRoute);
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(screen.getByText("Actualizando turnos…", { exact: true })).toHaveCount(0);
    // Successful absence from the list still cannot establish rollback of an in-flight write.
    await expect(uncertaintyWarning).toBeVisible();
    await expect(newTurn).toBeDisabled();
    await dayList.getByRole("button", { name: /Clara López/ }).click();
    await expect(detail.getByText("Guardado antes del GET", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toBeEnabled();
    await expect(uncertaintyWarning).toBeVisible();
    await expect(newTurn).toBeDisabled();
    // Navigation remounts the screen but remains in the same authenticated business scope.
    await business.goto(`${system.webUrl}/profile`);
    await business.goto(`${system.webUrl}/turnos`);
    await expect(uncertaintyWarning).toBeVisible();
    await expect(newTurn).toBeDisabled();
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await expect(dayList.getByRole("listitem")).toHaveCount(1);
    expect(post).toBe(1);
    expect(patch).toBe(1);
    expect(await setup.read("clients")).toHaveLength(1); // This routed abort did not reach persistence.
    await business.screenshot({ path: testInfo.outputPath("turnos-uncertainty-readonly-inspection.png"), fullPage: true });
    await screen.getByRole("button", { name: "Consultar resultado guardado", exact: true }).click();
    await expect(screen.getByText(/Todavía no hay una recepción confirmada/)).toBeVisible();
    await expect(newTurn).toBeDisabled();
    expect(post).toBe(1);
    await screen.getByRole("button", { name: "Cancelar solicitud pendiente", exact: true }).click();
    await expect(screen.getByText(/No cancela un turno ni revierte/)).toBeVisible();
    const fenceResponse = business.waitForResponse(response => response.request().method() === "POST" && /appointment-operations\/.*\/cancel$/.test(response.url()));
    await screen.getByRole("button", { name: "Confirmar cancelación de solicitud", exact: true }).click();
    expect((await fenceResponse).status()).toBe(200);
    await expect(newTurn).toBeEnabled();
    await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toHaveCount(0);
    expect(lostCreate).not.toBeNull();
    const lost = lostCreate as unknown as { key: string; body: object };
    const late = await business.request.post(`${system.webUrl}/api/me/appointments`, {
      headers: { ...setup.headers, "x-appointment-operation-key": lost.key }, data: lost.body,
    });
    expect(late.status()).toBe(409);
    expect(await setup.read("clients")).toHaveLength(1);
    expect(await setup.read("appointments")).toHaveLength(1);
    expect(post).toBe(1);

    // Delayed detail completion cannot revive the former session after logout.
    let releaseDetail!: () => void;
    const heldDetail = new Promise<void>(resolve => { releaseDetail = resolve; });
    let detailCompleted!: () => void, detailRejected!: (error: unknown) => void;
    const detailCompletion = new Promise<void>((resolve, reject) => {
      detailCompleted = resolve; detailRejected = reject;
    });
    let logoutAsserted = false;
    await business.route(`**/api/me/appointments/${saved.id}`, async route => {
      await heldDetail;
      try {
        await route.continue();
        detailCompleted();
      } catch (error) {
        if (logoutAsserted && error instanceof Error && error.message === "route.continue: Route is already handled!")
          detailCompleted();
        else detailRejected(error);
      }
    });
    await dayList.getByRole("button", { name: /Clara López/ }).click();
    await expect(screen.getByText("Actualizando detalle…", { exact: true })).toBeVisible();
    await business.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
    await expect(business).toHaveURL(system.webUrl + "/");
    logoutAsserted = true;
    releaseDetail();
    await detailCompletion;
    await business.unroute(`**/api/me/appointments/${saved.id}`);
    await login(business, system.webUrl, setup.email, setup.password);
    await expect(business).toHaveURL(/\/profile$/);
    await business.goto(`${system.webUrl}/turnos`);
    await expect(screen.getByRole("region", { name: "Detalle del turno", exact: true })).toHaveCount(0);
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await expect(dayList.getByRole("listitem")).toHaveCount(1);
    await dayList.getByRole("button", { name: /Clara López/ }).click();
    await expect(detail.getByText("Guardado antes del GET", { exact: true })).toBeVisible();
    expect(post).toBe(1);
    // Platform administrators are denied the business-only route, even if they know the URL.
    await page.goto(`${system.webUrl}/turnos`);
    await expect(page.locator('main[data-state="denied"]')).toBeVisible();
  } finally { await context.close(); }
});

test("Turnos uncapped all-state calendars and clock locks with UI-mocked attendance; real tenant isolation", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    const setup = await provision(page, business, system, "turnos-calendar");
    const { client, service, resource, date, offer } = setup;
    const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    await page.getByLabel("Nombre", { exact: true }).fill("Turnos otra identidad");
    await page.getByLabel("Correo del usuario", { exact: true }).fill("turnos-other@example.test");
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(setup.password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Turnos otra identidad", exact: true })).toBeVisible();
    await login(other, system.webUrl, "turnos-other@example.test", setup.password);
    await expect(other).toHaveURL(/\/profile$/);
    await other.goto(`${system.webUrl}/turnos`);
    await expect(other.getByText("No hay turnos para esta fecha.", { exact: true })).toBeVisible();
    const foreign = await other.request.get(`${system.webUrl}/api/me/appointments/${saved.id}`);
    expect(foreign.status()).toBe(404);
    const foreignList = await other.request.get(`${system.webUrl}/api/me/appointments`);
    expect(foreignList.status()).toBe(200);
    expect(await foreignList.json()).toEqual([]);
    const clock = Date.now();
    await business.clock.install({ time: new Date(clock) });
    const startMs = clock + 120000;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(clock));
    let projection = { ...saved, startMs, endMs: startMs + 1800000, startsAt: new Date(startMs).toISOString() };
    const many = Array.from({ length: 105 }, (_, index) => ({ ...projection,
      id: index === 0 ? saved.id : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      client: index === 0 ? saved.client : { ...saved.client, firstName: `Ejemplo ${index}` },
      state: index === 0 ? "confirmed" : ["confirmed", "cancelled", "done", "no_show"][index % 4],
    }));
    let patch = 0;
    await business.route("**/api/me/appointments?*", route => route.fulfill({ json: many }));
    await business.route(`**/api/me/appointments/${saved.id}`, route => route.fulfill({ json: projection }));
    await business.route(`**/api/me/appointments/${saved.id}/state`, async route => {
      patch++;
      const body = route.request().postDataJSON();
      expect(body).toEqual({ state: "done", confirmed: true });
      projection = { ...projection, state: "done" };
      many[0] = projection;
      await route.fulfill({ json: projection }); // UI-only: no real past appointment can be created through this API.
    });
    await business.goto(`${system.webUrl}/turnos`);
    const screen = business.getByRole("main");
    const todayList = screen.getByRole("list", { name: `Turnos ${today}`, exact: true });
    await expect(todayList.getByRole("listitem")).toHaveCount(105);
    await expect(todayList.getByText("Cancelado", { exact: true })).toHaveCount(26);
    await expect(todayList.getByText("Completado", { exact: true })).toHaveCount(26);
    await expect(todayList.getByText("Ausente", { exact: true })).toHaveCount(26);
    await expect(todayList.getByText("Recurso de prueba", { exact: true })).toHaveCount(0);
    await todayList.getByRole("button", { name: /Clara López/ }).click();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByText("Recurso de prueba", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Marcar completado", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Marcar ausente", exact: true })).toBeDisabled();
    await business.clock.setSystemTime(new Date(startMs));
    await business.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Cancelar turno", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Marcar completado", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Marcar ausente", exact: true })).toBeEnabled();
    expect(patch).toBe(0); // The clock must never transition attendance automatically.
    await business.screenshot({ path: testInfo.outputPath("turnos-started-lock-attendance-mocked.png"), fullPage: true });
    await detail.getByRole("button", { name: "Marcar completado", exact: true }).click();
    await detail.getByRole("button", { name: "Volver sin cambiar", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Marcar completado", exact: true })).toBeFocused();
    expect(patch).toBe(0);
    await detail.getByRole("button", { name: "Marcar completado", exact: true }).click();
    await detail.getByRole("button", { name: "Confirmar estado", exact: true }).click();
    await expect(detail.getByText("Completado", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button")).toHaveCount(0);
    expect(patch).toBe(1);
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await expect(todayList.getByRole("listitem")).toHaveCount(105);
    await expect(screen.getByRole("heading", { level: 2 }).filter({ hasNotText: "Clara López" })).toHaveCount(7);
    await screen.getByRole("button", { name: "Anterior", exact: true }).click();
    await expect(todayList).toHaveCount(0);
    await screen.getByRole("button", { name: "Volver a hoy", exact: true }).click();
    await expect(todayList.getByRole("listitem")).toHaveCount(105);
    await screen.getByRole("button", { name: "Mes", exact: true }).click();
    const month = screen.getByRole("group", { name: "Días del mes", exact: true });
    await expect(month.getByRole("button", { name: `${Number(today.slice(-2))} 105 turnos`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(todayList.getByRole("listitem")).toHaveCount(105);
    await business.setViewportSize({ width: 360, height: 900 });
    await business.screenshot({ path: testInfo.outputPath("turnos-uncapped-mobile-mocked.png"), fullPage: true });
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); await otherContext.close(); }
});

test("Turnos mounted read recovery resolves a persisted PATCH without blocking unrelated writes", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const setup = await provision(page, business, system, "turnos-uncertain-patch");
    const { client, service, resource, date, offer } = setup;
    const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    await business.goto(`${system.webUrl}/turnos`);
    const screen = business.getByRole("main");
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    const row = screen.getByRole("list", { name: `Turnos ${date}`, exact: true }).getByRole("button", { name: /Clara López/ });
    await row.click();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    const notes = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
    await notes.getByLabel("Notas del turno", { exact: true }).fill("Persistió sin respuesta al navegador");
    let writes = 0;
    business.on("request", request => {
      if (["POST", "PATCH"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/me/appointments")) writes++;
    });
    await business.route(`**/api/me/appointments/${saved.id}/notes`, async route => {
      const response = await route.fetch(); // The actual API commits before the browser loses the response.
      expect(response.status()).toBe(200);
      expect((await response.json()).notes).toBe("Persistió sin respuesta al navegador");
      await route.abort("failed");
    });
    await notes.getByRole("button", { name: "Guardar notas", exact: true }).click();
    const warning = screen.locator(':scope > [role="alert"]').filter({ hasText: "El turno podría haberse guardado" });
    await expect(warning).toBeVisible();
    expect((await setup.read(`appointments/${saved.id}`)).notes).toBe("Persistió sin respuesta al navegador");
    expect(writes).toBe(1);
    await business.unroute(`**/api/me/appointments/${saved.id}/notes`);
    const newTurn = screen.getByRole("button", { name: "Nuevo turno", exact: true });
    await expect(newTurn).toBeEnabled(); // A PATCH on one record does not block unrelated create intents.
    // A second real appointment remains writable while the first PATCH outcome is unresolved.
    const nextOffer = setup.offers.find((slot: { startMs: number }) => slot.startMs >= offer.endMs);
    const unrelatedClient = await setup.create("clients", { firstName: "Otro", lastName: "Cliente", phone: "+5491123456774" });
    const unrelated = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: unrelatedClient.id,
      date, startRaw: nextOffer.start, expectedTerms: nextOffer.terms, confirmed: true });
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    const otherRow = screen.getByRole("list", { name: `Turnos ${date}`, exact: true }).getByRole("button", { name: /Otro Cliente/ });
    await otherRow.click();
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    await notes.getByLabel("Notas del turno", { exact: true }).fill("Cambio independiente");
    const otherSaved = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${unrelated.id}/notes`));
    await notes.getByRole("button", { name: "Guardar notas", exact: true }).click();
    expect((await otherSaved).status()).toBe(200);
    expect((await setup.read(`appointments/${unrelated.id}`)).notes).toBe("Cambio independiente");
    expect(writes).toBe(2);
    await row.click(); // Read-only selection must not erase uncertainty.
    await expect(detail.getByText("Persistió sin respuesta al navegador", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Cancelar turno", exact: true })).toBeDisabled();
    await expect(warning).toBeVisible();
    let detailGET = 0;
    await business.route(`**/api/me/appointments/${saved.id}`, async route => {
      detailGET++;
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
    });
    await row.click();
    await expect(screen.getByText("Actualizando detalle…", { exact: true })).toHaveCount(0);
    expect(detailGET).toBe(1);
    await expect(warning).toBeVisible();
    await expect(newTurn).toBeEnabled();
    expect(writes).toBe(2);
    await business.unroute(`**/api/me/appointments/${saved.id}`);
    await row.click();
    await expect(screen.getByText("Actualizando detalle…", { exact: true })).toHaveCount(0);
    await expect(detail.getByText("Persistió sin respuesta al navegador", { exact: true })).toBeVisible();
    await expect(warning).toBeVisible();
    await expect(newTurn).toBeEnabled();
    expect(writes).toBe(2); // Domain GET alone does not authorize repeating this record's write.
    await business.screenshot({ path: testInfo.outputPath("turnos-persisted-patch-uncertainty.png"), fullPage: true });
    await business.reload();
    await expect(warning).toBeVisible();
    await expect(newTurn).toBeEnabled();
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await row.click();
    await expect(detail.getByText("Persistió sin respuesta al navegador", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeDisabled();
    expect(writes).toBe(2);
    await screen.getByRole("button", { name: "Consultar resultado guardado", exact: true }).click();
    await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeEnabled();
    await expect(warning).toHaveCount(0);
    expect(writes).toBe(2);
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    await notes.getByLabel("Notas del turno", { exact: true }).fill("Nuevo cambio tras recepción confirmada");
    const nextSave = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}/notes`));
    await notes.getByRole("button", { name: "Guardar notas", exact: true }).click();
    expect((await nextSave).status()).toBe(200);
    await expect(detail.getByText("Nuevo cambio tras recepción confirmada", { exact: true })).toBeVisible();
    expect(writes).toBe(3);
  } finally { await context.close(); }
});

test("Turnos stale receipt never replaces current state and requires GET-only freshness recovery", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  for (const inspected of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const business = await context.newPage();
    try {
      const setup = await provision(page, business, system, `stale-receipt-${inspected}`);
      const { client, service, resource, date, offer } = setup;
      const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
        date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
      await business.goto(`${system.webUrl}/turnos`);
      const screen = business.getByRole("main");
      await screen.getByRole("button", { name: "Semana", exact: true }).click();
      const row = screen.getByRole("list", { name: `Turnos ${date}`, exact: true }).getByRole("button", { name: /Clara López/ });
      await row.click();
      const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
      await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
      const form = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
      await form.getByLabel("Notas del turno", { exact: true }).fill("Historical receipt notes");
      let writes = 0;
      business.on("request", request => { if (request.method() === "PATCH") writes++; });
      let lossCompleted!: () => void, lossRejected!: (cause: unknown) => void;
      const lossCompletion = new Promise<void>((resolve, reject) => { lossCompleted = resolve; lossRejected = reject; });
      await business.route(`**/api/me/appointments/${saved.id}/notes`, async route => {
        try {
          const committed = await route.fetch(); expect(committed.status()).toBe(200);
          await route.abort("failed"); lossCompleted();
        } catch (cause) { lossRejected(cause); }
      });
      await form.getByRole("button", { name: "Guardar notas", exact: true }).click();
      await lossCompletion;
      await expect(screen.locator(':scope > [role="alert"]').filter({ hasText: "El turno podría haberse guardado" })).toBeVisible();
      await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toBeVisible();
      await business.unroute(`**/api/me/appointments/${saved.id}/notes`);
      // Another authenticated session advances the record after the receipt was committed.
      const other = await browser.newContext();
      try {
        const otherPage = await other.newPage();
        await login(otherPage, system.webUrl, setup.email, setup.password);
        await expect(otherPage).toHaveURL(/\/profile$/);
        const csrf = await otherPage.evaluate(() => sessionStorage.getItem("agendia.csrf"));
        const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
        const note = await otherPage.request.patch(`${system.webUrl}/api/me/appointments/${saved.id}/notes`, { headers, data: { notes: "Current newer notes" } });
        expect(note.status()).toBe(200);
        const cancel = await otherPage.request.patch(`${system.webUrl}/api/me/appointments/${saved.id}/state`, { headers, data: { state: "cancelled", confirmed: true } });
        expect(cancel.status()).toBe(200);
      } finally { await other.close(); }
      if (inspected) {
        await row.click();
        await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
        await expect(detail.getByText("Current newer notes", { exact: true })).toBeVisible();
      }
      await business.route(`**/api/me/appointments/${saved.id}`, route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
      await business.route("**/api/me/appointments?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
      await screen.getByRole("button", { name: "Consultar resultado guardado", exact: true }).click();
      await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toHaveCount(0);
      await expect(screen.getByText(/No pudimos verificar el estado actual del turno/)).toBeVisible();
      if (inspected) {
        await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
        await expect(detail.getByText("Current newer notes", { exact: true })).toBeVisible();
        await expect(detail.getByText("Historical receipt notes", { exact: true })).toHaveCount(0);
      } else {
        await expect(detail.getByText("Confirmado", { exact: true })).toBeVisible();
        await expect(detail.getByText("Sin notas", { exact: true })).toBeVisible(); // Retained saved projection, not the editor draft.
        const retainedEditor = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
        const draft = retainedEditor.getByLabel("Notas del turno", { exact: true });
        await expect(draft).toHaveValue("Historical receipt notes"); // User input is retained, never installed as current saved notes.
        await expect(draft).toBeDisabled();
        await expect(retainedEditor.getByRole("button", { name: "Guardar notas", exact: true })).toBeDisabled();
        await expect(retainedEditor.getByRole("button", { name: "Cancelar notas", exact: true })).toBeDisabled();
        for (const name of ["Cancelar turno", "Marcar completado", "Marcar ausente"])
          await expect(detail.getByRole("button", { name, exact: true })).toBeDisabled();
        await expect(detail.locator("dt").filter({ hasText: /^Notas$/ }).locator("+ dd")).toHaveText("Sin notas");
        await expect(detail.locator("dl").getByText("Historical receipt notes", { exact: true })).toHaveCount(0);
      }
      await expect(screen.getByRole("button", { name: "Nuevo turno", exact: true })).toBeEnabled();
      expect(writes).toBe(1);
      await business.screenshot({ path: testInfo.outputPath(`stale-receipt-${inspected}-get-fault.png`), fullPage: true });
      await business.unroute(`**/api/me/appointments/${saved.id}`);
      await business.unroute("**/api/me/appointments?*");
      await screen.getByRole("button", { name: "Actualizar estado actual", exact: true }).click();
      await expect(screen.getByText(/No pudimos verificar el estado actual del turno/)).toHaveCount(0);
      await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
      await expect(detail.getByText("Current newer notes", { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toHaveCount(0);
      expect(writes).toBe(1);
      await business.screenshot({ path: testInfo.outputPath(`stale-receipt-${inspected}-fresh.png`), fullPage: true });
    } finally { await context.close(); }
  }
});

test("Turnos mounted read recovery resolves atomic new-client POST response loss with one saved booking", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const setup = await provision(page, business, system, "turnos-lost-create");
    await business.goto(`${system.webUrl}/turnos`);
    const screen = business.getByRole("main");
    await screen.getByRole("button", { name: "Nuevo turno", exact: true }).click();
    const form = screen.getByRole("form", { name: "Crear turno", exact: true });
    await form.getByLabel("Origen del cliente", { exact: true }).selectOption("new");
    await form.getByLabel("Nombre", { exact: true }).fill("Nueva");
    await form.getByLabel("Apellido", { exact: true }).fill("Guardada");
    await form.getByLabel("Teléfono", { exact: true }).fill("11 23456773");
    await form.getByLabel("Servicio", { exact: true }).selectOption(setup.service.id);
    await form.getByLabel("Recurso", { exact: true }).selectOption(setup.resource.id);
    await form.getByLabel("Fecha", { exact: true }).fill(setup.date);
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await form.getByLabel("Horario disponible", { exact: true }).selectOption(setup.offer.start);
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    let post = 0, key = "", savedId = "";
    business.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/me/appointments") post++; });
    await business.route("**/api/me/appointments", async route => {
      key = route.request().headers()["x-appointment-operation-key"]!;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      savedId = (await response.json()).id;
      await route.abort("failed");
    });
    await form.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("El turno podría haberse guardado");
    expect(post).toBe(1);
    expect(await setup.read("appointments")).toHaveLength(1);
    expect(await setup.read("clients")).toHaveLength(2);
    await business.unroute("**/api/me/appointments");
    await expect(screen.getByRole("button", { name: "Nuevo turno", exact: true })).toBeDisabled();
    const receiptResponse = business.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/appointment-operations/${key}`));
    await screen.getByRole("button", { name: "Consultar resultado guardado", exact: true }).click();
    const receipt = await receiptResponse;
    expect(receipt.status()).toBe(200);
    expect(await receipt.json()).toMatchObject({ state: "completed", appointment: { id: savedId } });
    await expect(form).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Nuevo turno", exact: true })).toBeEnabled();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByRole("heading", { name: "Nueva Guardada", exact: true })).toBeFocused();
    await expect(detail.getByText("Confirmado", { exact: true })).toBeVisible();
    await expect(screen.getByText("Turno guardado", { exact: true })).toBeVisible();
    expect(post).toBe(1);
    expect(await setup.read("appointments")).toHaveLength(1);
    expect(await setup.read("clients")).toHaveLength(2);
    await business.screenshot({ path: testInfo.outputPath("turnos-create-receipt-recovered.png"), fullPage: true });
    await business.reload();
    await expect(screen.getByRole("button", { name: "Nuevo turno", exact: true })).toBeEnabled();
    await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toHaveCount(0);
    expect(post).toBe(1);
  } finally { await context.close(); }
});
