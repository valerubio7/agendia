import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { test } from "./support/fixtures.ts";
import { ASSISTANT_STYLE_LIMIT, ASSISTANT_BUSINESS_INSTRUCTIONS_LIMIT } from "../../packages/domain/src/assistant-config.ts";

const tenant = {
  name: "Estudio Voz Propia",
  email: "assistant-redesign@example.test",
  password: "tenant assistant password safe",
};

const values = {
  style: "  \tCálida, resolutiva y atenta a cada consulta.\n\nClaro, cercano y profesional,\n\tsiempre en español rioplatense.\t  ",
  businessInstructions: " \tRespondé con precisión y proponé un próximo paso concreto.\n\nEl estudio acompaña a pequeños negocios de todo el país.\n\tConfirmá disponibilidad antes de prometer una fecha.\nNo inventes precios, horarios ni servicios no informados.\t  ",
};

const fields = [
  ["Estilo de atención", "style"],
  ["Indicaciones del negocio", "businessInstructions"],
] as const;

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

async function expectReachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
}

async function expectPair(locator: Locator, foreground: string, background: string) {
  await expect(locator).toHaveCSS("color", foreground);
  await expect(locator).toHaveCSS("background-color", background);
}

async function expectKeyboardFocus(page: Page, locator: Locator) {
  for (let step = 0; step < 20; step++) {
    await page.keyboard.press("Tab");
    if (await locator.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(locator).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(locator).toBeFocused();
  expect(await locator.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect(locator).toHaveCSS("outline-color", "rgb(168, 58, 26)");
  await expect(locator).toHaveCSS("outline-style", "solid");
}

async function expectOfficialSignalBrand(page: Page, shell: Locator) {
  const header = shell.locator(".assistant-signal__header");
  const wrapper = header.locator(".assistant-signal__brand");
  const image = wrapper.locator("img");
  // First guard must expose the actual missing SVG before testing geometry.
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("src", "/brand/logo-symbol-inverse.svg");
  await expect(wrapper).toHaveAttribute("aria-hidden", "true");
  await expect(image).toHaveAttribute("alt", "");
  await expect(shell.getByRole("img", { name: "agendIA", exact: true })).toHaveCount(1);
  await expect(header).not.toContainText(/agendIA/i);
  await expect(shell.locator(".assistant-signal__core")).toHaveText("IA");
  const asset = await page.context().request.get(new URL("/brand/logo-symbol-inverse.svg", page.url()).href);
  expect(asset.ok()).toBe(true);
  expect(await asset.text()).toMatch(/viewBox="0 0 120 120"/);
  await expect.poll(() => image.evaluate((element) => {
    const img = element as HTMLImageElement;
    // ViewBox coordinates do not prescribe a viewBox-only SVG's natural pixels.
    return img.complete && Number.isFinite(img.naturalWidth) &&
      Number.isFinite(img.naturalHeight) && img.naturalWidth > 0 &&
      img.naturalHeight > 0 && img.naturalWidth === img.naturalHeight;
  })).toBe(true);
  await expect(image).toHaveCSS("object-fit", "contain");
  for (const side of ["top", "right", "bottom", "left"]) {
    await expect(wrapper).toHaveCSS(`padding-${side}`, "22px");
  }
  for (const element of [wrapper, image]) {
    await expect(element).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(element).toHaveCSS("background-image", "none");
    await expect(element).toHaveCSS("box-shadow", "none");
    await expect(element).toHaveCSS("filter", "none");
    await expect(element).toHaveCSS("transform", "none");
    await expect(element).toHaveCSS("opacity", "1");
  }
  await header.scrollIntoViewIfNeeded();
  const bounds = await header.evaluate((element) => {
    const box = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      header: box(element), label: box(element.firstElementChild!),
      wrapper: box(element.querySelector(".assistant-signal__brand")!),
      image: box(element.querySelector("img")!), card: box(element.closest(".assistant-signal")!),
      viewport: { left: 0, right: innerWidth, top: 0, bottom: innerHeight },
    };
  });
  expect(bounds.image.width).toBe(24);
  expect(bounds.image.height).toBe(24);
  expect(bounds.wrapper.width).toBe(68);
  expect(bounds.wrapper.height).toBe(68);
  expect(bounds.wrapper.left - bounds.label.right).toBeGreaterThanOrEqual(16);
  for (const container of [bounds.header, bounds.card, bounds.viewport]) {
    expect(bounds.wrapper.left).toBeGreaterThanOrEqual(container.left);
    expect(bounds.wrapper.right).toBeLessThanOrEqual(container.right);
    expect(bounds.wrapper.top).toBeGreaterThanOrEqual(container.top);
    expect(bounds.wrapper.bottom).toBeLessThanOrEqual(container.bottom);
  }
  console.log("Assistant official symbol bounds", JSON.stringify(bounds));
}

test("assistant save preserves newer activation draft and advances the next revision", async ({ page, system }) => {
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  await page.getByLabel("Nombre", { exact: true }).fill("Asistente concurrente");
  await page.getByLabel("Correo del usuario", { exact: true }).fill("assistant-draft@example.test");
  await page.getByLabel("Contraseña inicial", { exact: true }).fill(tenant.password);
  await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Negocio creado");
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await login(page, system.webUrl, "assistant-draft@example.test", tenant.password);
  await expect(page).toHaveURL(/\/profile$/);
  await page.goto(`${system.webUrl}/assistant`);
  const active = page.getByRole("checkbox", { name: "Respuestas automáticas activas", exact: true });
  await expect(active).not.toBeChecked();
  const submitted: Array<{ active: boolean; expectedRevision: number }> = [];
  let release!: () => void;
  let observed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const mutationObserved = new Promise<void>(resolve => { observed = resolve; });
  await page.route("**/me/assistant", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    submitted.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (submitted.length === 1) {
      observed();
      await held;
    }
    await route.fulfill({ response });
  });
  await active.check();
  await page.getByRole("button", { name: "Guardar y activar", exact: true }).click();
  await mutationObserved;
  try {
    await expect(page.getByRole("button", { name: "Guardando…", exact: true })).toBeDisabled();
    await expect(active).toBeEnabled();
    await active.uncheck();
    await page.getByLabel("Estilo de atención", { exact: true }).fill("Borrador posterior al envío");
  } finally { release(); }
  await expect(page.getByRole("status")).toHaveText("Asistente guardado");
  await expect(active).not.toBeChecked();
  await expect(page.getByText("Pausa pendiente", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Estilo de atención", { exact: true })).toHaveValue("Borrador posterior al envío");
  await page.getByRole("button", { name: "Guardar configuración", exact: true }).click();
  await expect(page.getByRole("button", { name: "Guardar configuración", exact: true })).toBeEnabled();
  expect(submitted).toHaveLength(2);
  expect(submitted[0]!.active).toBe(true);
  expect(submitted[1]).toMatchObject({ active: false, expectedRevision: submitted[0]!.expectedRevision + 1 });
  await page.reload();
  await expect(active).not.toBeChecked();
  await expect(page.getByLabel("Estilo de atención", { exact: true })).toHaveValue("Borrador posterior al envío");
  await page.unroute("**/me/assistant");
  await page.route("**/me/assistant", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 409, json: { code: "CONFLICT" } }) : route.continue());
  await active.check();
  await page.getByRole("button", { name: "Guardar y activar", exact: true }).click();
  await expect(page.locator('[data-ui="assistant-screen"]').getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
  await expect(active).toBeChecked();
  await page.getByRole("button", { name: "Recargar configuración", exact: true }).click();
  await expect(active).not.toBeChecked();
  await page.unroute("**/me/assistant");

  let releaseLate!: () => void;
  let observeLate!: () => void;
  let deliverLate!: () => void;
  const lateHeld = new Promise<void>(resolve => { releaseLate = resolve; });
  const lateObserved = new Promise<void>(resolve => { observeLate = resolve; });
  const lateDelivered = new Promise<void>(resolve => { deliverLate = resolve; });
  await page.route("**/me/assistant", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    observeLate();
    await lateHeld;
    await route.fulfill({ response });
    deliverLate();
  });
  await active.check();
  await page.getByRole("button", { name: "Guardar y activar", exact: true }).click();
  await lateObserved;
  try {
    await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await login(page, system.webUrl, system.admin.email, system.admin.password);
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  } finally { releaseLate(); }
  await lateDelivered;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  await expect(page.locator('[data-ui="admin-screen"]').getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "Asistente concurrente", exact: true })).toBeVisible();
});

