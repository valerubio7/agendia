import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";
import { AGENT_STYLE_LIMIT, AGENT_BUSINESS_INSTRUCTIONS_LIMIT } from "../../packages/domain/src/agent/config.ts";

const tenant = {
  name: "Estudio Voz Propia",
  email: "agent-redesign@example.test",
  password: "tenant agent password safe",
};

const values = {
  style: "  \tCálida, resolutiva y atenta a cada consulta.\n\nClaro, cercano y profesional,\n\tsiempre en español rioplatense.\t  ",
  businessInstructions: " \tRespondé con precisión y proponé un próximo paso concreto.\n\nEl estudio acompaña a pequeños negocios de todo el país.\n\tConfirmá disponibilidad antes de prometer una fecha.\nNo inventes precios, horarios ni servicios no informados.\t  ",
};

const fields = [
  ["Estilo de atención", "style"],
  ["Indicaciones del negocio", "businessInstructions"],
] as const;

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
  expect(await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
  })).toBe(true);
}

test("agent save preserves newer activation draft and advances the next revision", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  await createBusinessInAdminUi(page, {
    name: "Agente concurrente", email: "agent-draft@example.test", password: tenant.password,
  });
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await login(page, system.webUrl, "agent-draft@example.test", tenant.password);
  await expect(page).toHaveURL(/\/profile$/);
  await page.goto(`${system.webUrl}/agent`);
  const active = page.getByRole("checkbox", { name: "Respuestas automáticas activas", exact: true });
  await expect(active).not.toBeChecked();
  const submitted: Array<{ active: boolean; expectedRevision: number }> = [];
  let release!: () => void;
  let observed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const mutationObserved = new Promise<void>(resolve => { observed = resolve; });
  await page.route("**/me/agent", async route => {
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
  await expect(page.getByRole("status")).toHaveText("Agente guardado");
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
  await page.unroute("**/me/agent");
  await page.route("**/me/agent", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 409, json: { code: "CONFLICT" } }) : route.continue());
  await active.check();
  await page.getByRole("button", { name: "Guardar y activar", exact: true }).click();
  await expect(page.locator('[data-ui="agent-screen"]').getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
  await expect(active).toBeChecked();
  await page.getByRole("button", { name: "Recargar configuración", exact: true }).click();
  await expect(active).not.toBeChecked();
  await page.unroute("**/me/agent");

  let releaseLate!: () => void;
  let observeLate!: () => void;
  let deliverLate!: () => void;
  const lateHeld = new Promise<void>(resolve => { releaseLate = resolve; });
  const lateObserved = new Promise<void>(resolve => { observeLate = resolve; });
  const lateDelivered = new Promise<void>(resolve => { deliverLate = resolve; });
  await page.route("**/me/agent", async route => {
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
    await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  } finally { releaseLate(); }
  await lateDelivered;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  await expect(page.locator('[data-ui="admin-screen"] .admin-feedback').getByRole("status")).toHaveCount(0);
  await expect(page.locator('[data-ui="admin-inventory"]').getByRole("listitem")
    .filter({ has: page.getByText("Agente concurrente", { exact: true }) })).toBeVisible();
});

test("the redesigned Agent screen preserves the real configuration workflow responsively", async ({
  browser,
  page,
  system,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);

  await createBusinessInAdminUi(page, tenant);

  const tenantContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const tenantPage = await tenantContext.newPage();

  try {
    await login(tenantPage, system.webUrl, tenant.email, tenant.password);
    await expect(tenantPage).toHaveURL(/\/profile$/);
    await tenantPage.goto(`${system.webUrl}/agent`);
    await expect(tenantPage).toHaveURL(/\/agent$/);

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

    const screen = shell.locator('[data-ui="agent-screen"]');
    const heading = screen.getByRole("heading", { level: 1, name: "Agente", exact: true });
    const activation = screen.locator('[data-ui="agent-activation"]');
    const savePanel = screen.locator('[data-ui="agent-save-panel"]');
    await expect(screen).toHaveCount(1);
    await expect(heading).toBeVisible();
    const guide = screen.getByRole("complementary", { name: "Guía para dirigir el agente", exact: true });
    await expect(guide.getByRole("heading", { name: "Escribí para orientar", exact: true })).toBeVisible();
    await expect(guide.getByRole("listitem")).toHaveText([
      "Usá indicaciones concretas y sin contradicciones.",
      "Separá el estilo de las reglas obligatorias.",
      "Revisá que los límites sean explícitos.",
    ]);

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

    const form = screen.locator("form#agent-configuration-form");
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
      await expect(field).toHaveAttribute("maxlength", String(name === "style" ? AGENT_STYLE_LIMIT : AGENT_BUSINESS_INSTRUCTIONS_LIMIT));
      expect(await field.evaluate((element) => element.tagName)).toBe(
        "TEXTAREA",
      );
    }

    const save = savePanel.getByRole("button", {
      name: "Guardar configuración",
      exact: true,
    });
    await expect(save).toHaveCount(1);
    for (const [, name] of fields) {
      await expect(textareas[name]).toHaveAttribute("aria-describedby", `agent-${name}-hint`);
      await expect(screen.locator(`#agent-${name}-hint`)).toBeVisible();
      await expectKeyboardFocus(tenantPage, textareas[name]);
    }
    await active.focus();
    await tenantPage.keyboard.press("Tab");
    await tenantPage.keyboard.press("Shift+Tab");
    await expect(active).toBeFocused();
    expect(await active.evaluate(element => element.matches(":focus-visible"))).toBe(true);
    expect(await activation.locator(".agent-activation__track").evaluate((element) => {
      const style = getComputedStyle(element);
      return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
    })).toBe(true);
    await expectKeyboardFocus(tenantPage, save);
    await tenantPage.screenshot({ path: testInfo.outputPath("agent-desktop.png"), fullPage: true });
    await expect(save).toHaveAttribute("type", "submit");
    await expect(save).toHaveAttribute("form", "agent-configuration-form");
    await expect(form.locator("button")).toHaveCount(0);
    await expect(screen.getByRole("button")).toHaveCount(1);
    await expect(screen.getByRole("link")).toHaveCount(0);
    await expect(
      screen.getByText(
        /Cancelar|Restablecer|Vista previa|Conversaciones|Métricas/i,
      ),
    ).toHaveCount(0);

    await expectNoHorizontalOverflow(tenantPage);
    await expectReachable(heading);
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
    await tenantPage.route("**/me/agent", async (route) => {
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
      await expect(form).toHaveAttribute("aria-busy", "true");
    } finally {
      releaseSaveRequest();
    }
    const status = screen.getByRole("status");
    await expect(status).toHaveCount(1);
    await expect(status).toHaveText("Agente guardado");
    await tenantPage.screenshot({ path: testInfo.outputPath("agent-success.png"), fullPage: true });
    await tenantPage.unroute("**/me/agent");

    await tenantPage.reload();
    await expect(tenantPage).toHaveURL(/\/agent$/);
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
    await tenantPage.route("**/me/agent", conflictRoute);

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
    await expectKeyboardFocus(tenantPage, reloadConfiguration);
    await tenantPage.screenshot({ path: testInfo.outputPath("agent-conflict.png"), fullPage: true });

    await tenantPage.unroute("**/me/agent", conflictRoute);
    const refreshedConfiguration = tenantPage.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname.endsWith("/me/agent") &&
        response.ok(),
    );
    await Promise.all([refreshedConfiguration, reloadConfiguration.click()]);
    await expect(tenantPage).toHaveURL(/\/agent$/);
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
        new URL(response.url()).pathname.endsWith("/me/agent") &&
        response.ok(),
    );
    await Promise.all([refreshedSaveResponse, refreshedSave.click()]);
    await expect(status).toHaveText("Agente guardado");

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
    await tenantPage.screenshot({ path: testInfo.outputPath("agent-mobile.png"), fullPage: true });
  } finally {
    await tenantContext.close();
  }
});
