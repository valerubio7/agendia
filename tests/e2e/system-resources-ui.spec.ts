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
    await expect(screen.getByRole("button", { name: /Suspender|Reactivar|Retirar|horarios/i })).toHaveCount(0);
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
    await expect(form.getByText(/No podrá recibir reservas/)).toBeVisible();
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
