import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { login, test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Administración Horizonte",
  email: "system-admin-ui@example.test",
  initialPassword: "tenant admin ui password safe",
};

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

function businessRow(page: Page, directory: Locator, name: string) {
  return directory.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
}

async function registerPending(page: Page, name: string, email: string, password: string) {
  const response = await page.request.post(new URL("/api/auth/register", page.url()).href, {
    headers: { origin: new URL(page.url()).origin }, data: { name, email, password },
  });
  expect(response.status()).toBe(202);
  await page.reload();
  const approve = page.getByRole("button", { name: `Aprobar ${name}`, exact: true });
  await expect(approve).toBeVisible();
  return approve;
}

async function openAiConfiguration(page: Page) {
  const tab = page.getByRole("tab", { name: "Configuración de IA", exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Configuración de IA", exact: true })).toBeVisible();
}

async function openManagement(row: Locator) {
  const details = row.locator("details");
  const summary = details.locator("summary");
  await expect(details).toHaveCount(1);
  await expect(summary.locator(".admin-manage-label")).toHaveText("Gestionar");
  expect(await details.evaluate(element => element.tagName)).toBe("DETAILS");
  expect(await summary.evaluate(element => element.tagName)).toBe("SUMMARY");
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await summary.click();
  await expect(details).toHaveAttribute("open", "");
  return details;
}

async function expectReachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
}

async function expectPair(locator: Locator, background: string, color: string) {
  await expect(locator).toHaveCSS("background-color", background);
  await expect(locator).toHaveCSS("color", color);
}

async function keyboardFocus(page: Page, locator: Locator) {
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate(element => element === document.activeElement)) break;
  }
  await expect(locator).toBeFocused();
  expect(await locator.evaluate(element => element.matches(":focus-visible"))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(locator).toBeFocused();
  await expect(locator).toHaveCSS("outline-color", "rgb(46, 107, 78)");
  await expect(locator).toHaveCSS("outline-style", "solid");
}

async function expectRegistryBrand(shell: Locator) {
  const brand = shell.locator(".authenticated-shell__sidebar .brand");
  const image = brand.locator("img");
  await expect(brand).toHaveAccessibleName("agendIA");
  await expect(brand.getByRole("img", { name: "agendIA", exact: true })).toHaveCount(0);
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("src", "/brand/logo-inverse-outlined.svg");
  await expect(image).toHaveAttribute("alt", "");
  await expect.poll(() => image.evaluate(element => {
    const img = element as HTMLImageElement;
    return img.complete && img.naturalWidth === 300 && img.naturalHeight === 93;
  })).toBe(true);
  const bounds = await image.evaluate(element => {
    const wrapper = element.parentElement!;
    const header = wrapper.parentElement!;
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const outer = rect(wrapper);
    const clipped: string[] = [];
    for (let ancestor: Element | null = header; ancestor; ancestor = ancestor.parentElement) {
      const css = getComputedStyle(ancestor), r = rect(ancestor);
      if ((/hidden|clip|auto|scroll/.test(css.overflowX) && (outer.left < r.left || outer.right > r.right)) ||
          (/hidden|clip|auto|scroll/.test(css.overflowY) && (outer.top < r.top || outer.bottom > r.bottom))) clipped.push(ancestor.tagName);
    }
    const css = getComputedStyle(wrapper);
    return { image: rect(element), wrapper: outer, header: rect(header), logout: rect(header.querySelector("button")!), clipped,
      padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(Number.parseFloat) };
  });
  expect(bounds.image.height).toBe(32);
  expect(bounds.image.width / bounds.image.height).toBeCloseTo(388 / 120, 2);
  for (const padding of bounds.padding) expect(padding).toBeCloseTo(32 * 11 / 12, 1);
  expect(bounds.logout.left - bounds.wrapper.right).toBeGreaterThanOrEqual(8);
  expect(bounds.wrapper.left).toBeGreaterThanOrEqual(bounds.header.left);
  expect(bounds.wrapper.right).toBeLessThanOrEqual(bounds.header.right);
  expect(bounds.wrapper.top).toBeGreaterThanOrEqual(bounds.header.top);
  expect(bounds.wrapper.bottom).toBeLessThanOrEqual(bounds.header.bottom);
  expect(bounds.clipped).toEqual([]);
  for (const node of [image, brand]) {
    for (const property of ["filter", "box-shadow", "transform"]) await expect(node).toHaveCSS(property, "none");
  }
}

