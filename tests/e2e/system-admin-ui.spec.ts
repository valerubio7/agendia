import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { login, test } from "./support/fixtures.ts";

const admin = (page: Page) => page.locator('[data-ui="admin-screen"]');
const feedback = (page: Page) => admin(page).locator(".admin-feedback");
const confirmation = (page: Page) => page.getByRole("alertdialog");
const directory = (page: Page) => page.locator(".admin-directory");
const business = (page: Page, name: string) => directory(page).getByRole("button", { name: `Información del negocio: ${name}`, exact: true });
const details = (page: Page) => page.getByRole("dialog", { name: "Información del negocio", exact: true });
const requests = (page: Page) => page.getByRole("region", { name: "Solicitudes pendientes", exact: true });
const timing = (page: Page) => page.getByRole("spinbutton", { name: "Espera activa (s)", exact: true });
const save = (page: Page) => page.getByRole("button", { name: "Guardar cambios", exact: true });

async function navigate(page: Page, name: "Inicio" | "Negocios" | "Ajustes") {
  const menu = page.getByRole("button", { name: "Abrir navegación" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name, exact: true }).click({ timeout: 5000 });
}
async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
async function registerPending(page: Page, name: string, email: string) {
  const response = await page.request.post(new URL("/api/auth/register", page.url()).href, {
    headers: { origin: new URL(page.url()).origin }, data: { name, email, password: "disposable admin fixture password" },
  });
  expect(response.status()).toBe(202);
  if (new URL(page.url()).pathname === "/solicitudes") await page.reload();
  else await navigate(page, "Inicio");
  const approve = requests(page).getByRole("button", { name: `Aprobar ${name}`, exact: true });
  await expect(approve).toBeVisible();
  return approve;
}
async function approve(page: Page, trigger: Locator) {
  await trigger.click();
  await confirmation(page).getByRole("button", { name: "Aprobar solicitud", exact: true }).click();
}
async function confirmStatus(page: Page, name: string, label = "Suspender negocio") {
  await business(page, name).click();
  await details(page).getByRole("button", { name: label, exact: true }).click();
  await confirmation(page).getByRole("button", { name: label, exact: true }).click();
}
async function editTiming(page: Page) {
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  return page.getByRole("dialog", { name: "Tiempos de respuesta", exact: true });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("admin destinations are addressable and the active destination survives reload", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/solicitudes$/);
  await expect(admin(page)).toBeVisible();
  for (const [width, name, path, heading] of [
    [360, "Ajustes", "/ajustes", "Ajustes"],
    [360, "Negocios", "/businesses", "Negocios"],
    [1280, "Inicio", "/solicitudes", "Solicitudes pendientes"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await navigate(page, name);
    await expect(page).toHaveURL(`${system.webUrl}${path}`);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: heading, exact: true })).toBeVisible();
    if (width === 360) await page.getByRole("button", { name: "Abrir navegación" }).click();
    await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
    if (width === 360) await page.getByRole("button", { name: "Cerrar navegación" }).click();
    await expectNoHorizontalOverflow(page);
  }
});

