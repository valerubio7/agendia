import { expect, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

test("Horario reads only the tenant calendar and retries safely", async ({ browser, page, system }, testInfo) => {
  const password = "calendar tenant password safe";
  const tenants = ["calendar-ui@example.test", "other-calendar-ui@example.test"];
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  for (const [index, email] of tenants.entries()) {
    await page.getByLabel("Nombre", { exact: true }).fill(`Estudio Horario ${index}`);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await expect(page.getByRole("cell", { name: `Estudio Horario ${index}`, exact: true })).toBeVisible();
  }
  const adminReads: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/me/business-calendar") adminReads.push(request.method());
  });
  await page.goto(`${system.webUrl}/business-calendar`);
  await expect(page.locator('main[data-state="denied"]')).toBeVisible();
  expect(adminReads).toEqual([]);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext();
  const business = await context.newPage();
  const other = await otherContext.newPage();
  try {
    await login(business, system.webUrl, tenants[0]!, password);
    await expect(business).toHaveURL(/\/profile$/);
    await login(other, system.webUrl, tenants[1]!, password);
    await expect(other).toHaveURL(/\/profile$/);
    const seed = async (target: Page, path: string, data: object) => {
      const csrf = await target.evaluate(() => sessionStorage.getItem("agendia.csrf"));
      expect(csrf).toBeTruthy();
      const response = await target.request.put(`${system.webUrl}/api/me/${path}`, {
        headers: { Origin: system.webUrl, "x-csrf-token": csrf! }, data,
      });
      expect(response.status()).toBe(200);
    };
    await seed(business, "business-profile", {
      displayName: "Horario propio", description: "", address: "", offerings: "", businessHours: "LEGACY 09:00 a 18:00",
    });
    await seed(other, "business-calendar", { weeklySchedule: {} });
    const methods: string[] = [];
    business.on("request", request => {
      if (new URL(request.url()).pathname === "/api/me/business-calendar") methods.push(request.method());
    });
    await business.getByRole("navigation", { name: "Navegación del negocio", exact: true })
      .getByRole("link", { name: "Horario", exact: true }).click();
    const screen = business.getByRole("main");
    await expect(screen.getByRole("heading", { name: "Horario sin configurar", exact: true })).toBeVisible();
    await expect(screen.getByText(/LEGACY/)).toHaveCount(0);
    await business.screenshot({ path: testInfo.outputPath("calendar-unconfigured.png"), fullPage: true });
    await other.goto(`${system.webUrl}/business-calendar`);
    await expect(other.getByRole("heading", { name: "Todos los días sin atención", exact: true })).toBeVisible();
    await expect(other.getByText("Sin atención", { exact: true })).toHaveCount(7);
    await other.screenshot({ path: testInfo.outputPath("calendar-all-off.png"), fullPage: true });
    const weeklySchedule = {
      1: [{ startMinute: 547, endMinute: 720 }, { startMinute: 660, endMinute: 780 }, { startMinute: 780, endMinute: 797 }],
      4: [{ startMinute: 1327, endMinute: 123 }],
      0: [{ startMinute: 0, endMinute: 1440 }],
    };
    await seed(business, "business-calendar", { weeklySchedule });
    const read = await business.request.get(`${system.webUrl}/api/me/business-calendar`);
    expect(await read.json()).toEqual({ weeklySchedule });
    await business.reload();
    await expect(screen.getByRole("heading", { name: "Horario semanal guardado", exact: true })).toBeVisible();
    const days = screen.locator(".resources-week div");
    await expect(days.locator("dt")).toHaveText(["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]);
    await expect(days.nth(0).locator("dd p")).toHaveText(["09:07 – 12:00", "11:00 – 13:00", "13:00 – 13:17"]);
    await expect(days.nth(3).locator("dd")).toHaveText("22:07 – 02:03 (día siguiente)");
    await expect(days.nth(6).locator("dd")).toHaveText("00:00 – 24:00");
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      if (width === 360) await business.locator('[data-ui="mobile-navigation"] summary').click();
      const nav = business.getByRole("navigation", { name: width === 360 ? "Navegación móvil del negocio" : "Navegación del negocio", exact: true });
      await expect(nav.getByRole("link", { name: "Horario", exact: true })).toHaveAttribute("aria-current", "page");
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`calendar-${width}.png`), fullPage: true });
      if (width === 360) {
        await business.locator('[data-ui="mobile-navigation"] summary').click();
        await business.screenshot({ path: testInfo.outputPath("calendar-360-closed.png"), fullPage: true });
      }
    }
    await other.reload();
    await expect(other.getByRole("heading", { name: "Todos los días sin atención", exact: true })).toBeVisible();
    let fail = true;
    await business.route("**/api/me/business-calendar", async route => {
      expect(route.request().method()).toBe("GET");
      if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "PRIVATE diagnostic" } }) });
      else await route.continue();
    });
    await business.reload();
    const error = business.locator('main[data-state="load-error"]');
    await expect(error.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await expect(business.getByText(/PRIVATE/)).toHaveCount(0);
    await business.screenshot({ path: testInfo.outputPath("calendar-error.png"), fullPage: true });
    const beforeRetry = methods.length;
    fail = false;
    await error.getByRole("button", { name: "Volver a intentar", exact: true }).click();
    await expect(screen.getByRole("heading", { name: "Horario semanal guardado", exact: true })).toBeVisible();
    expect(methods.length).toBe(beforeRetry + 1);
    expect(methods.every(method => method === "GET")).toBe(true);
    await expect(screen.getByRole("button")).toHaveCount(0);
    await expect(screen.getByRole("form")).toHaveCount(0);
  } finally {
    await context.close();
    await otherContext.close();
  }
});