test("initial registration read failure leaves admin controls available and retries reads only", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  const approve = await registerPending(page, "Negocio existente", "existing-retry@example.test", "existing initial password");
  await approve.click();
  await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Solicitud aprobada");
  await registerPending(page, "Solicitud recuperada", "pending-retry@example.test", "pending initial password");
  let registrationReads = 0;
  let writes = 0;
  let registrationsUnavailable = true;
  await page.route("**/admin/**", async route => {
    const request = route.request();
    if (request.method() !== "GET") writes++;
    if (request.method() === "GET" && new URL(request.url()).pathname.endsWith("/admin/registrations")) {
      registrationReads++;
      if (registrationsUnavailable) return route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } });
    }
    await route.continue();
  });
  await page.reload();
  const requests = page.getByRole("region", { name: "Solicitudes pendientes" });
  await expect(requests.getByText("No se pudieron cargar las solicitudes pendientes.")).toBeVisible();
  await expect(requests.getByText("No hay solicitudes pendientes.")).toHaveCount(0);
  const management = await openManagement(businessRow(page, page.locator(".admin-directory"), "Negocio existente"));
  await management.getByRole("button", { name: "Suspender" }).click();
  await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Negocio actualizado");
  await expect(businessRow(page, page.locator(".admin-directory"), "Negocio existente").getByText("Suspendido", { exact: true })).toBeVisible();
  await openAiConfiguration(page);
  const timing = page.getByRole("spinbutton", { name: /^Espera activa \(segundos\)/ });
  await expect(timing).toHaveValue("90");
  await timing.fill("23");
  await page.getByRole("button", { name: "Guardar configuración" }).click();
  await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Tiempos guardados");
  await expect(timing).toHaveValue("23");
  await expect(page.locator(".admin-feedback").getByRole("alert")).toBeVisible();
  expect(writes).toBe(2);
  registrationsUnavailable = false;
  await page.getByRole("button", { name: "Reintentar consulta" }).click();
  await expect(page.locator(".admin-feedback").getByRole("alert")).toHaveCount(0);
  await page.getByRole("tab", { name: "Negocios", exact: true }).click();
  await expect(requests.getByRole("button", { name: "Aprobar Solicitud recuperada" })).toBeVisible();
  expect(registrationReads).toBe(4);
  expect(writes).toBe(2);
});