test("delete requires confirmation and distinguishes failed deletion from failed refresh", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(admin(page)).toBeVisible();
  const name = "Negocio a eliminar";
  await approve(page, await registerPending(page, name, "delete-admin@example.test"));
  await expect(feedback(page).getByRole("status")).toHaveText("Solicitud aprobada");
  await navigate(page, "Negocios");
  const row = business(page, name);
  await row.click();
  const remove = details(page).getByRole("button", { name: `Eliminar ${name}`, exact: true });
  const accept = confirmation(page).getByRole("button", { name: "Eliminar definitivamente", exact: true });
  let writes = 0, failed = true, failRefresh = false;
  const held = deferred(), observed = deferred();
  await page.route("**/admin/businesses/**", async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    writes++;
    if (failed) return route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } });
    failRefresh = true;
    observed.resolve();
    await held.promise;
    return route.fulfill({ status: 200, json: { deleted: true } });
  });
  await page.route("**/admin/businesses", route => failRefresh ? route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } }) : route.continue());
  await remove.click();
  for (const word of ["irreversible", "copias", "historial", "mensajes"]) await expect(confirmation(page)).toContainText(word);
  await confirmation(page).getByRole("button", { name: "Cancelar", exact: true }).click();
  expect(writes).toBe(0);
  await remove.click();
  await accept.click();
  await expect(confirmation(page).getByRole("alert")).toBeVisible();
  await expect(row).toHaveCount(1);
  expect(writes).toBe(1);
  failed = false;
  await accept.click();
  try {
    await observed.promise;
    await expect(confirmation(page).getByRole("button", { name: "Procesando…", exact: true })).toBeDisabled();
    expect(writes).toBe(2);
  } finally { held.resolve(); }
  await expect(row).toHaveCount(0);
  await expect(feedback(page).getByRole("status")).toHaveText("Negocio eliminado");
  await expect(feedback(page).getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Reintentar consulta" }).click();
  expect(writes).toBe(2);
});

test("initial registration read failure leaves admin controls available and retries reads only", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(admin(page)).toBeVisible();
  await approve(page, await registerPending(page, "Negocio existente", "existing-retry@example.test"));
  await expect(feedback(page).getByRole("status")).toHaveText("Solicitud aprobada");
  await registerPending(page, "Solicitud recuperada", "pending-retry@example.test");
  let registrationReads = 0, writes = 0, unavailable = true;
  await page.route("**/admin/**", async route => {
    const request = route.request();
    if (request.method() !== "GET") writes++;
    if (request.method() === "GET" && new URL(request.url()).pathname.endsWith("/admin/registrations")) {
      registrationReads++;
      if (unavailable) return route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } });
    }
    await route.continue();
  });
  await page.reload();
  await expect(requests(page).getByText("No se pudieron cargar las solicitudes pendientes.")).toBeVisible();
  await expect(requests(page).getByText("No hay solicitudes pendientes")).toHaveCount(0);
  await navigate(page, "Negocios");
  await confirmStatus(page, "Negocio existente");
  await expect(feedback(page).getByRole("status")).toHaveText("Negocio actualizado");
  await expect(business(page, "Negocio existente")).toContainText("Suspendido");
  await navigate(page, "Ajustes");
  await editTiming(page);
  await expect(timing(page)).toHaveValue("90");
  await timing(page).fill("23");
  await save(page).click();
  await expect(feedback(page).getByRole("status")).toHaveText("Tiempos guardados");
  await expect(page.getByText("23 s", { exact: true })).toBeVisible();
  await expect(feedback(page).getByRole("alert")).toBeVisible();
  expect(writes).toBe(2);
  const before = registrationReads;
  unavailable = false;
  await page.getByRole("button", { name: "Reintentar consulta" }).click();
  await expect(feedback(page).getByRole("alert")).toHaveCount(0);
  expect(registrationReads).toBe(before + 1);
  await navigate(page, "Inicio");
  await expect(requests(page).getByRole("button", { name: "Aprobar Solicitud recuperada" })).toBeVisible();
  expect(writes).toBe(2);
});