test("the redesigned Assistant screen preserves the real configuration workflow responsively", async ({
  browser,
  page,
  system,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);

  await page.getByLabel("Nombre", { exact: true }).fill(tenant.name);
  await page
    .getByLabel("Correo del usuario", { exact: true })
    .fill(tenant.email);
  await page
    .getByLabel("Contraseña inicial", { exact: true })
    .fill(tenant.password);
  await page
    .getByRole("button", { name: "Crear negocio", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: tenant.name, exact: true }),
  ).toBeVisible();

  const tenantContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const tenantPage = await tenantContext.newPage();

  try {
    await login(tenantPage, system.webUrl, tenant.email, tenant.password);
    await expect(tenantPage).toHaveURL(/\/profile$/);
    await tenantPage.goto(`${system.webUrl}/assistant`);
    await expect(tenantPage).toHaveURL(/\/assistant$/);

    const shell = tenantPage.locator(
      '[data-ui="authenticated-shell"][data-variant="business"]',
    );
    await expect(shell).toHaveCount(1);
    await expect(
      shell.getByRole("img", { name: "agendIA", exact: true }),
    ).toBeVisible();
    await expect(
      shell.getByRole("navigation", {
        name: "Navegación del negocio",
        exact: true,
      }),
    ).toBeVisible();

    const screen = shell.locator('[data-ui="assistant-screen"]');
    const hero = screen.locator('[data-ui="assistant-hero"]');
    const activation = screen.locator('[data-ui="assistant-activation"]');
    const savePanel = screen.locator('[data-ui="assistant-save-panel"]');
    await expect(screen).toHaveCount(1);
    await expect(hero).toBeVisible();
    await expect(
      hero.getByText("Dirección del asistente", { exact: true }),
    ).toBeVisible();
    await expect(
      hero.getByRole("heading", {
        level: 1,
        name: "Una voz que suena a tu negocio.",
        exact: true,
      }),
    ).toBeVisible();

    await expectOfficialSignalBrand(tenantPage, shell);

    // Official palette and role weights: assert the genuine hero mismatch first.
    await expectPair(hero, "rgb(243, 238, 225)", "rgb(18, 55, 42)");
    await expect(hero.locator("h1")).toHaveCSS("font-weight", "650");
    await expect(hero.locator("h1")).toHaveCSS("font-family", /Source Sans 3/);
    const eyebrow = hero.locator(".assistant-hero__eyebrow");
    await expect(eyebrow).toHaveCSS("color", "rgb(243, 238, 225)");
    await expect(eyebrow).toHaveCSS("font-family", /Source Sans 3/);
    await expect(eyebrow).toHaveCSS("font-weight", "650");
    const numeric = hero.locator(".assistant-signal__legend span").first();
    await expect(numeric).toHaveCSS("color", "rgb(243, 238, 225)");
    await expect(numeric).toHaveCSS("font-family", /JetBrains Mono/);
    await expect(numeric).toHaveCSS("font-weight", "700");
    await expect(numeric).toHaveCSS("font-variant-numeric", "tabular-nums");

    const sectionHeadings = [
      "Voz y personalidad",
      "Contexto y dirección",
    ] as const;
    const sections: Locator[] = [];
    for (const heading of sectionHeadings) {
      const section = screen.locator("section", {
        has: tenantPage.getByRole("heading", { name: heading, exact: true }),
      });
      sections.push(section);
      await expect(section).toHaveCount(1);
      await expect(
        section.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
    }

    const form = screen.locator("form#assistant-configuration-form");
    await expect(form).toHaveCount(1);
    await expect(activation).toHaveCount(1);
    await expect(savePanel).toHaveCount(1);

    const active = activation.getByRole("checkbox", {
      name: "Respuestas automáticas activas",
      exact: true,
    });
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute("name", "active");
    await expect(active).not.toBeChecked();
    await expect(screen.getByRole("checkbox")).toHaveCount(1);

    await expect(screen.locator("textarea")).toHaveCount(2);
    await expect(form.locator("input, textarea, select, button")).toHaveCount(
      3,
    );
    await expect(form.locator("textarea")).toHaveCount(2);
    await expect(form.locator('input[type="checkbox"]')).toHaveCount(1);
    await expect(
      screen.locator('input:not([type="checkbox"]), select'),
    ).toHaveCount(0);
    await expect(screen.locator('input[type="radio"]')).toHaveCount(0);

    type FieldName = (typeof fields)[number][1];
    const textareas = {} as Record<FieldName, Locator>;
    for (const [label, name] of fields) {
      const field = form.getByLabel(label, { exact: true });
      textareas[name] = field;
      await expect(field).toHaveCount(1);
      await expect(field).toHaveAttribute("name", name);
      await expect(field).toHaveAttribute("maxlength", String(name === "style" ? ASSISTANT_STYLE_LIMIT : ASSISTANT_BUSINESS_INSTRUCTIONS_LIMIT));
      expect(await field.evaluate((element) => element.tagName)).toBe(
        "TEXTAREA",
      );
    }

    for (const section of sections) {
      await expect(section.locator("h2")).toHaveCSS("font-weight", "650");
      await expect(section.locator(".assistant-field__label")).toHaveCSS("font-weight", "650");
      await expect(section.locator(".assistant-field__label")).toHaveCSS("font-family", /Source Sans 3/);
      await expectPair(section.locator("textarea"), "rgb(28, 38, 32)", "rgb(243, 238, 225)");
      await expect(section.locator("textarea")).toHaveCSS("font-family", /JetBrains Mono/);
      await expect(section.locator("textarea")).toHaveCSS("font-weight", "450");
    }

    const save = savePanel.getByRole("button", {
      name: "Guardar configuración",
      exact: true,
    });
    await expect(save).toHaveCount(1);
    await expectPair(save, "rgb(255, 255, 255)", "rgb(168, 58, 26)");
    await expect(save).toHaveCSS("font-weight", "650");
    await expectKeyboardFocus(tenantPage, save);
    await tenantPage.screenshot({ path: testInfo.outputPath("assistant-desktop.png"), fullPage: true });
    await expect(save).toHaveAttribute("type", "submit");
    await expect(save).toHaveAttribute("form", "assistant-configuration-form");
    await expect(form.locator("button")).toHaveCount(0);
    await expect(screen.getByRole("button")).toHaveCount(1);
    await expect(screen.getByRole("link")).toHaveCount(0);
    await expect(
      screen.getByText(
        /Cancelar|Restablecer|Vista previa|Conversaciones|Métricas/i,
      ),
    ).toHaveCount(0);

    await expectNoHorizontalOverflow(tenantPage);
    await expectReachable(hero);
    for (const section of sections) await expectReachable(section);
    await expectReachable(activation);
    await expectReachable(savePanel);

    for (const [, name] of fields) {
      await textareas[name].fill(values[name]);
    }

    let observeSaveRequest!: () => void;
    const saveRequestObserved = new Promise<void>((resolve) => {
      observeSaveRequest = resolve;
    });
    let releaseSaveRequest!: () => void;
    const saveRequestReleased = new Promise<void>((resolve) => {
      releaseSaveRequest = resolve;
    });
    await tenantPage.route("**/me/assistant", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      expect(route.request().postDataJSON()).toMatchObject(values);
      observeSaveRequest();
      await saveRequestReleased;
      await route.continue();
    });

    await active.check();
    const activateAndSave = savePanel.getByRole("button", {
      name: "Guardar y activar",
      exact: true,
    });
    await expect(activateAndSave).toBeEnabled();
    await Promise.all([saveRequestObserved, activateAndSave.click()]);
    try {
      await expect(
        savePanel.getByRole("button", { name: "Guardando…", exact: true }),
      ).toBeDisabled();
      await expectPair(savePanel.getByRole("button", { name: "Guardando…", exact: true }), "rgb(255, 255, 255)", "rgb(168, 58, 26)");
      await expect(form).toHaveAttribute("aria-busy", "true");
    } finally {
      releaseSaveRequest();
    }
    const status = screen.getByRole("status");
    await expect(status).toHaveCount(1);
    await expect(status).toHaveText("Asistente guardado");
    await expectPair(status, "rgb(255, 255, 255)", "rgb(46, 125, 79)");
    await tenantPage.screenshot({ path: testInfo.outputPath("assistant-success.png"), fullPage: true });
    await tenantPage.unroute("**/me/assistant");

    await tenantPage.reload();
    await expect(tenantPage).toHaveURL(/\/assistant$/);
    await expect(
      tenantPage.getByLabel("Estilo de atención", { exact: true }),
    ).toHaveValue(values.style);
    await expect(
      tenantPage.getByLabel("Indicaciones del negocio", { exact: true }),
    ).toHaveValue(values.businessInstructions);
    await expect(
      tenantPage.getByLabel("Respuestas automáticas activas", {
        exact: true,
      }),
    ).toBeChecked();
    await expectNoHorizontalOverflow(tenantPage);

    const staleStyle =
      "Este cambio local no debe sobrevivir al conflicto.";
    let conflictPending = true;
    const conflictRoute = async (route: Route) => {
      if (route.request().method() !== "PUT" || !conflictPending) {
        await route.continue();
        return;
      }
      conflictPending = false;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          code: "CONFLICT",
          message: "Revision conflict",
        }),
      });
    };
    await tenantPage.route("**/me/assistant", conflictRoute);

    await textareas.style.fill(staleStyle);
    await savePanel
      .getByRole("button", { name: "Guardar y activar", exact: true })
      .click();

    const conflictAlert = screen.getByRole("alert");
    await expect(conflictAlert).toHaveCount(1);
    await expect(conflictAlert).toHaveText(
      "Los datos cambiaron. Recargá y volvé a intentar.",
    );
    const reloadConfiguration = screen.getByRole("button", {
      name: "Recargar configuración",
      exact: true,
    });
    await expect(reloadConfiguration).toBeVisible();
    // This mounted conflict is simulated 409 style coverage, not API rejection proof.
    await expectPair(conflictAlert, "rgb(255, 255, 255)", "rgb(179, 58, 31)");
    await expectPair(reloadConfiguration, "rgb(255, 255, 255)", "rgb(46, 107, 78)");
    await expectKeyboardFocus(tenantPage, reloadConfiguration);
    await tenantPage.screenshot({ path: testInfo.outputPath("assistant-conflict.png"), fullPage: true });

    await tenantPage.unroute("**/me/assistant", conflictRoute);
    const refreshedConfiguration = tenantPage.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname.endsWith("/me/assistant") &&
        response.ok(),
    );
    await Promise.all([refreshedConfiguration, reloadConfiguration.click()]);
    await expect(tenantPage).toHaveURL(/\/assistant$/);
    await expect(screen).toBeVisible();
    await expect(textareas.style).toHaveValue(values.style);
    await expect(conflictAlert).toHaveCount(0);
    await expect(reloadConfiguration).toHaveCount(0);
    await expect(screen.getByRole("button")).toHaveCount(1);

    const refreshedStyle = `${values.style} Revisión actualizada.`;
    await textareas.style.fill(refreshedStyle);
    const refreshedSave = savePanel.getByRole("button", {
      name: "Guardar y activar",
      exact: true,
    });
    await expect(refreshedSave).toBeEnabled();
    const refreshedSaveResponse = tenantPage.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname.endsWith("/me/assistant") &&
        response.ok(),
    );
    await Promise.all([refreshedSaveResponse, refreshedSave.click()]);
    await expect(status).toHaveText("Asistente guardado");

    await tenantPage.setViewportSize({ width: 360, height: 800 });
    for (const [, name] of fields) await expectReachable(textareas[name]);
    await expectReachable(activation);
    const mobileSave = savePanel.getByRole("button", {
      name: "Guardar y activar",
      exact: true,
    });
    await expectReachable(mobileSave);
    await expect(mobileSave).toBeEnabled();
    await expectNoHorizontalOverflow(tenantPage);
    await expectOfficialSignalBrand(tenantPage, shell);
    await tenantPage.screenshot({ path: testInfo.outputPath("assistant-mobile.png"), fullPage: true });
  } finally {
    await tenantContext.close();
  }
});
