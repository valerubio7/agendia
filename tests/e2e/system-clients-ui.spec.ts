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

test("Clientes fences an uncertain standalone POST across reload until GET confirms the exact identity", async ({ browser, page, system }) => {
  test.setTimeout(180_000);
  const password = "uncertain clients tenant password";
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await page.waitForURL(/\/businesses$/);
  for (const [name, email] of [["Cliente incierto", "uncertain@example.test"], ["Cliente separado", "separate@example.test"]] as const) {
    await page.getByLabel("Nombre", { exact: true }).fill(name);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await page.getByRole("cell", { name, exact: true }).waitFor({ state: "visible" });
  }
  const context = await browser.newContext();
  const business = await context.newPage();
  try {
    await login(business, system.webUrl, "uncertain@example.test", password);
    await business.waitForURL(/\/profile$/);
    await business.goto(`${system.webUrl}/clients`);
    const screen = business.getByRole("main");
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    const seed = await business.request.post(`${system.webUrl}/api/me/clients`, {
      headers: { Origin: system.webUrl, "x-csrf-token": csrf! },
      data: { firstName: "Bruno", lastName: "Existente", phone: "+5491123456788" },
    });
    expect(seed.status()).toBe(201);
    await business.reload();
    await screen.getByRole("list", { name: "Clientes del negocio", exact: true }).getByRole("listitem").waitFor();
    await screen.getByRole("button", { name: "Crear cliente", exact: true }).click();
    const form = screen.getByRole("form", { name: "Crear cliente", exact: true });
    const draft = { Nombre: " Alicia ", Apellido: " Gómez ", Teléfono: "11 2345-6789" };
    for (const [label, value] of Object.entries(draft)) await form.getByLabel(label, { exact: true }).fill(value);
    let posts = 0;
    let saved: { id: string; firstName: string; lastName: string; phone: string } | undefined;
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
    for (const reload of [false, true]) {
      if (reload) await business.reload();
      for (const [label, value] of Object.entries(draft)) {
        await expect(form.getByLabel(label, { exact: true })).toHaveValue(value);
        await expect(form.getByLabel(label, { exact: true })).toBeDisabled(); // Independent RED: current draft is editable.
      }
      await expect(form.locator('button[type="submit"]')).toBeDisabled();
      await expect(form.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
      await expect(screen.locator(":scope > button").filter({ hasText: /^Crear cliente$/ })).toBeDisabled();
      await expect(screen.getByRole("form", { name: "Buscar clientes", exact: true }).getByRole("textbox")).toBeDisabled();
      await expect(screen.getByRole("form", { name: "Buscar clientes", exact: true }).getByRole("button")).toBeDisabled();
      await expect(screen.getByRole("list", { name: "Clientes del negocio", exact: true }).getByRole("button").first()).toBeDisabled();
      expect(posts).toBe(1);
    }
    // Switch identities in the same browser storage, then restore the original fence.
    await business.getByRole("button", { name: "Cerrar sesión", exact: true }).first().click();
    await business.getByLabel("Correo", { exact: true }).waitFor();
    await login(business, system.webUrl, "separate@example.test", password);
    await business.waitForURL(/\/profile$/);
    await business.goto(`${system.webUrl}/clients`);
    await expect(screen.getByRole("button", { name: "Crear cliente", exact: true })).toBeEnabled();
    await expect(form).toHaveCount(0);
    await expect(screen.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
    await expect(screen.getByText(/Alicia|Gómez|2345-6789/)).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Comprobar cliente", exact: true })).toHaveCount(0);
    await business.getByRole("button", { name: "Cerrar sesión", exact: true }).first().click();
    await business.getByLabel("Correo", { exact: true }).waitFor();
    await login(business, system.webUrl, "uncertain@example.test", password);
    await business.waitForURL(/\/profile$/);
    await business.goto(`${system.webUrl}/clients`);
    await expect(form.getByLabel("Teléfono", { exact: true })).toHaveValue(draft.Teléfono);
    await expect(form.locator('button[type="submit"]')).toBeDisabled();
    expect(posts).toBe(1);
    const check = screen.getByRole("button", { name: "Comprobar cliente", exact: true });
    for (const [status, body] of [[500, '{"code":"INTERNAL_ERROR"}'], [200, "[]"],
      [200, JSON.stringify([{ ...saved, firstName: "Otra persona" }])]] as const) {
      await business.unroute("**/api/me/clients");
      await business.route("**/api/me/clients", route => route.fulfill({ status, contentType: "application/json", body }));
      const checked = business.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/me/clients");
      await check.click();
      expect((await checked).status()).toBe(status);
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
    expect(saved).toEqual({ id: expect.any(String), firstName: "Alicia", lastName: "Gómez", phone: "+5491123456789" });
    await expect(detail.getByRole("heading", { name: "Alicia Gómez", exact: true })).toBeVisible();
    await expect(detail.getByText(saved!.phone, { exact: true })).toBeVisible();
    await expect.poll(() => selectedIds).toEqual([saved!.id]);
    await expect(form).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Editar cliente", exact: true })).toBeFocused();
    expect(posts).toBe(1);
    await expect(business).toHaveURL(`${system.webUrl}/clients`);
    await business.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("agendia.client-create:")) throw new DOMException("Storage denied", "QuotaExceededError");
        original.call(this, key, value);
      };
    });
    await screen.getByRole("button", { name: "Crear cliente", exact: true }).click();
    for (const [label, value] of Object.entries(draft)) await form.getByLabel(label, { exact: true }).fill(value);
    await form.locator('button[type="submit"]').click();
    await expect(screen.getByRole("alert").filter({ hasText: "No pudimos proteger" })).toBeVisible();
    await expect(form.getByLabel("Teléfono", { exact: true })).toBeDisabled();
    await expect(form.locator('button[type="submit"]')).toBeDisabled();
    await expect(form.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
    expect(posts).toBe(1); // No durable journal means no new POST.
  } finally { await context.close(); }
});

