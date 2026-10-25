import { expect, type Page } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

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

test("Servicios creates and edits persisted owned services with safe validation and responsive states", async ({
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
    await createBusinessInAdminUi(page, { ...tenant, password });
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
    await expect(screen.getByRole("form", { name: "Crear servicio", exact: true })).toBeVisible();

    await login(otherPage, system.webUrl, tenants[1]!.email, password);
    await expect(otherPage).toHaveURL(/\/profile$/);
    await seedService(otherPage, "Servicio ajeno", 900);
    await otherPage.goto(`${system.webUrl}/services`);
    await expect(otherPage.getByRole("heading", { name: "Servicio ajeno", exact: true })).toBeVisible();

    const create = screen.getByRole("form", { name: "Crear servicio", exact: true });
    await create.getByLabel("Nombre", { exact: true }).fill("Consulta inicial");
    await create.getByLabel("Descripción (opcional)").fill("Una primera conversación para planificar tu atención.");
    await create.getByLabel("Precio (ARS)").fill("0");
    const requests = { POST: 0, PUT: 0, GET: 0 };
    businessPage.on("request", request => {
      if (/\/api\/me\/services(?:\/[^/]+)?$/.test(request.url())) {
        const method = request.method() as keyof typeof requests;
        if (method in requests) requests[method]++;
      }
    });
    const warning = screen.getByText("El servicio se guardó, pero no pudimos actualizar el catálogo. Reintentá la actualización.", { exact: true });
    const retry = screen.getByRole("button", { name: "Actualizar catálogo", exact: true });
    const failRefresh = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
        await businessPage.unroute("**/api/me/services", failRefresh);
      } else await route.continue();
    };
    const checkRefreshRecovery = async () => {
      await expect(warning).toBeVisible();
      await expect(create.getByLabel("Nombre", { exact: true })).toHaveValue("");
      await expect(screen.locator(".services-form").getByRole("alert")).toHaveCount(0);
      const before = { ...requests };
      await retry.click();
      await expect(warning).toHaveCount(0);
      expect(requests).toEqual({ ...before, GET: before.GET + 1 });
      console.log("refresh recovery requests", requests);
    };
    await create.getByLabel("Duración (minutos)").fill("16");
    await create.getByRole("button", { name: "Crear servicio", exact: true }).click();
    expect(await create.getByLabel("Duración (minutos)").evaluate((input: HTMLInputElement) => input.validity.stepMismatch)).toBe(true);
    expect(requests.POST).toBe(0); // Native validation, not an API failure.
    await create.getByLabel("Duración (minutos)").fill("15");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await businessPage.route("**/api/me/services", async route => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await create.getByRole("button", { name: "Crear servicio", exact: true }).click();
    await expect(create).toHaveAttribute("aria-busy", "true");
    await expect(create.getByRole("button", { name: "Guardando…" })).toBeDisabled();
    await expect(create.getByLabel("Nombre", { exact: true })).toBeDisabled();
    await businessPage.screenshot({ path: testInfo.outputPath("services-pending.png"), fullPage: true });
    await businessPage.route("**/api/me/services", failRefresh);
    const createdResponse = businessPage.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/services"));
    const failedCreateRefresh = businessPage.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith("/api/me/services") && response.status() === 500);
    release();
    expect((await createdResponse).status()).toBe(201);
    expect((await failedCreateRefresh).status()).toBe(500);
    console.log("POST201 then GET500 requests", requests);
    await expect(create.getByRole("status")).toHaveText("Servicio creado");
    await expect(screen.getByRole("heading", { name: "Consulta inicial", exact: true })).toBeVisible();
    await businessPage.screenshot({ path: testInfo.outputPath("services-create-refresh-warning.png"), fullPage: true });
    await checkRefreshRecovery();
    await businessPage.unroute("**/api/me/services");
    expect(requests.POST).toBe(1);
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
    await expect(active.getByText("15 min", { exact: true })).toBeVisible();
    await expect(active.getByText(/^ARS\s+0,00$/)).toBeVisible();
    await expect(active.getByText("Una primera conversación para planificar tu atención.", { exact: true })).toBeVisible();
    const inactive = list.getByRole("listitem").filter({ hasText: "Acompañamiento personalizado" });
    await expect(inactive.getByText("Suspendido", { exact: true })).toBeVisible();
    await expect(inactive.getByText(/^ARS\s+1\.250,50$/)).toBeVisible();
    await expect(inactive.locator(".services-description")).toHaveCount(0);
    await expect(screen.getByText("Servicio ajeno", { exact: true })).toHaveCount(0);
    await active.getByRole("button", { name: "Editar Consulta inicial", exact: true }).click();
    const edit = screen.getByRole("form", { name: "Editar servicio", exact: true });
    await expect(edit.getByLabel("Nombre", { exact: true })).toBeFocused();
    await expect(edit.getByLabel("Duración (minutos)")).toHaveValue("15");
    await expect(edit.getByLabel("Precio (ARS)")).toHaveValue("0");
    await expect(edit.getByLabel("Descripción (opcional)")).toHaveValue("Una primera conversación para planificar tu atención.");
    await edit.getByLabel("Nombre", { exact: true }).fill(" acompañamiento personalizado para pequeños negocios ");
    await edit.getByLabel("Duración (minutos)").fill("45");
    await edit.getByLabel("Precio (ARS)").fill("2750.125");
    await edit.getByLabel("Descripción (opcional)").fill("Seguimiento acordado.");
    const conflict = businessPage.waitForResponse(response => response.request().method() === "PUT" && /\/api\/me\/services\/[^/]+$/.test(response.url()));
    await edit.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(edit.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
    await expect(edit.getByLabel("Precio (ARS)")).toHaveValue("2750.125");
    await expect(edit.getByLabel("Descripción (opcional)")).toHaveValue("Seguimiento acordado.");
    await businessPage.screenshot({ path: testInfo.outputPath("services-conflict.png"), fullPage: true });
    await edit.getByLabel("Nombre", { exact: true }).fill("Consulta de seguimiento");
    await businessPage.route("**/api/me/services", failRefresh);
    const savedResponse = businessPage.waitForResponse(response => response.request().method() === "PUT" && /\/api\/me\/services\/[^/]+$/.test(response.url()));
    const failedEditRefresh = businessPage.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith("/api/me/services") && response.status() === 500);
    await edit.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    expect((await savedResponse).status()).toBe(200);
    expect((await failedEditRefresh).status()).toBe(500);
    console.log("PUT200 then GET500 requests", requests);
    await expect(create.getByRole("status")).toHaveText("Servicio actualizado");
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("heading", { name: "Consulta de seguimiento", exact: true })).toBeVisible();
    await expect(inactive.getByText("Suspendido", { exact: true })).toBeVisible();
    await businessPage.screenshot({ path: testInfo.outputPath("services-edit-refresh-warning.png"), fullPage: true });
    await checkRefreshRecovery();
    expect(requests.PUT).toBe(2);
    await expect(screen.locator(".services-form").getByRole("alert")).toHaveCount(0);
    await businessPage.reload();
    const updated = list.getByRole("listitem").filter({ hasText: "Consulta de seguimiento" });
    await expect(updated.getByText("45 min", { exact: true })).toBeVisible();
    await expect(updated.getByText(/^ARS\s+2\.750,125$/)).toBeVisible();
    await expect(updated.getByText("Seguimiento acordado.", { exact: true })).toBeVisible();
    await inactive.getByRole("button", { name: /Editar/ }).click();
    await expect(edit.getByLabel("Duración (minutos)")).toHaveValue("30");
    await expect(edit.getByLabel("Precio (ARS)")).toHaveValue("1250.5");
    await expect(edit.getByLabel("Descripción (opcional)")).toHaveValue("");
    await edit.getByRole("button", { name: "Cancelar edición" }).click();
    await otherPage.reload();
    await expect(otherPage.getByRole("listitem")).toHaveCount(1);
    await expect(otherPage.getByText("Consulta inicial", { exact: true })).toHaveCount(0);
    await expect(otherPage.getByText("Consulta de seguimiento", { exact: true })).toHaveCount(0);

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