for (const failedRead of ["businesses", "response-timing"]) {
  test(`confirmed admin writes survive failed ${failedRead} refresh with GET-only recovery`, async ({ page, system }) => {
    await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    await expect(admin(page)).toBeVisible();
    const name = "Negocio confirmado";
    const trigger = await registerPending(page, name, "confirmed-admin@example.test");
    let mutationCount = 0, readCount = 0, failRefresh = false;
    await page.route("**/admin/**", async route => {
      const request = route.request();
      if (request.method() !== "GET") {
        mutationCount++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        failRefresh = true;
        return route.fulfill({ response });
      }
      if (new URL(request.url()).pathname.endsWith(`/admin/${failedRead}`)) {
        readCount++;
        if (failRefresh) return route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } });
      }
      await route.continue();
    });
    for (const action of ["create", "status", "timing"] as const) {
      if (action === "create") await approve(page, trigger);
      if (action === "status") { await navigate(page, "Negocios"); await confirmStatus(page, name); }
      if (action === "timing") { await navigate(page, "Ajustes"); await editTiming(page); await timing(page).fill("23"); await save(page).click(); }
      await expect(feedback(page).getByRole("status")).toHaveText(action === "create" ? "Solicitud aprobada" : action === "timing" ? "Tiempos guardados" : "Negocio actualizado");
      const warning = feedback(page).getByRole("alert");
      await expect(warning).toHaveText("No se pudo actualizar la información. Reintentá solo la consulta.");
      if (action === "create") await expect(trigger).toHaveCount(0);
      if (action === "status") await expect(business(page, name)).toContainText("Suspendido");
      if (action === "timing") await expect(page.getByText("23 s", { exact: true })).toBeVisible();
      const writes = mutationCount, reads = readCount;
      failRefresh = false;
      await page.getByRole("button", { name: "Reintentar consulta", exact: true }).click();
      await expect(warning).toHaveCount(0);
      expect(readCount).toBeGreaterThan(reads);
      expect(mutationCount).toBe(writes);
    }
    expect(mutationCount).toBe(3);
    await page.reload();
    await editTiming(page);
    await expect(timing(page)).toHaveValue("23");
    await page.keyboard.press("Escape");
    await navigate(page, "Negocios");
    await expect(business(page, name)).toContainText("Suspendido");
    await page.route("**/admin/businesses/*/status", route => route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } }));
    await confirmStatus(page, name, "Reactivar negocio");
    await expect(confirmation(page).getByRole("alert")).toBeVisible();
    await expect(feedback(page).getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reintentar consulta", exact: true })).toHaveCount(0);
  });
}

test("late admin mutation and refresh responses cannot overwrite a newer session action", async ({ page, system }) => {
  const adminLogin = () => login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await adminLogin();
  for (const phase of ["mutation", "refresh"] as const) {
    await expect(admin(page)).toBeVisible();
    const name = `Negocio sesión ${phase}`;
    const trigger = await registerPending(page, name, `session-${phase}@example.test`);
    const held = deferred(), intercepted = deferred(), delivered = deferred();
    let captured = false;
    const lateRoute = async (route: Route) => {
      if (captured || route.request().method() !== (phase === "mutation" ? "POST" : "GET")) return route.continue();
      captured = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      intercepted.resolve();
      await held.promise;
      await route.fulfill({ response });
      delivered.resolve();
    };
    const routePattern = phase === "mutation" ? "**/admin/registrations/*/approve" : "**/admin/businesses";
    await page.route(routePattern, lateRoute);
    await approve(page, trigger);
    await intercepted.promise;
    try {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/login$/);
      await adminLogin();
      await navigate(page, "Negocios");
      await confirmStatus(page, name);
      await expect(feedback(page).getByRole("status")).toHaveText("Negocio actualizado");
    } finally { held.resolve(); }
    await delivered.promise;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(feedback(page).getByRole("status")).toHaveText("Negocio actualizado");
    await expect(business(page, name)).toContainText("Suspendido");
    await page.unroute(routePattern, lateRoute);
  }
});

