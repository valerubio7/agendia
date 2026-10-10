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

test("Recursos reads owned catalogs and weekly spans without mutation controls", async ({ browser, page, system }, testInfo) => {
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
    await expect(screen.getByRole("button")).toHaveCount(0);
    await expect(screen.locator("form, input, textarea, select")).toHaveCount(0);
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
