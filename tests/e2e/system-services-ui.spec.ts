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
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
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
    await edit.getByLabel("Duración (minutos)").fill("20");
    await edit.getByLabel("Precio (ARS)").fill("2750.125");
    await edit.getByLabel("Descripción (opcional)").fill("Seguimiento acordado.");
    const unrelatedConflict = async (route: import("@playwright/test").Route) => {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "CONFLICT", message: "Unrelated conflict" }) });
    };
    await businessPage.route("**/api/me/services/*", unrelatedConflict);
    await edit.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(edit.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
    await businessPage.unroute("**/api/me/services/*", unrelatedConflict);
    const conflict = businessPage.waitForResponse(response => response.request().method() === "PUT" && /\/api\/me\/services\/[^/]+$/.test(response.url()));
    await edit.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    expect((await conflict).status()).toBe(409);
    await expect(edit.getByRole("alert")).toHaveText("Ya hay un servicio con ese nombre. Elegí otro nombre.");
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
    expect(requests.PUT).toBe(3);
    await expect(screen.locator(".services-form").getByRole("alert")).toHaveCount(0);
    await businessPage.reload();
    const updated = list.getByRole("listitem").filter({ hasText: "Consulta de seguimiento" });
    await expect(updated.getByText("20 min", { exact: true })).toBeVisible();
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

    await create.getByLabel("Nombre", { exact: true }).fill("Consulta de seguimiento");
    await create.getByLabel("Descripción (opcional)").fill("Conservar esta descripción");
    const duplicate = businessPage.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/services"));
    await create.getByRole("button", { name: "Crear servicio", exact: true }).click();
    expect((await duplicate).status()).toBe(409);
    await expect(create.getByRole("alert")).toHaveText("Ya hay un servicio con ese nombre. Elegí otro nombre.");
    await expect(create.getByLabel("Nombre", { exact: true })).toHaveValue("Consulta de seguimiento");
    await expect(create.getByLabel("Descripción (opcional)")).toHaveValue("Conservar esta descripción");
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await create.getByLabel("Nombre", { exact: true }).fill("Consulta nueva");
    await create.getByRole("button", { name: "Crear servicio", exact: true }).click();
    await expect(create.getByRole("status")).toHaveText("Servicio creado");
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await expect(list.getByRole("heading", { name: "Consulta nueva", exact: true })).toBeVisible();
  } finally {
    await context.close();
    await otherContext.close();
  }
});

test("categorías ocultan el catálogo cuando falla la autorización al refrescar", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, { name: "Catálogo privado", email: "category-auth@example.test", password: "category auth safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "category-auth@example.test", "category auth safe password");
  await expect(page).toHaveURL(/\/profile$/);
  await seedService(page, "Servicio privado", 500);
  await page.goto(`${system.webUrl}/services`);
  await expect(page.getByRole("heading", { name: "Servicio privado" })).toBeVisible();
  await page.route("**/api/me/service-categories", async route => {
    if (route.request().method() === "GET") await route.fulfill({ status: 401, contentType: "application/json", body: '{"code":"UNAUTHENTICATED"}' });
    else await route.continue();
  });
  const form = page.getByRole("form", { name: "Crear categoría" });
  await form.getByLabel("Nombre de categoría").fill("Privada");
  await form.getByRole("button", { name: "Crear categoría" }).click();
  await expect(page.getByRole("heading", { name: "Servicio privado" })).toHaveCount(0);
  await expect(page.getByText("Privada", { exact: true })).toHaveCount(0);
});

