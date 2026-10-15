import { expect, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

async function seed(page: Page, method: "post" | "put", path: string, data: object, status: number) {
  const csrf = await page.evaluate(() => sessionStorage.getItem("agendia.csrf"));
  expect(csrf).toBeTruthy();
  const response = await page.request[method](new URL(`/api/me/${path}`, page.url()).href, {
    headers: { Origin: new URL(page.url()).origin, "x-csrf-token": csrf! }, data,
  });
  expect(response.status()).toBe(status);
  return await response.json() as { id: string };
}

test("Recursos manages owned assignments while preserving weekly spans", async ({ browser, page, system }, testInfo) => {
  const password = "tenant resources password safe";
  const tenants = [
    { name: "Estudio Recursos", email: "resources-ui@example.test" },
    { name: "Otro Estudio Recursos", email: "other-resources-ui@example.test" },
  ];
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  await expect(page.getByRole("link", { name: "Recursos", exact: true })).toHaveCount(0);
  for (const tenant of tenants) {
    await page.getByLabel("Nombre", { exact: true }).fill(tenant.name);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(tenant.email);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await expect(page.getByRole("cell", { name: tenant.name, exact: true })).toBeVisible();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext();
  const business = await context.newPage();
  const other = await otherContext.newPage();
  try {
    await login(business, system.webUrl, tenants[0]!.email, password);
    await expect(business).toHaveURL(/\/profile$/);
    const navigation = business.getByRole("navigation", { name: "Navegación del negocio", exact: true });
    await expect(navigation.getByRole("link", { name: "Recursos", exact: true })).toBeVisible();
    const mutations: string[] = [];
    business.on("request", request => {
      if (/\/api\/me\/(?:resources|services)(?:\/|$)/.test(new URL(request.url()).pathname) && request.method() !== "GET")
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await business.goto(`${system.webUrl}/resources`);
    const screen = business.getByRole("main");
    await expect(screen.getByRole("heading", { name: "Todavía no hay recursos", exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Recursos", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(screen.getByRole("form", { name: "Crear recurso", exact: true })).toBeVisible();
    const weeklyEditor = screen.getByRole("form", { name: "Crear recurso", exact: true })
      .getByRole("group", { name: "Horario semanal", exact: true });
    await expect(weeklyEditor).toBeVisible();
    await expect(weeklyEditor.getByRole("group", { name: "Lunes", exact: true })).toBeVisible();
    await expect(weeklyEditor.getByRole("button", { name: "Agregar franja Lunes", exact: true })).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("resources-empty.png"), fullPage: true });
    await login(other, system.webUrl, tenants[1]!.email, password);
    await expect(other).toHaveURL(/\/profile$/);
    const foreignService = await seed(other, "post", "services", { name: "Servicio ajeno", durationMinutes: 30, priceArs: 0 }, 201);
    await seed(other, "post", "resources", { name: "Recurso ajeno", serviceIds: [foreignService.id], weeklySchedule: {} }, 201);
    const ownService = await seed(business, "post", "services", { name: "Consulta propia", durationMinutes: 30, priceArs: 0 }, 201);
    const suspendedService = await seed(business, "post", "services", { name: "Seguimiento propio", durationMinutes: 15, priceArs: 0 }, 201);
    await seed(business, "put", `services/${suspendedService.id}/status`, { status: "suspended" }, 200);
    const weeklySchedule = {
      1: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }],
      4: [{ startMinute: 1320, endMinute: 120 }],
      0: [{ startMinute: 0, endMinute: 1440 }],
    };
    await seed(business, "put", "business-calendar", { weeklySchedule }, 200);
    await seed(business, "post", "resources", {
      name: "Profesional de acompañamiento para pequeños negocios", description: "Atención personalizada.",
      serviceIds: [ownService.id, suspendedService.id], weeklySchedule,
    }, 201);
    const inactive = await seed(business, "post", "resources", { name: "Sala de consulta", serviceIds: [], weeklySchedule: {} }, 201);
    await seed(business, "put", `resources/${inactive.id}/status`, { status: "suspended" }, 200);
    await business.reload();
    const catalog = screen.getByRole("list", { name: "Catálogo de recursos", exact: true });
    await expect(catalog.getByRole("listitem")).toHaveCount(2);
    const active = catalog.getByRole("listitem").filter({ hasText: "Profesional de acompañamiento" });
    await expect(active.getByText("Activo", { exact: true })).toBeVisible();
    await expect(active.getByRole("button", { name: "Suspender", exact: true })).toBeVisible();
    await expect(active.getByText("Atención personalizada.", { exact: true })).toBeVisible();
    await expect(active.getByText("Consulta propia", { exact: true })).toBeVisible();
    await expect(active.getByText("Seguimiento propio (suspendido)", { exact: true })).toBeVisible();
    const days = active.locator(".resources-week div");
    await expect(days.filter({ hasText: "Lunes" })).toContainText("09:00–12:00 · 14:00–18:00");
    await expect(days.filter({ hasText: "Martes" })).toContainText("Sin franjas");
    await expect(days.filter({ hasText: "Jueves" })).toContainText("22:00–02:00 (día siguiente)");
    await expect(days.filter({ hasText: "Domingo" })).toContainText("00:00–24:00");
    const suspended = catalog.getByRole("listitem").filter({ hasText: "Sala de consulta" });
    await expect(suspended.getByText("Suspendido", { exact: true })).toBeVisible();
    await expect(suspended.getByText("Sin servicios asignados", { exact: true })).toBeVisible();
    await expect(suspended.locator(".resources-description")).toHaveCount(0);
    await expect(suspended.locator(".resources-week dd")).toHaveText(Array(7).fill("Sin franjas"));
    await expect(screen.getByText("Recurso ajeno", { exact: true })).toHaveCount(0);
    await expect(screen.getByText("Servicio ajeno", { exact: true })).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Retirar", exact: true })).toHaveCount(2);
    await expect(screen.locator('input[name="status"], input[name="id"], input[name="weeklySchedule"]')).toHaveCount(0);
    await other.goto(`${system.webUrl}/resources`);
    await expect(other.getByRole("heading", { name: "Recurso ajeno", exact: true })).toBeVisible();
    await expect(other.getByRole("listitem")).toHaveCount(1);
    await expect(other.getByText("Sala de consulta", { exact: true })).toHaveCount(0);
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      if (width === 360) {
        const mobile = business.locator('[data-ui="mobile-navigation"]');
        await mobile.getByText("Menú", { exact: true }).click();
        await expect(mobile.getByRole("link", { name: "Recursos", exact: true })).toBeVisible();
        await mobile.getByRole("link", { name: "Recursos", exact: true }).click();
        await expect(mobile.getByRole("link", { name: "Recursos", exact: true })).toHaveAttribute("aria-current", "page");
        await mobile.getByText("Menú", { exact: true }).click();
      }
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`resources-${width}.png`), fullPage: true });
    }
    // MOCKED initial-load GET500; retry below returns the real tenant catalog.
    await business.route("**/api/me/resources", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await business.reload();
    const error = business.locator('main[data-state="load-error"]');
    await expect(error.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await business.screenshot({ path: testInfo.outputPath("resources-mocked-load-error.png"), fullPage: true });
    await business.unroute("**/api/me/resources");
    await error.getByRole("button", { name: "Volver a intentar", exact: true }).click();
    await expect(catalog.getByRole("listitem")).toHaveCount(2);
    expect(mutations).toEqual([]); // page.request seeding is not a mounted UI mutation.
    // Real mutations; only post-save GET failures below are mocked.
    const form = screen.getByRole("form");
    await expect(form.getByRole("checkbox")).toHaveCount(2);
    await expect(form.getByRole("checkbox", { name: "Seguimiento propio (suspendido)", exact: true })).toBeVisible();
    await expect(form.getByText(/Sin franjas no podrá recibir reservas/)).toBeVisible();
    const counts = { POST: 0, PUT: 0, GET: 0 };
    const bodies: Record<string, unknown>[] = [];
    business.on("request", request => {
      if (!/\/api\/me\/resources(?:\/|$)/.test(new URL(request.url()).pathname)) return;
      const method = request.method() as keyof typeof counts;
      if (method in counts) counts[method]++;
      if (method === "POST" || method === "PUT") bodies.push(request.postDataJSON());
    });
    let failGet = true;
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await business.route("**/api/me/resources", async route => {
      if (route.request().method() === "POST") { await held; await route.continue(); }
      else if (failGet) await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
      else await route.continue();
    });
    await form.getByLabel("Nombre", { exact: true }).fill("Recurso creado en pantalla");
    await form.getByLabel("Descripción (opcional)").fill("Descripción inicial");
    await form.getByRole("checkbox", { name: "Consulta propia", exact: true }).check();
    await form.getByRole("checkbox", { name: "Seguimiento propio (suspendido)", exact: true }).check();
    await form.getByRole("button", { name: "Crear recurso", exact: true }).click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(form.getByRole("button", { name: "Guardando…" })).toBeDisabled();
    await form.evaluate(element => {
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(counts.POST).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("resources-pending.png"), fullPage: true });
    release!();
    const created = catalog.getByRole("listitem").filter({ hasText: "Recurso creado en pantalla" });
    const warning = screen.getByRole("region", { name: "Actualización del catálogo" });
    await expect(form.getByRole("status")).toHaveText("Recurso creado");
    await expect(created.getByRole("heading", { name: "Recurso creado en pantalla", exact: true })).toBeVisible();
    await expect(created.locator(".resources-week dd")).toHaveText(Array(7).fill("Sin franjas"));
    expect(counts).toEqual({ POST: 1, PUT: 0, GET: 1 });
    expect(bodies[0]).toEqual({ name: "Recurso creado en pantalla", description: "Descripción inicial",
      serviceIds: [ownService.id, suspendedService.id], weeklySchedule: {} });
    await expect(warning.getByRole("alert")).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("resources-create-saved-warning.png"), fullPage: true });
    failGet = false;
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(counts).toEqual({ POST: 1, PUT: 0, GET: 2 });
    await business.reload();
    await expect(created.getByText("Descripción inicial", { exact: true })).toBeVisible();
    await created.getByRole("button", { name: "Editar Recurso creado en pantalla", exact: true }).click();
    await expect(form.getByLabel("Nombre", { exact: true })).toBeFocused();
    await form.getByLabel("Nombre", { exact: true }).fill("Sala de consulta");
    const conflict = business.waitForResponse(response => response.request().method() === "PUT" && response.status() === 409);
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await conflict;
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(form.getByLabel("Nombre", { exact: true })).toHaveValue("Sala de consulta");
    await expect(form.getByLabel("Descripción (opcional)")).toHaveValue("Descripción inicial");
    await business.screenshot({ path: testInfo.outputPath("resources-real-conflict.png"), fullPage: true });
    await form.getByRole("button", { name: "Cancelar edición", exact: true }).click();
    await active.getByRole("button", { name: /Editar Profesional/ }).click();
    await form.getByLabel("Nombre", { exact: true }).fill("Profesional actualizado");
    await form.getByLabel("Descripción (opcional)").fill("");
    await form.getByRole("checkbox", { name: "Consulta propia", exact: true }).uncheck();
    await form.getByRole("checkbox", { name: "Seguimiento propio (suspendido)", exact: true }).uncheck();
    failGet = true;
    const beforeEdit = { ...counts };
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Recurso actualizado");
    const updated = catalog.getByRole("listitem").filter({ hasText: "Profesional actualizado" });
    await expect(updated.getByText("Sin servicios asignados", { exact: true })).toBeVisible();
    await expect(updated.locator(".resources-description")).toHaveCount(0);
    expect(bodies.at(-1)).toEqual({ name: "Profesional actualizado", serviceIds: [], weeklySchedule });
    expect(counts).toEqual({ POST: beforeEdit.POST, PUT: beforeEdit.PUT + 1, GET: beforeEdit.GET + 1 });
    await expect(warning.getByRole("alert")).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("resources-edit-saved-warning.png"), fullPage: true });
    failGet = false;
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(counts).toEqual({ POST: beforeEdit.POST, PUT: beforeEdit.PUT + 1, GET: beforeEdit.GET + 2 });
    await business.unroute("**/api/me/resources");
    await business.reload();
    await expect(updated.getByText("Activo", { exact: true })).toBeVisible();
    await expect(updated.locator(".resources-description")).toHaveCount(0);
    await expect(updated.getByText("Sin servicios asignados", { exact: true })).toBeVisible();
    await expect(updated.locator(".resources-week div").filter({ hasText: "Lunes" })).toContainText("09:00–12:00 · 14:00–18:00");
    await expect(updated.locator(".resources-week div").filter({ hasText: "Jueves" })).toContainText("22:00–02:00 (día siguiente)");
    const persisted = await business.request.get(`${system.webUrl}/api/me/resources`);
    expect(persisted.status()).toBe(200);
    const records = await persisted.json() as Array<{ name: string; description: string | null; weeklySchedule: unknown }>;
    expect(records.find(record => record.name === "Profesional actualizado")).toMatchObject({ description: null, weeklySchedule });
    await other.reload();
    await expect(other.getByRole("listitem")).toHaveCount(1);
    await expect(other.getByText("Profesional actualizado", { exact: true })).toHaveCount(0);
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await business.screenshot({ path: testInfo.outputPath("resources-edited-360.png"), fullPage: true });
    // Weekly editor: real mutations/conflicts; only the committed-save GET500 is mocked.
    const hoursResource = await seed(business, "post", "resources", {
      name: "Recurso con franjas", description: "  descripción sin recortar  ",
      serviceIds: [ownService.id, suspendedService.id],
      weeklySchedule: { 1: [{ startMinute: 541, endMinute: 602 }], 2: [] },
    }, 201);
    await seed(business, "put", `resources/${hoursResource.id}/status`, { status: "suspended" }, 200);
    await business.reload();
    const hoursRow = catalog.getByRole("listitem").filter({ hasText: "Recurso con franjas" });
    const readHours = async () => {
      const response = await business.request.get(`${system.webUrl}/api/me/resources`);
      expect(response.status()).toBe(200);
      return (await response.json() as Array<Record<string, unknown>>).find(record => record.id === hoursResource.id)!;
    };
    const initialHours = await readHours();
    await hoursRow.getByRole("button", { name: "Editar Recurso con franjas", exact: true }).click();
    const editor = form.getByRole("group", { name: "Horario semanal", exact: true });
    await expect(editor.getByLabel("Inicio Lunes 1", { exact: true })).toHaveValue("09:01");
    await expect(editor.getByLabel("Fin Lunes 1", { exact: true })).toHaveValue("10:02");
    await form.getByLabel("Nombre", { exact: true }).fill("Recurso con franjas renombrado");
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Recurso actualizado");
    expect(await readHours()).toEqual({ ...initialHours, name: "Recurso con franjas renombrado" });
    await hoursRow.getByRole("button", { name: /Editar Recurso con franjas/ }).click();
    const beforeInvalid = counts.PUT;
    for (const [start, end] of [["09:01", "09:01"], ["9:01", "10:02"], ["24:00", "10:02"], ["09:01", "24:01"], ["09:01:00", "10:02"]]) {
      await editor.getByLabel("Inicio Lunes 1", { exact: true }).fill(start!);
      await editor.getByLabel("Fin Lunes 1", { exact: true }).fill(end!);
      await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
      await expect(form.getByRole("alert")).toContainText("HH:mm distintas");
      expect(counts.PUT).toBe(beforeInvalid);
    }
    await editor.getByLabel("Inicio Lunes 1", { exact: true }).fill("09:01");
    await editor.getByLabel("Fin Lunes 1", { exact: true }).fill("10:02");
    const addSpan = async (day: string, index: number, start: string, end: string) => {
      await editor.getByRole("button", { name: `Agregar franja ${day}`, exact: true }).click();
      await expect(editor.getByLabel(`Inicio ${day} ${index}`, { exact: true })).toHaveValue("");
      await expect(editor.getByLabel(`Fin ${day} ${index}`, { exact: true })).toHaveValue("");
      await editor.getByLabel(`Inicio ${day} ${index}`, { exact: true }).fill(start);
      await editor.getByLabel(`Fin ${day} ${index}`, { exact: true }).fill(end);
    };
    await addSpan("Martes", 1, "08:00", "09:00");
    const envelopeConflict = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}`)
      && response.request().method() === "PUT" && response.status() === 409);
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await envelopeConflict;
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(editor.getByLabel("Inicio Martes 1", { exact: true })).toHaveValue("08:00");
    expect(await readHours()).toEqual({ ...initialHours, name: "Recurso con franjas renombrado" });
    await business.screenshot({ path: testInfo.outputPath("resources-real-envelope-conflict-360.png"), fullPage: true });
    await editor.getByRole("button", { name: "Quitar franja Martes 1", exact: true }).click();
    const fullWeek = Object.fromEntries(Array.from({ length: 7 }, (_, day) =>
      [day, [{ startMinute: 0, endMinute: 1440 }]]));
    await seed(business, "put", "business-calendar", { weeklySchedule: fullWeek }, 200);
    await addSpan("Lunes", 2, "09:30", "11:01"); // overlap is valid; preserve raw rows
    await addSpan("Lunes", 3, "11:01", "12:00"); // adjacent is valid too
    await addSpan("Jueves", 1, "22:01", "01:02");
    await addSpan("Domingo", 1, "23:01", "00:02"); // wraps into Monday
    await addSpan("Sábado", 1, "00:00", "24:00");
    const rawSchedule = {
      1: [{ startMinute: 541, endMinute: 602 }, { startMinute: 570, endMinute: 661 }, { startMinute: 661, endMinute: 720 }],
      4: [{ startMinute: 1321, endMinute: 62 }], 0: [{ startMinute: 1381, endMinute: 2 }],
      6: [{ startMinute: 0, endMinute: 1440 }],
    };
    let releaseHours: (() => void) | undefined;
    const heldHours = new Promise<void>(resolve => { releaseHours = resolve; });
    await business.route(`**/api/me/resources/${hoursResource.id}`, async route => {
      await heldHours;
      await route.continue();
    });
    await business.route("**/api/me/resources", route => route.fulfill({ status: 500,
      contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    const beforeHoursSave = { ...counts };
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(editor.getByRole("button", { name: "Agregar franja Lunes", exact: true })).toBeDisabled();
    await expect(editor.getByLabel("Inicio Lunes 1", { exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Quitar franja Lunes 1", exact: true })).toBeDisabled();
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await business.screenshot({ path: testInfo.outputPath("resources-hours-pending-360.png"), fullPage: true });
    releaseHours!();
    await expect(form.getByRole("status")).toHaveText("Recurso actualizado");
    await expect(warning.getByRole("alert")).toBeVisible();
    expect(bodies.at(-1)).toEqual({ name: "Recurso con franjas renombrado", description: "  descripción sin recortar  ",
      serviceIds: initialHours.serviceIds, weeklySchedule: rawSchedule });
    expect(counts).toEqual({ ...beforeHoursSave, PUT: beforeHoursSave.PUT + 1, GET: beforeHoursSave.GET + 1 });
    await business.unroute(`**/api/me/resources/${hoursResource.id}`);
    await business.unroute("**/api/me/resources");
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(counts).toEqual({ ...beforeHoursSave, PUT: beforeHoursSave.PUT + 1, GET: beforeHoursSave.GET + 2 });
    await business.reload();
    expect(await readHours()).toEqual({ ...initialHours, name: "Recurso con franjas renombrado", weeklySchedule: rawSchedule });
    await hoursRow.getByRole("button", { name: /Editar Recurso con franjas/ }).click();
    await expect(editor.getByLabel("Fin Sábado 1", { exact: true })).toHaveValue("24:00");
    await expect(editor.getByLabel("Fin Domingo 1", { exact: true })).toHaveValue("00:02");
    await business.screenshot({ path: testInfo.outputPath("resources-hours-draft-360.png"), fullPage: true });
    for (const day of ["Lunes", "Jueves", "Domingo", "Sábado"]) {
      while (await editor.getByRole("button", { name: `Quitar franja ${day} 1`, exact: true }).count())
        await editor.getByRole("button", { name: `Quitar franja ${day} 1`, exact: true }).click();
    }
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Recurso actualizado");
    await business.reload();
    expect(await readHours()).toEqual({ ...initialHours, name: "Recurso con franjas renombrado", weeklySchedule: {} });
    await seed(business, "put", `resources/${inactive.id}`, {
      name: "Sala de consulta", description: "", serviceIds: [], weeklySchedule: {},
    }, 200);
    await business.reload();
    await suspended.getByRole("button", { name: "Editar Sala de consulta", exact: true }).click();
    await form.getByLabel("Nombre", { exact: true }).fill("Sala renombrada");
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Recurso actualizado");
    expect(bodies.at(-1)).toEqual({ name: "Sala renombrada", description: "", serviceIds: [], weeklySchedule: {} });
    await business.reload();
    const emptyDescriptionRecords = await business.request.get(`${system.webUrl}/api/me/resources`);
    expect((await emptyDescriptionRecords.json() as Array<Record<string, unknown>>).find(record => record.id === inactive.id))
      .toMatchObject({ name: "Sala renombrada", description: "", status: "suspended", serviceIds: [], weeklySchedule: {} });
    // Seed a real offered future booking; shrinking the assigned resource must produce a real 409.
    await seed(business, "put", `resources/${hoursResource.id}`, {
      name: "Recurso con franjas renombrado", description: "  descripción sin recortar  ",
      serviceIds: [ownService.id, suspendedService.id], weeklySchedule: fullWeek,
    }, 200);
    await seed(business, "put", `resources/${hoursResource.id}/status`, { status: "active" }, 200);
    const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const available = await business.request.get(`${system.webUrl}/api/me/appointments/availability?serviceId=${ownService.id}&resourceId=${hoursResource.id}&date=${date}`);
    expect(available.status()).toBe(200);
    const slots = await available.json() as Array<{ start: string; resourceId: string; terms: object }>;
    expect(slots.length).toBeGreaterThan(0);
    const booking = await seed(business, "post", "appointments", { serviceId: ownService.id, resourceId: hoursResource.id,
      startRaw: slots[0]!.start, date, expectedTerms: slots[0]!.terms, confirmed: true,
      newClient: { firstName: "Cliente", lastName: "Horario", phone: "+5491123456789" },
    }, 201);
    await business.reload();
    const bookedRecord = await readHours();
    await hoursRow.getByRole("button", { name: /Editar Recurso con franjas/ }).click();
    for (const day of ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"])
      await editor.getByRole("button", { name: `Quitar franja ${day} 1`, exact: true }).click();
    const bookingConflict = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}`)
      && response.request().method() === "PUT" && response.status() === 409);
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await bookingConflict;
    await expect(form.getByRole("alert")).toBeVisible();
    await expect(editor.getByRole("button", { name: /Quitar franja/ })).toHaveCount(0);
    expect(await readHours()).toEqual(bookedRecord);
    await business.screenshot({ path: testInfo.outputPath("resources-real-booking-conflict-360.png"), fullPage: true });
    // Lifecycle uses real status/retirement APIs; only catalog GET failure is mocked.
    await form.getByRole("button", { name: "Cancelar edición", exact: true }).click();
    await expect(hoursRow).toBeVisible();
    const lifecycleCounts = { PUT: 0, DELETE: 0, GET: 0 };
    business.on("request", request => {
      if (!/\/api\/me\/resources(?:\/|$)/.test(new URL(request.url()).pathname)) return;
      const method = request.method() as keyof typeof lifecycleCounts;
      if (method in lifecycleCounts) lifecycleCounts[method]++;
    });
    const confirmation = screen.getByRole("region", { name: "Confirmar acción sobre recurso", exact: true });
    for (const action of ["Suspender", "Retirar"]) {
      const opener = hoursRow.getByRole("button", { name: action, exact: true });
      await opener.focus();
      await business.keyboard.press("Enter");
      await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
      await business.screenshot({ path: testInfo.outputPath(`resources-${action}-confirm-360.png`), fullPage: true });
      await business.keyboard.press("Enter");
      await expect(opener).toBeEnabled();
      await expect(opener).toBeFocused();
      expect(lifecycleCounts).toEqual({ PUT: 0, DELETE: 0, GET: 0 });
    }
    const readBooking = async () => {
      const response = await business.request.get(`${system.webUrl}/api/me/appointments/${booking.id}`);
      expect(response.status()).toBe(200);
      return await response.json();
    };
    const originalBooking = await readBooking();
    let releaseStatus: (() => void) | undefined;
    const heldStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
    await business.route(`**/api/me/resources/${hoursResource.id}/status`, async route => {
      await heldStatus;
      await route.continue();
    });
    await business.route("**/api/me/resources", route => route.fulfill({ status: 500,
      contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await hoursRow.getByRole("button", { name: "Suspender", exact: true }).click();
    await expect(confirmation).toContainText("Los turnos existentes no se cancelan.");
    const suspendButton = confirmation.getByRole("button", { name: "Confirmar suspensión", exact: true });
    await suspendButton.click();
    await expect(confirmation).toHaveAttribute("aria-busy", "true");
    await expect(hoursRow.getByRole("button", { name: "Suspender", exact: true })).toBeDisabled();
    await expect(form.getByRole("button", { name: "Guardando…", exact: true })).toBeDisabled();
    await business.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('.resources-confirmation button:last-child');
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lifecycleCounts.PUT).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("resources-status-pending-360.png"), fullPage: true });
    const statusResponse = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}/status`)
      && response.request().method() === "PUT" && response.status() === 200);
    releaseStatus!();
    await statusResponse;
    await expect(hoursRow.getByText("Suspendido", { exact: true })).toBeVisible();
    await expect(hoursRow.getByRole("button", { name: "Reactivar", exact: true })).toBeFocused();
    await expect(warning.getByRole("alert")).toBeVisible();
    expect(lifecycleCounts).toEqual({ PUT: 1, DELETE: 0, GET: 1 });
    expect(await readBooking()).toEqual(originalBooking);
    expect(await readHours()).toEqual({ ...bookedRecord, status: "suspended" });
    await business.screenshot({ path: testInfo.outputPath("resources-status-saved-warning-360.png"), fullPage: true });
    await business.unroute(`**/api/me/resources/${hoursResource.id}/status`);
    await business.unroute("**/api/me/resources");
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(lifecycleCounts).toEqual({ PUT: 1, DELETE: 0, GET: 2 });
    await business.reload();
    await expect(hoursRow.getByText("Suspendido", { exact: true })).toBeVisible();
    const reactivateResponse = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}/status`)
      && response.request().method() === "PUT" && response.status() === 200);
    await hoursRow.getByRole("button", { name: "Reactivar", exact: true }).click();
    await reactivateResponse;
    await expect(hoursRow.getByRole("button", { name: "Suspender", exact: true })).toBeFocused();
    await business.reload();
    await expect(hoursRow.getByText("Activo", { exact: true })).toBeVisible();
    expect(await readHours()).toEqual(bookedRecord);
    expect(await readBooking()).toEqual(originalBooking);
    await hoursRow.getByRole("button", { name: "Retirar", exact: true }).click();
    const retireConflict = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}`)
      && response.request().method() === "DELETE" && response.status() === 409);
    await confirmation.getByRole("button", { name: "Confirmar retiro", exact: true }).click();
    await retireConflict;
    await expect(screen.locator(':scope > [role="alert"]')).toBeVisible();
    await expect(hoursRow).toBeVisible();
    expect(await readHours()).toEqual(bookedRecord);
    expect(await readBooking()).toEqual(originalBooking);
    await business.screenshot({ path: testInfo.outputPath("resources-real-retire-409-360.png"), fullPage: true });
    await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(hoursRow.getByRole("button", { name: "Retirar", exact: true })).toBeFocused();
    const retiredRow = catalog.getByRole("listitem").filter({ hasText: "Sala renombrada" });
    await business.route("**/api/me/resources", route => route.fulfill({ status: 500,
      contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await retiredRow.getByRole("button", { name: "Retirar", exact: true }).click();
    await expect(confirmation).toContainText("se conservará el historial");
    const beforeRetire = { ...lifecycleCounts };
    const retiredResponse = business.waitForResponse(response => response.url().endsWith(`/resources/${inactive.id}`)
      && response.request().method() === "DELETE" && response.status() === 200);
    await confirmation.getByRole("button", { name: "Confirmar retiro", exact: true }).click();
    expect(await (await retiredResponse).json()).toEqual({ id: inactive.id });
    await expect(retiredRow).toHaveCount(0);
    await expect(screen.getByRole("heading", { name: "Recursos", exact: true })).toBeFocused();
    await expect(warning.getByRole("alert")).toBeVisible();
    expect(lifecycleCounts).toEqual({ ...beforeRetire, DELETE: beforeRetire.DELETE + 1, GET: beforeRetire.GET + 1 });
    expect(await readBooking()).toEqual(originalBooking);
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await business.screenshot({ path: testInfo.outputPath("resources-retired-warning-360.png"), fullPage: true });
    await business.unroute("**/api/me/resources");
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(lifecycleCounts).toEqual({ ...beforeRetire, DELETE: beforeRetire.DELETE + 1, GET: beforeRetire.GET + 2 });
    await business.reload();
    await expect(retiredRow).toHaveCount(0);
    const adminReads: string[] = [];
    page.on("request", request => { if (/\/api\/me\/(resources|services)$/.test(request.url())) adminReads.push(request.url()); });
    await page.goto(`${system.webUrl}/resources`);
    await expect(page.locator('main[data-state="denied"]')).toBeVisible();
    expect(adminReads).toEqual([]);
  } finally {
    await context.close();
    await otherContext.close();
  }
});
