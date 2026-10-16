import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { test } from "./support/fixtures.ts";
import { RECEPTIONIST_SYSTEM_INSTRUCTIONS } from "../../packages/domain/src/receptionist-instructions.ts";

const tenant = {
  name: "Estudio Administración Horizonte",
  renamedName: "Estudio Administración Horizonte Sur",
  failedRenameName: "Estudio Administración Horizonte Costero",
  email: "system-admin-ui@example.test",
  initialPassword: "tenant admin ui password safe",
  replacementPassword: "tenant replacement password safe",
};

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

async function expectInput(
  input: Locator,
  options: {
    name?: string;
    type: "text" | "email" | "password";
    required?: boolean;
    minLength?: string;
    maxLength?: string;
    pattern?: string | RegExp;
  },
) {
  await expect(input).toBeVisible();
  expect(
    await input.evaluate((element) => ({
      tagName: element.tagName,
      type: (element as HTMLInputElement).type,
    })),
  ).toEqual({ tagName: "INPUT", type: options.type });
  if (options.name) await expect(input).toHaveAttribute("name", options.name);
  if (options.required) await expect(input).toHaveAttribute("required", "");
  if (options.minLength)
    await expect(input).toHaveAttribute("minlength", options.minLength);
  if (options.maxLength)
    await expect(input).toHaveAttribute("maxlength", options.maxLength);
  if (options.pattern)
    await expect(input).toHaveAttribute("pattern", options.pattern);
}

function businessRow(page: Page, table: Locator, name: string) {
  return table.getByRole("row").filter({
    has: page.getByText(name, { exact: true }),
  });
}