test("Clientes creates standalone owned identities with canonical detail and GET-only recovery", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const password = "standalone clients tenant password";
  const email = "standalone-clients@example.test";
  const otherEmail = "standalone-other@example.test";
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await page.waitForURL(/\/businesses$/);
  for (const [name, userEmail] of [["Clientes independientes", email], ["Otros clientes independientes", otherEmail]] as const) {
    await page.getByLabel("Nombre", { exact: true }).fill(name);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(userEmail);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await page.getByRole("cell", { name, exact: true }).waitFor({ state: "visible" });
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
    await business.waitForURL(/\/profile$/);
    await business.goto(`${system.webUrl}/clients`);
    const screen = business.getByRole("main");
    const create = screen.getByRole("button", { name: "Crear cliente", exact: true });
    // This is the first assertion: the base screen lacks standalone creation.
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
      data: { firstName: "Bruno", lastName: "Existente", phone: "+5491123456788" },
    });
    expect(seedResponse.status()).toBe(201);
    const seed = await seedResponse.json();
    await business.reload();
    const list = screen.getByRole("list", { name: "Clientes del negocio", exact: true });
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await create.click();
    const form = screen.getByRole("form", { name: "Crear cliente", exact: true });
    const firstName = form.getByLabel("Nombre", { exact: true });
    const lastName = form.getByLabel("Apellido", { exact: true });
    const phone = form.getByLabel("Teléfono", { exact: true });
    const submit = form.locator('button[type="submit"]');
    const cancel = form.getByRole("button", { name: "Cancelar", exact: true });
    await expect(firstName).toBeFocused();
    await firstName.fill("Borrador cancelado");
    await cancel.click();
    await expect(form).toHaveCount(0);
    await expect(create).toBeFocused();
    expect(counts.POST).toBe(0);
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await create.click();
    for (const input of [firstName, lastName, phone]) {
      await expect(input).toHaveValue("");
      await expect(input).toHaveAttribute("required", "");
    }
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      await expect(firstName).toBeFocused();
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`clients-create-blank-${width}.png`), fullPage: true });
    }
    await submit.click();
    await expect(firstName).toBeFocused();
    expect(await firstName.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    expect(counts.POST).toBe(0);
    await firstName.fill(" Alicia ");
    await submit.click();
    await expect(lastName).toBeFocused();
    expect(counts.POST).toBe(0);
    await lastName.fill(" Gómez ");
    await submit.click();
    await expect(phone).toBeFocused();
    expect(counts.POST).toBe(0);
    await phone.fill("not-a-phone");
    const invalid = business.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/me/clients");
    await submit.click();
    expect((await invalid).status()).toBe(400); // Real API validation, not a mocked rejection.
    await expect(form.getByRole("alert")).toHaveText("Revisá los campos indicados.");
    await expect(firstName).toHaveValue(" Alicia ");
    await expect(lastName).toHaveValue(" Gómez ");
    await expect(phone).toHaveValue("not-a-phone");
    await expect(submit).toBeEnabled();
    await expect(submit).toBeFocused();
    expect(counts.POST).toBe(1);
    await phone.fill("11 2345-6788");
    const duplicate = business.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/me/clients");
    await submit.click();
    expect((await duplicate).status()).toBe(409); // Existing phone in this tenant only.
    await expect(form.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
    await expect(firstName).toHaveValue(" Alicia ");
    await expect(lastName).toHaveValue(" Gómez ");
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
    for (const control of [firstName, lastName, phone, submit, cancel]) await expect(control).toBeDisabled();
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
    expect(saved).toEqual({ id: saved.id, firstName: "Alicia", lastName: "Gómez", phone: "+5491123456789" });
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
    for (const title of ["Próximos turnos", "Historial completo"]) {
      await expect(detail.getByRole("region", { name: title, exact: true }).getByText("No hay turnos en esta sección.", { exact: true })).toBeVisible();
    }
    const persistedResponse = await business.request.get(`${system.webUrl}/api/me/clients`);
    expect(persistedResponse.status()).toBe(200);
    expect(await persistedResponse.json()).toEqual(expect.arrayContaining([seed, saved]));
    const ownAppointments = await business.request.get(`${system.webUrl}/api/me/appointments`);
    expect(ownAppointments.status()).toBe(200);
    expect(await ownAppointments.json()).toEqual([]);
    await business.reload();
    await expect(business).toHaveURL(`${system.webUrl}/clients`);
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await list.getByRole("button", { name: /Alicia Gómez/ }).click();
    await expect(detail.getByRole("heading", { name: "Alicia Gómez", exact: true })).toBeVisible();
    await expect(detail.getByText(saved.phone, { exact: true })).toBeVisible();
    await expect(detail.getByText("Cargando turnos…", { exact: true })).toHaveCount(0);
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      await edit.click();
      const editForm = detail.getByRole("form", { name: "Editar cliente", exact: true });
      await expect(editForm.getByLabel("Nombre", { exact: true })).toBeFocused();
      await editForm.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(edit).toBeFocused();
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`clients-created-persisted-${width}.png`), fullPage: true });
    }
    await login(other, system.webUrl, otherEmail, password);
    await other.waitForURL(/\/profile$/);
    await other.goto(`${system.webUrl}/clients`);
    await expect(other.getByText("Todavía no hay clientes.", { exact: true })).toBeVisible();
    await expect(other.getByRole("list", { name: "Clientes del negocio", exact: true }).getByRole("listitem")).toHaveCount(0);
    await other.getByRole("button", { name: "Crear cliente", exact: true }).click();
    const otherForm = other.getByRole("form", { name: "Crear cliente", exact: true });
    await otherForm.getByLabel("Nombre", { exact: true }).fill("Otra");
    await otherForm.getByLabel("Apellido", { exact: true }).fill("Identidad");
    await otherForm.getByLabel("Teléfono", { exact: true }).fill(saved.phone);
    const otherCreated = other.waitForResponse(result => result.request().method() === "POST" &&
      new URL(result.url()).pathname === "/api/me/clients");
    await otherForm.locator('button[type="submit"]').click();
    const otherResponse = await otherCreated;
    expect(otherResponse.status()).toBe(201); // Same phone is legal in a different tenant.
    const otherSaved = await otherResponse.json();
    expect(otherSaved).toEqual({ id: expect.any(String), firstName: "Otra", lastName: "Identidad", phone: saved.phone });
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
