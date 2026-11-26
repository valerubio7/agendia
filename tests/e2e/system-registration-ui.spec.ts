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
  await expect(page).toHaveURL(/\/inicio$/);
});

test("registration is a branded, responsive form separate from unchanged login", async ({ page, system }, testInfo) => {
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${system.webUrl}/login`);
    await expect(page.locator('[data-ui="login-story"]')).toBeVisible();
    await page.goto(`${system.webUrl}/register`);
    const registration = page.locator('[data-ui="register-screen"]');
    await expect(registration.getByRole("img", { name: "agendIA" })).toBeVisible();
    await expect(registration.getByLabel("Contraseña", { exact: true })).toHaveAccessibleDescription("Al menos 16 caracteres.");
    await expect(registration.getByRole("link", { name: "Volver a iniciar sesión" })).toHaveAttribute("href", "/login");
    await expect(page.locator('[data-ui="login-story"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`register-${width}.png`), fullPage: true });
  }
});

test("rejecting a request requires confirmation and cancellation leaves it pending", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  expect((await page.request.post(`${system.webUrl}/api/auth/register`, {
    headers: { origin: system.webUrl }, data: { name: "Solicitud cancelable", email: "cancel@example.test", password: "registration password safe" },
  })).status()).toBe(202);
  await expect(page).toHaveURL(/\/solicitudes$/);
  await page.reload();
  let writes = 0;
  await page.route("**/api/admin/registrations/*/reject", async route => { writes++; await route.continue(); });
  const reject = page.getByRole("button", { name: "Rechazar Solicitud cancelable", exact: true });
  await reject.click();
  const confirmation = page.getByRole("alertdialog", { name: "¿Rechazar solicitud?" });
  await expect(confirmation).toBeVisible({ timeout: 3000 });
  expect(writes).toBe(0);
  await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(reject).toBeFocused();
  expect(writes).toBe(0);
  await expect(page.getByText("cancel@example.test")).toBeVisible();
});

test("registration rejects mismatched passwords without sending a request", async ({ page, system }) => {
  await page.goto(`${system.webUrl}/register`);
  let submissions = 0;
  await page.route("**/api/auth/register", async route => { submissions++; await route.continue(); });
  await page.getByLabel("Nombre del negocio").fill("Negocio de prueba");
  await page.getByLabel("Correo", { exact: true }).fill("mismatch@example.test");
  await page.getByLabel("Contraseña", { exact: true }).fill("registration password safe");
  await page.getByLabel("Repetir contraseña", { exact: true }).fill("different password safe");
  await page.getByRole("button", { name: "Solicitar acceso" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Las contraseñas no coinciden" })).toBeVisible();
  expect(submissions).toBe(0);
  await expect(page).toHaveURL(/\/register$/);
});

test("registration success and admin decisions handle an error without losing the request", async ({ page, system }) => {
  for (const [name, email] of [["Primer negocio", "first-registration@example.test"], ["Segundo negocio", "second-registration@example.test"]]) {
    await page.goto(`${system.webUrl}/register`);
    await page.getByLabel("Nombre del negocio").fill(name!);
    await page.getByLabel("Correo", { exact: true }).fill(email!);
    await page.getByLabel("Contraseña", { exact: true }).fill("registration password safe");
    await page.getByLabel("Repetir contraseña", { exact: true }).fill("registration password safe");
    await page.getByRole("button", { name: "Solicitar acceso" }).click();
    await expect(page).toHaveURL(/\/login\?registro=pendiente$/);
    await expect(page.getByRole("status")).toContainText("Esperá la aprobación");
    await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
  }
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/solicitudes$/);
  await expect(page.getByRole("heading", { name: "Solicitudes pendientes" })).toBeVisible();
  let failed = false;
  await page.route("**/api/admin/registrations/*/approve", async route => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR" }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Aprobar Primer negocio" }).click();
  const confirmation = page.getByRole("alertdialog");
  const approve = confirmation.getByRole("button", { name: "Aprobar solicitud", exact: true });
  await approve.click();
  await expect(confirmation.getByRole("alert")).toHaveText("No se pudo completar la operación.");
  await expect(page.getByText("first-registration@example.test")).toHaveCount(1);
  await approve.click();
  await expect(page.getByText("first-registration@example.test")).toHaveCount(0);
  await page.getByRole("button", { name: "Rechazar Segundo negocio" }).click();
  await confirmation.getByRole("button", { name: "Rechazar solicitud", exact: true }).click();
  await expect(page.getByText("second-registration@example.test")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Solicitud rechazada" })).toBeVisible();
});