for (const failedRead of ["businesses", "response-timing"]) {
  test(`confirmed admin writes survive failed ${failedRead} refresh with GET-only recovery`, async ({ page, system }) => {
    await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
    const approve = await registerPending(page, "Negocio confirmado", "confirmed-admin@example.test", "confirmed initial password");
    const directory = page.locator(".admin-directory");
    const feedback = page.locator(".admin-feedback");
    const currentName = "Negocio confirmado";
    let mutationCount = 0;
    let failRefresh = false;
    let readCount = 0;
    let release!: () => void;
    let observed!: () => void;
    let held = Promise.resolve();
    let mutationObserved = Promise.resolve();
    await page.route("**/admin/**", async route => {
      const request = route.request();
      if (request.method() !== "GET") {
        mutationCount++;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        observed();
        await held;
        await route.fulfill({ response });
      } else {
        readCount++;
        if (failRefresh && new URL(request.url()).pathname.endsWith(`/admin/${failedRead}`)) {
          await route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } });
        } else await route.continue();
      }
    });
    for (const action of ["create", "status", "instructions"] as const) {
      failRefresh = true;
      held = new Promise<void>(resolve => { release = resolve; });
      mutationObserved = new Promise<void>(resolve => { observed = resolve; });
      if (action === "create") {
        await approve.click();
      } else if (action === "instructions") {
        await openAiConfiguration(page);
        await page.getByRole("spinbutton", { name: /^Espera activa \(segundos\)/ }).fill("23");
        await page.getByRole("button", { name: "Guardar configuración", exact: true }).click();
      } else {
        const management = await openManagement(businessRow(page, directory, currentName));
        await management.getByRole("button", { name: "Suspender", exact: true }).click();
      }
      await mutationObserved;
      release();
      await expect(feedback.getByRole("status")).toHaveText(action === "create" ? "Solicitud aprobada" : action === "instructions" ? "Tiempos guardados" : "Negocio actualizado");
      const warning = feedback.getByRole("alert");
      await expect(warning).toHaveText("No se pudo actualizar la información. Reintentá solo la consulta.");
      if (action === "instructions") await page.getByRole("tab", { name: "Negocios", exact: true }).click();
      if (action !== "create" || failedRead !== "businesses") await expect(businessRow(page, directory, currentName)).toHaveCount(1);
      if (action === "status") await expect(businessRow(page, directory, currentName).getByText("Suspendido", { exact: true })).toBeVisible();
      const writes = mutationCount;
      const reads = readCount;
      failRefresh = false;
      await page.getByRole("button", { name: "Reintentar consulta", exact: true }).click();
      await expect(warning).toHaveCount(0);
      expect(readCount).toBeGreaterThan(reads);
      expect(mutationCount).toBe(writes);
      await expect(businessRow(page, directory, currentName)).toHaveCount(1);
    }
    expect(mutationCount).toBe(3);
    await page.reload();
    await expect(businessRow(page, directory, currentName).getByText("Suspendido", { exact: true })).toBeVisible();
    await openAiConfiguration(page);
    await expect(page.getByRole("spinbutton", { name: /^Espera activa \(segundos\)/ })).toHaveValue("23");
    await page.getByRole("tab", { name: "Negocios", exact: true }).click();
    await page.route("**/admin/businesses/*/status", route => route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } }));
    const management = await openManagement(businessRow(page, directory, currentName));
    await management.getByRole("button", { name: "Reactivar", exact: true }).click();
    await expect(management.getByRole("alert")).toContainText("No se pudo actualizar el estado");
    await expect(feedback.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reintentar consulta", exact: true })).toHaveCount(0);
  });
}

test("late admin mutation and refresh responses cannot overwrite a newer session action", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  const directory = page.locator(".admin-directory");
  const notice = page.locator(".admin-feedback").getByRole("status");
  for (const phase of ["mutation", "refresh"] as const) {
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
    const name = `Negocio sesión ${phase}`;
    const approve = await registerPending(page, name, `session-${phase}@example.test`, "late session initial password");
    let release!: () => void;
    let observed!: () => void;
    let delivered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const intercepted = new Promise<void>(resolve => { observed = resolve; });
    const delivery = new Promise<void>(resolve => { delivered = resolve; });
    let captured = false;
    const lateRoute = async (route: Route) => {
      if (captured || route.request().method() !== (phase === "mutation" ? "POST" : "GET")) return route.continue();
      captured = true;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      observed();
      await held;
      await route.fulfill({ response });
      delivered();
    };
    const routePattern = phase === "mutation" ? "**/admin/registrations/*/approve" : "**/admin/businesses";
    await page.route(routePattern, lateRoute);
    await approve.click();
    await intercepted;
    try {
      await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/login$/);
      await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
      await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible({ timeout: 30_000 });
      const management = await openManagement(businessRow(page, directory, name));
      await management.getByRole("button", { name: "Suspender", exact: true }).click();
      await expect(notice).toHaveText("Negocio actualizado");
    } finally { release(); }
    await delivery;
    // Drain browser frames after delivery before checking the newer session.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(notice).toHaveText("Negocio actualizado");
    await expect(businessRow(page, directory, name).getByText("Suspendido", { exact: true })).toBeVisible();
    await page.unroute(routePattern, lateRoute);
  }
});

