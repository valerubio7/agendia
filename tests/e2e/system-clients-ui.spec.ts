import { expect, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

test("Clientes searches and edits owned identities with complete appointment history and safe recovery", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const password = "clients UI tenant password", email = "clients-ui@example.test";
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  await page.getByLabel("Nombre", { exact: true }).fill("Estudio Clientes");
  await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
  await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Estudio Clientes", exact: true })).toBeVisible();
  await page.getByLabel("Nombre", { exact: true }).fill("Otro negocio clientes");
  await page.getByLabel("Correo del usuario", { exact: true }).fill("other-clients@example.test");
  await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Otro negocio clientes", exact: true })).toBeVisible();
  await page.goto(`${system.webUrl}/clients`);
  await expect(page.locator('main[data-state="denied"]')).toBeVisible();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    await login(business, system.webUrl, email, password);
    await expect(business).toHaveURL(/\/profile$/);
    const navigation = business.getByRole("navigation", { name: "Navegación del negocio", exact: true });
    await expect(navigation.getByRole("link", { name: "Clientes", exact: true })).toBeVisible();
    await navigation.getByRole("link", { name: "Clientes", exact: true }).click();
    const screen = business.getByRole("main");
    await expect(screen.getByRole("heading", { name: "Clientes", exact: true })).toBeVisible();
    await expect(screen.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
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
    const client = await create("clients", { firstName: "Ana %_\\\\", lastName: "Pérez", phone: "+5491123456789" });
    const second = await create("clients", { firstName: "Bruno", lastName: "Díaz", phone: "+5491123456788" });
    const full = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
    const calendar = await business.request.put(`${system.webUrl}/api/me/business-calendar`, { headers, data: { weeklySchedule: full } });
    expect(calendar.status()).toBe(200);
    const service = await create("services", { name: "Consulta original", durationMinutes: 30, priceArs: 1250.5 });
    const resource = await create("resources", { name: "Profesional original", serviceIds: [service.id], weeklySchedule: full });
    const date = new Date(Date.now() + 7 * 86400000 - 3 * 3600000).toISOString().slice(0, 10);
    const slots = await read(`appointments/availability?${new URLSearchParams({ serviceId: service.id, resourceId: resource.id, date })}`);
    const firstSlot = slots.find((slot: { startMs: number }) => slot.startMs >= Date.parse(`${date}T10:00:00-03:00`));
    expect(firstSlot).toBeDefined();
    const selectedSlots = [firstSlot, slots.find((slot: { startMs: number }) => slot.startMs >= firstSlot.endMs)];
    expect(selectedSlots).toHaveLength(2);
    const appointments = [];
    for (const slot of selectedSlots) appointments.push(await create("appointments", {
      date, serviceId: service.id, resourceId: resource.id, clientId: client.id,
      startRaw: slot.start, expectedTerms: slot.terms, confirmed: true,
    }));
    const cancelled = await business.request.patch(`${system.webUrl}/api/me/appointments/${appointments[1].id}/state`, {
      headers, data: { state: "cancelled", confirmed: true },
    });
    expect(cancelled.status()).toBe(200);
    appointments[1] = await cancelled.json();
    const rename = await business.request.put(`${system.webUrl}/api/me/services/${service.id}`, {
      headers, data: { name: "Consulta actual", durationMinutes: 45, priceArs: 9000 },
    });
    expect(rename.status()).toBe(200);
    await business.reload();
    const list = screen.getByRole("list", { name: "Clientes del negocio", exact: true });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    const search = screen.getByRole("form", { name: "Buscar clientes", exact: true });
    const runSearch = async (value: string, count: number) => {
      await search.getByLabel("Nombre o teléfono").fill(value);
      await search.getByRole("button", { name: "Buscar", exact: true }).click();
      await expect(screen.getByText("Cargando clientes…", { exact: true })).toHaveCount(0);
      await expect(list.getByRole("listitem")).toHaveCount(count);
    };
    await runSearch("  %_\\\\  ", 1); // Literal wildcards/backslash through the real API.
    await runSearch("23456789", 1);
    await runSearch("no existe", 0);
    await expect(screen.getByText("No hay clientes que coincidan.", { exact: true })).toBeVisible();
    await runSearch("", 2);
    await list.getByRole("button", { name: /Ana/ }).click();
    const detail = screen.getByRole("region", { name: "Cliente seleccionado", exact: true });
    const upcoming = detail.getByRole("list", { name: "Próximos turnos", exact: true });
    const history = detail.getByRole("list", { name: "Historial completo", exact: true });
    await expect(upcoming.getByRole("listitem")).toHaveCount(1);
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(history.getByText("Consulta original", { exact: true })).toHaveCount(2);
    await expect(history.getByText("Profesional original · Cancelado", { exact: true })).toBeVisible();
    await expect(history.getByText(/30 min/)).toHaveCount(2);
    await expect(detail.getByText("Consulta actual", { exact: true })).toHaveCount(0);
    const counts = { PUT: 0, GET: 0 };
    business.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/me/clients")) {
        if (request.method() === "PUT") counts.PUT++;
        if (request.method() === "GET") counts.GET++;
      }
    });
    const edit = detail.getByRole("button", { name: "Editar cliente", exact: true });
    await edit.click();
    const form = detail.getByRole("form", { name: "Editar cliente", exact: true });
    const save = form.getByRole("button", { name: "Guardar cambios", exact: true });
    await expect(form.getByLabel("Nombre", { exact: true })).toBeFocused();
    await form.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(edit).toBeEnabled();
    await expect(edit).toBeFocused();
    expect(counts.PUT).toBe(0);
    await edit.click();
    await form.getByLabel("Teléfono", { exact: true }).fill(second.phone);
    const conflict = business.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/clients/${client.id}`));
    await save.click();
    expect((await conflict).status()).toBe(409); // Real unique-phone conflict, not mocked persistence.
    await expect(form.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
    await expect(form.getByLabel("Teléfono", { exact: true })).toHaveValue(second.phone);
    await expect(save).toBeEnabled();
    await expect(save).toBeFocused();
    await business.screenshot({ path: testInfo.outputPath("clients-real-conflict-focus.png"), fullPage: true });
    await form.getByLabel("Nombre", { exact: true }).fill(" Alicia ");
    await form.getByLabel("Apellido", { exact: true }).fill(" Gómez ");
    await form.getByLabel("Teléfono", { exact: true }).fill("11 2345-6789");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await business.route(`**/api/me/clients/${client.id}`, async route => { await held; await route.continue(); });
    await business.route("**/api/me/clients", async route => {
      if (route.request().method() === "GET") await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
      else await route.continue();
    });
    const savedResponse = business.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/clients/${client.id}`));
    await save.click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(form.getByLabel("Nombre", { exact: true })).toBeDisabled();
    await form.evaluate(element => { element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(counts.PUT).toBe(2); // Failed real PUT plus exactly one held PUT.
    release();
    expect((await savedResponse).status()).toBe(200);
    await expect(detail.getByRole("status").filter({ hasText: /^Cliente guardado$/ })).toHaveText("Cliente guardado");
    await expect(detail.getByRole("heading", { name: "Alicia Gómez", exact: true })).toBeVisible();
    await expect(edit).toBeFocused();
    await expect(screen.getByText("El cliente se guardó, pero no pudimos actualizar la lista.", { exact: true })).toBeVisible();
    expect(counts.PUT).toBe(2);
    await business.screenshot({ path: testInfo.outputPath("clients-saved-refresh-warning.png"), fullPage: true });
    await business.unroute(`**/api/me/clients/${client.id}`);
    await business.unroute("**/api/me/clients");
    const beforeRetry = { ...counts };
    await screen.getByRole("button", { name: "Actualizar clientes", exact: true }).click();
    await expect(screen.getByText("El cliente se guardó, pero no pudimos actualizar la lista.", { exact: true })).toHaveCount(0);
    expect(counts).toEqual({ PUT: beforeRetry.PUT, GET: beforeRetry.GET + 1 });
    const persisted = (await read("clients")).find((row: { id: string }) => row.id === client.id);
    expect(persisted).toEqual({ id: client.id, firstName: "Alicia", lastName: "Gómez", phone: "+5491123456789" });
    const afterHistory = await read(`appointments?clientId=${client.id}`);
    expect(afterHistory).toEqual(appointments.map(row => ({ ...row, client: persisted })));
    await business.reload();
    await runSearch("Alicia", 1);
    await list.getByRole("button", { name: /Alicia/ }).click();
    await expect(history.getByRole("listitem")).toHaveCount(2);

    // UI-only projection fixture: all states, strict future boundary and uncapped history.
    // These records are NOT claimed as API-persisted appointments.
    const projection = Array.from({ length: 105 }, (_, i) => ({ ...afterHistory[0], id: `projection-${i}`,
      state: ["confirmed", "done", "cancelled", "no_show"][i % 4], startMs: afterHistory[0].startMs + (i - 4) * 60000 }));
    await business.clock.setFixedTime(new Date(afterHistory[0].startMs));
    await business.evaluate(() => window.dispatchEvent(new Event("focus")));
    await business.route("**/api/me/appointments?*", route => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(projection),
    }));
    await list.getByRole("button", { name: /Alicia/ }).click();
    await expect(history.getByRole("listitem")).toHaveCount(105);
    await expect(upcoming.getByRole("listitem")).toHaveCount(projection.filter(row => row.state === "confirmed" && row.startMs > afterHistory[0].startMs).length);
    for (const state of ["Confirmado", "Completado", "Cancelado", "Ausente"]) await expect(history.getByText(new RegExp(state)).first()).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("clients-history-all-states.png"), fullPage: true });
    await business.unroute("**/api/me/appointments?*");
    await business.route("**/api/me/appointments?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await list.getByRole("button", { name: /Alicia/ }).click();
    await expect(detail.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await business.unroute("**/api/me/appointments?*");
    await detail.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(detail.getByRole("alert")).toHaveCount(0);
    await runSearch("", 2);
    let releaseDetail!: () => void;
    const staleDetail = new Promise<void>(resolve => { releaseDetail = resolve; });
    await business.route(`**/api/me/appointments?clientId=${client.id}`, async route => { await staleDetail; await route.continue(); });
    await list.getByRole("button", { name: /Alicia/ }).click();
    await expect(detail.getByText("Cargando turnos…", { exact: true })).toBeVisible();
    await list.getByRole("button", { name: /Bruno/ }).click();
    await expect(detail.getByRole("heading", { name: "Bruno Díaz", exact: true })).toBeVisible();
    releaseDetail();
    await expect(detail.getByText("Cargando turnos…", { exact: true })).toHaveCount(0);
    await expect(detail.getByRole("list")).toHaveCount(0);
    await business.unroute(`**/api/me/appointments?clientId=${client.id}`);
    await runSearch("", 2);
    await list.getByRole("button", { name: /Alicia/ }).click();
    await expect(history.getByRole("listitem")).toHaveCount(2);
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`clients-ready-${width}.png`), fullPage: true });
    }
    await business.locator('[data-ui="mobile-navigation"] summary').click();
    await expect(business.getByRole("navigation", { name: "Navegación móvil del negocio", exact: true }).getByRole("link", { name: "Clientes", exact: true })).toHaveAttribute("aria-current", "page");
    const otherContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await login(other, system.webUrl, "other-clients@example.test", password);
      await expect(other).toHaveURL(/\/profile$/);
      await other.goto(`${system.webUrl}/clients`);
      await expect(other.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
      const otherCsrf = await other.evaluate(() => sessionStorage.getItem("agendia.csrf"));
      const foreign = await other.request.put(`${system.webUrl}/api/me/clients/${client.id}`, {
        headers: { Origin: system.webUrl, "x-csrf-token": otherCsrf! },
        data: { firstName: "Ajeno", lastName: "Ajeno", phone: client.phone },
      });
      expect(foreign.status()).toBe(404);
      expect(await (await other.request.get(`${system.webUrl}/api/me/appointments?clientId=${client.id}`)).json()).toEqual([]);
    } finally { await otherContext.close(); }
  } finally {
    await context.close();
  }
});