test("platform admin saves and reloads global reply waits without guidance controls", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(admin(page)).toBeVisible();
  await navigate(page, "Ajustes");
  const panel = await editTiming(page);
  await expect(panel.locator("textarea")).toHaveCount(0);
  await expect(panel.getByText(/indicaciones administrativas|instrucciones base/i)).toHaveCount(0);
  const initial = page.getByRole("spinbutton", { name: "Espera inicial (s)", exact: true });
  const reset = page.getByRole("spinbutton", { name: "Reinicio por inactividad (s)", exact: true });
  for (const [control, id] of [[initial, "initialDelaySeconds-help"], [timing(page), "activeDelaySeconds-help"], [reset, "inactivityResetSeconds-help"]] as const)
    await expect(control).toHaveAttribute("aria-describedby", id);
  await expect(initial).toHaveValue("600");
  await expect(timing(page)).toHaveValue("90");
  await expect(reset).toHaveValue("3600");
  for (const width of [1280, 900, 360]) { await page.setViewportSize({ width, height: 900 }); await expectNoHorizontalOverflow(page); }
  await initial.fill("0");
  await timing(page).fill("23");
  await reset.fill("75");
  await save(page).click();
  await expect(feedback(page).getByRole("status")).toHaveText("Tiempos guardados");
  await page.reload();
  await editTiming(page);
  await expect(initial).toHaveValue("0");
  await expect(timing(page)).toHaveValue("23");
  await expect(reset).toHaveValue("75");
  await reset.fill("0");
  await save(page).click();
  expect(await reset.evaluate(input => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  await page.reload();
  await editTiming(page);
  await expect(reset).toHaveValue("75");
});

// Effective reference at 1280/360 × 900; page coordinates exclude its 49 px demo banner.
const panelBounds = {
  requests: [[274, 99.89, 954, 85], [14, 176.83, 332, 131]],
  businesses: [[274, 244.97, 954, 132.94], [14, 304.06, 332, 85]],
  settings: [[274, 103.89, 680, 263.33], [14, 135.59, 332, 230.66]],
  requestDialog: [[355, 198.98, 570, 502.03], [10, 391.42, 340, 498.58]],
  businessDialog: [[355, 90.86, 570, 718.28], [10, 111.75, 340, 778.25]],
} as const;

async function box(locator: Locator) {
  return locator.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return [x, y, width, height] as const;
  });
}

async function settleDialog(dialog: Locator) {
  await dialog.evaluate(async element => {
    const finite = element.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    await Promise.allSettled(finite.map(animation => animation.finished));
  });
}

async function expectReferenceBounds(locator: Locator, surface: keyof typeof panelBounds, width: number, tolerance: number) {
  const actual = await box(locator);
  const expected = panelBounds[surface][width === 1280 ? 0 : 1];
  expect.soft(Math.max(...actual.map((value, i) => Math.abs(value - expected[i]!))),
    `${surface} at ${width}: ${actual.join(", ")}`).toBeLessThanOrEqual(tolerance);
  return actual;
}