test("un cambio de sesión no mezcla catálogos ni envía cambios desde la pestaña anterior", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  for (const [name, email] of [["Primer negocio", "category-owner-a@example.test"], ["Segundo negocio", "category-owner-b@example.test"]] as const)
    await createBusinessInAdminUi(page, { name, email, password: "category owner safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "category-owner-a@example.test", "category owner safe password");
  await expect(page).toHaveURL(/\/profile$/);
  await seedService(page, "Servicio del primero", 300);
  await page.goto(`${system.webUrl}/services`);
  await expect(page.getByRole("heading", { name: "Servicio del primero" })).toBeVisible();
  const second = await page.context().newPage();
  await second.goto(`${system.webUrl}/profile`);
  await second.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(second, system.webUrl, "category-owner-b@example.test", "category owner safe password");
  await expect(second).toHaveURL(/\/profile$/);
  let posts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/me/service-categories")) posts++; });
  const form = page.getByRole("form", { name: "Crear categoría" });
  await form.getByLabel("Nombre de categoría").fill("No enviar");
  await form.getByRole("button", { name: "Crear categoría" }).click();
  await expect(page.getByRole("heading", { name: "Servicio del primero" })).toHaveCount(0);
  expect(posts).toBe(0);
  await second.close();
});

test("categorías agrupan servicios y al eliminarlas conservan sus datos", async ({ page, system }, testInfo) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, { name: "Odontología", email: "categories@example.test", password: "categories safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "categories@example.test", "categories safe password");
  await expect(page).toHaveURL(/\/profile$/);
  await page.goto(`${system.webUrl}/services`);
  const screen = page.getByRole("main");
  const categoryForm = screen.getByRole("form", { name: "Crear categoría" });
  await categoryForm.getByLabel("Nombre de categoría").fill("Odontología");
  await categoryForm.getByRole("button", { name: "Crear categoría" }).click();
  const create = screen.getByRole("form", { name: "Crear servicio" });
  for (const name of ["Consulta", "Tratamiento de conducto"]) {
    await create.getByLabel("Nombre", { exact: true }).fill(name);
    await create.getByLabel("Precio (ARS)").fill("1200");
    await create.getByLabel("Categoría", { exact: true }).selectOption({ label: "Odontología" });
    await create.getByRole("button", { name: "Crear servicio" }).click();
    await expect(create.getByRole("status")).toHaveText("Servicio creado");
  }
  const group = screen.getByRole("region", { name: "Odontología", exact: true });
  await expect(group.getByRole("heading", { name: "Consulta", exact: true })).toBeVisible();
  await expect(group.getByRole("heading", { name: "Tratamiento de conducto", exact: true })).toBeVisible();
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`category-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await categoryForm.getByLabel("Nombre de categoría").fill("Otra categoría");
  await categoryForm.getByRole("button", { name: "Crear categoría" }).click();
  await expect(screen.getByRole("region", { name: "Otra categoría" })).toBeVisible();
  await group.getByRole("button", { name: "Editar Consulta" }).click();
  const edit = screen.getByRole("form", { name: "Editar servicio" });
  await edit.getByLabel("Categoría", { exact: true }).selectOption({ label: "Otra categoría" });
  await edit.getByRole("button", { name: "Guardar cambios" }).click();
  const other = screen.getByRole("region", { name: "Otra categoría" });
  await expect(other.getByRole("heading", { name: "Consulta", exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Editar Consulta" }).click();
  await edit.getByLabel("Categoría", { exact: true }).selectOption("");
  await edit.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(screen.getByRole("region", { name: "Sin categoría" }).getByRole("heading", { name: "Consulta", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Editar Consulta" }).click();
  await edit.getByLabel("Categoría", { exact: true }).selectOption({ label: "Odontología" });
  await edit.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(group.getByRole("heading", { name: "Consulta", exact: true })).toBeVisible();
  const deleteButton = group.getByRole("button", { name: "Eliminar categoría Odontología" });
  await deleteButton.click();
  await expect(screen.getByRole("region", { name: "Confirmar eliminación de categoría" }).getByRole("button", { name: "Cancelar" })).toBeFocused();
  await screen.getByRole("region", { name: "Confirmar eliminación de categoría" }).getByRole("button", { name: "Cancelar" }).click();
  await expect(deleteButton).toBeFocused();
  await deleteButton.click();
  const confirmation = screen.getByRole("region", { name: "Confirmar eliminación de categoría" });
  await expect(confirmation).toContainText("Los servicios se conservan y quedan sin categoría");
  await confirmation.getByRole("button", { name: "Confirmar eliminación" }).click();
  const unassigned = screen.getByRole("region", { name: "Sin categoría" });
  await expect(unassigned.getByRole("heading", { name: "Consulta", exact: true })).toBeVisible();
  await expect(unassigned.getByRole("heading", { name: "Tratamiento de conducto", exact: true })).toBeVisible();
  await page.reload();
  await expect(unassigned.getByText("15 min")).toHaveCount(2);
  await expect(unassigned.getByText(/^ARS\s+1\.200,00$/)).toHaveCount(2);
  await unassigned.getByRole("button", { name: "Editar Consulta", exact: true }).click();
  await expect(screen.getByRole("form", { name: "Editar servicio" }).getByLabel("Categoría", { exact: true })).toHaveValue("");
});

test("an interrupted services operation stays interrupted after logout fails", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, { name: "Carreras", email: "services-race@example.test", password: "services race safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "services-race@example.test", "services race safe password");
  await expect(page).toHaveURL(/\/profile$/);
  await page.goto(`${system.webUrl}/services`);
  const category = page.getByRole("form", { name: "Crear categoría" });
  await expect(category).toBeVisible();
  let writes = 0;
  page.on("request", request => {
    if (/\/api\/me\/(services|service-categories)(?:\/.*)?$/.test(request.url()) && request.method() !== "GET") writes++;
  });
  await page.route("**/api/auth/logout", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));

  let releaseSession!: () => void, sessionReached!: () => void;
  const sessionHeld = new Promise<void>(resolve => { releaseSession = resolve; });
  const sessionStarted = new Promise<void>(resolve => { sessionReached = resolve; });
  const holdSession = async (route: import("@playwright/test").Route) => {
    const response = await route.fetch();
    sessionReached();
    await sessionHeld;
    await route.fulfill({ response });
  };
  await page.route("**/api/auth/session", holdSession);
  await category.getByLabel("Nombre de categoría").fill("No enviar");
  await category.getByRole("button", { name: "Crear categoría" }).click();
  await sessionStarted;
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cerrar sesión", exact: true })).toBeEnabled();
  releaseSession();
  await expect(category.getByRole("button", { name: "Crear categoría" })).toBeEnabled();
  expect(writes).toBe(0);
  await expect(category.getByLabel("Nombre de categoría")).toHaveValue("No enviar");
  await expect(category.getByRole("status")).toHaveCount(0);
  await page.unroute("**/api/auth/session", holdSession);

  let releaseSave!: () => void, saveReached!: () => void;
  const saveHeld = new Promise<void>(resolve => { releaseSave = resolve; });
  const saveStarted = new Promise<void>(resolve => { saveReached = resolve; });
  await page.route("**/api/me/services", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    saveReached();
    await saveHeld;
    await route.fulfill({ response });
  });
  const form = page.getByRole("form", { name: "Crear servicio" });
  await form.getByLabel("Nombre", { exact: true }).fill("Respuesta vieja");
  await form.getByLabel("Precio (ARS)").fill("100");
  await form.getByRole("button", { name: "Crear servicio" }).click();
  await saveStarted;
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cerrar sesión", exact: true })).toBeEnabled();
  releaseSave();
  await expect(form).toHaveAttribute("aria-busy", "false");
  expect(writes).toBe(1);
  await expect(form.getByLabel("Nombre", { exact: true })).toHaveValue("Respuesta vieja");
  await expect(form.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Respuesta vieja", exact: true })).toHaveCount(0);
});

test("categorías informan errores y reintentan solo la lectura", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, { name: "Errores categorías", email: "category-errors@example.test", password: "category errors safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "category-errors@example.test", "category errors safe password");
  await expect(page).toHaveURL(/\/profile$/);
  await page.goto(`${system.webUrl}/services`);
  const serviceForm = page.getByRole("form", { name: "Crear servicio" });
  await serviceForm.getByLabel("Nombre", { exact: true }).fill("Servicio sin categoría");
  await serviceForm.getByLabel("Precio (ARS)").fill("450");
  await serviceForm.getByRole("button", { name: "Crear servicio" }).click();
  const unassigned = page.getByRole("region", { name: "Sin categoría" });
  await expect(unassigned.getByRole("heading", { name: "Servicio sin categoría" })).toBeVisible();
  await expect(unassigned.getByText("15 min")).toBeVisible();
  const form = page.getByRole("form", { name: "Crear categoría" });
  const url = "**/api/me/service-categories";
  const failCreate = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
    else await route.continue();
  };
  await page.route(url, failCreate);
  await form.getByLabel("Nombre de categoría").fill("Prueba");
  await form.getByRole("button", { name: "Crear categoría" }).click();
  await expect(form.getByRole("alert")).toHaveText("No se pudo completar la operación.");
  await expect(form.getByLabel("Nombre de categoría")).toHaveValue("Prueba");
  await page.unroute(url, failCreate);
  let posts = 0;
  page.on("request", request => { if (request.url().endsWith("/api/me/service-categories") && request.method() === "POST") posts++; });
  const failGet = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
    else await route.continue();
  };
  await page.route(url, failGet);
  await form.getByRole("button", { name: "Crear categoría" }).click();
  await expect(form.getByRole("status")).toHaveText("Categoría creada");
  await expect(page.getByRole("region", { name: "Actualización del catálogo" })).toBeVisible();
  expect(posts).toBe(1);
  await page.unroute(url, failGet);
  let releaseRefresh!: () => void, refreshReached!: () => void;
  const refreshHeld = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const refreshStarted = new Promise<void>(resolve => { refreshReached = resolve; });
  const holdRefresh = async (route: import("@playwright/test").Route) => {
    const response = await route.fetch();
    refreshReached();
    await refreshHeld;
    await route.fulfill({ response });
  };
  await page.route(url, holdRefresh);
  await page.route("**/api/auth/logout", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
  const retry = page.getByRole("button", { name: "Actualizar catálogo" });
  await retry.click();
  await refreshStarted;
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cerrar sesión", exact: true })).toBeEnabled();
  releaseRefresh();
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("region", { name: "Actualización del catálogo" })).toBeVisible();
  await page.unroute(url, holdRefresh);
  await retry.click();
  await expect(page.getByRole("region", { name: "Actualización del catálogo" })).toHaveCount(0);
  expect(posts).toBe(1);
  const group = page.getByRole("region", { name: "Prueba", exact: true });
  await group.getByRole("button", { name: "Eliminar categoría Prueba" }).click();
  const confirm = page.getByRole("region", { name: "Confirmar eliminación de categoría" });
  await page.route("**/api/me/service-categories/*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
  await confirm.getByRole("button", { name: "Confirmar eliminación" }).click();
  await expect(confirm.getByRole("alert")).toHaveText("No se pudo completar la operación.");
  await expect(group).toBeVisible();
  await confirm.getByRole("button", { name: "Cancelar" }).click();
  await expect(group.getByRole("button", { name: "Eliminar categoría Prueba" })).toBeFocused();
  await page.reload();
  await expect(group).toBeVisible();
});

test("Servicios confirms lifecycle actions, persists changes and recovers without repeating mutations", async ({ page, system }, testInfo) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
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
