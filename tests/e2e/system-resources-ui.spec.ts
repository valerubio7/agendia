import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { expect, type Page } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

async function seed(page: Page, method: "post" | "put", path: string, data: object, status: number) {
  const csrf = await page.evaluate(() => sessionStorage.getItem("agendia.csrf"));
  expect(csrf).toBeTruthy();
  const response = await page.request[method](new URL(`/api/me/${path}`, page.url()).href, {
    headers: { Origin: new URL(page.url()).origin, "x-csrf-token": csrf! }, data,
  });
  expect(response.status()).toBe(status);
  return await response.json() as { id: string };
}

test("Recursos opens a responsive detail and persists real service and hours edits", async ({ browser, page, system }, info) => {
  const tenant = { name: "Estudio Visual", email: "visual-resources@example.test", password: "visual resource password" };
  const admin = await browser.newPage();
  try {
    await login(admin, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    await createBusinessInAdminUi(admin, tenant);
  } finally { await admin.close(); }
  await login(page, system.webUrl, tenant.email, tenant.password);
  await expect(page).toHaveURL(/\/inicio$/);
  const services = [];
  for (const name of ["Corte y peinado", "Color completo", "Brushing", "Tratamiento nutritivo"]) {
    services.push((await seed(page, "post", "services", { name, durationMinutes: 30, priceArs: 0 }, 201)).id);
  }
  await seed(page, "put", `services/${services[3]}/status`, { status: "suspended" }, 200);
  const week = (days: number[], startMinute: number, endMinute: number) =>
    Object.fromEntries(days.map(day => [day, [{ startMinute, endMinute }]]));
  await seed(page, "put", "business-calendar", { weeklySchedule: week([0, 1, 2, 3, 4, 5, 6], 0, 1440) }, 200);
  const lucia = await seed(page, "post", "resources", {
    name: "Lucía Paredes", description: "Especialista en corte y estilismo",
    serviceIds: [services[0], services[2], services[3]], weeklySchedule: week([1, 2, 3, 4, 5, 6], 540, 1080),
  }, 201);
  await seed(page, "post", "resources", { name: "Tomás Rivas", description: "Especialista en color",
    serviceIds: services.slice(0, 2), weeklySchedule: week([2, 3, 4, 5, 6], 600, 1140) }, 201);
  const sala = await seed(page, "post", "resources", { name: "Sala privada", description: "Espacio para tratamientos",
    serviceIds: [services[3]], weeklySchedule: week([1, 2, 3, 4, 5], 600, 1020) }, 201);
  await seed(page, "put", `resources/${sala.id}/status`, { status: "suspended" }, 200);
  await page.goto(`${system.webUrl}/resources`);
  await expect(page.getByRole("heading", { name: "Recursos", exact: true })).toBeVisible();
  const writes: string[] = [];
  page.on("request", request => {
    if (/\/api\/me\/resources(?:\/|$)/.test(new URL(request.url()).pathname) && request.method() !== "GET")
      writes.push(request.method());
  });
  const capture = async (target: Page, name: string, selectors: Record<string, string>) => {
    await target.mouse.move(0, 0);
    await target.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
    const boxes = await target.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
      const node = document.querySelector(selector)!;
      const { x, y, width, height } = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return [key, { x, y, width, height, font: style.fontFamily, size: style.fontSize, background: style.backgroundColor }];
    })), selectors);
    await writeFile(info.outputPath(`${name}-geometry.json`), JSON.stringify(boxes, null, 2));
    return boxes;
  };
  const compare = (app: Awaited<ReturnType<typeof capture>>, mock: Awaited<ReturnType<typeof capture>>, keys: string[], yOffset = 0) => {
    for (const key of keys) for (const axis of ["x", "y", "width", "height"] as const) {
      const expected = mock[key]![axis] - (axis === "y" ? yOffset : 0);
      expect(Math.abs(app[key]![axis] - expected), `${key}.${axis}`).toBeLessThanOrEqual(1);
    }
  };
  const tile = page.getByRole("button", { name: "Ver Lucía Paredes", exact: true });
  const dialog = page.getByRole("dialog", { name: "Recurso", exact: true });
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const fixture = process.env.AGENDIA_RESOURCES_REFERENCE;
    let reference: { catalog: Awaited<ReturnType<typeof capture>>; detail: Awaited<ReturnType<typeof capture>>; edit: Awaited<ReturnType<typeof capture>> } | undefined;
    if (fixture) {
      const mock = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await mock.goto(pathToFileURL(fixture).href);
        // Match the API's name and assignment ordering in memory only; the HTML/CSS is unchanged.
        const byId = Object.fromEntries(services.map((id, index) => [`s${index + 1}`, id]));
        await mock.evaluate(`(() => {
          const ids = ${JSON.stringify(byId)};
          const byName = (a, b) => a.name.localeCompare(b.name, 'es');
          resources.sort(byName).forEach(r => r.services.sort((a, b) => ids[a].localeCompare(ids[b])));
          services.sort(byName).forEach(s => { if (!s.active) s.name += ' (suspendido)'; });
          state.role = 'business'; state.page = 'recursos'; render();
        })()`);
        await mock.getByRole("button", { name: "Ver Lucía Paredes", exact: true }).waitFor();
        const catalog = await capture(mock, `mock-catalog-${width}`, { banner: ".demo-bar", title: ".resources-topbar h1", action: ".resources-topbar button", grid: ".resources-grid", tile: "[data-select-resource='r1']" });
        await mock.getByRole("button", { name: "Ver Lucía Paredes", exact: true }).click();
        const detail = await capture(mock, `mock-detail-${width}`, { dialog: ".resource-float-dialog", head: ".float-head", name: ".resource-view-headline h3", facts: ".resource-view-info", services: ".resource-view-services", footer: ".float-footer" });
        await mock.getByRole("button", { name: "Editar recurso", exact: true }).click();
        const edit = await capture(mock, `mock-edit-${width}`, { dialog: ".resource-float-dialog", nameField: "#float-resource-name", description: "#float-resource-description", hours: "#float-resource-hours", choices: ".resource-service-choices", checkbox: ".resource-service-choice input", footer: ".float-footer" });
        reference = { catalog, detail, edit };
      } finally { await mock.close(); }
    }
    await expect(page.getByRole("form")).toHaveCount(0);
    await expect(tile).toBeVisible();
    await page.getByRole("heading", { name: "Recursos", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const catalog = await capture(page, `app-catalog-${width}`, { title: ".rd-topbar h1", action: ".rd-topbar button", grid: ".rd-grid", tile: "[aria-label='Ver Lucía Paredes']" });
    if (reference) compare(catalog, reference.catalog, ["title", "action", "grid", "tile"], reference.catalog.banner!.height);
    await tile.click();
    await expect(dialog.getByText("Corte y peinado", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Lun–Sáb · 9:00–18:00", { exact: true })).toBeVisible();
    const detail = await capture(page, `app-detail-${width}`, { dialog: ".rd-dialog", head: ".rd-head", name: ".rd-headline h3", facts: ".rd-facts", services: ".rd-service-view", footer: ".rd-footer" });
    if (reference) compare(detail, reference.detail, ["dialog", "head", "name", "facts", "services", "footer"]);
    await page.keyboard.press("Escape");
    await expect(tile).toBeFocused();
    await tile.click();
    await dialog.getByRole("button", { name: "Editar recurso", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Editar recurso", exact: true });
    await expect(editor.getByLabel("Nombre", { exact: true })).toBeFocused();
    const edit = await capture(page, `app-edit-${width}`, { dialog: ".rd-dialog", nameField: "#resource-name", description: "#resource-description", hours: ".rd-hours-edit summary > span:last-child", choices: ".rd-choices", checkbox: ".rd-choices input", footer: ".rd-footer" });
    if (reference) compare(edit, reference.edit, ["dialog", "nameField", "description", "hours", "choices", "checkbox", "footer"]);
    if (width === 1280) await page.keyboard.press("Escape");
  }
  expect(writes).toEqual([]);
  const editor = page.getByRole("dialog", { name: "Editar recurso", exact: true });
  await editor.getByRole("checkbox", { name: "Brushing", exact: true }).uncheck();
  await editor.getByRole("checkbox", { name: "Color completo", exact: true }).check();
  await editor.getByText("Disponibilidad habitual", { exact: true }).click();
  await editor.getByLabel("Inicio Lunes 1", { exact: true }).fill("09:15");
  await editor.getByRole("button", { name: "Guardar cambios", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Recurso actualizado");
  expect(writes).toEqual(["PUT"]);
  await page.reload();
  await tile.click();
  await expect(dialog.getByText("Color completo", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Brushing", { exact: true })).toHaveCount(0);
  await dialog.getByText("Disponibilidad habitual", { exact: true }).click();
  await expect(dialog.getByText("09:15–18:00", { exact: true })).toBeVisible();
  const response = await page.request.get(`${system.webUrl}/api/me/resources`);
  expect(response.status()).toBe(200);
  const persisted = (await response.json() as Array<{ id: string; serviceIds: string[]; weeklySchedule: unknown }>)
    .find(resource => resource.id === lucia.id)!;
  expect([...persisted.serviceIds].sort()).toEqual([services[0], services[1], services[3]].sort());
  expect(persisted.weeklySchedule).toEqual({ ...week([2, 3, 4, 5, 6], 540, 1080), 1: [{ startMinute: 555, endMinute: 1080 }] });
});

test("Recursos manages owned assignments while preserving weekly spans", async ({ browser, page, system }, testInfo) => {
  const password = "tenant resources password safe";
  const tenants = [
    { name: "Estudio Recursos", email: "resources-ui@example.test" },
    { name: "Otro Estudio Recursos", email: "other-resources-ui@example.test" },
  ];
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/solicitudes$/);
  await expect(page.getByRole("link", { name: "Recursos", exact: true })).toHaveCount(0);
  for (const tenant of tenants) {
    await createBusinessInAdminUi(page, { ...tenant, password });
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext();
  const business = await context.newPage();
  const other = await otherContext.newPage();
  try {
    await login(business, system.webUrl, tenants[0]!.email, password);
    await expect(business).toHaveURL(/\/inicio$/);
    await business.goto(`${system.webUrl}/profile`);
    const hub = business.getByRole("navigation", { name: "Gestión del negocio", exact: true });
    const breadcrumb = business.getByRole("navigation", { name: "Ruta de navegación", exact: true });
    const mutations: string[] = [];
    business.on("request", request => {
      if (/\/api\/me\/(?:resources|services)(?:\/|$)/.test(new URL(request.url()).pathname) && request.method() !== "GET")
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await hub.getByRole("link", { name: "Recursos", exact: true }).click();
    await expect(business).toHaveURL(/\/resources$/);
    const screen = business.getByRole("main");
    await expect(screen.getByRole("heading", { name: "Todavía no hay recursos", exact: true })).toBeVisible();
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText("Recursos");
    const newResource = screen.getByRole("button", { name: "Nuevo recurso", exact: true }).first();
    const form = screen.getByRole("form");
    const detail = screen.getByRole("dialog", { name: "Recurso", exact: true });
    const editorPanel = screen.getByRole("dialog", { name: "Editar recurso", exact: true });
    const openHours = () => form.getByText("Disponibilidad habitual", { exact: true }).click();
    const inspect = async (name: string) => {
      await screen.getByRole("button", { name: `Ver ${name}`, exact: true }).click();
      await detail.getByText("Disponibilidad habitual", { exact: true }).click();
    };
    const edit = async (name: string, hours = false) => {
      await screen.getByRole("button", { name: `Ver ${name}`, exact: true }).click();
      await detail.getByRole("button", { name: "Editar recurso", exact: true }).click();
      await expect(editorPanel).toBeVisible();
      if (hours) await openHours();
    };
    const close = () => business.keyboard.press("Escape");
    await business.screenshot({ path: testInfo.outputPath("resources-empty.png"), fullPage: true });
    await newResource.click();
    await expect(form).toHaveAccessibleName("Nuevo recurso");
    await openHours();
    const weeklyEditor = form.getByRole("group", { name: "Horario semanal", exact: true });
    await expect(weeklyEditor).toBeVisible();
    await expect(weeklyEditor.getByRole("group", { name: "Lunes", exact: true })).toBeVisible();
    await expect(weeklyEditor.getByRole("button", { name: "Agregar franja Lunes", exact: true })).toBeVisible();
    await close();
    await login(other, system.webUrl, tenants[1]!.email, password);
    await expect(other).toHaveURL(/\/inicio$/);
    const foreignService = await seed(other, "post", "services", { name: "Servicio ajeno", durationMinutes: 30, priceArs: 0 }, 201);
    await seed(other, "post", "resources", { name: "Recurso ajeno", serviceIds: [foreignService.id], weeklySchedule: {} }, 201);
    const ownService = await seed(business, "post", "services", { name: "Consulta propia", durationMinutes: 30, priceArs: 0 }, 201);
    const suspendedService = await seed(business, "post", "services", { name: "Seguimiento propio", durationMinutes: 15, priceArs: 0 }, 201);
    await seed(business, "put", `services/${suspendedService.id}/status`, { status: "suspended" }, 200);
    const weeklySchedule = {
      1: [{ startMinute: 540, endMinute: 720 }, { startMinute: 840, endMinute: 1080 }],
      4: [{ startMinute: 1320, endMinute: 120 }],
      0: [{ startMinute: 0, endMinute: 1440 }],
    };
    await seed(business, "put", "business-calendar", { weeklySchedule }, 200);
    await seed(business, "post", "resources", {
      name: "Profesional de acompañamiento para pequeños negocios", description: "Atención personalizada.",
      serviceIds: [ownService.id, suspendedService.id], weeklySchedule,
    }, 201);
    const inactive = await seed(business, "post", "resources", { name: "Sala de consulta", serviceIds: [], weeklySchedule: {} }, 201);
    await seed(business, "put", `resources/${inactive.id}/status`, { status: "suspended" }, 200);
    await business.reload();
    const catalog = screen.getByRole("list", { name: "Catálogo de recursos", exact: true });
    await expect(catalog.getByRole("listitem")).toHaveCount(2);
    const professional = "Profesional de acompañamiento para pequeños negocios";
    await inspect(professional);
    await expect(detail.getByText("Activo", { exact: true })).toBeVisible();
    await expect(detail.getByText("Atención personalizada.", { exact: true })).toBeVisible();
    await expect(detail.getByText("Consulta propia", { exact: true })).toBeVisible();
    await expect(detail.getByText("Seguimiento propio (suspendido)", { exact: true })).toBeVisible();
    const days = detail.locator(".resources-week div");
    await expect(days.filter({ hasText: "Lunes" })).toContainText("09:00–12:00 · 14:00–18:00");
    await expect(days.filter({ hasText: "Martes" })).toContainText("Sin franjas");
    await expect(days.filter({ hasText: "Jueves" })).toContainText("22:00–02:00 (día siguiente)");
    await expect(days.filter({ hasText: "Domingo" })).toContainText("00:00–24:00");
    await close();
    await inspect("Sala de consulta");
    await expect(detail.getByText("Suspendido", { exact: true })).toBeVisible();
    await expect(detail.getByText("Sin servicios asignados", { exact: true })).toBeVisible();
    await expect(detail.locator(".resources-description")).toHaveCount(0);
    await expect(detail.locator(".resources-week dd")).toHaveText(Array(7).fill("Sin franjas"));
    await close();
    for (const name of [professional, "Sala de consulta"]) {
      await edit(name);
      await expect(form.getByRole("button", { name: name === professional ? "Suspender" : "Reactivar", exact: true })).toBeVisible();
      await expect(form.getByRole("button", { name: "Retirar", exact: true })).toBeVisible();
      await expect(form.locator('input[name="status"], input[name="id"], input[name="weeklySchedule"]')).toHaveCount(0);
      await expect(form.getByText("Servicio ajeno", { exact: true })).toHaveCount(0);
      await close();
    }
    await expect(screen.getByText("Recurso ajeno", { exact: true })).toHaveCount(0);
    await other.goto(`${system.webUrl}/resources`);
    await expect(other.getByRole("button", { name: "Ver Recurso ajeno", exact: true })).toBeVisible();
    await expect(other.getByRole("listitem")).toHaveCount(1);
    await expect(other.getByText("Sala de consulta", { exact: true })).toHaveCount(0);
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      if (width === 360) {
        const mobile = business.locator('[data-ui="mobile-navigation"]');
        await mobile.getByText("Menú", { exact: true }).click();
        const negocio = mobile.getByRole("link", { name: "Negocio", exact: true });
        await expect(negocio).toHaveAttribute("aria-current", "location");
        await negocio.click();
        await expect(mobile).not.toHaveAttribute("open", "");
        await hub.getByRole("link", { name: "Recursos", exact: true }).click();
        await expect(business).toHaveURL(/\/resources$/);
        await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText("Recursos");
      }
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`resources-${width}.png`), fullPage: true });
    }
    // MOCKED initial-load GET500; retry below returns the real tenant catalog.
    await business.route("**/api/me/resources", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await business.reload();
    const error = business.locator('main[data-state="load-error"]');
    await expect(error.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await business.screenshot({ path: testInfo.outputPath("resources-mocked-load-error.png"), fullPage: true });
    await business.unroute("**/api/me/resources");
    await error.getByRole("button", { name: "Volver a intentar", exact: true }).click();
    await expect(catalog.getByRole("listitem")).toHaveCount(2);
    expect(mutations).toEqual([]); // page.request seeding is not a mounted UI mutation.
    // Real mutations; only post-save GET failures below are mocked.
    await newResource.click();
    await expect(form.getByRole("checkbox")).toHaveCount(2);
    await expect(form.getByRole("checkbox", { name: "Seguimiento propio (suspendido)", exact: true })).toBeVisible();
    await openHours();
    await expect(form.getByText(/Sin franjas no podrá recibir reservas/)).toBeVisible();
    const counts = { POST: 0, PUT: 0, GET: 0 };
    const bodies: Record<string, unknown>[] = [];
    business.on("request", request => {
      if (!/\/api\/me\/resources(?:\/|$)/.test(new URL(request.url()).pathname)) return;
      const method = request.method() as keyof typeof counts;
      if (method in counts) counts[method]++;
      if (method === "POST" || method === "PUT") bodies.push(request.postDataJSON());
    });
    let failGet = true;
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await business.route("**/api/me/resources", async route => {
      if (route.request().method() === "POST") { await held; await route.continue(); }
      else if (failGet) await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
      else await route.continue();
    });
    await form.getByLabel("Nombre", { exact: true }).fill("Recurso creado en pantalla");
    await form.getByLabel("Descripción (opcional)").fill("Descripción inicial");
    await form.getByRole("checkbox", { name: "Consulta propia", exact: true }).check();
    await form.getByRole("checkbox", { name: "Seguimiento propio (suspendido)", exact: true }).check();
    await form.getByRole("button", { name: "Crear recurso", exact: true }).click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(form.getByRole("button", { name: "Guardando…" })).toBeDisabled();
    await form.evaluate(element => {
      element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(counts.POST).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("resources-pending.png"), fullPage: true });
    release!();
    const created = catalog.getByRole("listitem").filter({ hasText: "Recurso creado en pantalla" });
    const warning = screen.getByRole("region", { name: "Actualización del catálogo" });
    await expect(screen.getByRole("status")).toHaveText("Recurso creado");
    await expect(created.getByRole("button", { name: "Ver Recurso creado en pantalla", exact: true })).toBeVisible();
    await expect(created.getByText("Horario sin definir", { exact: true })).toBeVisible();
    expect(counts).toEqual({ POST: 1, PUT: 0, GET: 1 });
    expect(bodies[0]).toEqual({ name: "Recurso creado en pantalla", description: "Descripción inicial",
      serviceIds: [ownService.id, suspendedService.id], weeklySchedule: {} });
    await expect(warning.getByRole("alert")).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("resources-create-saved-warning.png"), fullPage: true });
    failGet = false;
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(counts).toEqual({ POST: 1, PUT: 0, GET: 2 });
    await business.reload();
    await expect(created.getByText("Descripción inicial", { exact: true })).toBeVisible();
    await edit("Recurso creado en pantalla");
    await expect(form.getByLabel("Nombre", { exact: true })).toBeFocused();
    await form.getByLabel("Nombre", { exact: true }).fill("Sala de consulta");
    const conflict = business.waitForResponse(response => response.request().method() === "PUT" && response.status() === 409);
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await conflict;
    await expect(form.getByRole("alert")).toHaveText("Ya hay un recurso con ese nombre. Elegí otro nombre.");
    await expect(form.getByLabel("Nombre", { exact: true })).toHaveValue("Sala de consulta");
    await expect(form.getByLabel("Descripción (opcional)")).toHaveValue("Descripción inicial");
    await business.screenshot({ path: testInfo.outputPath("resources-real-conflict.png"), fullPage: true });
    await form.getByRole("button", { name: "Cancelar edición", exact: true }).click();
    await expect(detail.getByText("Descripción inicial", { exact: true })).toBeVisible();
    await close();
    await edit(professional);
    await form.getByLabel("Nombre", { exact: true }).fill("Profesional actualizado");
    await form.getByLabel("Descripción (opcional)").fill("");
    await form.getByRole("checkbox", { name: "Consulta propia", exact: true }).uncheck();
    await form.getByRole("checkbox", { name: "Seguimiento propio (suspendido)", exact: true }).uncheck();
    failGet = true;
    const beforeEdit = { ...counts };
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(screen.getByRole("status")).toHaveText("Recurso actualizado");
    await inspect("Profesional actualizado");
    await expect(detail.getByText("Sin servicios asignados", { exact: true })).toBeVisible();
    await expect(detail.locator(".resources-description")).toHaveCount(0);
    await close();
    expect(bodies.at(-1)).toEqual({ name: "Profesional actualizado", serviceIds: [], weeklySchedule });
    expect(counts).toEqual({ POST: beforeEdit.POST, PUT: beforeEdit.PUT + 1, GET: beforeEdit.GET + 1 });
    await expect(warning.getByRole("alert")).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("resources-edit-saved-warning.png"), fullPage: true });
    failGet = false;
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(counts).toEqual({ POST: beforeEdit.POST, PUT: beforeEdit.PUT + 1, GET: beforeEdit.GET + 2 });
    await business.unroute("**/api/me/resources");
    await business.reload();
    await inspect("Profesional actualizado");
    await expect(detail.getByText("Activo", { exact: true })).toBeVisible();
    await expect(detail.locator(".resources-description")).toHaveCount(0);
    await expect(detail.getByText("Sin servicios asignados", { exact: true })).toBeVisible();
    await expect(days.filter({ hasText: "Lunes" })).toContainText("09:00–12:00 · 14:00–18:00");
    await expect(days.filter({ hasText: "Jueves" })).toContainText("22:00–02:00 (día siguiente)");
    await close();
    const persisted = await business.request.get(`${system.webUrl}/api/me/resources`);
    expect(persisted.status()).toBe(200);
    const records = await persisted.json() as Array<{ name: string; description: string | null; weeklySchedule: unknown }>;
    expect(records.find(record => record.name === "Profesional actualizado")).toMatchObject({ description: null, weeklySchedule });
    await other.reload();
    await expect(other.getByRole("listitem")).toHaveCount(1);
    await expect(other.getByText("Profesional actualizado", { exact: true })).toHaveCount(0);
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await business.screenshot({ path: testInfo.outputPath("resources-edited-360.png"), fullPage: true });
    // Weekly editor: real mutations/conflicts; only the committed-save GET500 is mocked.
    const hoursResource = await seed(business, "post", "resources", {
      name: "Recurso con franjas", description: "  descripción sin recortar  ",
      serviceIds: [ownService.id, suspendedService.id],
      weeklySchedule: { 1: [{ startMinute: 541, endMinute: 602 }], 2: [] },
    }, 201);
    await seed(business, "put", `resources/${hoursResource.id}/status`, { status: "suspended" }, 200);
    await business.reload();
    const hoursRow = catalog.getByRole("listitem").filter({ hasText: "Recurso con franjas" });
    const readHours = async () => {
      const response = await business.request.get(`${system.webUrl}/api/me/resources`);
      expect(response.status()).toBe(200);
      return (await response.json() as Array<Record<string, unknown>>).find(record => record.id === hoursResource.id)!;
    };
    const initialHours = await readHours();
    await edit("Recurso con franjas", true);
    const editor = form.getByRole("group", { name: "Horario semanal", exact: true });
    await expect(editor.getByLabel("Inicio Lunes 1", { exact: true })).toHaveValue("09:01");
    await expect(editor.getByLabel("Fin Lunes 1", { exact: true })).toHaveValue("10:02");
    await form.getByLabel("Nombre", { exact: true }).fill("Recurso con franjas renombrado");
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(screen.getByRole("status")).toHaveText("Recurso actualizado");
    expect(await readHours()).toEqual({ ...initialHours, name: "Recurso con franjas renombrado" });
    await edit("Recurso con franjas renombrado", true);
    const beforeInvalid = counts.PUT;
    for (const [start, end] of [["09:01", "09:01"], ["9:01", "10:02"], ["24:00", "10:02"], ["09:01", "24:01"], ["09:01:00", "10:02"]]) {
      await editor.getByLabel("Inicio Lunes 1", { exact: true }).fill(start!);
      await editor.getByLabel("Fin Lunes 1", { exact: true }).fill(end!);
      await openHours(); // Collapse the invalid draft before trying to save.
      await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
      await expect(form.getByRole("alert")).toContainText("HH:mm distintas");
      expect(counts.PUT).toBe(beforeInvalid);
      await expect(editor.getByLabel("Inicio Lunes 1", { exact: true })).toBeVisible();
      await expect(editor.getByLabel("Inicio Lunes 1", { exact: true })).toHaveValue(start!);
      await expect(editor.getByLabel("Fin Lunes 1", { exact: true })).toHaveValue(end!);
    }
    await editor.getByLabel("Inicio Lunes 1", { exact: true }).fill("09:01");
    await editor.getByLabel("Fin Lunes 1", { exact: true }).fill("10:02");
    const addSpan = async (day: string, index: number, start: string, end: string) => {
      await editor.getByRole("button", { name: `Agregar franja ${day}`, exact: true }).click();
      await expect(editor.getByLabel(`Inicio ${day} ${index}`, { exact: true })).toHaveValue("");
      await expect(editor.getByLabel(`Fin ${day} ${index}`, { exact: true })).toHaveValue("");
      await editor.getByLabel(`Inicio ${day} ${index}`, { exact: true }).fill(start);
      await editor.getByLabel(`Fin ${day} ${index}`, { exact: true }).fill(end);
    };
    await addSpan("Martes", 1, "08:00", "09:00");
    const envelopeConflict = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}`)
      && response.request().method() === "PUT" && response.status() === 409);
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await envelopeConflict;
    await expect(form.getByRole("alert")).toHaveText("Los horarios de los recursos deben estar dentro del horario del negocio. Revisá ambos horarios.");
    await expect(editor.getByLabel("Inicio Martes 1", { exact: true })).toHaveValue("08:00");
    expect(await readHours()).toEqual({ ...initialHours, name: "Recurso con franjas renombrado" });
    await business.screenshot({ path: testInfo.outputPath("resources-real-envelope-conflict-360.png"), fullPage: true });
    await editor.getByRole("button", { name: "Quitar franja Martes 1", exact: true }).click();
    const fullWeek = Object.fromEntries(Array.from({ length: 7 }, (_, day) =>
      [day, [{ startMinute: 0, endMinute: 1440 }]]));
    await seed(business, "put", "business-calendar", { weeklySchedule: fullWeek }, 200);
    await addSpan("Lunes", 2, "09:30", "11:01"); // overlap is valid; preserve raw rows
    await addSpan("Lunes", 3, "11:01", "12:00"); // adjacent is valid too
    await addSpan("Jueves", 1, "22:01", "01:02");
    await addSpan("Domingo", 1, "23:01", "00:02"); // wraps into Monday
    await addSpan("Sábado", 1, "00:00", "24:00");
    const rawSchedule = {
      1: [{ startMinute: 541, endMinute: 602 }, { startMinute: 570, endMinute: 661 }, { startMinute: 661, endMinute: 720 }],
      4: [{ startMinute: 1321, endMinute: 62 }], 0: [{ startMinute: 1381, endMinute: 2 }],
      6: [{ startMinute: 0, endMinute: 1440 }],
    };
    let releaseHours: (() => void) | undefined;
    const heldHours = new Promise<void>(resolve => { releaseHours = resolve; });
    await business.route(`**/api/me/resources/${hoursResource.id}`, async route => {
      await heldHours;
      await route.continue();
    });
    await business.route("**/api/me/resources", route => route.fulfill({ status: 500,
      contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    const beforeHoursSave = { ...counts };
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(editor.getByRole("button", { name: "Agregar franja Lunes", exact: true })).toBeDisabled();
    await expect(editor.getByLabel("Inicio Lunes 1", { exact: true })).toBeDisabled();
    await expect(editor.getByRole("button", { name: "Quitar franja Lunes 1", exact: true })).toBeDisabled();
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await business.screenshot({ path: testInfo.outputPath("resources-hours-pending-360.png"), fullPage: true });
    releaseHours!();
    await expect(screen.getByRole("status")).toHaveText("Recurso actualizado");
    await expect(warning.getByRole("alert")).toBeVisible();
    expect(bodies.at(-1)).toEqual({ name: "Recurso con franjas renombrado", description: "  descripción sin recortar  ",
      serviceIds: initialHours.serviceIds, weeklySchedule: rawSchedule });
    expect(counts).toEqual({ ...beforeHoursSave, PUT: beforeHoursSave.PUT + 1, GET: beforeHoursSave.GET + 1 });
    await business.unroute(`**/api/me/resources/${hoursResource.id}`);
    await business.unroute("**/api/me/resources");
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(counts).toEqual({ ...beforeHoursSave, PUT: beforeHoursSave.PUT + 1, GET: beforeHoursSave.GET + 2 });
    await business.reload();
    expect(await readHours()).toEqual({ ...initialHours, name: "Recurso con franjas renombrado", weeklySchedule: rawSchedule });
    await edit("Recurso con franjas renombrado", true);
    await expect(editor.getByLabel("Fin Sábado 1", { exact: true })).toHaveValue("24:00");
    await expect(editor.getByLabel("Fin Domingo 1", { exact: true })).toHaveValue("00:02");
    await business.screenshot({ path: testInfo.outputPath("resources-hours-draft-360.png"), fullPage: true });
    for (const day of ["Lunes", "Jueves", "Domingo", "Sábado"]) {
      while (await editor.getByRole("button", { name: `Quitar franja ${day} 1`, exact: true }).count())
        await editor.getByRole("button", { name: `Quitar franja ${day} 1`, exact: true }).click();
    }
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(screen.getByRole("status")).toHaveText("Recurso actualizado");
    await business.reload();
    expect(await readHours()).toEqual({ ...initialHours, name: "Recurso con franjas renombrado", weeklySchedule: {} });
    await seed(business, "put", `resources/${inactive.id}`, {
      name: "Sala de consulta", description: "", serviceIds: [], weeklySchedule: {},
    }, 200);
    await business.reload();
    await edit("Sala de consulta");
    await form.getByLabel("Nombre", { exact: true }).fill("Sala renombrada");
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await expect(screen.getByRole("status")).toHaveText("Recurso actualizado");
    expect(bodies.at(-1)).toEqual({ name: "Sala renombrada", description: "", serviceIds: [], weeklySchedule: {} });
    await business.reload();
    const emptyDescriptionRecords = await business.request.get(`${system.webUrl}/api/me/resources`);
    expect((await emptyDescriptionRecords.json() as Array<Record<string, unknown>>).find(record => record.id === inactive.id))
      .toMatchObject({ name: "Sala renombrada", description: "", status: "suspended", serviceIds: [], weeklySchedule: {} });
    // Seed a real offered future booking; shrinking the assigned resource must produce a real 409.
    await seed(business, "put", `resources/${hoursResource.id}`, {
      name: "Recurso con franjas renombrado", description: "  descripción sin recortar  ",
      serviceIds: [ownService.id, suspendedService.id], weeklySchedule: fullWeek,
    }, 200);
    await seed(business, "put", `resources/${hoursResource.id}/status`, { status: "active" }, 200);
    const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const available = await business.request.get(`${system.webUrl}/api/me/appointments/availability?serviceId=${ownService.id}&resourceId=${hoursResource.id}&date=${date}`);
    expect(available.status()).toBe(200);
    const slots = await available.json() as Array<{ start: string; resourceId: string; terms: object }>;
    expect(slots.length).toBeGreaterThan(0);
    const booking = await seed(business, "post", "appointments", { serviceId: ownService.id, resourceId: hoursResource.id,
      startRaw: slots[0]!.start, date, expectedTerms: slots[0]!.terms, confirmed: true,
      newClient: { name: "Cliente Horario", phone: "+5491123456789" },
    }, 201);
    await business.reload();
    const bookedRecord = await readHours();
    await edit("Recurso con franjas renombrado", true);
    for (const day of ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"])
      await editor.getByRole("button", { name: `Quitar franja ${day} 1`, exact: true }).click();
    const bookingConflict = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}`)
      && response.request().method() === "PUT" && response.status() === 409);
    await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
    await bookingConflict;
    await expect(form.getByRole("alert")).toHaveText("El cambio del recurso presenta un conflicto con turnos futuros. Revisá los turnos antes de continuar.");
    await expect(editor.getByRole("button", { name: /Quitar franja/ })).toHaveCount(0);
    expect(await readHours()).toEqual(bookedRecord);
    await business.screenshot({ path: testInfo.outputPath("resources-real-booking-conflict-360.png"), fullPage: true });
    // Lifecycle uses real status/retirement APIs; only catalog GET failure is mocked.
    await form.getByRole("button", { name: "Cancelar edición", exact: true }).click();
    await detail.getByRole("button", { name: "Editar recurso", exact: true }).click();
    const lifecycleCounts = { PUT: 0, DELETE: 0, GET: 0 };
    business.on("request", request => {
      if (!/\/api\/me\/resources(?:\/|$)/.test(new URL(request.url()).pathname)) return;
      const method = request.method() as keyof typeof lifecycleCounts;
      if (method in lifecycleCounts) lifecycleCounts[method]++;
    });
    const confirmation = screen.getByRole("region", { name: "Confirmar acción sobre recurso", exact: true });
    for (const action of ["Suspender", "Retirar"]) {
      const opener = form.getByRole("button", { name: action, exact: true });
      await opener.focus();
      await business.keyboard.press("Enter");
      await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
      await business.screenshot({ path: testInfo.outputPath(`resources-${action}-confirm-360.png`), fullPage: true });
      await business.keyboard.press("Enter");
      await expect(opener).toBeEnabled();
      await expect(opener).toBeFocused();
      expect(lifecycleCounts).toEqual({ PUT: 0, DELETE: 0, GET: 0 });
    }
    const readBooking = async () => {
      const response = await business.request.get(`${system.webUrl}/api/me/appointments/${booking.id}`);
      expect(response.status()).toBe(200);
      return await response.json();
    };
    const originalBooking = await readBooking();
    let releaseStatus: (() => void) | undefined;
    const heldStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
    await business.route(`**/api/me/resources/${hoursResource.id}/status`, async route => {
      await heldStatus;
      await route.continue();
    });
    await business.route("**/api/me/resources", route => route.fulfill({ status: 500,
      contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await form.getByRole("button", { name: "Suspender", exact: true }).click();
    await expect(confirmation).toContainText("Los turnos existentes no se cancelan.");
    const suspendButton = confirmation.getByRole("button", { name: "Confirmar suspensión", exact: true });
    await suspendButton.click();
    await expect(confirmation).toHaveAttribute("aria-busy", "true");
    await expect(business.locator('.rd-dialog form .rd-lifecycle button').filter({ hasText: "Suspender" })).toBeDisabled();
    await expect(business.locator('.rd-dialog button[type="submit"]').filter({ hasText: "Guardando…" })).toBeDisabled();
    await business.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('.resources-confirmation button:last-child');
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lifecycleCounts.PUT).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("resources-status-pending-360.png"), fullPage: true });
    const statusResponse = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}/status`)
      && response.request().method() === "PUT" && response.status() === 200);
    releaseStatus!();
    await statusResponse;
    await expect(hoursRow.getByText("Suspendido", { exact: true })).toBeVisible();
    await expect(form.getByRole("button", { name: "Reactivar", exact: true })).toBeFocused();
    await expect(warning.getByRole("alert")).toBeVisible();
    expect(lifecycleCounts).toEqual({ PUT: 1, DELETE: 0, GET: 1 });
    expect(await readBooking()).toEqual(originalBooking);
    expect(await readHours()).toEqual({ ...bookedRecord, status: "suspended" });
    await business.screenshot({ path: testInfo.outputPath("resources-status-saved-warning-360.png"), fullPage: true });
    await business.unroute(`**/api/me/resources/${hoursResource.id}/status`);
    await business.unroute("**/api/me/resources");
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(lifecycleCounts).toEqual({ PUT: 1, DELETE: 0, GET: 2 });
    await business.reload();
    await expect(hoursRow.getByText("Suspendido", { exact: true })).toBeVisible();
    const reactivateResponse = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}/status`)
      && response.request().method() === "PUT" && response.status() === 200);
    await edit("Recurso con franjas renombrado");
    await form.getByRole("button", { name: "Reactivar", exact: true }).click();
    await reactivateResponse;
    await expect(form.getByRole("button", { name: "Suspender", exact: true })).toBeFocused();
    await business.reload();
    await inspect("Recurso con franjas renombrado");
    await expect(detail.getByText("Activo", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Editar recurso", exact: true }).click();
    expect(await readHours()).toEqual(bookedRecord);
    expect(await readBooking()).toEqual(originalBooking);
    await form.getByRole("button", { name: "Retirar", exact: true }).click();
    const retireConflict = business.waitForResponse(response => response.url().endsWith(`/resources/${hoursResource.id}`)
      && response.request().method() === "DELETE" && response.status() === 409);
    await confirmation.getByRole("button", { name: "Confirmar retiro", exact: true }).click();
    await retireConflict;
    await expect(confirmation.getByRole("alert")).toHaveText("El cambio del recurso presenta un conflicto con turnos futuros. Revisá los turnos antes de continuar.");
    expect(await readHours()).toEqual(bookedRecord);
    expect(await readBooking()).toEqual(originalBooking);
    await business.screenshot({ path: testInfo.outputPath("resources-real-retire-409-360.png"), fullPage: true });
    await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(form.getByRole("button", { name: "Retirar", exact: true })).toBeFocused();
    await close();
    await expect(hoursRow).toBeVisible();
    await edit("Sala renombrada");
    const retiredRow = catalog.getByRole("listitem").filter({ hasText: "Sala renombrada" });
    await business.route("**/api/me/resources", route => route.fulfill({ status: 500,
      contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await form.getByRole("button", { name: "Retirar", exact: true }).click();
    await expect(confirmation).toContainText("se conservará el historial");
    const beforeRetire = { ...lifecycleCounts };
    const retiredResponse = business.waitForResponse(response => response.url().endsWith(`/resources/${inactive.id}`)
      && response.request().method() === "DELETE" && response.status() === 200);
    await confirmation.getByRole("button", { name: "Confirmar retiro", exact: true }).click();
    expect(await (await retiredResponse).json()).toEqual({ id: inactive.id });
    await expect(retiredRow).toHaveCount(0);
    await expect(screen.getByRole("heading", { name: "Recursos", exact: true })).toBeFocused();
    await expect(warning.getByRole("alert")).toBeVisible();
    expect(lifecycleCounts).toEqual({ ...beforeRetire, DELETE: beforeRetire.DELETE + 1, GET: beforeRetire.GET + 1 });
    expect(await readBooking()).toEqual(originalBooking);
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await business.screenshot({ path: testInfo.outputPath("resources-retired-warning-360.png"), fullPage: true });
    await business.unroute("**/api/me/resources");
    await warning.getByRole("button", { name: "Actualizar catálogo", exact: true }).click();
    await expect(warning).toHaveCount(0);
    expect(lifecycleCounts).toEqual({ ...beforeRetire, DELETE: beforeRetire.DELETE + 1, GET: beforeRetire.GET + 2 });
    await business.reload();
    await expect(retiredRow).toHaveCount(0);
    const adminReads: string[] = [];
    page.on("request", request => { if (/\/api\/me\/(resources|services)$/.test(request.url())) adminReads.push(request.url()); });
    await page.goto(`${system.webUrl}/resources`);
    await expect(page.locator('main[data-state="denied"]')).toBeVisible();
    expect(adminReads).toEqual([]);
  } finally {
    await context.close();
    await otherContext.close();
  }
});
