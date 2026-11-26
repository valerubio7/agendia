import { pathToFileURL } from "node:url";
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

test("Servicios shows a filterable card catalog and opens read-only detail and management dialogs", async ({ page, system, browser }, testInfo) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, { name: "Estudio Oliva", email: "services-visual@example.test", password: "services visual safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "services-visual@example.test", "services visual safe password");
  await expect(page).toHaveURL(/\/inicio$/);
  const csrf = await page.evaluate(() => sessionStorage.getItem("agendia.csrf"));
  const url = new URL(page.url()).origin;
  const headers = { Origin: url, "x-csrf-token": csrf! };
  const categories = new Map<string, string>();
  for (const name of ["Peluquería", "Color", "Tratamientos"]) {
    const res = await page.request.post(`${url}/api/me/service-categories`, { headers, data: { name } });
    expect(res.status()).toBe(201);
    categories.set(name, (await res.json()).id);
  }
  for (const [name, category, durationMinutes, priceArs, description] of [
    ["Corte y peinado", "Peluquería", 45, 18000, "Lavado, corte y terminación"],
    ["Color completo", "Color", 120, 42000, "Color y cuidado capilar"],
    ["Brushing", "Peluquería", 30, 13000, "Secado y modelado"],
    ["Tratamiento nutritivo", "Tratamientos", 60, 26000, "Hidratación profunda"],
  ] as const) {
    const res = await page.request.post(`${url}/api/me/services`, { headers, data: { name, categoryId: categories.get(category), durationMinutes, priceArs, description } });
    expect(res.status()).toBe(201);
    if (category === "Tratamientos") {
      const mutation = await page.request.put(`${url}/api/me/services/${(await res.json()).id}/status`, { headers, data: { status: "suspended" } });
      expect(mutation.status()).toBe(200);
    }
  }
  await page.goto(`${url}/services`);
  await expect(page.getByRole("heading", { name: "Corte y peinado", exact: true })).toBeVisible();
  const recorded: string[] = [];
  page.on("request", request => { if (/\/api\/me\/(services|service-categories)(?:\/.*)?$/.test(request.url()) && request.method() !== "GET") recorded.push(request.method()); });
  async function capture(target: Page, output: string, selectors: Record<string, string>) {
    await target.evaluate(async () => { await document.fonts.ready; });
    await target.mouse.move(0, 0);
    const boxes = await target.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing ${key}: ${selector}`);
      const { x, y, width, height } = node.getBoundingClientRect();
      const values = [x, y, width, height];
      if (key === "dialog") {
        const stripe = getComputedStyle(node, "::before");
        values.push(parseFloat(stripe.left), parseFloat(stripe.right), parseFloat(stripe.height));
      }
      return [key, values.map(n => Math.round(n * 100) / 100)];
    })), selectors);
    await target.screenshot({ path: testInfo.outputPath(`${output}.png`), animations: "disabled" });
    await testInfo.attach(output, { body: JSON.stringify(boxes), contentType: "application/json" });
    if (process.env.AGENDIA_SERVICES_REFERENCE) console.log(output, JSON.stringify(boxes));
    return boxes;
  }
  const tile = page.getByRole("button", { name: "Ver servicio Brushing", exact: true });
  const detail = page.getByRole("dialog", { name: "Servicio", exact: true });
  const prototypePath = process.env.AGENDIA_SERVICES_REFERENCE;
  const serviceOrder = await page.locator(".service-tile strong").allTextContents();
  const categoryOrder = (await page.locator(".service-chip").allTextContents()).slice(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [1280, 360]) {
    const viewport = { width, height: 900 };
    await page.setViewportSize(viewport);
    const shell = { dialog: ".service-dialog", head: ".service-panel-head", body: ".service-panel-body", footer: ".service-panel-footer" };
    const actual: Record<string, Awaited<ReturnType<typeof capture>>> = {
      catalog: await capture(page, `catalog-${width}`, { title: ".services-header", filters: ".services-filters", chips: ".service-chips", manage: ".service-manage", grid: ".services-list", tile: ".service-tile" }),
    };
    await tile.click();
    await expect(detail.getByRole("heading", { name: "Brushing" })).toBeVisible();
    await expect(detail.getByText("30 min", { exact: true })).toBeVisible();
    await expect(detail.getByText(/13\.000/)).toBeVisible();
    await expect(detail.getByText("Activo", { exact: true })).toBeVisible();
    actual.detail = await capture(page, `detail-${width}`, { ...shell, facts: ".service-view-facts" });
    await detail.getByRole("button", { name: "Editar servicio", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Editar servicio" });
    await expect(editor.getByLabel("Nombre del servicio")).toBeFocused();
    await expect(editor.getByLabel("Categoría")).toHaveValue(categories.get("Peluquería")!);
    const fields = { name: '[name="name"]', pair: ".service-form-grid", description: 'textarea[name="description"]' };
    actual.edit = await capture(page, `edit-${width}`, { ...shell, ...fields });
    await editor.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(detail).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tile).toBeFocused();
    await page.getByRole("button", { name: "Nuevo servicio", exact: true }).click();
    await expect(page.getByLabel("Duración (minutos)")).toHaveValue("15");
    actual.create = await capture(page, `create-${width}`, { ...shell, ...fields });
    await page.keyboard.press("Escape");
    const manage = page.getByRole("button", { name: "Categorías", exact: true });
    await manage.click();
    const manager = page.getByRole("dialog", { name: "Categorías", exact: true });
    await expect(manager.getByLabel("Nueva categoría")).toBeFocused();
    actual.categories = await capture(page, `categories-${width}`, { ...shell, rows: ".service-category-list", input: '[name="categoryName"]', add: ".service-category-add button" });
    await manager.getByRole("button", { name: "Listo" }).click();
    await expect(manage).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

    if (!prototypePath) continue;
    const context = await browser.newContext({ viewport, reducedMotion: "reduce", offline: true });
    try {
      const prototype = await context.newPage();
      await prototype.goto(pathToFileURL(prototypePath).href);
      // Match the persisted catalog order in the offline reference, without changing either app's ordering policy.
      await prototype.evaluate(`selectRole('business'); state.page = 'oferta';
        services = ${JSON.stringify(serviceOrder)}.map(name => services.find(service => service.name === name));
        categories = ${JSON.stringify(categoryOrder)}; render()`);
      const banner = (await prototype.locator(".demo-bar").boundingBox())!.height;
      const reference: typeof actual = {
        catalog: await capture(prototype, `reference-catalog-${width}`, { title: ".services-title-bar", filters: ".services-filters", chips: ".services-chip-list", manage: ".service-manage", grid: ".service-grid", tile: ".service-tile" }),
      };
      const float = { dialog: ".float-dialog", head: ".float-head", body: ".float-content", footer: ".float-footer" };
      await prototype.getByRole("button", { name: "Ver servicio Brushing" }).click();
      reference.detail = await capture(prototype, `reference-detail-${width}`, { ...float, facts: ".service-view-facts" });
      await prototype.getByRole("button", { name: "Editar servicio" }).click();
      const floatFields = { name: "#float-service-name", pair: ".service-form-grid", description: "#float-service-description" };
      reference.edit = await capture(prototype, `reference-edit-${width}`, { ...float, ...floatFields });
      await prototype.keyboard.press("Escape");
      await prototype.getByRole("button", { name: "Nuevo servicio" }).click();
      await prototype.getByLabel("Duración (minutos)").fill("15");
      await prototype.getByLabel("Nombre del servicio").focus();
      reference.create = await capture(prototype, `reference-create-${width}`, { ...float, ...floatFields });
      await prototype.keyboard.press("Escape");
      await prototype.getByRole("button", { name: "Categorías", exact: true }).click();
      reference.categories = await capture(prototype, `reference-categories-${width}`, { ...float, rows: ".service-cat-manager", input: "#new-category", add: ".service-cat-add button" });
      for (const [surface, boxes] of Object.entries(actual)) {
        for (const [key, box] of Object.entries(boxes)) {
          const referenceBox = reference[surface]![key]!;
          const largestDelta = Math.max(...box.map((n, i) => Math.abs(n - referenceBox[i]! + (surface === "catalog" && i === 1 ? banner : 0))));
          expect.soft(largestDelta, `${width}px ${surface}.${key}: app ${box}, reference ${referenceBox}`).toBeLessThanOrEqual(0.25);
        }
      }
    } finally {
      await context.close();
      await page.bringToFront();
    }
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const filter = page.getByRole("group", { name: "Filtrar por categoría" });
  await expect(filter.getByRole("button", { name: "Todas" })).toHaveAttribute("aria-pressed", "true");
  await filter.getByRole("button", { name: "Peluquería" }).click();
  await expect(filter.getByRole("button", { name: "Peluquería" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await expect(tile).toBeVisible();
  expect(recorded).toEqual([]);
});

async function editService(page: Page, name: string) {
  await page.getByRole("button", { name: `Ver servicio ${name}`, exact: true }).click();
  await page.getByRole("dialog", { name: "Servicio", exact: true }).getByRole("button", { name: "Editar servicio", exact: true }).click();
  return page.getByRole("form", { name: "Editar servicio", exact: true });
}

async function manageCategories(page: Page) {
  await page.getByRole("button", { name: "Categorías", exact: true }).click();
  return page.getByRole("dialog", { name: "Categorías", exact: true });
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
  await expect(page).toHaveURL(/\/solicitudes$/);
  for (const tenant of tenants) {
    await createBusinessInAdminUi(page, { ...tenant, password });
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext();
  const businessPage = await context.newPage();
  const otherPage = await otherContext.newPage();
  try {
    await login(businessPage, system.webUrl, tenants[0]!.email, password);
    await expect(businessPage).toHaveURL(/\/inicio$/);
    await businessPage.goto(`${system.webUrl}/profile`);
    const hub = businessPage.getByRole("navigation", { name: "Gestión del negocio", exact: true });
    const breadcrumb = businessPage.getByRole("navigation", { name: "Ruta de navegación", exact: true });
    await hub.getByRole("link", { name: "Servicios", exact: true }).click();
    await expect(businessPage).toHaveURL(/\/services$/);
    const screen = businessPage.getByRole("main");
    await expect(screen.getByRole("heading", { name: "Servicios", exact: true })).toBeVisible();
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText("Servicios");
    await expect(screen.getByRole("heading", { name: "Sin servicios", exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Nuevo servicio", exact: true }).click();

    await login(otherPage, system.webUrl, tenants[1]!.email, password);
    await expect(otherPage).toHaveURL(/\/inicio$/);
    await seedService(otherPage, "Servicio ajeno", 900);
    await otherPage.goto(`${system.webUrl}/services`);
    await expect(otherPage.getByRole("heading", { name: "Servicio ajeno", exact: true })).toBeVisible();

    const createPanel = screen.getByRole("dialog", { name: "Nuevo servicio", exact: true });
    const create = createPanel.getByRole("form", { name: "Nuevo servicio", exact: true });
    await create.getByLabel("Nombre del servicio").fill("Consulta inicial");
    await create.getByLabel("Descripción").fill("Una primera conversación para planificar tu atención.");
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
      await expect(screen.getByRole("dialog")).toHaveCount(0);
      await expect(screen.locator(".service-editor").getByRole("alert")).toHaveCount(0);
      const before = { ...requests };
      await retry.click();
      await expect(warning).toHaveCount(0);
      expect(requests).toEqual({ ...before, GET: before.GET + 1 });
      console.log("refresh recovery requests", requests);
    };
    await create.getByLabel("Duración (minutos)").fill("16");
    await createPanel.getByRole("button", { name: "Guardar servicio", exact: true }).click();
    expect(await create.getByLabel("Duración (minutos)").evaluate((input: HTMLInputElement) => input.validity.stepMismatch)).toBe(true);
    expect(requests.POST).toBe(0); // Native validation, not an API failure.
    await create.getByLabel("Duración (minutos)").fill("15");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await businessPage.route("**/api/me/services", async route => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await createPanel.getByRole("button", { name: "Guardar servicio", exact: true }).click();
    await expect(create).toHaveAttribute("aria-busy", "true");
    await expect(createPanel.getByRole("button", { name: "Guardando…" })).toBeDisabled();
    await expect(create.getByLabel("Nombre del servicio")).toBeDisabled();
    await businessPage.keyboard.press("Escape");
    await expect(createPanel).toBeVisible();
    await businessPage.screenshot({ path: testInfo.outputPath("services-pending.png"), fullPage: true });
    await businessPage.route("**/api/me/services", failRefresh);
    const createdResponse = businessPage.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/services"));
    const failedCreateRefresh = businessPage.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith("/api/me/services") && response.status() === 500);
    release();
    expect((await createdResponse).status()).toBe(201);
    expect((await failedCreateRefresh).status()).toBe(500);
    console.log("POST201 then GET500 requests", requests);
    await expect(screen.getByRole("status")).toHaveText("Servicio creado");
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
    await expect(active.getByText("15 min", { exact: true })).toBeVisible();
    await expect(active.getByText(/^\$\s+0$/)).toBeVisible();
    await expect(active.getByText("Una primera conversación para planificar tu atención.", { exact: true })).toBeVisible();
    const inactive = list.getByRole("listitem").filter({ hasText: "Acompañamiento personalizado" });
    await expect(inactive.getByText("Pausado", { exact: true })).toBeVisible();
    await expect(inactive.getByText(/^\$\s+1\.250,5$/)).toBeVisible();
    await expect(inactive.getByText("Sin descripción", { exact: true })).toBeVisible();
    await expect(screen.getByText("Servicio ajeno", { exact: true })).toHaveCount(0);
    const edit = await editService(businessPage, "Consulta inicial");
    const editPanel = screen.getByRole("dialog", { name: "Editar servicio", exact: true });
    await expect(edit.getByLabel("Nombre del servicio")).toBeFocused();
    await expect(edit.getByLabel("Duración (minutos)")).toHaveValue("15");
    await expect(edit.getByLabel("Precio (ARS)")).toHaveValue("0");
    await expect(edit.getByLabel("Descripción")).toHaveValue("Una primera conversación para planificar tu atención.");
    await edit.getByLabel("Nombre del servicio").fill(" acompañamiento personalizado para pequeños negocios ");
    await edit.getByLabel("Duración (minutos)").fill("20");
    await edit.getByLabel("Precio (ARS)").fill("2750.125");
    await edit.getByLabel("Descripción").fill("Seguimiento acordado.");
    const unrelatedConflict = async (route: import("@playwright/test").Route) => {
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "CONFLICT", message: "Unrelated conflict" }) });
    };
    await businessPage.route("**/api/me/services/*", unrelatedConflict);
    const saveEdit = editPanel.getByRole("button", { name: "Guardar servicio", exact: true });
    await saveEdit.click();
    await expect(edit.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
    await businessPage.unroute("**/api/me/services/*", unrelatedConflict);
    const conflict = businessPage.waitForResponse(response => response.request().method() === "PUT" && /\/api\/me\/services\/[^/]+$/.test(response.url()));
    await saveEdit.click();
    expect((await conflict).status()).toBe(409);
    await expect(edit.getByRole("alert")).toHaveText("Ya hay un servicio con ese nombre. Elegí otro nombre.");
    await expect(edit.getByLabel("Precio (ARS)")).toHaveValue("2750.125");
    await expect(edit.getByLabel("Descripción")).toHaveValue("Seguimiento acordado.");
    await businessPage.screenshot({ path: testInfo.outputPath("services-conflict.png"), fullPage: true });
    await edit.getByLabel("Nombre del servicio").fill("Consulta de seguimiento");
    await businessPage.route("**/api/me/services", failRefresh);
    const savedResponse = businessPage.waitForResponse(response => response.request().method() === "PUT" && /\/api\/me\/services\/[^/]+$/.test(response.url()));
    const failedEditRefresh = businessPage.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith("/api/me/services") && response.status() === 500);
    await saveEdit.click();
    expect((await savedResponse).status()).toBe(200);
    expect((await failedEditRefresh).status()).toBe(500);
    console.log("PUT200 then GET500 requests", requests);
    await expect(screen.getByRole("status")).toHaveText("Servicio actualizado");
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("heading", { name: "Consulta de seguimiento", exact: true })).toBeVisible();
    await expect(inactive.getByText("Pausado", { exact: true })).toBeVisible();
    await businessPage.screenshot({ path: testInfo.outputPath("services-edit-refresh-warning.png"), fullPage: true });
    await checkRefreshRecovery();
    expect(requests.PUT).toBe(3);
    await expect(screen.locator(".service-editor").getByRole("alert")).toHaveCount(0);
    await businessPage.reload();
    const updated = list.getByRole("listitem").filter({ hasText: "Consulta de seguimiento" });
    await expect(updated.getByText("20 min", { exact: true })).toBeVisible();
    await expect(updated.getByText(/^\$\s+2\.750,125$/)).toBeVisible();
    await expect(updated.getByText("Seguimiento acordado.", { exact: true })).toBeVisible();
    await editService(businessPage, "Acompañamiento personalizado para pequeños negocios");
    await expect(edit.getByLabel("Duración (minutos)")).toHaveValue("30");
    await expect(edit.getByLabel("Precio (ARS)")).toHaveValue("1250.5");
    await expect(edit.getByLabel("Descripción")).toHaveValue("");
    await businessPage.keyboard.press("Escape");
    await otherPage.reload();
    await expect(otherPage.getByRole("listitem")).toHaveCount(1);
    await expect(otherPage.getByText("Consulta inicial", { exact: true })).toHaveCount(0);
    await expect(otherPage.getByText("Consulta de seguimiento", { exact: true })).toHaveCount(0);

    for (const width of [1280, 360]) {
      await businessPage.setViewportSize({ width, height: 900 });
      if (width === 360) {
        const mobile = businessPage.locator('[data-ui="mobile-navigation"]');
        await mobile.getByText("Menú", { exact: true }).click();
        await expect(mobile.getByRole("link", { name: "Negocio", exact: true })).toHaveAttribute("aria-current", "location");
        await mobile.getByRole("link", { name: "Negocio", exact: true }).click();
        await expect(mobile).not.toHaveAttribute("open", "");
        await hub.getByRole("link", { name: "Servicios", exact: true }).click();
        await expect(businessPage).toHaveURL(/\/services$/);
        await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText("Servicios");
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

    await screen.getByRole("button", { name: "Nuevo servicio", exact: true }).click();
    await expect(create.getByLabel("Nombre del servicio")).toHaveValue("");
    await create.getByLabel("Nombre del servicio").fill("Consulta de seguimiento");
    await create.getByLabel("Descripción").fill("Conservar esta descripción");
    const duplicate = businessPage.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/services"));
    const saveNew = createPanel.getByRole("button", { name: "Guardar servicio", exact: true });
    await saveNew.click();
    expect((await duplicate).status()).toBe(409);
    await expect(create.getByRole("alert")).toHaveText("Ya hay un servicio con ese nombre. Elegí otro nombre.");
    await expect(create.getByLabel("Nombre del servicio")).toHaveValue("Consulta de seguimiento");
    await expect(create.getByLabel("Descripción")).toHaveValue("Conservar esta descripción");
    await create.getByLabel("Nombre del servicio").fill("Consulta nueva");
    await saveNew.click();
    await expect(screen.getByRole("status")).toHaveText("Servicio creado");
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
  await expect(page).toHaveURL(/\/inicio$/);
  await seedService(page, "Servicio privado", 500);
  await page.goto(`${system.webUrl}/services`);
  await expect(page.getByRole("heading", { name: "Servicio privado" })).toBeVisible();
  await page.route("**/api/me/service-categories", async route => {
    if (route.request().method() === "GET") await route.fulfill({ status: 401, contentType: "application/json", body: '{"code":"UNAUTHENTICATED"}' });
    else await route.continue();
  });
  const manager = await manageCategories(page);
  const form = manager.getByRole("form", { name: "Crear categoría" });
  await form.getByLabel("Nueva categoría").fill("Privada");
  await form.getByRole("button", { name: "Agregar" }).click();
  await expect(manager).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Servicio privado" })).toHaveCount(0);
  await expect(page.getByText("Privada", { exact: true })).toHaveCount(0);
});

test("un cambio de sesión no mezcla catálogos ni envía cambios desde la pestaña anterior", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  for (const [name, email] of [["Primer negocio", "category-owner-a@example.test"], ["Segundo negocio", "category-owner-b@example.test"]] as const)
    await createBusinessInAdminUi(page, { name, email, password: "category owner safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "category-owner-a@example.test", "category owner safe password");
  await expect(page).toHaveURL(/\/inicio$/);
  await seedService(page, "Servicio del primero", 300);
  await page.goto(`${system.webUrl}/services`);
  await expect(page.getByRole("heading", { name: "Servicio del primero" })).toBeVisible();
  const second = await page.context().newPage();
  await second.goto(`${system.webUrl}/profile`);
  await second.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(second, system.webUrl, "category-owner-b@example.test", "category owner safe password");
  await expect(second).toHaveURL(/\/inicio$/);
  let posts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/me/service-categories")) posts++; });
  const manager = await manageCategories(page);
  const form = manager.getByRole("form", { name: "Crear categoría" });
  await form.getByLabel("Nueva categoría").fill("No enviar");
  await form.getByRole("button", { name: "Agregar" }).click();
  await expect(manager).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Servicio del primero" })).toHaveCount(0);
  expect(posts).toBe(0);
  await second.close();
});

test("categorías agrupan servicios y al eliminarlas conservan sus datos", async ({ page, system }, testInfo) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, { name: "Odontología", email: "categories@example.test", password: "categories safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "categories@example.test", "categories safe password");
  await expect(page).toHaveURL(/\/inicio$/);
  await page.goto(`${system.webUrl}/services`);
  const screen = page.getByRole("main");
  const manager = await manageCategories(page);
  const categoryForm = manager.getByRole("form", { name: "Crear categoría" });
  const addCategory = async (name: string) => {
    await categoryForm.getByLabel("Nueva categoría").fill(name);
    await categoryForm.getByRole("button", { name: "Agregar" }).click();
    await expect(categoryForm.getByRole("status")).toHaveText("Categoría creada");
    await manager.getByRole("button", { name: "Listo" }).click();
  };
  await addCategory("Odontología");
  const create = screen.getByRole("dialog", { name: "Nuevo servicio" });
  for (const name of ["Consulta", "Tratamiento de conducto"]) {
    await screen.getByRole("button", { name: "Nuevo servicio" }).click();
    await create.getByLabel("Nombre del servicio").fill(name);
    await create.getByLabel("Precio (ARS)").fill("1200");
    await create.getByRole("combobox", { name: "Categoría", exact: true }).selectOption({ label: "Odontología" }, { timeout: 5_000 });
    await create.getByRole("button", { name: "Guardar servicio" }).click();
    await expect(screen.getByRole("status")).toHaveText("Servicio creado");
  }
  const filters = screen.getByRole("group", { name: "Filtrar por categoría" });
  await filters.getByRole("button", { name: "Odontología" }).click();
  await expect(screen.getByRole("listitem")).toHaveCount(2);
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`category-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await manageCategories(page);
  await addCategory("Otra categoría");
  const editDialog = screen.getByRole("dialog", { name: "Editar servicio" });
  const card = screen.getByRole("button", { name: "Ver servicio Consulta", exact: true });
  for (const [value, next] of [["Otra categoría", "Otra categoría"], ["", "Sin categoría"], ["Odontología", "Odontología"]] as const) {
    const edit = await editService(page, "Consulta");
    await edit.getByRole("combobox", { name: "Categoría", exact: true }).selectOption(value ? { label: value } : "", { timeout: 5_000 });
    await editDialog.getByRole("button", { name: "Guardar servicio" }).click();
    await expect(editDialog).toHaveCount(0);
    if (next === "Odontología") {
      // Reassigning the last uncategorized service removes that filter.
      await expect(filters.getByRole("button", { name: "Sin categoría", exact: true })).toHaveCount(0);
      await expect(filters.getByRole("button", { name: "Todas", exact: true })).toHaveAttribute("aria-pressed", "true");
    } else await expect(card).toHaveCount(0);
    await filters.getByRole("button", { name: next, exact: true }).click();
    await expect(card.getByText(next, { exact: true })).toBeVisible();
  }
  await manageCategories(page);
  const deleteButton = manager.getByRole("button", { name: "Eliminar categoría Odontología" });
  await deleteButton.click();
  const confirmDialog = screen.getByRole("dialog", { name: "Eliminar Odontología", exact: true });
  const cancel = confirmDialog.getByRole("button", { name: "Cancelar" });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(deleteButton).toBeFocused();
  await deleteButton.click();
  await expect(confirmDialog).toContainText("Los servicios se conservan y quedan sin categoría");
  await confirmDialog.getByRole("button", { name: "Confirmar eliminación" }).click();
  await expect(categoryForm.getByRole("status")).toHaveText("Categoría eliminada");
  await manager.getByRole("button", { name: "Listo" }).click();
  await expect(filters.getByRole("button", { name: "Todas" })).toHaveAttribute("aria-pressed", "true");
  await expect(card).toBeVisible();
  await expect(screen.getByRole("button", { name: "Ver servicio Tratamiento de conducto", exact: true })).toBeVisible();
  await page.reload();
  const unassigned = screen.getByRole("list", { name: "Catálogo de servicios" });
  await filters.getByRole("button", { name: "Sin categoría" }).click();
  await expect(unassigned.getByText("15 min")).toHaveCount(2);
  await expect(unassigned.getByText(/^\$\s+1\.200$/)).toHaveCount(2);
  const edit = await editService(page, "Consulta");
  await expect(edit.getByRole("combobox", { name: "Categoría", exact: true })).toHaveValue("");
});

test("an interrupted services operation stays interrupted after logout fails", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, { name: "Carreras", email: "services-race@example.test", password: "services race safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "services-race@example.test", "services race safe password");
  await expect(page).toHaveURL(/\/inicio$/);
  await page.goto(`${system.webUrl}/services`);
  const manager = await manageCategories(page);
  const category = manager.getByRole("form", { name: "Crear categoría" });
  await expect(category).toBeVisible();
  // Native dialogs make the shell inert; dispatch the shell action to retain the in-flight race coverage.
  const logout = page.getByRole("button", { name: "Cerrar sesión", exact: true, includeHidden: true });
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
  await category.getByLabel("Nueva categoría").fill("No enviar");
  await category.getByRole("button", { name: "Agregar" }).click();
  await sessionStarted;
  await logout.first().dispatchEvent("click");
  await expect(logout.first()).toBeEnabled();
  releaseSession();
  await expect(category.getByRole("button", { name: "Agregar" })).toBeEnabled();
  expect(writes).toBe(0);
  await expect(category.getByLabel("Nueva categoría")).toHaveValue("No enviar");
  await expect(category.getByRole("status")).toHaveCount(0);
  await page.unroute("**/api/auth/session", holdSession);
  await manager.getByRole("button", { name: "Listo" }).click();

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
  await page.getByRole("button", { name: "Nuevo servicio" }).click();
  const editor = page.getByRole("dialog", { name: "Nuevo servicio" });
  const form = editor.getByRole("form");
  await form.getByLabel("Nombre del servicio").fill("Respuesta vieja");
  await form.getByLabel("Precio (ARS)").fill("100");
  await editor.getByRole("button", { name: "Guardar servicio" }).click();
  await saveStarted;
  await logout.first().dispatchEvent("click");
  await expect(logout.first()).toBeEnabled();
  releaseSave();
  await expect(form).toHaveAttribute("aria-busy", "false");
  expect(writes).toBe(1);
  await expect(form.getByLabel("Nombre del servicio")).toHaveValue("Respuesta vieja");
  await expect(form.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Respuesta vieja", exact: true })).toHaveCount(0);
});

test("categorías informan errores y reintentan solo la lectura", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, { name: "Errores categorías", email: "category-errors@example.test", password: "category errors safe password" });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "category-errors@example.test", "category errors safe password");
  await expect(page).toHaveURL(/\/inicio$/);
  await page.goto(`${system.webUrl}/services`);
  await page.getByRole("button", { name: "Nuevo servicio" }).click();
  const serviceForm = page.getByRole("dialog", { name: "Nuevo servicio" });
  await serviceForm.getByLabel("Nombre del servicio").fill("Servicio sin categoría");
  await serviceForm.getByLabel("Precio (ARS)").fill("450");
  await serviceForm.getByRole("button", { name: "Guardar servicio" }).click();
  await expect(page.getByRole("heading", { name: "Servicio sin categoría" })).toBeVisible();
  await expect(page.getByText("15 min")).toBeVisible();
  const manager = await manageCategories(page);
  const form = manager.getByRole("form", { name: "Crear categoría" });
  const url = "**/api/me/service-categories";
  const failCreate = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
    else await route.continue();
  };
  await page.route(url, failCreate);
  await form.getByLabel("Nueva categoría").fill("Prueba");
  await form.getByRole("button", { name: "Agregar" }).click();
  await expect(form.getByRole("alert")).toHaveText("No se pudo completar la operación.");
  await expect(form.getByLabel("Nueva categoría")).toHaveValue("Prueba");
  await page.unroute(url, failCreate);
  let posts = 0;
  page.on("request", request => { if (request.url().endsWith("/api/me/service-categories") && request.method() === "POST") posts++; });
  const failGet = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "GET") await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
    else await route.continue();
  };
  await page.route(url, failGet);
  await form.getByRole("button", { name: "Agregar" }).click();
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
  const logout = page.getByRole("button", { name: "Cerrar sesión", exact: true, includeHidden: true }).first();
  await logout.dispatchEvent("click");
  await expect(logout).toBeEnabled();
  releaseRefresh();
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("region", { name: "Actualización del catálogo" })).toBeVisible();
  await page.unroute(url, holdRefresh);
  await retry.click();
  await expect(page.getByRole("region", { name: "Actualización del catálogo" })).toHaveCount(0);
  expect(posts).toBe(1);
  const remove = manager.getByRole("button", { name: "Eliminar categoría Prueba" });
  await remove.click();
  const confirm = page.getByRole("dialog", { name: "Eliminar Prueba" });
  await page.route("**/api/me/service-categories/*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
  await confirm.getByRole("button", { name: "Confirmar eliminación" }).click();
  await expect(confirm.getByRole("alert")).toHaveText("No se pudo completar la operación.");
  await confirm.getByRole("button", { name: "Cancelar" }).click();
  await expect(remove).toBeFocused();
  await page.reload();
  await expect(page.getByRole("group", { name: "Filtrar por categoría" }).getByRole("button", { name: "Prueba" })).toBeVisible();
});

