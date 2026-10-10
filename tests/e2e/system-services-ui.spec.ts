import { expect, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

async function seedService(page: Page, name: string, priceArs: number, description?: string) {
  const csrf = await page.evaluate(() => sessionStorage.getItem("agendia.csrf"));
  expect(csrf).toBeTruthy();
  const response = await page.request.post(new URL("/api/me/services", page.url()).href, {
    headers: { Origin: new URL(page.url()).origin, "x-csrf-token": csrf! },
    data: { name, durationMinutes: 30, priceArs, ...(description ? { description } : {}) },
  });
  expect(response.status()).toBe(201);
  return await response.json() as { id: string };
}

test("Servicios shows only the owned catalog, empty and responsive read-only states", async ({
  browser, page, system,
}, testInfo) => {
  const password = "tenant services password safe";
  const tenants = [
    { name: "Estudio Servicios", email: "services-ui@example.test" },
    { name: "Otro Estudio", email: "other-services-ui@example.test" },
  ];
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  for (const tenant of tenants) {
    await page.getByLabel("Nombre", { exact: true }).fill(tenant.name);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(tenant.email);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await expect(page.getByRole("cell", { name: tenant.name, exact: true })).toBeVisible();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext();
  const businessPage = await context.newPage();
  const otherPage = await otherContext.newPage();
  try {
    await login(businessPage, system.webUrl, tenants[0]!.email, password);
    await expect(businessPage).toHaveURL(/\/profile$/);
    const navigation = businessPage.getByRole("navigation", { name: "Navegación del negocio", exact: true });
    await expect(navigation.getByRole("link", { name: "Servicios", exact: true })).toBeVisible();
    await businessPage.goto(`${system.webUrl}/services`);
    const screen = businessPage.getByRole("main");
    await expect(screen.getByRole("heading", { name: "Servicios", exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Servicios", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(screen.getByRole("heading", { name: "Todavía no hay servicios", exact: true })).toBeVisible();
    await expect(screen.locator("form, button, a")).toHaveCount(0);

    await login(otherPage, system.webUrl, tenants[1]!.email, password);
    await expect(otherPage).toHaveURL(/\/profile$/);
    await seedService(otherPage, "Servicio ajeno", 900);
    await otherPage.goto(`${system.webUrl}/services`);
    await expect(otherPage.getByRole("heading", { name: "Servicio ajeno", exact: true })).toBeVisible();

    await seedService(businessPage, "Consulta inicial", 0, "Una primera conversación para planificar tu atención.");
    const suspended = await seedService(businessPage, "Acompañamiento personalizado para pequeños negocios", 1250.5);
    const csrf = await businessPage.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    const response = await businessPage.request.put(new URL(`/api/me/services/${suspended.id}/status`, businessPage.url()).href, {
      headers: { Origin: new URL(businessPage.url()).origin, "x-csrf-token": csrf! },
      data: { status: "suspended" },
    });
    expect(response.status()).toBe(200);
    await businessPage.reload();
    const list = screen.getByRole("list", { name: "Catálogo de servicios", exact: true });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    const active = list.getByRole("listitem").filter({ hasText: "Consulta inicial" });
    await expect(active.getByText("Activo", { exact: true })).toBeVisible();
    await expect(active.getByText("30 min", { exact: true })).toBeVisible();
    await expect(active.getByText(/^ARS\s+0,00$/)).toBeVisible();
    await expect(active.getByText("Una primera conversación para planificar tu atención.", { exact: true })).toBeVisible();
    const inactive = list.getByRole("listitem").filter({ hasText: "Acompañamiento personalizado" });
    await expect(inactive.getByText("Suspendido", { exact: true })).toBeVisible();
    await expect(inactive.getByText(/^ARS\s+1\.250,50$/)).toBeVisible();
    await expect(inactive.locator(".services-description")).toHaveCount(0);
    await expect(screen.getByText("Servicio ajeno", { exact: true })).toHaveCount(0);
    await expect(screen.locator("form, button, a")).toHaveCount(0);
    await otherPage.reload();
    await expect(otherPage.getByRole("listitem")).toHaveCount(1);
    await expect(otherPage.getByText("Consulta inicial", { exact: true })).toHaveCount(0);

    for (const width of [1280, 360]) {
      await businessPage.setViewportSize({ width, height: 900 });
      if (width === 360) {
        const mobile = businessPage.locator('[data-ui="mobile-navigation"]');
        await mobile.getByText("Menú", { exact: true }).click();
        await expect(mobile.getByRole("link", { name: "Servicios", exact: true })).toBeVisible();
        await mobile.getByRole("link", { name: "Servicios", exact: true }).click();
        await expect(mobile.getByRole("link", { name: "Servicios", exact: true })).toHaveAttribute("aria-current", "page");
        await mobile.getByText("Menú", { exact: true }).click();
      }
      expect(await businessPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await businessPage.screenshot({ path: testInfo.outputPath(`services-${width}.png`), fullPage: true });
    }
    await businessPage.route("**/api/me/services", route => route.fulfill({
      status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR" }),
    }));
    await businessPage.reload();
    await expect(businessPage.getByRole("heading", { name: "No pudimos cargar el panel", exact: true })).toBeVisible();
    await expect(businessPage.locator('main[data-state="load-error"]').getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await businessPage.unroute("**/api/me/services");
    await businessPage.getByRole("button", { name: "Volver a intentar", exact: true }).click();
    await expect(businessPage.getByRole("listitem")).toHaveCount(2);
  } finally {
    await context.close();
    await otherContext.close();
  }
});
