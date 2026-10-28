import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { login, test } from "./support/fixtures.ts";
import { AGENT_SYSTEM_PROMPT } from "../../packages/domain/src/agent/system-prompt.ts";

const tenant = {
  name: "Estudio Administración Horizonte",
  renamedName: "Estudio Administración Horizonte Sur",
  failedRenameName: "Estudio Administración Horizonte Costero",
  email: "system-admin-ui@example.test",
  initialPassword: "tenant admin ui password safe",
  replacementPassword: "tenant replacement password safe",
};

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectInput(input: Locator, options: {
  name?: string;
  type: "text" | "email" | "password";
  required?: boolean;
  minLength?: string;
  maxLength?: string;
  pattern?: string | RegExp;
}) {
  await expect(input).toBeVisible();
  expect(await input.evaluate(element => ({ tagName: element.tagName, type: (element as HTMLInputElement).type })))
    .toEqual({ tagName: "INPUT", type: options.type });
  if (options.name) await expect(input).toHaveAttribute("name", options.name);
  if (options.required) await expect(input).toHaveAttribute("required", "");
  if (options.minLength) await expect(input).toHaveAttribute("minlength", options.minLength);
  if (options.maxLength) await expect(input).toHaveAttribute("maxlength", options.maxLength);
  if (options.pattern) await expect(input).toHaveAttribute("pattern", options.pattern);
}

function businessRow(page: Page, directory: Locator, name: string) {
  return directory.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
}

async function openCreate(page: Page) {
  const button = page.locator('[aria-controls="admin-create"]');
  await expect(button).toHaveText("Nuevo negocio");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const area = page.locator('[data-ui="admin-create"]');
  await expect(area).toBeVisible();
  await expect(area.getByLabel(/^Nombre/)).toBeFocused();
  return area.locator("form");
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

for (const failedRead of ["businesses", "ai-instructions"]) {
  test(`confirmed admin writes survive failed ${failedRead} refresh with GET-only recovery`, async ({ page, system }) => {
    await login(page, system.webUrl, system.admin.email, system.admin.password);
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
    const create = await openCreate(page);
    const directory = page.locator(".admin-directory");
    const feedback = page.locator(".admin-feedback");
    let currentName = "Negocio confirmado";
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
    for (const action of ["create", "password", "password", "status", "rename", "instructions"] as const) {
      failRefresh = true;
      held = new Promise<void>(resolve => { release = resolve; });
      mutationObserved = new Promise<void>(resolve => { observed = resolve; });
      let secret: Locator | undefined;
      if (action === "create") {
        await create.getByLabel(/^Nombre/).fill(currentName);
        await create.getByLabel("Correo del usuario", { exact: true }).fill("confirmed-admin@example.test");
        secret = create.getByLabel(/^Contraseña inicial/);
        await secret.fill("confirmed initial password");
        await create.getByRole("button", { name: "Crear negocio", exact: true }).click();
      } else if (action === "instructions") {
        await openAiConfiguration(page);
        await page.getByLabel("Indicaciones administrativas complementarias", { exact: true }).fill("Instrucciones confirmadas");
        await page.getByRole("button", { name: "Guardar configuración", exact: true }).click();
      } else {
        const management = await openManagement(businessRow(page, directory, currentName));
        if (action === "password") {
          secret = management.getByLabel(`Nueva contraseña de ${currentName}`);
          await secret.fill("confirmed replacement password");
          await management.getByRole("button", { name: "Cambiar contraseña", exact: true }).click();
        } else if (action === "status") {
          await management.getByRole("button", { name: "Suspender", exact: true }).click();
        } else {
          await management.getByLabel(`Nombre de ${currentName}`, { exact: true }).fill("Negocio renombrado confirmado");
          await management.getByRole("button", { name: "Renombrar", exact: true }).click();
        }
      }
      await mutationObserved;
      // Simulate a newer autofill/input value even while the pending UI disables manual editing.
      const newerSecret = action === "password" && mutationCount === 2;
      if (newerSecret) await secret!.evaluate(node => { (node as HTMLInputElement).value = "newer unsent password"; });
      release();
      await expect(feedback.getByRole("status")).toHaveText(action === "create" ? "Negocio creado" : action === "instructions" ? "Instrucciones guardadas" : "Negocio actualizado");
      const warning = feedback.getByRole("alert");
      await expect(warning).toHaveText("No se pudo actualizar la información. Reintentá solo la consulta.");
      if (action === "rename") currentName = "Negocio renombrado confirmado";
      if (action === "instructions") await page.getByRole("tab", { name: "Negocios", exact: true }).click();
      await expect(businessRow(page, directory, currentName)).toHaveCount(1);
      if (action === "status") await expect(businessRow(page, directory, currentName).getByText("Suspendido", { exact: true })).toBeVisible();
      if (secret) await expect(secret).toHaveValue(newerSecret ? "newer unsent password" : "");
      const writes = mutationCount;
      const reads = readCount;
      failRefresh = false;
      await page.getByRole("button", { name: "Reintentar consulta", exact: true }).click();
      await expect(warning).toHaveCount(0);
      expect(readCount).toBeGreaterThan(reads);
      expect(mutationCount).toBe(writes);
    }
    expect(mutationCount).toBe(6);
    await page.reload();
    await expect(businessRow(page, directory, currentName).getByText("Suspendido", { exact: true })).toBeVisible();
    await openAiConfiguration(page);
    await expect(page.getByLabel("Indicaciones administrativas complementarias", { exact: true })).toHaveValue("Instrucciones confirmadas");
    await page.getByRole("tab", { name: "Negocios", exact: true }).click();
    await page.route("**/admin/businesses/*/user", route => route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } }));
    const management = await openManagement(businessRow(page, directory, currentName));
    const password = management.getByLabel(`Nueva contraseña de ${currentName}`);
    await password.fill("failed replacement password");
    await management.getByRole("button", { name: "Cambiar contraseña", exact: true }).click();
    await expect(management.getByRole("alert")).toContainText("No se pudo cambiar la contraseña");
    await expect(password).toHaveValue("failed replacement password");
    await expect(feedback.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reintentar consulta", exact: true })).toHaveCount(0);
  });
}