test("Servicios confirms lifecycle actions, persists changes and recovers without repeating mutations", async ({ page, system }, testInfo) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, {
    name: "Lifecycle Studio", email: "lifecycle@example.test", password: "lifecycle safe password",
  });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await login(page, system.webUrl, "lifecycle@example.test", "lifecycle safe password");
  await expect(page).toHaveURL(/\/inicio$/);
  const service = await seedService(page, "Consulta lifecycle", 0);
  await page.goto(`${system.webUrl}/services`);
  const screen = page.getByRole("main");
  const row = screen.getByRole("listitem").filter({ hasText: "Consulta lifecycle" });
  await expect(row).toBeVisible();
  const editor = screen.getByRole("dialog", { name: "Editar servicio", exact: true });
  const confirmation = screen.getByRole("dialog", { name: /^(Suspender|Retirar) Consulta lifecycle$/ });
  const status = screen.getByRole("dialog", { name: "Servicio", exact: true });
  await editService(page, "Consulta lifecycle");
  const counts = { PUT: 0, DELETE: 0, GET: 0 };
  page.on("request", request => {
    if (/\/api\/me\/services(?:\/[^/]+(?:\/status)?)?$/.test(request.url())) {
      const method = request.method() as keyof typeof counts;
      if (method in counts) counts[method]++;
    }
  });
  const editorAction = (name: string) => editor.getByRole("button", { name, exact: true });
  const action = async (name: "Pausar servicio" | "Retirar") => {
    await editorAction(name).click();
    await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  };
  for (const name of ["Pausar servicio", "Retirar"] as const) {
    await action(name);
    await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(editorAction(name)).toBeEnabled();
    await expect(editorAction(name)).toBeFocused();
    expect(counts).toEqual({ PUT: 0, DELETE: 0, GET: 0 });
  }
  await action("Pausar servicio");
  await expect(confirmation).toContainText("No cancela los turnos existentes");
  const statusUrl = `**/api/me/services/${service.id}/status`;
  await page.route(statusUrl, route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
  await confirmation.getByRole("button", { name: "Confirmar suspensión" }).click();
  await expect(confirmation.getByRole("alert")).toHaveText("No se pudo completar la operación.");
  await expect(confirmation.locator(".service-editor input[name=name]")).toHaveValue("Consulta lifecycle");
  expect(counts.PUT).toBe(1);
  await page.unroute(statusUrl);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(statusUrl, async route => { await held; await route.continue(); });
  const suspended = page.waitForResponse(response => response.url().endsWith(`/services/${service.id}/status`) && response.status() === 200);
  await confirmation.getByRole("button", { name: "Confirmar suspensión" }).click();
  await expect(confirmation.getByRole("region", { name: "Confirmar acción" })).toHaveAttribute("aria-busy", "true");
  await expect(confirmation.getByRole("button", { name: "Confirmar suspensión" })).toBeDisabled();
  await expect(confirmation.locator(".service-editor input[name=name]")).toBeDisabled();
  await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("lifecycle-pending.png"), fullPage: true });
  release();
  expect((await suspended).status()).toBe(200);
  await expect(editorAction("Reactivar servicio")).toBeEnabled();
  await expect(editorAction("Reactivar servicio")).toBeFocused();
  await page.unroute(statusUrl);
  await page.reload();
  await expect(row.getByText("Pausado", { exact: true })).toBeVisible();
  await editService(page, "Consulta lifecycle");
  const reactivated = page.waitForResponse(response => response.url().endsWith(`/services/${service.id}/status`) && response.status() === 200);
  await editorAction("Reactivar servicio").click();
  expect((await reactivated).status()).toBe(200);
  await expect(editorAction("Pausar servicio")).toBeEnabled();
  await expect(editorAction("Pausar servicio")).toBeFocused();
  await page.reload();
  await page.setViewportSize({ width: 360, height: 900 });
  await row.getByRole("button").click();
  await expect(status.getByText("Activo", { exact: true })).toBeVisible();
  await status.getByRole("button", { name: "Editar servicio" }).click();
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
  expect(counts.DELETE).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("lifecycle-mocked-conflict-mobile.png"), fullPage: true });
  await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(editorAction("Retirar")).toBeFocused();
  await expect(editorAction("Pausar servicio")).toBeVisible();
  expect(counts.DELETE).toBe(1);
  await page.unroute(retireUrl);
  await action("Retirar");
  await page.route("**/api/me/services", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
  const retired = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().endsWith(`/services/${service.id}`));
  await confirmation.getByRole("button", { name: "Confirmar retiro" }).click();
  expect((await retired).status()).toBe(200);
  await expect(row).toHaveCount(0);
  await expect(screen.getByRole("heading", { name: "Servicios", exact: true })).toBeFocused();
  await expect(screen.getByRole("status")).toHaveText("Servicio retirado");
  await expect(screen.getByRole("region", { name: "Actualización del catálogo" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("lifecycle-retired-warning-mobile.png"), fullPage: true });
  const before = { ...counts };
  await page.unroute("**/api/me/services");
  await screen.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
  await expect(screen.getByRole("region", { name: "Actualización del catálogo" })).toHaveCount(0);
  expect(counts).toEqual({ ...before, GET: before.GET + 1 });
  console.log("lifecycle real status200 x2; mocked status500/DELETE409; real DELETE200 then GET500; recovery counts", counts);
  await page.reload();
  await expect(screen.getByRole("heading", { name: "Sin servicios" })).toBeVisible();
  expect(counts.PUT).toBe(3);
  expect(counts.DELETE).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
