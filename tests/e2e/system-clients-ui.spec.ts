import { pathToFileURL } from "node:url";
import { expect, type Locator, type Request } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

async function settledBox(surface: Locator) {
  await expect(surface).toBeVisible();
  return surface.evaluate(async element => {
    // The dialog scales on open; the reference shell also animates its inset on resize.
    element.getBoundingClientRect();
    const animations: Animation[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      animations.push(...node.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity));
    }
    await Promise.all(animations.map(animation => animation.finished));
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
}

test("Clientes searches and edits owned identities with complete appointment history and safe recovery", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const password = "clients UI tenant password", email = "clients-ui@example.test";
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/solicitudes$/);
  await createBusinessInAdminUi(page, { name: "Estudio Clientes", email, password });
  await createBusinessInAdminUi(page, { name: "Otro negocio clientes", email: "other-clients@example.test", password });
  await page.goto(`${system.webUrl}/clients`);
  await expect(page.locator('main[data-state="denied"]')).toBeVisible();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    await login(business, system.webUrl, email, password);
    await expect(business).toHaveURL(/\/inicio$/);
    await business.goto(`${system.webUrl}/profile`);
    const hub = business.getByRole("navigation", { name: "Gestión del negocio", exact: true });
    const screen = business.getByRole("main");
    for (const entry of ["warm", "cold"]) {
      let observeList!: () => void, releaseList!: () => void;
      const listRequested = new Promise<void>(resolve => { observeList = resolve; });
      const listHeld = new Promise<void>(resolve => { releaseList = resolve; });
      await business.route("**/api/me/clients", async route => {
        observeList();
        await listHeld;
        await route.continue();
      }, { times: 1 });
      try {
        if (entry === "warm") await hub.getByRole("link", { name: "Clientes", exact: true }).click();
        else await business.reload();
        await expect(business).toHaveURL(/\/clients$/);
        await listRequested;
        await expect(screen.getByRole("heading", { name: "Clientes", exact: true })).toBeVisible();
        const directory = screen.getByRole("region", { name: "Directorio de clientes" });
        await expect(directory.getByRole("form", { name: "Buscar clientes" })).toBeVisible();
        await expect(directory).toHaveAttribute("aria-busy", "true", { timeout: 2_000 });
        await expect(business.getByText(/Cargando (panel|sección|clientes)…|Todavía no hay clientes\./)).toHaveCount(0);
      } finally { releaseList(); }
      await expect(screen.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
    }
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
    const create = async (path: string, data: object) => {
      const response = await business.request.post(`${system.webUrl}/api/me/${path}`, { headers, data });
      expect(response.status()).toBe(201);
      return response.json();
    };
    const read = async (path: string) => {
      const response = await business.request.get(`${system.webUrl}/api/me/${path}`, { maxRetries: 1 });
      expect(response.status()).toBe(200);
      return response.json();
    };
    const second = await create("clients", { name: "Bruno Díaz", phone: "+5491123456788" });
    const client = await create("clients", { name: "Ana %_\\\\ Pérez", phone: "+5491123456789" });
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
    // Prototype coordinates minus its 49 px demo banner.
    for (const [width, inset, top, rowHeight] of [[1280, 274, 79.4, 74], [360, 14, 117.4, 103]] as const) {
      await business.setViewportSize({ width, height: 900 });
      const directory = screen.getByRole("region", { name: "Directorio de clientes" });
      await expect(directory).toBeVisible();
      const box = (await directory.boundingBox())!;
      expect(box.x).toBe(inset);
      expect(Math.abs(box.y - top)).toBeLessThan(1);
      expect(box.width).toBe(width - inset - (width === 1280 ? 52 : 14));
      expect((await list.getByRole("button").first().boundingBox())?.height).toBe(rowHeight);
    }
    await business.setViewportSize({ width: 1280, height: 900 });
    const search = screen.getByRole("form", { name: "Buscar clientes", exact: true });
    const panel = screen.getByRole("dialog");
    const closePanel = async () => {
      if (await panel.isVisible()) await panel.getByRole("button", { name: "Cerrar panel" }).click();
    };
    const openClient = async (name: RegExp) => {
      await closePanel();
      await list.getByRole("button", { name }).click();
    };
    const runSearch = async (value: string, count: number) => {
      await closePanel();
      await search.getByLabel("Nombre o teléfono").fill(value);
      await search.getByRole("button", { name: "Buscar", exact: true }).click();
      await expect(screen.getByRole("region", { name: "Directorio de clientes" })).not.toHaveAttribute("aria-busy", "true");
      await expect(screen.getByText("Cargando clientes…", { exact: true })).toHaveCount(0);
      await expect(list.getByRole("listitem")).toHaveCount(count);
    };
    await runSearch("  %_\\\\  ", 1); // Literal wildcards/backslash through the real API.
    await runSearch(client.name, 1);
    await expect(list.getByRole("button").first()).toContainText(client.name);
    await runSearch("23456789", 1);
    await expect(list.getByRole("button").first()).toContainText(client.name);
    await runSearch("no existe", 0);
    await expect(screen.getByText("No hay clientes que coincidan.", { exact: true })).toBeVisible();
    await runSearch("", 2);
    await expect(list.getByRole("button").nth(0)).toContainText(client.name);
    await expect(list.getByRole("button").nth(1)).toContainText(second.name);
    await openClient(/Ana/);
    const detail = screen.getByRole("region", { name: "Cliente seleccionado", exact: true });
    const upcoming = detail.getByRole("list", { name: "Próximos turnos", exact: true });
    const history = detail.getByRole("list", { name: "Historial completo", exact: true });
    await expect(upcoming.getByRole("listitem")).toHaveCount(1);
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(history.getByText("Consulta original", { exact: true })).toHaveCount(2);
    const cancelledRow = history.getByRole("listitem").filter({ hasText: "Cancelado" });
    await expect(cancelledRow).toContainText("Profesional original");
    await expect(history.getByText(/30 min/)).toHaveCount(2);
    await expect(detail.getByText("Consulta actual", { exact: true })).toHaveCount(0);
    // Keep real stored records and move only the browser's date beyond their range.
    await business.clock.setFixedTime(new Date(appointments[1].endMs + 2 * 86400000));
    await business.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(upcoming).toHaveCount(0);
    const handoffRequests: string[] = [];
    const record = (request: Request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/me/") && (!/^(GET|HEAD)$/.test(request.method()) || /^\/api\/me\/appointments\//.test(path)))
        handoffRequests.push(`${request.method()} ${path}`);
    };
    business.on("request", record);
    const savedDialog = business.getByRole("dialog", { name: "Detalle del turno", exact: true });
    for (const [width, index] of [[1280, 1], [360, 0]] as const) {
      await business.setViewportSize({ width, height: 900 });
      const appointment = appointments[index];
      const trigger = history.getByRole("button", { name: index ? /Cancelado/ : /Confirmado/ });
      await expect(trigger).toBeEnabled();
      await trigger.focus();
      await business.keyboard.press("Enter");
      const saved = savedDialog.getByRole("region", { name: "Detalle del turno", exact: true });
      await expect(saved.getByRole("heading", { name: /Ana/ })).toBeFocused();
      await expect(saved.locator("time")).toHaveAttribute("datetime", appointment.startsAt);
      await expect(saved.getByText(index ? "Cancelado" : "Confirmado", { exact: true })).toBeVisible();
      await expect(saved).toContainText("Consulta original");
      await expect(saved).not.toContainText("Consulta actual");
      await expect(saved.getByRole("button", { name: "Modificar turno" })).toHaveCount(0);
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`client-history-detail-${width}.png`) });
      if (index) await savedDialog.getByRole("button", { name: "Cerrar ventana de turno" }).click();
      else await business.keyboard.press("Escape");
      await expect(savedDialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(detail).toBeVisible();
      await expect(business).toHaveURL(`${system.webUrl}/clients`);
    }
    expect(handoffRequests).toEqual([appointments[1], appointments[0]].map(row => `GET /api/me/appointments/${row.id}`));
    business.off("request", record);
    await business.clock.setFixedTime(new Date());
    await business.evaluate(() => window.dispatchEvent(new Event("focus")));
    await business.setViewportSize({ width: 1280, height: 900 });
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
    const save = form.getByRole("button", { name: "Guardar cliente", exact: true });
    const fullName = form.getByLabel("Nombre completo", { exact: true });
    await expect(fullName).toBeFocused();
    await expect(fullName).toHaveValue(client.name);
    await expect(form.getByLabel("Apellido", { exact: true })).toHaveCount(0);
    await form.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(edit).toBeEnabled();
    await expect(edit).toBeFocused();
    expect(counts.PUT).toBe(0);
    await edit.click();
    await form.getByLabel("Teléfono", { exact: true }).fill(second.phone);
    const conflict = business.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith(`/clients/${client.id}`));
    await save.click();
    expect((await conflict).status()).toBe(409); // Real unique-phone conflict, not mocked persistence.
    await expect(form.getByRole("alert")).toHaveText("Ya hay un cliente con ese teléfono. Usá otro teléfono.");
    await expect(form.getByLabel("Teléfono", { exact: true })).toHaveValue(second.phone);
    await expect(save).toBeEnabled();
    await expect(save).toBeFocused();
    await business.screenshot({ path: testInfo.outputPath("clients-real-conflict-focus.png"), fullPage: true });
    await fullName.fill(" Alicia Gómez ");
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
    await expect(fullName).toBeDisabled();
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
    expect(persisted).toEqual({ id: client.id, name: "Alicia Gómez", phone: "+5491123456789" });
    const afterHistory = await read(`appointments?clientId=${client.id}`);
    expect(afterHistory).toEqual(appointments.map(row => ({ ...row, client: persisted })));
    await business.reload();
    await runSearch("Alicia Gómez", 1);
    await openClient(/Alicia/);
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
    await openClient(/Alicia/);
    await expect(history.getByRole("listitem")).toHaveCount(105);
    await expect(upcoming.getByRole("listitem")).toHaveCount(projection.filter(row => row.state === "confirmed" && row.startMs > afterHistory[0].startMs).length);
    for (const state of ["Confirmado", "Completado", "Cancelado", "Ausente"]) await expect(history.getByText(new RegExp(state)).first()).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("clients-history-all-states.png"), fullPage: true });
    await business.unroute("**/api/me/appointments?*");
    await business.route("**/api/me/appointments?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await openClient(/Alicia/);
    await expect(detail.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await expect(list.getByRole("listitem", { includeHidden: true })).toHaveCount(1);
    await business.unroute("**/api/me/appointments?*");
    await detail.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(detail.getByRole("alert")).toHaveCount(0);
    await runSearch("", 2);
    let releaseDetail!: () => void;
    const staleDetail = new Promise<void>(resolve => { releaseDetail = resolve; });
    await business.route(`**/api/me/appointments?clientId=${client.id}`, async route => { await staleDetail; await route.continue(); });
    try {
      await openClient(/Alicia/);
      const historySection = detail.getByRole("region", { name: "Historial completo" });
      await expect(historySection).toHaveAttribute("aria-busy", "true", { timeout: 2_000 });
      await expect(historySection.getByRole("heading", { name: "Historial completo" })).toBeVisible();
      await expect(detail.getByText(/Cargando turnos…|todavía no tiene turnos/)).toHaveCount(0);
      await openClient(/Bruno/);
      await expect(detail.getByRole("heading", { name: "Bruno Díaz", exact: true })).toBeVisible();
    } finally { releaseDetail(); }
    await expect(detail.getByRole("region", { name: "Historial completo" })).not.toHaveAttribute("aria-busy", "true");
    await expect(detail.getByText("Cargando turnos…", { exact: true })).toHaveCount(0);
    await expect(detail.getByRole("list")).toHaveCount(0);
    await business.unroute(`**/api/me/appointments?clientId=${client.id}`);
    await runSearch("", 2);
    await openClient(/Alicia/);
    await expect(history.getByRole("listitem")).toHaveCount(2);
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`clients-ready-${width}.png`), fullPage: true });
    }
    await closePanel();
    await business.locator('[data-ui="mobile-navigation"] summary').click();
    await expect(business.getByRole("navigation", { name: "Navegación móvil del negocio", exact: true }).getByRole("link", { name: "Negocio", exact: true })).toHaveAttribute("aria-current", "location");
    await business.locator('[data-ui="mobile-navigation"] summary').press("Escape");
    await expect(business.getByRole("navigation", { name: "Ruta de navegación", exact: true }).locator('[aria-current="page"]')).toHaveText("Clientes");
    const otherContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await login(other, system.webUrl, "other-clients@example.test", password);
      await expect(other).toHaveURL(/\/inicio$/);
      await other.goto(`${system.webUrl}/clients`);
      await expect(other.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
      const otherCsrf = await other.evaluate(() => sessionStorage.getItem("agendia.csrf"));
      const foreign = await other.request.put(`${system.webUrl}/api/me/clients/${client.id}`, {
        headers: { Origin: system.webUrl, "x-csrf-token": otherCsrf! },
        data: { name: "Ajeno Ajeno", phone: client.phone },
      });
      expect(foreign.status()).toBe(404);
      expect(await (await other.request.get(`${system.webUrl}/api/me/appointments?clientId=${client.id}`)).json()).toEqual([]);
    } finally { await otherContext.close(); }
  } finally {
    await context.close();
  }
});