test("late admin mutation and refresh responses cannot overwrite a newer session action", async ({ page, system }) => {
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  const directory = page.locator(".admin-directory");
  const notice = page.locator(".admin-feedback").getByRole("status");
  for (const phase of ["mutation", "refresh"] as const) {
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
    const create = await openCreate(page);
    const name = `Negocio sesión ${phase}`;
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
    await page.route("**/admin/businesses", lateRoute);
    await create.getByLabel(/^Nombre/).fill(name);
    await create.getByLabel("Correo del usuario", { exact: true }).fill(`session-${phase}@example.test`);
    await create.getByLabel(/^Contraseña inicial/).fill("late session initial password");
    await create.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await intercepted;
    try {
      await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/login$/);
      await login(page, system.webUrl, system.admin.email, system.admin.password);
      const management = await openManagement(businessRow(page, directory, name));
      await management.getByLabel(`Nombre de ${name}`, { exact: true }).fill(`${name} nuevo`);
      await management.getByRole("button", { name: "Renombrar", exact: true }).click();
      await expect(notice).toHaveText("Negocio actualizado");
    } finally { release(); }
    await delivery;
    // Drain browser frames after delivery before checking the newer session.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(notice).toHaveText("Negocio actualizado");
    await expect(businessRow(page, directory, `${name} nuevo`)).toHaveCount(1);
    await expect(businessRow(page, directory, name)).toHaveCount(0);
    await page.unroute("**/admin/businesses", lateRoute);
  }
});