async function openManagement(row: Locator) {
  const details = row.locator("details");
  const summary = details.locator("summary");

  await expect(details).toHaveCount(1);
  await expect(summary).toHaveText("Gestionar");
  expect(await details.evaluate((element) => element.tagName)).toBe("DETAILS");
  expect(await summary.evaluate((element) => element.tagName)).toBe("SUMMARY");

  if (
    !(await details.evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await summary.click();
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
    if (await locator.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(locator).toBeFocused();
  expect(await locator.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(locator).toBeFocused();
  await expect(locator).toHaveCSS("outline-color", "rgb(168, 58, 26)");
  await expect(locator).toHaveCSS("outline-style", "solid");
}

async function expectRegistryBrand(hero: Locator) {
  const image = hero.locator('.admin-registry-map__brand img');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("src", "/brand/logo-symbol-inverse.svg");
  await expect(image).toHaveAttribute("alt", "");
  await expect(hero.locator('.admin-registry-map__brand')).toHaveAttribute("aria-hidden", "true");
  await expect(hero.getByRole("img")).toHaveCount(0);
  await expect.poll(() => image.evaluate((element) => {
    const img = element as HTMLImageElement;
    return img.complete && Number.isFinite(img.naturalWidth) && img.naturalWidth > 0 &&
      Number.isFinite(img.naturalHeight) && img.naturalHeight > 0 && img.naturalWidth === img.naturalHeight;
  })).toBe(true);
  const bounds = await image.evaluate((element) => {
    const wrapper = element.parentElement!;
    const header = wrapper.parentElement!;
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const clipped: string[] = [];
    const outer = rect(wrapper);
    for (let ancestor = header; ancestor; ancestor = ancestor.parentElement!) {
      const css = getComputedStyle(ancestor), r = rect(ancestor);
      if ((/hidden|clip|auto|scroll/.test(css.overflowX) && (outer.left < r.left || outer.right > r.right)) ||
          (/hidden|clip|auto|scroll/.test(css.overflowY) && (outer.top < r.top || outer.bottom > r.bottom))) clipped.push(ancestor.tagName);
    }
    return { image: rect(element), wrapper: outer, header: rect(header), label: rect(header.firstElementChild!), clipped,
      padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map(key => getComputedStyle(wrapper).getPropertyValue(key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`))) };
  });
  expect([bounds.image.width, bounds.image.height, bounds.wrapper.width, bounds.wrapper.height]).toEqual([24, 24, 68, 68]);
  expect(bounds.padding).toEqual(["22px", "22px", "22px", "22px"]);
  expect(bounds.wrapper.left - bounds.label.right).toBeGreaterThanOrEqual(16);
  expect(bounds.wrapper.left).toBeGreaterThanOrEqual(bounds.header.left);
  expect(bounds.wrapper.right).toBeLessThanOrEqual(bounds.header.right);
  expect(bounds.wrapper.top).toBeGreaterThanOrEqual(bounds.header.top);
  expect(bounds.wrapper.bottom).toBeLessThanOrEqual(bounds.header.bottom);
  expect(bounds.clipped).toEqual([]);
  for (const node of [image, hero.locator('.admin-registry-map__brand')]) {
    for (const property of ["filter", "box-shadow", "transform"]) await expect(node).toHaveCSS(property, "none");
  }
  console.log("Admin registry bounds", JSON.stringify(bounds));
}

for (const failedRead of ["businesses", "ai-instructions"]) {
  test(`confirmed admin writes survive failed ${failedRead} refresh with GET-only recovery`, async ({ page, system }) => {
    await login(page, system.webUrl, system.admin.email, system.admin.password);
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
    const create = page.locator('[data-ui="admin-create"] form');
    const table = page.getByRole("table");
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
        await create.getByLabel("Nombre", { exact: true }).fill(currentName);
        await create.getByLabel("Correo del usuario", { exact: true }).fill("confirmed-admin@example.test");
        secret = create.getByLabel("Contraseña inicial", { exact: true });
        await secret.fill("confirmed initial password");
        await create.getByRole("button", { name: "Crear negocio", exact: true }).click();
      } else if (action === "instructions") {
        await page.getByLabel("Indicaciones administrativas complementarias", { exact: true }).fill("Instrucciones confirmadas");
        await page.getByRole("button", { name: "Guardar", exact: true }).click();
      } else {
        const management = await openManagement(businessRow(page, table, currentName));
        if (action === "password") {
          secret = management.getByLabel(`Nueva contraseña de ${currentName}`, { exact: true });
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
      await expect(page.getByRole("status")).toHaveText(action === "create" ? "Negocio creado" : action === "instructions" ? "Instrucciones guardadas" : "Negocio actualizado");
      const warning = page.locator('[data-ui="admin-screen"]').getByRole("alert");
      await expect(warning).toHaveText("No se pudo actualizar la información. Reintentá solo la consulta.");
      if (action === "rename") currentName = "Negocio renombrado confirmado";
      await expect(businessRow(page, table, currentName)).toHaveCount(1);
      if (action === "status") await expect(businessRow(page, table, currentName).getByRole("cell", { name: "Suspendido", exact: true })).toBeVisible();
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
    await expect(businessRow(page, table, currentName).getByRole("cell", { name: "Suspendido", exact: true })).toBeVisible();
    await expect(page.getByLabel("Indicaciones administrativas complementarias", { exact: true })).toHaveValue("Instrucciones confirmadas");
    await page.route("**/admin/businesses/*/user", route => route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } }));
    const management = await openManagement(businessRow(page, table, currentName));
    const password = management.getByLabel(`Nueva contraseña de ${currentName}`, { exact: true });
    await password.fill("failed replacement password");
    await management.getByRole("button", { name: "Cambiar contraseña", exact: true }).click();
    await expect(management.getByRole("alert")).toContainText("No se pudo cambiar la contraseña");
    await expect(password).toHaveValue("failed replacement password");
    await expect(page.locator(".admin-feedback").getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reintentar consulta", exact: true })).toHaveCount(0);
  });
}

test("late admin mutation and refresh responses cannot overwrite a newer session action", async ({ page, system }) => {
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  for (const phase of ["mutation", "refresh"] as const) {
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
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
    await page.getByLabel("Nombre", { exact: true }).fill(name);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(`session-${phase}@example.test`);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill("late session initial password");
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await intercepted;
    try {
      await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
      await expect(page).toHaveURL(/\/$/);
      await login(page, system.webUrl, system.admin.email, system.admin.password);
      const row = businessRow(page, page.getByRole("table"), name);
      const management = await openManagement(row);
      await management.getByLabel(`Nombre de ${name}`, { exact: true }).fill(`${name} nuevo`);
      await management.getByRole("button", { name: "Renombrar", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("Negocio actualizado");
    } finally { release(); }
    await delivery;
    // Drain browser frames after delivery before checking the newer session.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("status")).toHaveText("Negocio actualizado");
    await expect(businessRow(page, page.getByRole("table"), `${name} nuevo`)).toHaveCount(1);
    await expect(businessRow(page, page.getByRole("table"), name)).toHaveCount(0);
    await page.unroute("**/admin/businesses", lateRoute);
  }
});

test("platform admin saves and reloads additions and global reply waits", async ({ page, system }) => {
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  const base = page.getByLabel("Instrucciones base del recepcionista", { exact: true });
  await expect(base).toHaveValue(RECEPTIONIST_SYSTEM_INSTRUCTIONS);
  await expect(base).toHaveAttribute("readonly", "");
  await expect(page.getByText("Sistema activo del recepcionista de WhatsApp, de solo lectura. Se modifica únicamente desde el código; no incluye datos de conversaciones.", { exact: true })).toBeVisible();
  await expect(page.getByText("Se envían como contexto complementario, no como instrucciones de sistema. No reemplazan las reglas base ni las herramientas; su cumplimiento no está garantizado.", { exact: true })).toBeVisible();
  const viewport = page.viewportSize()!;
  const hints = page.getByRole("region", { name: "Instrucciones de IA de la plataforma", exact: true }).locator("form > p");
  await expect(hints).toHaveCount(6);
  for (const size of [{ width: 1280, height: 900 }, { width: 900, height: 900 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(size);
    for (const hint of await hints.all()) {
      await expect(hint).toBeVisible();
      expect(await hint.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const form = node.parentElement!.getBoundingClientRect();
        return bounds.width > 0 && Math.abs(bounds.width - form.width) < 1
          && bounds.left >= form.left && bounds.right <= form.right;
      })).toBe(true);
    }
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize(viewport);
  const additions = page.getByLabel("Indicaciones administrativas complementarias", { exact: true });
  const raw = "  Atención 😀\nSegunda línea  ";
  await additions.fill(raw);
  const initialWait = page.getByLabel("Espera inicial (segundos)", { exact: true });
  const activeWait = page.getByLabel("Espera activa (segundos)", { exact: true });
  const reset = page.getByLabel("Reinicio por inactividad (segundos)", { exact: true });
  await expect(initialWait).toHaveValue("600");
  await expect(activeWait).toHaveValue("90");
  await expect(reset).toHaveValue("3600");
  await initialWait.fill("0");
  await activeWait.fill("23");
  await reset.fill("75");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Instrucciones guardadas");
  await page.reload();
  await expect(additions).toHaveValue(raw);
  await expect(initialWait).toHaveValue("0");
  await expect(activeWait).toHaveValue("23");
  await expect(reset).toHaveValue("75");
  await expect(base).toHaveValue(RECEPTIONIST_SYSTEM_INSTRUCTIONS);
  await expect(base).toHaveAttribute("readonly", "");
  await reset.fill("0");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  expect(await reset.evaluate(input => (input as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  await page.reload();
  await expect(reset).toHaveValue("75");
  await expect(additions).toHaveValue(raw);
  // Editing only the supplementary text must retain all numeric controls.
  await additions.fill(`${raw}\nMás instrucciones`);
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Instrucciones guardadas");
  await page.reload();
  await expect(additions).toHaveValue(`${raw}\nMás instrucciones`);
  await expect(base).toHaveValue(RECEPTIONIST_SYSTEM_INSTRUCTIONS);
  await expect(initialWait).toHaveValue("0");
  await expect(activeWait).toHaveValue("23");
  await expect(reset).toHaveValue("75");
});

test("the redesigned administration screen preserves the real business workflow responsively", async ({
  page,
  system,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);

  const shell = page.locator(
    '[data-ui="authenticated-shell"][data-variant="admin"]',
  );
  await expect(shell).toHaveCount(1);
  await expect(
    shell.getByRole("img", { name: "agendIA", exact: true }),
  ).toBeVisible();

  const navigation = shell.getByRole("navigation", {
    name: "Navegación administrativa",
    exact: true,
  });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link")).toHaveText(["Negocios"]);
  await expect(
    navigation.getByRole("link", { name: "Negocios", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  const screen = shell.locator('[data-ui="admin-screen"]');
  const hero = screen.locator('[data-ui="admin-hero"]');
  const createArea = screen.locator('[data-ui="admin-create"]');
  const inventory = screen.locator('[data-ui="admin-inventory"]');
  await expect(screen).toHaveCount(1);
  await expect(hero).toBeVisible();
  await expectPair(hero, "rgb(18, 55, 42)", "rgb(243, 238, 225)");
  await expectRegistryBrand(hero);
  const asset = await page.request.get(new URL("/brand/logo-symbol-inverse.svg", page.url()).href);
  expect(asset.ok()).toBe(true);
  expect(await asset.text()).toContain('viewBox="0 0 120 120"');
  await expect(hero.locator("h1")).toHaveCSS("font-weight", "650");
  await expect(hero.locator("h1")).toHaveCSS("font-family", /Source Sans 3/);
  await expect(hero.locator("header")).toHaveCSS("font-weight", "700");
  await expect(
    hero.getByText("Operación de plataforma", { exact: true }),
  ).toBeVisible();
  await expect(
    hero.getByRole("heading", {
      level: 1,
      name: "Cada negocio, bajo control.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(createArea).toBeVisible();
  await expect(inventory).toBeVisible();

  const createForm = createArea.locator("form");
  await expect(createForm).toHaveCount(1);
  await expect(createForm.locator("input")).toHaveCount(3);
  const nameInput = createForm.getByLabel("Nombre", { exact: true });
  const emailInput = createForm.getByLabel("Correo del usuario", {
    exact: true,
  });
  const passwordInput = createForm.getByLabel("Contraseña inicial", {
    exact: true,
  });
  await expectInput(nameInput, {
    name: "name",
    type: "text",
    required: true,
    maxLength: "160",
    pattern: /.+/,
  });
  const namePattern = await nameInput.getAttribute("pattern");
  expect(namePattern).not.toBeNull();
  await expectInput(emailInput, {
    name: "userEmail",
    type: "email",
    required: true,
  });
  await expectInput(passwordInput, {
    name: "initialPassword",
    type: "password",
    required: true,
    minLength: "16",
  });

  const createButton = createForm.getByRole("button", {
    name: "Crear negocio",
    exact: true,
  });
  await expect(createForm.getByRole("button")).toHaveCount(1);
  await expectPair(createButton, "rgb(168, 58, 26)", "rgb(255, 255, 255)");
  await expect(nameInput).toHaveCSS("font-family", /JetBrains Mono/);
  await expect(nameInput).toHaveCSS("font-weight", "450");
  await keyboardFocus(page, nameInput);
  await page.screenshot({ path: testInfo.outputPath("admin-desktop.png"), fullPage: true });

  const table = inventory.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText([
    "Negocio",
    "Operación",
    "Asistente",
    "WhatsApp",
    "Alta",
    "Última actividad técnica",
    "Gestión",
  ]);

  await expect(screen.locator("a")).toHaveCount(0);
  await expect(
    screen.getByRole("button", {
      name: /Eliminar|Ver detalle|Conversaciones?|Métricas?|Dashboard/i,
    }),
  ).toHaveCount(0);
  await expect(
    screen.locator("summary").filter({
      hasText: /Eliminar|Ver detalle|Conversaciones?|Métricas?|Dashboard/i,
    }),
  ).toHaveCount(0);
  await expect(
    screen.getByRole("heading", {
      name: /Métricas?|Dashboard|Total de negocios|Negocios activos|Negocios suspendidos/i,
    }),
  ).toHaveCount(0);
  await expect(
    screen.locator(
      '[data-ui*="metric"], [data-ui*="dashboard"], [data-ui*="total"]',
    ),
  ).toHaveCount(0);

  let createRequestCount = 0;
  let observeCreateRequest!: () => void;
  const createRequestObserved = new Promise<void>((resolve) => {
    observeCreateRequest = resolve;
  });
  let releaseCreateRequest!: () => void;
  const createRequestReleased = new Promise<void>((resolve) => {
    releaseCreateRequest = resolve;
  });
  await page.route("**/admin/businesses", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    createRequestCount += 1;
    observeCreateRequest();
    await createRequestReleased;
    await route.continue();
  });

  await nameInput.fill("   ");
  await emailInput.fill(tenant.email);
  await passwordInput.fill(tenant.initialPassword);
  const whitespaceNameValidity = await nameInput.evaluate((element) => ({
    valid: (element as HTMLInputElement).checkValidity(),
    validationMessage: (element as HTMLInputElement).validationMessage,
  }));
  expect(whitespaceNameValidity.valid).toBe(false);
  expect(whitespaceNameValidity.validationMessage).not.toBe("");
  await createButton.click();
  expect(createRequestCount).toBe(0);

  await nameInput.fill(tenant.name);
  expect(
    await nameInput.evaluate((element) =>
      (element as HTMLInputElement).checkValidity(),
    ),
  ).toBe(true);
  await Promise.all([createRequestObserved, createButton.click()]);
  try {
    await expect(
      createForm.getByRole("button", { name: "Creando…", exact: true }),
    ).toBeDisabled();
    await expect(createForm).toHaveAttribute("aria-busy", "true");
    await expectPair(createForm.getByRole("button", { name: "Creando…", exact: true }), "rgb(168, 58, 26)", "rgb(255, 255, 255)");
    await page.screenshot({ path: testInfo.outputPath("admin-pending.png"), fullPage: true });
  } finally {
    releaseCreateRequest();
  }

  await expect(screen.getByRole("status")).toHaveText("Negocio creado");
  await expectPair(screen.getByRole("status"), "rgb(46, 125, 79)", "rgb(255, 255, 255)");
  const createdRow = businessRow(page, table, tenant.name);
  await expect(createdRow).toHaveCount(1);
  await expect(
    createdRow.getByRole("cell", { name: tenant.name, exact: true }),
  ).toBeVisible();
  await expect(
    createdRow.getByRole("cell", { name: "Activo", exact: true }),
  ).toBeVisible();
  await expect(
    createdRow.getByRole("cell", { name: "Inactivo", exact: true }),
  ).toBeVisible();
  await expect(
    createdRow.getByRole("cell", {
      name: "Requiere vinculación",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    createdRow.getByRole("cell", { name: "Sin actividad", exact: true }),
  ).toBeVisible();
  await expect(createdRow.getByRole("cell")).toHaveCount(7);
  await page.unroute("**/admin/businesses");

  await expectPair(createdRow.locator(".admin-status--business-active"), "rgb(46, 125, 79)", "rgb(255, 255, 255)");
  await expectPair(createdRow.locator(".admin-status--assistant-inactive"), "rgb(243, 238, 225)", "rgb(76, 91, 83)");
  await expectPair(createdRow.locator(".admin-status--whatsapp-link_required"), "rgb(233, 180, 76)", "rgb(28, 38, 32)");
  await expect(createdRow.locator(".admin-timestamp").first()).toHaveCSS("font-weight", "450");
  await keyboardFocus(page, createdRow.locator("summary"));
  let management = await openManagement(createdRow);
  const renameInput = management.getByLabel(`Nombre de ${tenant.name}`, {
    exact: true,
  });
  await expectInput(renameInput, {
    type: "text",
    maxLength: "160",
    pattern: namePattern!,
  });
  await renameInput.fill(tenant.renamedName);
  const [renameRequest] = await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === "PUT" &&
        /\/admin\/businesses\/[^/]+$/.test(new URL(request.url()).pathname),
    ),
    management.getByRole("button", { name: "Renombrar", exact: true }).click(),
  ]);
  await expect(screen.getByRole("status")).toHaveText("Negocio actualizado");

  let managedRow = businessRow(page, table, tenant.renamedName);
  await expect(managedRow).toHaveCount(1);
  await expect(
    managedRow.getByRole("cell", { name: tenant.renamedName, exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("cell", { name: tenant.name, exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("status")).toHaveCount(0);
  managedRow = businessRow(page, table, tenant.renamedName);
  management = await openManagement(managedRow);

  const failedRenameInput = management.getByLabel(
    `Nombre de ${tenant.renamedName}`,
    { exact: true },
  );
  await expectInput(failedRenameInput, {
    type: "text",
    maxLength: "160",
    pattern: namePattern!,
  });
  let renameFailurePending = true;
  const failedRenameRoute = async (route: Route) => {
    if (route.request().method() !== "PUT" || !renameFailurePending) {
      await route.continue();
      return;
    }
    renameFailurePending = false;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INTERNAL_ERROR",
        message: "Internal error",
      }),
    });
  };
  await page.route(renameRequest.url(), failedRenameRoute);

  try {
  await failedRenameInput.fill(tenant.failedRenameName);
  await management
    .getByRole("button", { name: "Renombrar", exact: true })
    .click();

  const rowAlert = management.getByRole("alert");
  await expect(rowAlert).toHaveCount(1);
  await expect(rowAlert).toContainText(tenant.renamedName);
  await expect(rowAlert).toContainText("No se pudo completar la operación.");
  await expect(screen.getByRole("alert")).toHaveCount(1);
  await expect(
    screen.locator(".admin-feedback").getByRole("alert"),
  ).toHaveCount(0);
  await expect(failedRenameInput).toHaveValue(tenant.failedRenameName);

  await expectPair(rowAlert, "rgb(179, 58, 31)", "rgb(255, 255, 255)");
  await expect(rowAlert.locator("strong")).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.screenshot({ path: testInfo.outputPath("admin-mocked-error.png"), fullPage: true });
  } finally {
    await page.unroute(renameRequest.url(), failedRenameRoute);
  }
  await failedRenameInput.fill(tenant.renamedName);

  const replacementPassword = management.getByLabel(
    `Nueva contraseña de ${tenant.renamedName}`,
    { exact: true },
  );
  await expectInput(replacementPassword, {
    type: "password",
    minLength: "16",
  });
  await replacementPassword.fill(tenant.replacementPassword);
  await management
    .getByRole("button", { name: "Cambiar contraseña", exact: true })
    .click();
  await expect(screen.getByRole("status")).toHaveText("Negocio actualizado");

  await page.reload();
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("status")).toHaveCount(0);
  managedRow = businessRow(page, table, tenant.renamedName);
  management = await openManagement(managedRow);
  await management
    .getByRole("button", { name: "Suspender", exact: true })
    .click();
  await expect(screen.getByRole("status")).toHaveText("Negocio actualizado");
  await expect(
    managedRow.getByRole("cell", { name: "Suspendido", exact: true }),
  ).toBeVisible();

  await expectPair(managedRow.locator(".admin-status--business-suspended"), "rgb(179, 58, 31)", "rgb(255, 255, 255)");
  management = await openManagement(managedRow);
  const reactivate = management.getByRole("button", {
    name: "Reactivar",
    exact: true,
  });
  await expect(reactivate).toBeVisible();
  await expect(
    management.getByRole("button", { name: "Suspender", exact: true }),
  ).toHaveCount(0);

  await expect(screen.locator("a")).toHaveCount(0);
  await expect(
    screen.getByRole("button", {
      name: /Eliminar|Ver detalle|Conversaciones?|Métricas?|Dashboard|Duplicar|Editar/i,
    }),
  ).toHaveCount(0);
  await expect(
    screen.locator('a[href*="conversation"], a[href*="conversacion"]'),
  ).toHaveCount(0);

  for (const locator of [hero, createArea, inventory, managedRow, management])
    await expectReachable(locator);
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ width: 360, height: 800 });
  await expectRegistryBrand(hero);
  const mobileTable = inventory.getByRole("table");
  const mobileRow = businessRow(page, mobileTable, tenant.renamedName);
  const mobileManagement = await openManagement(mobileRow);
  const mobileRename = mobileManagement.getByRole("button", {
    name: "Renombrar",
    exact: true,
  });
  const mobilePassword = mobileManagement.getByRole("button", {
    name: "Cambiar contraseña",
    exact: true,
  });
  const mobileReactivate = mobileManagement.getByRole("button", {
    name: "Reactivar",
    exact: true,
  });

  for (const locator of [
    hero,
    createArea,
    inventory,
    mobileTable,
    mobileRow,
    mobileManagement,
    mobileRename,
    mobilePassword,
    mobileReactivate,
  ])
    await expectReachable(locator);
  await expect(mobileTable).toHaveCount(1);
  await expect(mobileTable.getByRole("columnheader")).toHaveCount(7);
  await expect(mobileRow).toHaveCount(1);
  await expect(mobileRow.getByRole("cell")).toHaveCount(7);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("admin-mobile.png"), fullPage: true });
});
