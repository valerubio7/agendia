import { test as base, type Page } from "@playwright/test";
import { startSystem, type SystemHarness } from "./system.ts";

export async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

export const test = base.extend<{ system: SystemHarness }>({
  system: async ({}, use) => {
    const system = await startSystem();
    try { await use(system); } finally { await system.stop(); }
  },
});
