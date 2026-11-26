import { expect } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

test("admin login and authenticated entrances open Inicio without replacing deep links", async ({ page, system }) => {
  const { webUrl, admin } = system;
  const screen = page.locator('[data-ui="admin-screen"]');
  const expectInicio = async () => {
    await expect(page).toHaveURL(`${webUrl}/solicitudes`);
    await expect(screen.getByRole("heading", { name: "Solicitudes pendientes", level: 1, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Inicio", exact: true })).toHaveAttribute("aria-current", "page");
  };

  await test.step("submit the admin login", async () => {
    await login(page, `${webUrl}/admin/login`, admin.email, admin.password);
    await expectInicio();
  });
  for (const entrance of ["/", "/login", "/admin/login"]) {
    await page.goto(`${webUrl}${entrance}`);
    await expectInicio();
  }
  for (const [path, heading] of [["/businesses", "Negocios"], ["/ajustes", "Ajustes"]] as const) {
    await page.goto(`${webUrl}${path}`);
    await expect(screen.getByRole("heading", { name: heading, level: 1, exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${webUrl}${path}`);
  }
});

test("business login and authenticated entrances still open Inicio without replacing deep links", async ({ page, browser, system }) => {
  const { webUrl, admin } = system;
  const tenant = { name: "Landing Business", email: "landing-business@example.test", password: "isolated landing test password" };
  await login(page, `${webUrl}/admin/login`, admin.email, admin.password);
  await createBusinessInAdminUi(page, tenant);

  const business = await browser.newPage();
  try {
    const expectInicio = async () => {
      await expect(business).toHaveURL(`${webUrl}/inicio`);
      await expect(business.getByRole("link", { name: "Ver agenda completa", exact: true })).toBeVisible();
    };
    await login(business, `${webUrl}/login`, tenant.email, tenant.password);
    await expectInicio();
    for (const entrance of ["/", "/login"]) {
      await business.goto(`${webUrl}${entrance}`);
      await expectInicio();
    }

    await business.goto(`${webUrl}/admin/login`);
    await expect(business.getByRole("heading", { name: "Acceso de administración", exact: true })).toBeVisible();
    await expect(business.getByRole("button", { name: "Ingresar", exact: true })).toBeEnabled();
    await expect(business).toHaveURL(`${webUrl}/admin/login`);

    await business.goto(`${webUrl}/turnos`);
    await expect(business.locator(".agenda-screen")).toBeVisible();
    await expect(business).toHaveURL(`${webUrl}/turnos`);
  } finally {
    await business.close();
  }
});
