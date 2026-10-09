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
    await tenantPage.screenshot({ path: testInfo.outputPath("assistant-mobile.png"), fullPage: true });
  } finally {
    await tenantContext.close();
  }
});
