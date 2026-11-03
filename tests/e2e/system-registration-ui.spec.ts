import { expect } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

test("shared setup approves a registration without ending the admin session", async ({ page, system }) => {
  const business = { name: "Negocio de prueba", email: "fixture-registration@example.test", password: "fixture registration password" };
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  const row = await createBusinessInAdminUi(page, business);
  await expect(row.getByText(business.name, { exact: true })).toBeVisible();
  await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, business.email, business.password);
  await expect(page).toHaveURL(/\/profile$/);
});

test("registration success and admin decisions handle an error without losing the request", async ({ page, system }) => {
  for (const [name, email] of [["Primer negocio", "first-registration@example.test"], ["Segundo negocio", "second-registration@example.test"]]) {
    await page.goto(`${system.webUrl}/register`);
    await page.getByLabel("Nombre del negocio").fill(name!);
    await page.getByLabel("Correo", { exact: true }).fill(email!);
    await page.getByLabel("Contraseña", { exact: true }).fill("registration password safe");
    await page.getByRole("button", { name: "Solicitar acceso" }).click();
    await expect(page.getByRole("status")).toContainText("Esperá la aprobación");
    await expect(page.getByRole("button", { name: "Solicitud enviada" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Enviando…" })).toHaveCount(0);
  }
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page.getByRole("heading", { name: "Solicitudes pendientes" })).toBeVisible();
  let failed = false;
  await page.route("**/api/admin/registrations/*/approve", async route => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR" }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Aprobar Primer negocio" }).click();
  await expect(page.getByRole("region", { name: "Solicitudes pendientes" }).getByRole("alert")).toContainText("No se pudo completar la operación.");
  await expect(page.getByText("first-registration@example.test")).toBeVisible();
  await page.getByRole("button", { name: "Aprobar Primer negocio" }).click();
  await expect(page.getByText("first-registration@example.test")).toHaveCount(0);
  await page.getByRole("button", { name: "Rechazar Segundo negocio" }).click();
  await expect(page.getByText("second-registration@example.test")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Solicitud rechazada" })).toBeVisible();
});