test("the redesigned administration screen preserves the real business workflow responsively", async ({ page, system }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(admin(page)).toBeVisible();
  await navigate(page, "Negocios");
  await expect(directory(page)).toBeEmpty();
  await expect(page.getByText("Aún no hay negocios", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Estado operativo" }).getByRole("button")).toHaveText(["Todos (0)", "Activos (0)", "Suspendidos (0)"]);
  const name = "Estudio Horizonte", email = "visual-admin@example.test";
  const trigger = await registerPending(page, name, email);
  await expect(requests(page).getByText(email, { exact: true })).toBeVisible();
  const when = await requests(page).locator("time").innerText();
  const measured: Record<string, number | readonly number[]> = {};
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    measured[`requests-${width}`] = await expectReferenceBounds(requests(page), "requests", width, 1);
    const headingTextWidth = await page.getByRole("heading", { level: 1 }).evaluate(element => {
      const content = document.createRange();
      content.selectNodeContents(element);
      return content.getBoundingClientRect().width;
    });
    measured[`headingTextWidth-${width}`] = headingTextWidth;
    expect.soft(Math.abs(headingTextWidth - (width === 1280 ? 367.89 : 280.77)), `request heading at ${width}: ${headingTextWidth}`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`requests-${width}.png`) });
    const request = requests(page).getByRole("button", { name: `Ver solicitud de ${name}`, exact: true });
    await request.click();
    const detail = page.getByRole("dialog", { name: "Solicitud de alta", exact: true });
    await expect(detail.getByText(email)).toBeVisible();
    await settleDialog(detail);
    measured[`request-dialog-${width}`] = await expectReferenceBounds(detail, "requestDialog", width, 2);
    expect.soft((await box(detail.locator("header button svg")))[2]).toBe(16);
    await page.screenshot({ path: testInfo.outputPath(`request-dialog-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(request).toBeFocused();
    await trigger.click();
    const approval = confirmation(page);
    await expect(approval).toBeVisible();
    await settleDialog(approval);
    measured[`approval-dialog-${width}`] = await box(approval);
    await page.screenshot({ path: testInfo.outputPath(`approval-dialog-${width}.png`) });
    await approval.getByRole("button", { name: "Cancelar", exact: true }).click();
  }
  const observed = deferred(), release = deferred();
  let writes = 0;
  await page.route("**/admin/registrations/*/approve", async route => { writes++; observed.resolve(); await release.promise; await route.continue(); });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(confirmation(page).getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  const accept = confirmation(page).getByRole("button", { name: "Aprobar solicitud", exact: true });
  await accept.click();
  try { await observed.promise; await expect(confirmation(page).getByRole("button", { name: "Procesando…", exact: true })).toBeDisabled(); } finally { release.resolve(); }
  await expect(feedback(page).getByRole("status")).toHaveText("Solicitud aprobada");
  expect(writes).toBe(1);
  await navigate(page, "Negocios");
  const row = business(page, name);
  await expect(row).toContainText("Activo");
  const search = page.getByRole("searchbox", { name: "Buscar negocio" });
  await search.fill("sin coincidencias");
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Limpiar filtros" }).click();
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Suspendidos (0)", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Todos (1)", exact: true }).click();
  let created = "";
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    measured[`businesses-${width}`] = await expectReferenceBounds(page.locator(".adm-table"), "businesses", width, 1);
    expect.soft(await row.locator(":scope > svg path").getAttribute("d")).toBe("M5 12h14m-6-6 6 6-6 6");
    await page.screenshot({ path: testInfo.outputPath(`businesses-${width}.png`) });
    await row.click();
    await expect(details(page).getByText("Sin vincular", { exact: true })).toBeVisible();
    await expect(details(page).getByText("Inactivo", { exact: true })).toBeVisible();
    await expect(details(page).getByText("Sin actividad", { exact: true })).toBeVisible();
    await expect(details(page).getByRole("button", { name: /Renombrar|Cambiar contraseña/ })).toHaveCount(0);
    created = await details(page).locator('dt').filter({ hasText: /^Alta · UTC$/ }).locator('+ dd').innerText();
    await settleDialog(details(page));
    measured[`business-dialog-${width}`] = await expectReferenceBounds(details(page), "businessDialog", width, 6);
    await page.screenshot({ path: testInfo.outputPath(`business-dialog-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(row).toBeFocused();
  }
  await confirmStatus(page, name);
  await expect(feedback(page).getByRole("status")).toHaveText("Negocio actualizado");
  await expect(row).toContainText("Suspendido");
  await confirmStatus(page, name, "Reactivar negocio");
  await expect(feedback(page).getByRole("status")).toHaveText("Negocio actualizado");
  await expect(row).toContainText("Activo");
  await page.reload();
  await expect(row).toContainText("Activo");
  await navigate(page, "Ajustes");
  await expect(page.getByRole("heading", { level: 1, name: "Ajustes" })).toBeVisible();
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    measured[`settings-${width}`] = await expectReferenceBounds(page.locator(".adm-settings-compact"), "settings", width, 1);
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`) });
    const timingDialog = await editTiming(page);
    await expect(timing(page)).toHaveAccessibleDescription(/Entre 0 y 86400 segundos/);
    await settleDialog(timingDialog);
    const bounds = await box(timingDialog);
    measured[`timing-dialog-${width}`] = bounds;
    const [x, y, w, h] = bounds;
    expect.soft([x, w]).toEqual(width === 1280 ? [355, 570] : [10, 340]);
    expect.soft(Math.abs(width === 1280 ? y * 2 + h - 900 : y + h - 890)).toBeLessThanOrEqual(0.25);
    await page.screenshot({ path: testInfo.outputPath(`timing-dialog-${width}.png`) });
    await page.keyboard.press("Escape");
  }
  await testInfo.attach("visual-fixture", { body: JSON.stringify({ name, email, when, created, measured }), contentType: "application/json" });
});