test("Servicios confirms lifecycle actions, persists changes and recovers without repeating mutations", async ({ page, system }, testInfo) => {
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, {
    name: "Lifecycle Studio", email: "lifecycle@example.test", password: "lifecycle safe password",
  });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "lifecycle@example.test", "lifecycle safe password");
  await expect(page).toHaveURL(/\/profile$/);
  const service = await seedService(page, "Consulta lifecycle", 0);
  await page.goto(`${system.webUrl}/services`);
  const screen = page.getByRole("main");
  const row = screen.getByRole("listitem").filter({ hasText: "Consulta lifecycle" });
  await expect(row).toBeVisible();
  const confirmation = screen.getByRole("region", { name: "Confirmar acción" });
  const counts = { PUT: 0, DELETE: 0, GET: 0 };
  page.on("request", request => {
    if (/\/api\/me\/services(?:\/[^/]+(?:\/status)?)?$/.test(request.url())) {
      const method = request.method() as keyof typeof counts;
      if (method in counts) counts[method]++;
    }
  });
  const action = async (name: "Suspender" | "Retirar") => {
    await row.getByRole("button", { name: `${name} Consulta lifecycle`, exact: true }).click();
    await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  };
  for (const name of ["Suspender", "Retirar"] as const) {
    await action(name);
    await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(row.getByRole("button", { name: `${name} Consulta lifecycle`, exact: true })).toBeEnabled();
    await expect(row.getByRole("button", { name: `${name} Consulta lifecycle`, exact: true })).toBeFocused();
    expect(counts).toEqual({ PUT: 0, DELETE: 0, GET: 0 });
  }
  await action("Suspender");
  await expect(confirmation).toContainText("No cancela los turnos existentes");
  const statusUrl = `**/api/me/services/${service.id}/status`;
  await page.route(statusUrl, route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
  await confirmation.getByRole("button", { name: "Confirmar suspensión" }).click();
  await expect(confirmation.getByRole("alert")).toHaveText("No se pudo completar la operación.");
  await expect(row.getByText("Activo", { exact: true })).toBeVisible();
  expect(counts.PUT).toBe(1);
  await page.unroute(statusUrl);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(statusUrl, async route => { await held; await route.continue(); });
  const suspended = page.waitForResponse(response => response.url().endsWith(`/services/${service.id}/status`) && response.status() === 200);
  await confirmation.getByRole("button", { name: "Confirmar suspensión" }).click();
  await expect(confirmation).toHaveAttribute("aria-busy", "true");
  await expect(row.getByRole("button", { name: /Editar/ })).toBeDisabled();
  await expect(screen.getByLabel("Nombre", { exact: true })).toBeDisabled();
  await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("lifecycle-pending.png"), fullPage: true });
  release();
  expect((await suspended).status()).toBe(200);
  await expect(row.getByText("Suspendido", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Reactivar Consulta lifecycle", exact: true })).toBeEnabled();
  await expect(row.getByRole("button", { name: "Reactivar Consulta lifecycle", exact: true })).toBeFocused();
  await page.unroute(statusUrl);
  await page.reload();
  await expect(row.getByText("Suspendido", { exact: true })).toBeVisible();
  const reactivated = page.waitForResponse(response => response.url().endsWith(`/services/${service.id}/status`) && response.status() === 200);
  await row.getByRole("button", { name: "Reactivar Consulta lifecycle", exact: true }).click();
  expect((await reactivated).status()).toBe(200);
  await expect(row.getByText("Activo", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Suspender Consulta lifecycle", exact: true })).toBeEnabled();
  await expect(row.getByRole("button", { name: "Suspender Consulta lifecycle", exact: true })).toBeFocused();
  await page.reload();
  await expect(row.getByText("Activo", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 900 });
  await action("Retirar");
  await expect(confirmation).toContainText("oculto del catálogo");
  await expect(confirmation).toContainText("historial se conserva");
  await expect(confirmation).toContainText("turnos futuros");
  const retireUrl = `**/api/me/services/${service.id}`;
  // UI MOCKED 409 only: real future-assignment enforcement is covered in
  // service-catalog-api.integration.test.ts (ALL future states DELETE test).
  await page.route(retireUrl, route => route.fulfill({ status: 409, contentType: "application/json", body: '{"code":"CONFLICT"}' }));
  await confirmation.getByRole("button", { name: "Confirmar retiro" }).click();
  await expect(confirmation.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
  await expect(row.getByText("Activo", { exact: true })).toBeVisible();
  expect(counts.DELETE).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("lifecycle-mocked-conflict-mobile.png"), fullPage: true });
  await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(row.getByRole("button", { name: "Retirar Consulta lifecycle", exact: true })).toBeFocused();
  expect(counts.DELETE).toBe(1);
  await page.unroute(retireUrl);
  await action("Retirar");
  await page.route("**/api/me/services", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
  const retired = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().endsWith(`/services/${service.id}`));
  await confirmation.getByRole("button", { name: "Confirmar retiro" }).click();
  expect((await retired).status()).toBe(200);
  await expect(row).toHaveCount(0);
  await expect(screen.getByRole("heading", { name: "Servicios", exact: true })).toBeFocused();
  await expect(screen.getByRole("form", { name: "Crear servicio", exact: true }).getByRole("status")).toHaveText("Servicio retirado");
  await expect(screen.getByRole("region", { name: "Actualización del catálogo" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("lifecycle-retired-warning-mobile.png"), fullPage: true });
  const before = { ...counts };
  await page.unroute("**/api/me/services");
  await screen.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
  await expect(screen.getByRole("region", { name: "Actualización del catálogo" })).toHaveCount(0);
  expect(counts).toEqual({ ...before, GET: before.GET + 1 });
  console.log("lifecycle real status200 x2; mocked status500/DELETE409; real DELETE200 then GET500; recovery counts", counts);
  await page.reload();
  await expect(screen.getByRole("heading", { name: "Todavía no hay servicios" })).toBeVisible();
  expect(counts.PUT).toBe(3);
  expect(counts.DELETE).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