test("platform admin saves and reloads additions and global reply waits", async ({ page, system }) => {
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  const openInstructions = async () => {
    await openAiConfiguration(page);
    const details = page.locator(".admin-base-instructions");
    await details.locator("summary").click();
    await expect(details).toHaveAttribute("open", "");
  };
  await openInstructions();
  const base = page.getByLabel("Instrucciones base · Solo lectura", { exact: true });
  const notice = page.locator(".admin-feedback").getByRole("status");
  await expect(base).toHaveValue(AGENT_SYSTEM_PROMPT);
  await expect(base).toHaveAttribute("readonly", "");
  await expect(page.getByText("Sistema activo del agente de WhatsApp, de solo lectura. Se modifica únicamente desde el código; no incluye datos de conversaciones.", { exact: true })).toBeVisible();
  await expect(page.getByText("Se envían como contexto complementario, no como instrucciones de sistema. No reemplazan las reglas base ni las herramientas; su cumplimiento no está garantizado.", { exact: true })).toBeVisible();
  const viewport = page.viewportSize()!;
  const hints = page.getByRole("tabpanel", { name: "Configuración de IA", exact: true })
    .locator("#platform-base-help, #platform-additional-help, .admin-pacing > p, .admin-pacing__fields small");
  await expect(hints).toHaveCount(6);
  for (const size of [{ width: 1280, height: 900 }, { width: 900, height: 900 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(size);
    for (const hint of await hints.all()) {
      await expect(hint).toBeVisible();
      expect(await hint.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const container = node.parentElement!.getBoundingClientRect();
        return bounds.width > 0 && node.scrollWidth <= node.clientWidth + 1
          && bounds.left >= container.left && bounds.right <= container.right + 1
          && bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth + 1;
      })).toBe(true);
    }
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize(viewport);
  const additions = page.getByLabel("Indicaciones administrativas complementarias", { exact: true });
  const raw = "  Atención 😀\nSegunda línea  ";
  await additions.fill(raw);
  const initialWait = page.getByRole("spinbutton", { name: /^Espera inicial \(segundos\)/ });
  const activeWait = page.getByRole("spinbutton", { name: /^Espera activa \(segundos\)/ });
  const reset = page.getByRole("spinbutton", { name: /^Reinicio por inactividad \(segundos\)/ });
  for (const [control, id] of [[base, "platform-base-help"], [additions, "platform-additional-help"],
    [initialWait, "platform-initial-help"], [activeWait, "platform-active-help"], [reset, "platform-inactivity-help"]] as const)
    await expect(control).toHaveAttribute("aria-describedby", id);
  await expect(initialWait).toHaveValue("600");
  await expect(activeWait).toHaveValue("90");
  await expect(reset).toHaveValue("3600");
  await initialWait.fill("0");
  await activeWait.fill("23");
  await reset.fill("75");
  await page.getByRole("button", { name: "Guardar configuración", exact: true }).click();
  await expect(notice).toHaveText("Instrucciones guardadas");
  await page.reload();
  await openInstructions();
  await expect(additions).toHaveValue(raw);
  await expect(initialWait).toHaveValue("0");
  await expect(activeWait).toHaveValue("23");
  await expect(reset).toHaveValue("75");
  await expect(base).toHaveValue(AGENT_SYSTEM_PROMPT);
  await expect(base).toHaveAttribute("readonly", "");
  await reset.fill("0");
  await page.getByRole("button", { name: "Guardar configuración", exact: true }).click();
  expect(await reset.evaluate(input => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  await page.reload();
  await openInstructions();
  await expect(reset).toHaveValue("75");
  await expect(additions).toHaveValue(raw);
  // Editing only the supplementary text must retain all numeric controls.
  await additions.fill(`${raw}\nMás instrucciones`);
  await page.getByRole("button", { name: "Guardar configuración", exact: true }).click();
  await expect(notice).toHaveText("Instrucciones guardadas");
  await page.reload();
  await openInstructions();
  await expect(additions).toHaveValue(`${raw}\nMás instrucciones`);
  await expect(base).toHaveValue(AGENT_SYSTEM_PROMPT);
  await expect(initialWait).toHaveValue("0");
  await expect(activeWait).toHaveValue("23");
  await expect(reset).toHaveValue("75");
});

test("the redesigned administration screen preserves the real business workflow responsively", async ({ page, system }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  const shell = page.locator('[data-ui="authenticated-shell"][data-variant="admin"]');
  await expect(shell).toHaveCount(1);
  await expect(shell.getByRole("img", { name: "agendIA", exact: true })).toBeVisible();
  const screen = shell.locator('[data-ui="admin-screen"]');
  const heading = screen.getByRole("heading", { level: 1, name: "Administración", exact: true });
  const createArea = screen.locator('[data-ui="admin-create"]');
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
  await expect(createArea).toBeHidden();
  const createForm = await openCreate(page);
  await expect(createForm).toHaveCount(1);
  await expect(createForm.locator("input")).toHaveCount(3);
  const nameInput = createForm.getByLabel(/^Nombre/);
  const emailInput = createForm.getByLabel("Correo del usuario", { exact: true });
  const passwordInput = createForm.getByLabel(/^Contraseña inicial/);
  await expectInput(nameInput, { name: "name", type: "text", required: true, maxLength: "160", pattern: /.+/ });
  const namePattern = await nameInput.getAttribute("pattern");
  expect(namePattern).not.toBeNull();
  await expectInput(emailInput, { name: "userEmail", type: "email", required: true });
  await expectInput(passwordInput, { name: "initialPassword", type: "password", required: true, minLength: "16" });
  const createButton = createForm.getByRole("button", { name: "Crear negocio", exact: true });
  await expect(createForm.getByRole("button")).toHaveCount(1);
  await expectPair(createButton, "rgb(46, 107, 78)", "rgb(255, 255, 255)");
  await expect(nameInput).toHaveCSS("font-family", /Source Sans 3/);
  await expect(nameInput).toHaveCSS("font-weight", "450");
  await keyboardFocus(page, nameInput);
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
  await page.route("**/admin/businesses", async route => {
    if (route.request().method() !== "POST") return route.continue();
    createRequestCount++;
    observeCreateRequest();
    await createRequestReleased;
    await route.continue();
  });
  await nameInput.fill("   ");
  await emailInput.fill(tenant.email);
  await passwordInput.fill(tenant.initialPassword);
  const whitespaceNameValidity = await nameInput.evaluate(element => ({
    valid: (element as HTMLInputElement).checkValidity(), validationMessage: (element as HTMLInputElement).validationMessage,
  }));
  expect(whitespaceNameValidity.valid).toBe(false);
  expect(whitespaceNameValidity.validationMessage).not.toBe("");
  await createButton.click();
  expect(createRequestCount).toBe(0);
  await nameInput.fill(tenant.name);
  expect(await nameInput.evaluate(element => (element as HTMLInputElement).checkValidity())).toBe(true);
  await Promise.all([createRequestObserved, createButton.click()]);
  try {
    const pending = createForm.getByRole("button", { name: "Creando…", exact: true });
    await expect(pending).toBeDisabled();
    await expect(createForm).toHaveAttribute("aria-busy", "true");
    await expectPair(pending, "rgb(46, 107, 78)", "rgb(255, 255, 255)");
    await page.screenshot({ path: testInfo.outputPath("admin-pending.png"), fullPage: true });
  } finally { releaseCreateRequest(); }
  await expect(notice).toHaveText("Negocio creado");
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
  await page.unroute("**/admin/businesses");
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
  const renameInput = management.getByLabel(`Nombre de ${tenant.name}`, { exact: true });
  await expectInput(renameInput, { type: "text", maxLength: "160", pattern: namePattern! });
  await renameInput.fill(tenant.renamedName);
  const [renameRequest] = await Promise.all([
    page.waitForRequest(request => request.method() === "PUT" && /\/admin\/businesses\/[^/]+$/.test(new URL(request.url()).pathname)),
    management.getByRole("button", { name: "Renombrar", exact: true }).click(),
  ]);
  await expect(notice).toHaveText("Negocio actualizado");
  let managedRow = businessRow(page, directory, tenant.renamedName);
  await expect(managedRow).toHaveCount(1);
  await expect(managedRow.getByText(tenant.renamedName, { exact: true })).toBeVisible();
  await expect(directory.getByText(tenant.name, { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(screen).toBeVisible();
  await expect(notice).toHaveCount(0);
  managedRow = businessRow(page, directory, tenant.renamedName);
  management = await openManagement(managedRow);
  const failedRenameInput = management.getByLabel(`Nombre de ${tenant.renamedName}`, { exact: true });
  await expectInput(failedRenameInput, { type: "text", maxLength: "160", pattern: namePattern! });
  let renameFailurePending = true;
  const failedRenameRoute = async (route: Route) => {
    if (route.request().method() !== "PUT" || !renameFailurePending) return route.continue();
    renameFailurePending = false;
    await route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR", message: "Internal error" } });
  };
  await page.route(renameRequest.url(), failedRenameRoute);
  try {
    await failedRenameInput.fill(tenant.failedRenameName);
    await management.getByRole("button", { name: "Renombrar", exact: true }).click();
    const rowAlert = management.getByRole("alert");
    await expect(rowAlert).toHaveCount(1);
    await expect(rowAlert).toContainText(tenant.renamedName);
    await expect(rowAlert).toContainText("No se pudo completar la operación.");
    await expect(screen.getByRole("alert")).toHaveCount(1);
    await expect(screen.locator(".admin-feedback").getByRole("alert")).toHaveCount(0);
    await expect(failedRenameInput).toHaveValue(tenant.failedRenameName);
    await expect(managedRow.locator(".admin-business-name")).toHaveText(tenant.renamedName);
    await expectPair(rowAlert, "rgb(243, 217, 211)", "rgb(168, 58, 26)");
    await expect(rowAlert.locator("strong")).toHaveCSS("color", "rgb(168, 58, 26)");
    await page.screenshot({ path: testInfo.outputPath("admin-mocked-error.png"), fullPage: true });
  } finally { await page.unroute(renameRequest.url(), failedRenameRoute); }
  await failedRenameInput.fill(tenant.renamedName);
  const replacementPassword = management.getByLabel(`Nueva contraseña de ${tenant.renamedName}`);
  await expectInput(replacementPassword, { type: "password", minLength: "16" });
  await replacementPassword.fill(tenant.replacementPassword);
  await management.getByRole("button", { name: "Cambiar contraseña", exact: true }).click();
  await expect(notice).toHaveText("Negocio actualizado");
  await page.reload();
  await expect(screen).toBeVisible();
  await expect(notice).toHaveCount(0);
  managedRow = businessRow(page, directory, tenant.renamedName);
  management = await openManagement(managedRow);
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
  // Reload closes the create disclosure; reopen it before checking responsive reachability.
  await openCreate(page);
  for (const locator of [heading, createArea, inventory, managedRow, management]) await expectReachable(locator);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await expectRegistryBrand(shell);
  const mobileRow = businessRow(page, directory, tenant.renamedName);
  const mobileManagement = await openManagement(mobileRow);
  const mobileReactivate = mobileManagement.getByRole("button", { name: "Reactivar", exact: true });
  for (const locator of [heading, createArea, inventory, directory, mobileRow, mobileManagement,
    mobileManagement.getByRole("button", { name: "Renombrar", exact: true }),
    mobileManagement.getByRole("button", { name: "Cambiar contraseña", exact: true }), mobileReactivate]) await expectReachable(locator);
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
  await expect(businessRow(page, directory, tenant.renamedName).locator(".admin-status--business-active")).toHaveText("Activo");
});
