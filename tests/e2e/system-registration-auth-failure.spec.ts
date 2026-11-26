import { expect } from "@playwright/test";
import { login, test } from "./support/fixtures.ts";

test("registration shows neutral feedback for an ambiguous conflict", async ({ page, system }) => {
  await page.route("**/api/auth/register", route => route.fulfill({ status: 409, json: { code: "CONFLICT", message: "Registration unavailable" } }));
  await page.goto(`${system.webUrl}/register`);
  await page.getByLabel("Nombre del negocio").fill("Negocio seguro");
  await page.getByLabel("Correo", { exact: true }).fill("user@example.test");
  await page.getByLabel("Contraseña", { exact: true }).fill("secure initial password");
  await page.getByLabel("Repetir contraseña").fill("secure initial password");
  await page.getByRole("button", { name: "Solicitar acceso" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("No se pudo enviar la solicitud. Revisá los datos o intentá nuevamente más tarde.");
  await expect(page).toHaveURL(`${system.webUrl}/register`);
  await expect(page.getByRole("button", { name: "Solicitar acceso" })).toBeEnabled();
});

test("registration shows neutral feedback when admission is unavailable", async ({ page, system }) => {
  await page.route("**/api/auth/register", route => route.fulfill({ status: 429, json: { code: "FORBIDDEN", message: "Too many registration attempts" } }));
  await page.goto(`${system.webUrl}/register`);
  await page.getByLabel("Nombre del negocio").fill("Negocio seguro");
  await page.getByLabel("Correo", { exact: true }).fill("user@example.test");
  await page.getByLabel("Contraseña", { exact: true }).fill("secure initial password");
  await page.getByLabel("Repetir contraseña").fill("secure initial password");
  await page.getByRole("button", { name: "Solicitar acceso" }).click();
  await expect(page.locator("main").getByRole("alert")).toHaveText("No se pudo enviar la solicitud. Intentá nuevamente más tarde.");
  await expect(page).toHaveURL(`${system.webUrl}/register`);
  await expect(page.getByRole("button", { name: "Solicitar acceso" })).toBeEnabled();
});

for (const status of [401, 403]) {
  test(`registration ${status} preserves healthy admin controls`, async ({ page, system }) => {
    await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    await expect(page).toHaveURL(/\/solicitudes$/);
    const response = await page.request.post(new URL("/api/auth/register", page.url()).href, {
      headers: { origin: new URL(page.url()).origin },
      data: { name: "Negocio seguro", email: `auth-${status}@example.test`, password: "secure initial password" },
    });
    expect(response.status()).toBe(202);
    await page.reload();
    await page.getByRole("button", { name: "Aprobar Negocio seguro" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Aprobar solicitud", exact: true }).click();
    await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Solicitud aprobada");
    await page.route("**/admin/registrations", route => route.fulfill({ status, json: { code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN" } }));
    await page.reload();
    const requests = page.getByRole("region", { name: "Solicitudes pendientes" });
    await expect(requests.getByText("No se pudieron cargar las solicitudes pendientes.")).toBeVisible();
    await expect(requests.getByText("No hay solicitudes pendientes")).toHaveCount(0);
    await page.getByRole("link", { name: "Negocios", exact: true }).click();
    await page.getByRole("button", { name: "Información del negocio: Negocio seguro", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Suspender negocio", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Suspender negocio", exact: true }).click();
    await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Negocio actualizado");
    await page.getByRole("link", { name: "Ajustes", exact: true }).click();
    await page.getByRole("button", { name: "Editar", exact: true }).click();
    const timing = page.getByRole("spinbutton", { name: /^Espera activa \(s\)/ });
    await timing.fill("23");
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Tiempos guardados");
    await expect(page.getByText("23 s", { exact: true })).toBeVisible();
  });
}

test("replaced same-identity session during registration failure fails closed", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  let release!: () => void, seen!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { seen = resolve; });
  await page.route("**/admin/registrations", async route => {
    seen();
    await hold;
    await route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
  });
  const loading = page.reload();
  await observed;
  const response = await page.request.post(`${system.webUrl}/api/auth/admin/login`, {
    headers: { origin: system.webUrl },
    data: { email: system.admin.email, password: system.admin.password },
  });
  expect(response.status()).toBe(200);
  release();
  await loading;
  await expect(page.locator('main.authenticated-terminal[data-state="load-error"]')).toBeVisible();
  await expect(page.locator('[data-ui="admin-screen"]')).toHaveCount(0);
});

test("replaced same-identity session during registration retry fails closed", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  let release!: () => void, seen!: () => void;
  let reads = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { seen = resolve; });
  await page.route("**/admin/registrations", async route => {
    reads++;
    if (reads === 1) return route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } });
    seen();
    await hold;
    await route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
  });
  await page.reload();
  await page.getByRole("button", { name: "Reintentar consulta" }).click();
  await observed;
  const response = await page.request.post(`${system.webUrl}/api/auth/admin/login`, {
    headers: { origin: system.webUrl },
    data: { email: system.admin.email, password: system.admin.password },
  });
  expect(response.status()).toBe(200);
  release();
  await expect(page.locator('main.authenticated-terminal[data-state="load-error"]')).toBeVisible();
  await expect(page.locator('[data-ui="admin-screen"]')).toHaveCount(0);
});

for (const validation of ["failure", "identity", "role", "business"] as const) {
  test(`registration auth failure with ${validation} session validation fails closed`, async ({ page, system }) => {
    await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
    const originalSession = await page.evaluate(async () => (await fetch("/api/auth/session")).json());
    let sessions = 0;
    await page.route("**/auth/session", async route => {
      sessions++;
      if (sessions === 1) return route.continue();
      if (validation === "failure") return route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } });
      await route.fulfill({ status: 200, json: { ...originalSession,
        ...(validation === "identity" ? { identityId: "different-identity" } : {}),
        ...(validation === "role" ? { role: "business_user" } : {}),
        ...(validation === "business" ? { businessId: "different-business" } : {}),
      } });
    });
    await page.route("**/admin/registrations", route => route.fulfill({ status: 403, json: { code: "FORBIDDEN" } }));
    await page.reload();
    await expect.poll(() => sessions).toBe(2);
    await expect(page.locator('p[role="alert"]')).toBeVisible();
    await expect(page.locator('[data-ui="admin-screen"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Ajustes", exact: true })).toHaveCount(0);
  });
}
