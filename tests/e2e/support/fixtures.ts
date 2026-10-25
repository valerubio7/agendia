import { expect, test as base, type Page } from "@playwright/test";
import { startSystem, type SystemHarness } from "./system.ts";

export async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

export async function createBusinessInAdminUi(page: Page, business: {
  name: string;
  email: string;
  password: string;
}) {
  const screen = page.locator('[data-ui="admin-screen"]');
  await expect(screen).toBeVisible();
  const tab = screen.getByRole("tab", { name: "Negocios", exact: true });
  if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
  const opener = screen.locator('[aria-controls="admin-create"]');
  if (await opener.getAttribute("aria-expanded") !== "true") await opener.click();
  const form = screen.locator('[data-ui="admin-create"] form');
  await expect(form).toBeVisible();
  await form.getByLabel(/^Nombre/).fill(business.name);
  await form.getByLabel("Correo del usuario", { exact: true }).fill(business.email);
  await form.getByLabel(/^Contraseña inicial/).fill(business.password);
  await form.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(screen.locator(".admin-feedback").getByRole("status")).toHaveText("Negocio creado");
  const row = screen.locator('[data-ui="admin-inventory"]').getByRole("listitem")
    .filter({ has: page.getByText(business.name, { exact: true }) });
  await expect(row).toBeVisible();
  return row;
}

export const test = base.extend<{ system: SystemHarness }>({
  system: async ({}, use) => {
    const system = await startSystem();
    try { await use(system); } finally { await system.stop(); }
  },
});
