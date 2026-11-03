import { expect, test as base, type Page } from "@playwright/test";
import { startSystem, type SystemHarness } from "./system.ts";
import { buildWebRuntime } from "./web-runtime.ts";

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
  const response = await page.request.post(new URL("/api/auth/register", page.url()).href, {
    headers: { origin: new URL(page.url()).origin }, data: business,
  });
  expect(response.status()).toBe(202);
  await page.reload();
  await expect(screen.getByRole("button", { name: `Aprobar ${business.name}`, exact: true })).toBeVisible();
  await screen.getByRole("button", { name: `Aprobar ${business.name}`, exact: true }).click();
  await expect(screen.locator(".admin-feedback").getByRole("status")).toHaveText("Solicitud aprobada");
  const row = screen.locator('[data-ui="admin-inventory"]').getByRole("listitem")
    .filter({ has: page.getByText(business.name, { exact: true }) });
  await expect(row).toBeVisible();
  return row;
}

export const test = base.extend<{ system: SystemHarness }, { webBuild: Awaited<ReturnType<typeof buildWebRuntime>> }>({
  webBuild: [async ({}, use) => {
    const build = await buildWebRuntime(process.cwd());
    try { await use(build); } finally { await build.dispose(); }
  }, { scope: "worker", timeout: 180_000 }],
  system: async ({ webBuild }, use) => {
    const system = await startSystem(webBuild.cwd);
    try { await use(system); } finally { await system.stop(); }
  },
});