test("platform admin saves and reloads global reply waits without guidance controls", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await openAiConfiguration(page);
  const panel = page.getByRole("tabpanel", { name: "Configuración de IA", exact: true });
  await expect(panel.locator("textarea")).toHaveCount(0);
  await expect(panel.getByText(/indicaciones administrativas|instrucciones base/i)).toHaveCount(0);
  const initialWait = page.getByRole("spinbutton", { name: /^Espera inicial \(segundos\)/ });
  const activeWait = page.getByRole("spinbutton", { name: /^Espera activa \(segundos\)/ });
  const reset = page.getByRole("spinbutton", { name: /^Reinicio por inactividad \(segundos\)/ });
  for (const [control, id] of [[initialWait, "platform-initial-help"], [activeWait, "platform-active-help"], [reset, "platform-inactivity-help"]] as const)
    await expect(control).toHaveAttribute("aria-describedby", id);
  await expect(initialWait).toHaveValue("600");
  await expect(activeWait).toHaveValue("90");
  await expect(reset).toHaveValue("3600");
  for (const size of [{ width: 1280, height: 900 }, { width: 900, height: 900 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(size);
    await expectNoHorizontalOverflow(page);
  }
  await initialWait.fill("0");
  await activeWait.fill("23");
  await reset.fill("75");
  await page.getByRole("button", { name: "Guardar configuración", exact: true }).click();
  await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Tiempos guardados");
  await page.reload();
  await openAiConfiguration(page);
  await expect(initialWait).toHaveValue("0");
  await expect(activeWait).toHaveValue("23");
  await expect(reset).toHaveValue("75");
  await reset.fill("0");
  await page.getByRole("button", { name: "Guardar configuración", exact: true }).click();
  expect(await reset.evaluate(input => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  await page.reload();
  await openAiConfiguration(page);
  await expect(reset).toHaveValue("75");
});

test("the redesigned administration screen preserves the real business workflow responsively", async ({ page, system }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  const shell = page.locator('[data-ui="authenticated-shell"][data-variant="admin"]');
  await expect(shell).toHaveCount(1);
  await expect(shell.getByRole("img", { name: "agendIA", exact: true })).toBeVisible();
  const screen = shell.locator('[data-ui="admin-screen"]');
  const heading = screen.getByRole("heading", { level: 1, name: "Administración", exact: true });
  const requests = screen.getByRole("region", { name: "Solicitudes pendientes" });
  const inventory = screen.locator('[data-ui="admin-inventory"]');
  const notice = screen.locator(".admin-feedback").getByRole("status");
  await expect(screen).toHaveCount(1);
  await expect(heading).toBeVisible();
  await expect(heading).toHaveCSS("font-weight", "650");
  await expect(heading).toHaveCSS("font-family", /Source Sans 3/);
  await expectPair(shell.locator(".authenticated-shell__sidebar"), "rgb(18, 55, 42)", "rgb(243, 238, 225)");
  await expectRegistryBrand(shell);
  const asset = await page.request.get(new URL("/brand/logo-inverse-outlined.svg", page.url()).href);
  expect(asset.ok()).toBe(true);
  expect(await asset.text()).toContain('viewBox="0 0 388 120"');

  const tabs = screen.getByRole("tablist", { name: "Espacios de administración", exact: true });
  const businessesTab = tabs.getByRole("tab", { name: "Negocios", exact: true });
  const aiTab = tabs.getByRole("tab", { name: "Configuración de IA", exact: true });
  await expect(tabs.getByRole("tab")).toHaveText(["Negocios", "Configuración de IA"]);
  await expect(businessesTab).toHaveAttribute("aria-selected", "true");
  await expect(businessesTab).toHaveAttribute("aria-controls", "admin-businesses-panel");
  await expect(aiTab).toHaveAttribute("aria-controls", "admin-ai-panel");
  await businessesTab.focus();
  for (const key of ["ArrowRight", "Home", "End", "ArrowLeft"]) {
    await page.keyboard.press(key);
    const aiSelected = key === "ArrowRight" || key === "End";
    await expect(aiSelected ? aiTab : businessesTab).toBeFocused();
    await expect(aiSelected ? aiTab : businessesTab).toHaveAttribute("aria-selected", "true");
    await expect(screen.getByRole("tabpanel", { name: aiSelected ? "Configuración de IA" : "Negocios", exact: true })).toBeVisible();
    await expect(screen.locator(aiSelected ? "#admin-businesses-panel" : "#admin-ai-panel")).toBeHidden();
  }
  await expect(page).toHaveURL(/\/businesses$/);
  await expect(screen.locator('[data-ui="admin-create"]')).toHaveCount(0);
  await expect(screen.getByRole("button", { name: /Nuevo negocio|Crear negocio/ })).toHaveCount(0);
  await expect(requests).toBeVisible();
  await expect(requests.getByText("No hay solicitudes pendientes.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("admin-desktop.png"), fullPage: true });

  const directory = inventory.getByRole("list");
  const emptyDirectory = inventory.getByRole("heading", { name: "Tu primer negocio empieza acá", exact: true });
  await expect(inventory).toBeVisible();
  await expect(directory).toBeEmpty();
  await expect(emptyDirectory).toBeVisible();
  await expect(inventory.getByRole("heading", { name: "Directorio de negocios", exact: true })).toHaveCount(1);
  await expect(inventory.getByLabel("Buscar negocio", { exact: true })).toBeVisible();
  const statusFilter = inventory.getByRole("combobox", { name: "Estado operativo", exact: true });
  await expect(statusFilter).toBeVisible();
  await expect(statusFilter).toHaveValue("all");
  await expect(statusFilter.getByRole("option")).toHaveText(["Todos (0)", "Activos (0)", "Suspendidos (0)"]);
  await expect(screen.locator("a")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: /Eliminar|Ver detalle|Conversaciones?|Métricas?|Dashboard/i })).toHaveCount(0);
  await expect(screen.locator("summary").filter({ hasText: /Eliminar|Ver detalle|Conversaciones?|Métricas?|Dashboard/i })).toHaveCount(0);
  await expect(screen.getByRole("heading", { name: /Métricas?|Dashboard|Total de negocios|Negocios activos|Negocios suspendidos/i })).toHaveCount(0);
  await expect(screen.locator('[data-ui*="metric"], [data-ui*="dashboard"], [data-ui*="total"]')).toHaveCount(0);

  let createRequestCount = 0;
  let observeCreateRequest!: () => void;
  const createRequestObserved = new Promise<void>(resolve => { observeCreateRequest = resolve; });
  let releaseCreateRequest!: () => void;
  const createRequestReleased = new Promise<void>(resolve => { releaseCreateRequest = resolve; });
  const approve = await registerPending(page, tenant.name, tenant.email, tenant.initialPassword);
  await expect(requests.getByText(tenant.email, { exact: false })).toBeVisible();
  await keyboardFocus(page, approve);
  await page.route("**/admin/registrations/*/approve", async route => {
    createRequestCount++;
    observeCreateRequest();
    await createRequestReleased;
    await route.continue();
  });
  await Promise.all([createRequestObserved, approve.click()]);
  try {
    await expect(approve).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("admin-pending.png"), fullPage: true });
  } finally { releaseCreateRequest(); }
  await expect(notice).toHaveText("Solicitud aprobada");
  expect(createRequestCount).toBe(1);
  await expectPair(notice, "rgb(223, 233, 225)", "rgb(18, 55, 42)");
  await expect(directory).toBeVisible();
  await expect(emptyDirectory).toBeHidden();
  await expect(inventory.locator(".admin-directory-heading > span")).toHaveText(["Negocio", "Operación", "Agente", "WhatsApp", "Gestión"]);
  const createdRow = businessRow(page, directory, tenant.name);
  await expect(createdRow).toHaveCount(1);
  await expect(createdRow.getByText(tenant.name, { exact: true })).toBeVisible();
  for (const text of ["Activo", "Inactivo", "Requiere vinculación"])
    await expect(createdRow.getByText(text, { exact: true })).toBeVisible();
  await expect(createdRow.locator(".admin-directory-state")).toHaveCount(3);
  await page.unroute("**/admin/registrations/*/approve");
  await expectPair(createdRow.locator(".admin-status--business-active"), "rgb(223, 233, 225)", "rgb(46, 107, 78)");
  await expectPair(createdRow.locator(".admin-status--agent-inactive"), "rgba(0, 0, 0, 0)", "rgb(76, 91, 83)");
  await expectPair(createdRow.locator(".admin-status--whatsapp-link_required"), "rgba(0, 0, 0, 0)", "rgb(168, 58, 26)");
  await keyboardFocus(page, createdRow.locator("summary"));
  let management = await openManagement(createdRow);
  await expect(management.locator(".admin-technical-details dt")).toHaveText(["Alta · UTC", "Última actividad técnica · UTC"]);
  await expect(management.locator(".admin-technical-details dd")).toHaveCount(2);
  await expect(management.locator(".admin-technical-details dd").first()).not.toHaveText(/Fecha no disponible|^$/);
  await expect(management.getByText("Sin actividad", { exact: true })).toBeVisible();
  await expect(management.locator(".admin-technical-details dd").first()).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(management.getByRole("button", { name: "Renombrar" })).toHaveCount(0);
  await expect(management.getByRole("button", { name: "Cambiar contraseña" })).toHaveCount(0);
  await expect(management.locator('input[name="name"], input[name="password"]')).toHaveCount(0);
  const managedRow = businessRow(page, directory, tenant.name);
  await management.getByRole("button", { name: "Suspender", exact: true }).click();
  await expect(notice).toHaveText("Negocio actualizado");
  await expect(managedRow.getByText("Suspendido", { exact: true })).toBeVisible();
  await expectPair(managedRow.locator(".admin-status--business-suspended"), "rgb(243, 217, 211)", "rgb(168, 58, 26)");
  management = await openManagement(managedRow);
  await expect(management.getByRole("button", { name: "Reactivar", exact: true })).toBeVisible();
  await expect(management.getByRole("button", { name: "Suspender", exact: true })).toHaveCount(0);
  await expect(screen.locator("a")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: /Eliminar|Ver detalle|Conversaciones?|Métricas?|Dashboard|Duplicar|Editar/i })).toHaveCount(0);
  await expect(screen.locator('a[href*="conversation"], a[href*="conversacion"]')).toHaveCount(0);
  for (const locator of [heading, requests, inventory, managedRow, management]) await expectReachable(locator);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectRegistryBrand(shell);
  const mobileRow = businessRow(page, directory, tenant.name);
  const mobileManagement = await openManagement(mobileRow);
  const mobileReactivate = mobileManagement.getByRole("button", { name: "Reactivar", exact: true });
  for (const locator of [heading, requests, inventory, directory, mobileRow, mobileManagement, mobileReactivate]) await expectReachable(locator);
  await expect(directory).toHaveCount(1);
  await expect(mobileRow).toHaveCount(1);
  await expect(mobileRow.locator(".admin-directory-state")).toHaveCount(3);
  await expect(mobileManagement.locator(".admin-technical-details dt")).toHaveText(["Alta · UTC", "Última actividad técnica · UTC"]);
  await expect(mobileManagement.getByText("Sin actividad", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("admin-mobile.png"), fullPage: true });
  await mobileReactivate.click();
  await expect(notice).toHaveText("Negocio actualizado");
  await expect(mobileRow.locator(".admin-status--business-active")).toHaveText("Activo");
  await page.reload();
  await expect(businessRow(page, directory, tenant.name).locator(".admin-status--business-active")).toHaveText("Activo");
});