test("Clientes refreshes history on booking close despite a held pre-save read", async ({ browser, page: admin, system }) => {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  let release: (() => void) | undefined;
  try {
    const email = "client-history-refresh@example.test", password = "client history fixture password";
    await login(admin, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    await expect(admin).toHaveURL(/\/solicitudes$/);
    await createBusinessInAdminUi(admin, { name: "Historial de clientes", email, password });
    await login(page, system.webUrl, email, password);
    await expect(page).toHaveURL(/\/inicio$/);
    const csrf = await page.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
    const endpoint = `${system.webUrl}/api/me`;
    const create = async (path: string, data: object) => {
      const response = await page.request.post(`${endpoint}/${path}`, { headers, data });
      expect(response.status()).toBe(201);
      return response.json();
    };
    const client = await create("clients", { name: "Clara López", phone: "+5491123456777" });
    const service = await create("services", { name: "Consulta nueva", durationMinutes: 30, priceArs: 1000 });
    const weeklySchedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
    const calendar = await page.request.put(`${endpoint}/business-calendar`, { headers, data: { weeklySchedule } });
    expect(calendar.status()).toBe(200);
    const resource = await create("resources", { name: "Profesional", serviceIds: [service.id], weeklySchedule });
    const date = new Date(Date.now() + 2 * 86400000 - 3 * 3600000).toISOString().slice(0, 10);
    const historyUrl = `${endpoint}/appointments?clientId=${client.id}`;
    const writes: string[] = [];
    page.on("request", request => {
      if (request.url().startsWith(`${endpoint}/`) && !/^(GET|HEAD)$/.test(request.method()))
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    const held = new Promise<void>(resolve => { release = resolve; });
    let delivered = false;
    let snapshot: unknown;
    await page.route(historyUrl, async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      snapshot = await response.json();
      await held;
      try { await route.fulfill({ response }); } finally { delivered = true; }
    }, { times: 1 });
    await page.goto(`${system.webUrl}/clients`);
    await page.getByRole("list", { name: "Clientes del negocio" }).getByRole("button", { name: /Clara López/ }).click();
    await expect.poll(() => snapshot).toEqual([]);
    const card = page.getByRole("dialog", { name: "Cliente", exact: true });
    await expect(card.getByRole("region", { name: "Historial completo" })).toHaveAttribute("aria-busy", "true", { timeout: 2_000 });
    await expect(card.getByText(/Cargando turnos…|todavía no tiene turnos/)).toHaveCount(0);
    const start = card.getByRole("button", { name: "Nuevo turno", exact: true });
    await start.click();
    const form = page.getByRole("form", { name: "Crear turno", exact: true });
    await form.getByRole("radio", { name: /Consulta nueva/ }).check();
    await form.getByLabel("Recurso", { exact: true }).selectOption(resource.id);
    await form.getByLabel("Fecha", { exact: true }).fill(date);
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await form.getByRole("group", { name: "Horarios disponibles" }).getByRole("radio", { name: "10:00", exact: true }).check();
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    expect(writes).toEqual([]);
    const response = page.waitForResponse(r => r.url() === `${endpoint}/appointments` && r.request().method() === "POST");
    await form.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    const savedResponse = await response;
    expect(savedResponse.status()).toBe(201);
    const saved = await savedResponse.json();
    expect(saved).toMatchObject({ client, state: "confirmed" });
    const detail = page.getByRole("dialog", { name: "Detalle del turno" });
    await expect(detail.getByRole("heading", { name: "Clara López" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(start).toBeFocused();
    release!();
    await expect.poll(() => delivered).toBe(true);
    await expect(card.getByText("Cargando turnos…")).toHaveCount(0);
    const history = card.getByRole("list", { name: "Historial completo" });
    await expect(history.getByRole("listitem")).toHaveCount(1);
    const exactDetail = page.waitForResponse(r => r.url() === `${endpoint}/appointments/${saved.id}` && r.request().method() === "GET");
    await history.getByRole("button", { name: /Consulta nueva/ }).click();
    expect(await (await exactDetail).json()).toEqual(saved);
    await expect(detail.locator("time")).toHaveAttribute("datetime", saved.startsAt);
    expect(writes).toEqual(["POST /api/me/appointments"]);
  } finally { release?.(); await page.close(); }
});

test("Clientes fences a current uncertain POST across reload and discards obsolete drafts", async ({ browser, page, system }) => {
  test.setTimeout(180_000);
  const password = "uncertain clients tenant password";
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await page.waitForURL(/\/solicitudes$/);
  for (const [name, email] of [["Cliente incierto", "uncertain@example.test"], ["Cliente separado", "separate@example.test"]] as const) {
    await createBusinessInAdminUi(page, { name, email, password });
  }
  const context = await browser.newContext();
  const business = await context.newPage();
  try {
    await login(business, system.webUrl, "uncertain@example.test", password);
    await business.waitForURL(/\/inicio$/);
    await business.goto(`${system.webUrl}/clients`);
    const screen = business.getByRole("main");
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    const seed = await business.request.post(`${system.webUrl}/api/me/clients`, {
      headers: { Origin: system.webUrl, "x-csrf-token": csrf! },
      data: { name: "Bruno Existente", phone: "+5491123456788" },
    });
    expect(seed.status()).toBe(201);
    await business.reload();
    await screen.getByRole("list", { name: "Clientes del negocio", exact: true }).getByRole("listitem").waitFor();
    const create = screen.getByRole("button", { name: "Nuevo cliente", exact: true, includeHidden: true });
    await create.click();
    const form = screen.getByRole("form", { name: "Crear cliente", exact: true });
    const draft = { "Nombre completo": "Alicia María Gómez", Teléfono: "11 2345-6789" };
    for (const [label, value] of Object.entries(draft)) await form.getByLabel(label, { exact: true }).fill(value);
    let posts = 0;
    let saved: { id: string; name: string; phone: string } | undefined;
    const selectedIds: string[] = [];
    business.on("request", request => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname === "/api/me/clients") posts++;
      if (url.pathname === "/api/me/appointments" && url.searchParams.has("clientId")) selectedIds.push(url.searchParams.get("clientId")!);
    });
    await business.route("**/api/me/clients", async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(); // Persist for real, then lose only the browser response.
      expect(response.status()).toBe(201);
      saved = await response.json();
      await route.abort("failed");
    });
    await form.locator('button[type="submit"]').click();
    await expect(form.getByRole("alert")).toContainText("No pudimos confirmar");
    const session = await (await business.request.get(`${system.webUrl}/api/auth/session`)).json();
    const journalKey = `agendia.client-create:${session.businessId}:${session.identityId}`;
    const journal = await business.evaluate(key => localStorage.getItem(key), journalKey);
    expect(JSON.parse(journal!)).toEqual({ version: 2, draft: { name: draft["Nombre completo"], phone: draft.Teléfono } });
    for (const reload of [false, true]) {
      if (reload) await business.reload();
      for (const [label, value] of Object.entries(draft)) {
        await expect(form.getByLabel(label, { exact: true })).toHaveValue(value);
        await expect(form.getByLabel(label, { exact: true })).toBeDisabled();
      }
      await expect(form.locator('button[type="submit"]')).toBeDisabled();
      await expect(form.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
      await expect(create).toBeDisabled();
      await expect(screen.getByRole("form", { name: "Buscar clientes", exact: true }).getByRole("textbox")).toBeDisabled();
      await expect(screen.getByRole("form", { name: "Buscar clientes", exact: true }).getByRole("button")).toBeDisabled();
      await expect(screen.getByRole("list", { name: "Clientes del negocio", exact: true }).getByRole("button").first()).toBeDisabled();
      expect(await business.evaluate(key => localStorage.getItem(key), journalKey)).toBe(journal);
      expect(posts).toBe(1);
    }
    // Leaving the dialog cannot clear the journal, and logout remains reachable.
    await business.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    const resume = screen.getByRole("button", { name: "Volver a la comprobación" });
    await expect(resume).toBeFocused();
    await resume.click();
    await expect(form.getByLabel("Teléfono", { exact: true })).toHaveValue(draft.Teléfono);
    await expect(form.locator('button[type="submit"]')).toBeDisabled();
    await screen.getByRole("button", { name: "Cerrar panel" }).click();
    await business.getByRole("button", { name: "Cerrar sesión", exact: true }).first().click({ timeout: 5_000 });
    await business.getByLabel("Correo", { exact: true }).waitFor();
    await login(business, system.webUrl, "separate@example.test", password);
    await business.waitForURL(/\/inicio$/);
    await business.goto(`${system.webUrl}/clients`);
    await expect(create).toBeEnabled();
    await expect(form).toHaveCount(0);
    await expect(screen.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
    await expect(screen.getByText(/Alicia|Gómez|2345-6789/)).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Comprobar cliente", exact: true })).toHaveCount(0);
    await business.getByRole("button", { name: "Cerrar sesión", exact: true }).first().click();
    await business.getByLabel("Correo", { exact: true }).waitFor();
    await login(business, system.webUrl, "uncertain@example.test", password);
    await business.waitForURL(/\/inicio$/);
    await business.goto(`${system.webUrl}/clients`);
    await expect(form.getByLabel("Teléfono", { exact: true })).toHaveValue(draft.Teléfono);
    await expect(form.locator('button[type="submit"]')).toBeDisabled();
    expect(posts).toBe(1);
    const check = screen.getByRole("button", { name: "Comprobar cliente", exact: true });
    await business.unroute("**/api/me/clients");
    const recoveryUrl = new URL("/api/me/clients", system.webUrl).href;
    for (const [status, body] of [[500, '{"code":"INTERNAL_ERROR"}'], [200, "[]"],
      [200, JSON.stringify([{ ...saved, name: "Otra persona" }])]] as const) {
      let intercepted: Request | undefined;
      let handled = 0;
      await business.route(recoveryUrl, async route => {
        intercepted = route.request();
        expect(intercepted.method()).toBe("GET");
        handled++;
        await route.fulfill({ status, contentType: "application/json", body });
      }, { times: 1 });
      const checked = business.waitForResponse(response => response.request() === intercepted);
      await check.click();
      await expect.poll(() => handled, { message: "The recovery click must hit the one-shot exact-URL handler" }).toBe(1);
      const response = await checked;
      expect(response.request()).toBe(intercepted);
      expect(response.url()).toBe(recoveryUrl);
      expect(response.status()).toBe(status);
      expect(handled).toBe(1);
      await expect(check).toBeEnabled();
      await expect(form.getByLabel("Teléfono", { exact: true })).toHaveValue(draft.Teléfono);
      await expect(form.locator('button[type="submit"]')).toBeDisabled();
      await expect(form.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
      expect(posts).toBe(1); // Empty list is not evidence of rollback.
    }
    await business.unroute("**/api/me/clients");
    await check.click(); // Real GET finds the canonical row committed by the lost POST.
    const detail = screen.getByRole("region", { name: "Cliente seleccionado", exact: true });
    await expect(detail.getByRole("status").filter({ hasText: /^Este cliente existe$/ })).toHaveText("Este cliente existe");
    expect(saved).toEqual({ id: expect.any(String), name: draft["Nombre completo"], phone: "+5491123456789" });
    await expect(detail.getByRole("heading", { name: draft["Nombre completo"], exact: true })).toBeVisible();
    await expect(detail.getByText(saved!.phone, { exact: true })).toBeVisible();
    await expect.poll(() => selectedIds).toEqual([saved!.id]);
    await expect(form).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Editar cliente", exact: true })).toBeFocused();
    expect(posts).toBe(1);
    await expect(business).toHaveURL(`${system.webUrl}/clients`);
    expect(await business.evaluate(key => localStorage.getItem(key), journalKey)).toBeNull();
    await business.evaluate(key => localStorage.setItem(key, JSON.stringify({
      version: 1, draft: { firstName: "Bruno", lastName: "Existente", phone: "+5491123456788" },
    })), journalKey);
    await business.reload();
    await expect(create).toBeEnabled();
    await expect(form).toHaveCount(0);
    await expect(check).toHaveCount(0);
    await expect(screen.getByRole("button", { name: /Bruno Existente/ })).toBeEnabled();
    expect(posts).toBe(1);
    await create.click();
    await expect(form.getByLabel("Nombre completo", { exact: true })).toHaveValue("");
    await expect(form.getByLabel("Teléfono", { exact: true })).toHaveValue("");
    const fresh = { name: "Carla Nueva", phone: "+5491123456787" };
    await form.getByLabel("Nombre completo", { exact: true }).fill(fresh.name);
    await form.getByLabel("Teléfono", { exact: true }).fill(fresh.phone);
    const freshResponse = business.waitForResponse(r => r.url() === recoveryUrl && r.request().method() === "POST");
    await form.locator('button[type="submit"]').click();
    const response = await freshResponse;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toEqual(fresh);
    expect(await response.json()).toEqual({ id: expect.any(String), ...fresh });
    await expect(detail.getByRole("heading", { name: fresh.name, exact: true })).toBeVisible();
    await business.keyboard.press("Escape");
    await expect(create).toBeEnabled();
    await business.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("agendia.client-create:")) throw new DOMException("Storage denied", "QuotaExceededError");
        original.call(this, key, value);
      };
    });
    await create.click();
    for (const [label, value] of Object.entries(draft)) await form.getByLabel(label, { exact: true }).fill(value);
    await form.locator('button[type="submit"]').click();
    await expect(screen.getByRole("alert").filter({ hasText: "No pudimos proteger" })).toBeVisible();
    await expect(form.getByLabel("Teléfono", { exact: true })).toBeDisabled();
    await expect(form.locator('button[type="submit"]')).toBeDisabled();
    await expect(form.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
    expect(posts).toBe(2); // No durable journal means no new POST.
  } finally { await context.close(); }
});

test("Clientes creates standalone owned identities with canonical detail and GET-only recovery", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const password = "standalone clients tenant password";
  const email = "standalone-clients@example.test";
  const otherEmail = "standalone-other@example.test";
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await page.waitForURL(/\/solicitudes$/);
  for (const [name, userEmail] of [["Clientes independientes", email], ["Otros clientes independientes", otherEmail]] as const) {
    await createBusinessInAdminUi(page, { name, email: userEmail, password });
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext({ viewport: { width: 360, height: 900 } });
  const business = await context.newPage();
  const other = await otherContext.newPage();
  const appointmentMutations: string[] = [];
  for (const tenantPage of [business, other]) tenantPage.on("request", request => {
    const path = new URL(request.url()).pathname;
    if ((path.startsWith("/api/me/appointments") || path.startsWith("/api/me/appointment-operations")) &&
        !["GET", "HEAD"].includes(request.method())) appointmentMutations.push(`${request.method()} ${path}`);
  });
  let releasePost: (() => void) | undefined;
  try {
    await login(business, system.webUrl, email, password);
    await business.waitForURL(/\/inicio$/);
    await business.goto(`${system.webUrl}/clients`);
    const screen = business.getByRole("main");
    const create = screen.getByRole("button", { name: "Nuevo cliente", exact: true, includeHidden: true });
    await expect(create).toBeVisible();
    await expect(business).toHaveURL(`${system.webUrl}/clients`);
    await expect(screen.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
    const counts = { POST: 0, GET: 0, otherMutations: 0 };
    const historyIds: string[] = [];
    business.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/me/clients")) {
        if (request.method() === "POST") counts.POST++;
        else if (request.method() === "GET") counts.GET++;
        else counts.otherMutations++;
      }
      if (url.pathname === "/api/me/appointments" && url.searchParams.has("clientId"))
        historyIds.push(url.searchParams.get("clientId")!);
    });
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const seedResponse = await business.request.post(`${system.webUrl}/api/me/clients`, {
      headers: { Origin: system.webUrl, "x-csrf-token": csrf! },
      data: { name: "Bruno Existente", phone: "+5491123456788" },
    });
    expect(seedResponse.status()).toBe(201);
    const seed = await seedResponse.json();
    await business.reload();
    const list = screen.getByRole("list", { name: "Clientes del negocio", exact: true });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await create.click();
    const form = screen.getByRole("form", { name: "Crear cliente", exact: true });
    const fullName = form.getByLabel("Nombre completo", { exact: true });
    await expect(form.getByLabel("Apellido", { exact: true })).toHaveCount(0);
    const phone = form.getByLabel("Teléfono", { exact: true });
    const submit = form.locator('button[type="submit"]');
    const cancel = form.getByRole("button", { name: "Cancelar", exact: true });
    await expect(screen.getByRole("dialog")).toBeVisible();
    await expect(fullName).toBeFocused();
    await fullName.fill("Borrador cancelado");
    await cancel.click();
    await expect(form).toHaveCount(0);
    await expect(create).toBeFocused();
    expect(counts.POST).toBe(0);
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await create.click();
    for (const input of [fullName, phone]) {
      await expect(input).toHaveValue("");
      await expect(input).toHaveAttribute("required", "");
    }
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      await expect(fullName).toBeFocused();
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`clients-create-blank-${width}.png`), fullPage: true });
    }
    await submit.click();
    await expect(fullName).toBeFocused();
    expect(await fullName.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    expect(counts.POST).toBe(0);
    await fullName.fill(" Alicia Gómez ");
    await submit.click();
    await expect(phone).toBeFocused();
    expect(counts.POST).toBe(0);
    await phone.fill("not-a-phone");
    const invalid = business.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/me/clients");
    await submit.click();
    expect((await invalid).status()).toBe(400); // Real API validation, not a mocked rejection.
    await expect(form.getByRole("alert")).toHaveText("Revisá los campos indicados.");
    await expect(fullName).toHaveValue(" Alicia Gómez ");
    await expect(phone).toHaveValue("not-a-phone");
    await expect(submit).toBeEnabled();
    await expect(submit).toBeFocused();
    expect(counts.POST).toBe(1);
    await phone.fill("11 2345-6788");
    const duplicate = business.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/me/clients");
    await submit.click();
    expect((await duplicate).status()).toBe(409); // Existing phone in this tenant only.
    await expect(form.getByRole("alert")).toHaveText("Ya hay un cliente con ese teléfono. Usá otro teléfono.");
    await expect(fullName).toHaveValue(" Alicia Gómez ");
    await expect(phone).toHaveValue("11 2345-6788");
    await expect(submit).toBeEnabled();
    await expect(submit).toBeFocused();
    expect(counts.POST).toBe(2);
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      await expect(submit).toBeFocused();
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`clients-create-conflict-${width}.png`), fullPage: true });
    }
    await phone.fill("11 2345-6789");
    const heldPost = new Promise<void>(resolve => { releasePost = resolve; });
    await business.route("**/api/me/clients", async route => {
      if (route.request().method() === "POST") {
        await heldPost;
        await route.continue(); // The held submission still reaches real persistence.
      } else if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
      } else await route.continue();
    });
    await business.route("**/api/me/appointments?*", route => route.fulfill({
      status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}',
    }));
    const createdResponse = business.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/me/clients");
    await submit.click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await business.keyboard.press("Escape");
    await expect(form).toBeVisible();
    for (const control of [fullName, phone, submit, cancel]) await expect(control).toBeDisabled();
    await expect(screen.getByRole("form", { name: "Buscar clientes", exact: true }).getByRole("button")).toBeDisabled();
    await form.evaluate(element => { element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await expect.poll(() => counts.POST).toBe(3); // Two failures plus exactly one pending real POST.
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      await expect(form).toHaveAttribute("aria-busy", "true");
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`clients-create-pending-${width}.png`), fullPage: true });
    }
    expect(counts.POST).toBe(3);
    releasePost!();
    const response = await createdResponse;
    expect(response.status()).toBe(201);
    const saved = await response.json();
    expect(saved.id).toEqual(expect.any(String));
    expect(saved.id.length).toBeGreaterThan(0);
    expect(saved.id).not.toBe(seed.id);
    expect(saved).toEqual({ id: saved.id, name: "Alicia Gómez", phone: "+5491123456789" });
    const detail = screen.getByRole("region", { name: "Cliente seleccionado", exact: true });
    const edit = detail.getByRole("button", { name: "Editar cliente", exact: true });
    await expect(form).toHaveCount(0);
    await expect(detail.getByRole("heading", { name: "Alicia Gómez", exact: true })).toBeVisible();
    await expect(detail.getByText(saved.phone, { exact: true })).toBeVisible();
    await expect(detail.getByRole("status").filter({ hasText: /^Cliente guardado$/ })).toBeVisible();
    await expect(edit).toBeFocused();
    await expect(screen.getByText("El cliente se guardó, pero no pudimos actualizar la lista.", { exact: true })).toBeVisible();
    await expect(detail.getByText("El cliente se guardó, pero no pudimos actualizar los turnos.", { exact: true })).toBeVisible();
    expect(historyIds).toEqual([saved.id]);
    expect(counts.POST).toBe(3);
    await expect(business).toHaveURL(`${system.webUrl}/clients`);
    await business.screenshot({ path: testInfo.outputPath("clients-created-read-warnings-360.png"), fullPage: true });
    const retryList = screen.getByRole("button", { name: "Actualizar clientes", exact: true });
    const retryHistory = detail.getByRole("button", { name: "Actualizar turnos", exact: true });
    const beforeFailedRetry = { ...counts };
    await retryList.click();
    await expect(retryList).toBeEnabled();
    await retryHistory.click();
    await expect(retryHistory).toBeEnabled();
    expect(counts).toEqual({ ...beforeFailedRetry, GET: beforeFailedRetry.GET + 1 });
    expect(historyIds).toEqual([saved.id, saved.id]);
    await expect(detail.getByRole("heading", { name: "Alicia Gómez", exact: true })).toBeVisible();
    await expect(detail.getByText(saved.phone, { exact: true })).toBeVisible();
    await expect(screen.getByText("El cliente se guardó, pero no pudimos actualizar la lista.", { exact: true })).toBeVisible();
    await expect(detail.getByText("El cliente se guardó, pero no pudimos actualizar los turnos.", { exact: true })).toBeVisible();
    await business.unroute("**/api/me/clients");
    await business.unroute("**/api/me/appointments?*");
    const beforeRecovery = { ...counts };
    await retryList.click();
    await expect(screen.getByText("El cliente se guardó, pero no pudimos actualizar la lista.", { exact: true })).toHaveCount(0);
    await retryHistory.click();
    await expect(detail.getByRole("alert")).toHaveCount(0);
    expect(counts).toEqual({ ...beforeRecovery, GET: beforeRecovery.GET + 1 });
    expect(historyIds).toEqual([saved.id, saved.id, saved.id]);
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("button", { name: /Alicia Gómez/ })).toHaveAttribute("aria-pressed", "true");
    await expect(detail.getByRole("region", { name: "Historial completo", exact: true })
      .getByText("Este cliente todavía no tiene turnos registrados.", { exact: true })).toBeVisible();
    const persistedResponse = await business.request.get(`${system.webUrl}/api/me/clients`);
    expect(persistedResponse.status()).toBe(200);
    expect(await persistedResponse.json()).toEqual(expect.arrayContaining([seed, saved]));
    const ownAppointments = await business.request.get(`${system.webUrl}/api/me/appointments`);
    expect(ownAppointments.status()).toBe(200);
    expect(await ownAppointments.json()).toEqual([]);
    await business.reload();
    await expect(business).toHaveURL(`${system.webUrl}/clients`);
    await expect(list.getByRole("listitem")).toHaveCount(2);
    const panel = screen.getByRole("dialog");
    const referencePath = process.env.AGENDIA_CLIENTS_REFERENCE;
    const reference = referencePath ? await context.newPage() : null;
    if (reference) {
      reference.setDefaultTimeout(5_000);
      await reference.route(/^https?:/, route => route.abort());
      await reference.goto(pathToFileURL(referencePath!).href);
      // Match the isolated tenant's real fixture records, in prototype memory only.
      const rows = [saved, seed].map(({ id, name, phone }) => {
        const [first, ...last] = name.split(" ");
        return { id, first, last: last.join(" "), phone };
      });
      await reference.evaluate(`state.role = 'business'; state.page = 'clientes'; clients = ${JSON.stringify(rows)}; appointments = []; render();`);
    }
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      await reference?.setViewportSize({ width, height: 900 });
      const checkGeometry = async (mode: string, surface: Locator, referenceSelector: string) => {
        const actual = await settledBox(surface);
        if (mode !== "directory") {
          expect(actual.width).toBe(width === 1280 ? 578 : 340);
          expect(actual.x).toBe(width === 1280 ? 351 : 10);
          expect(actual.y + actual.height / (width === 1280 ? 2 : 1)).toBeCloseTo(width === 1280 ? 450 : 890, 1);
        }
        await business.screenshot({ path: testInfo.outputPath(`clients-matched-${mode}-${width}.png`) });
        if (!reference) return;
        const expected = await settledBox(reference.locator(referenceSelector));
        if (mode === "directory") expected.y -= (await settledBox(reference.locator(".demo-bar"))).height;
        console.log(`Clientes ${width} ${mode} (reference/app):`, { expected, actual });
        expect.soft(actual.width).toBe(expected.width);
        expect.soft(actual.x).toBe(expected.x);
        if (mode === "directory") expect.soft(Math.abs(actual.y - expected.y)).toBeLessThan(1);
        await reference.screenshot({ path: testInfo.outputPath(`clients-reference-${mode}-${width}.png`) });
      };
      await checkGeometry("directory", screen.getByRole("region", { name: "Directorio de clientes" }), ".clients-pane");
      await create.click();
      await reference?.getByRole("button", { name: "Nuevo cliente", exact: true }).click();
      await checkGeometry("create", panel, ".client-float-dialog");
      await cancel.click();
      await reference?.getByRole("button", { name: "Cancelar", exact: true }).click();
      await list.getByRole("button", { name: /Alicia Gómez/ }).click();
      await reference?.getByRole("button", { name: /Alicia Gómez/ }).click();
      await expect(detail.getByRole("heading", { name: "Alicia Gómez", exact: true })).toBeVisible();
      await expect(detail.getByText(saved.phone, { exact: true })).toBeVisible();
      await expect(detail.getByText("Este cliente todavía no tiene turnos registrados.")).toBeVisible();
      await checkGeometry("detail", panel, ".client-float-dialog");
      await edit.click();
      await reference?.getByRole("button", { name: "Editar", exact: true }).click();
      const editForm = detail.getByRole("form", { name: "Editar cliente", exact: true });
      await expect(editForm.getByLabel("Nombre completo", { exact: true })).toBeFocused();
      await checkGeometry("edit", panel, ".client-float-dialog");
      await editForm.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(edit).toBeFocused();
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`clients-created-persisted-${width}.png`), fullPage: true });
      await detail.getByRole("button", { name: "Cerrar", exact: true }).click();
      await reference?.getByRole("button", { name: "Cerrar panel", exact: true }).click();
    }
    await reference?.close();
    await login(other, system.webUrl, otherEmail, password);
    await other.waitForURL(/\/inicio$/);
    await other.goto(`${system.webUrl}/clients`);
    await expect(other.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
    await expect(other.getByRole("list", { name: "Clientes del negocio", exact: true }).getByRole("listitem")).toHaveCount(0);
    await other.getByRole("button", { name: "Nuevo cliente", exact: true }).click();
    const otherForm = other.getByRole("form", { name: "Crear cliente", exact: true });
    await otherForm.getByLabel("Nombre completo", { exact: true }).fill("Otra Identidad");
    await otherForm.getByLabel("Teléfono", { exact: true }).fill(saved.phone);
    const otherCreated = other.waitForResponse(result => result.request().method() === "POST" &&
      new URL(result.url()).pathname === "/api/me/clients");
    await otherForm.locator('button[type="submit"]').click();
    const otherResponse = await otherCreated;
    expect(otherResponse.status()).toBe(201); // Same phone is legal in a different tenant.
    const otherSaved = await otherResponse.json();
    expect(otherSaved).toEqual({ id: expect.any(String), name: "Otra Identidad", phone: saved.phone });
    expect(otherSaved.id).not.toBe(saved.id);
    await expect(other).toHaveURL(`${system.webUrl}/clients`);
    await expect(other.getByRole("region", { name: "Cliente seleccionado", exact: true }).getByRole("heading", { name: "Otra Identidad", exact: true })).toBeVisible();
    const otherRows = await other.request.get(`${system.webUrl}/api/me/clients`);
    expect(otherRows.status()).toBe(200);
    expect(await otherRows.json()).toEqual([otherSaved]);
    const foreignHistory = await other.request.get(`${system.webUrl}/api/me/appointments?clientId=${saved.id}`);
    expect(foreignHistory.status()).toBe(200);
    expect(await foreignHistory.json()).toEqual([]);
    const ownRowsAfter = await business.request.get(`${system.webUrl}/api/me/clients`);
    expect(ownRowsAfter.status()).toBe(200);
    expect(await ownRowsAfter.json()).toEqual(expect.arrayContaining([seed, saved]));
    expect(await ownRowsAfter.json()).toHaveLength(2);
    expect(counts.POST).toBe(3);
    expect(counts.otherMutations).toBe(0);
    expect(appointmentMutations).toEqual([]);
  } finally {
    releasePost?.();
    await otherContext.close();
    await context.close();
  }
});
