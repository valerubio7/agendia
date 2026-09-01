import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Voz Propia",
  email: "assistant-redesign@example.test",
  password: "tenant assistant password safe",
};

const values = {
  personality: "Cálida, resolutiva y atenta a cada consulta.",
  tone: "Claro, cercano y profesional, siempre en español rioplatense.",
  instructions: "Respondé con precisión y proponé un próximo paso concreto.",
  knowledge: "El estudio acompaña a pequeños negocios de todo el país.",
  rules: "Confirmá disponibilidad antes de prometer una fecha.",
  restrictions: "No inventes precios, horarios ni servicios no informados.",
};

const fields = [
  ["Personalidad", "personality"],
  ["Tono", "tone"],
  ["Instrucciones", "instructions"],
  ["Conocimiento", "knowledge"],
  ["Reglas", "rules"],
  ["Restricciones", "restrictions"],
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

test("the redesigned Assistant screen preserves the real configuration workflow responsively", async ({
  browser,
  page,
  system,
}) => {
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

    const sectionHeadings = [
      "Voz y personalidad",
      "Contexto y dirección",
      "Reglas y límites",
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

    await expect(screen.locator("textarea")).toHaveCount(6);
    await expect(form.locator("input, textarea, select, button")).toHaveCount(
      7,
    );
    await expect(form.locator("textarea")).toHaveCount(6);
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
      await expect(field).toHaveAttribute("maxlength", "8000");
      expect(await field.evaluate((element) => element.tagName)).toBe(
        "TEXTAREA",
      );
    }

    const save = savePanel.getByRole("button", {
      name: "Guardar configuración",
      exact: true,
    });
    await expect(save).toHaveCount(1);
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
    } finally {
      releaseSaveRequest();
    }
    const status = screen.getByRole("status");
    await expect(status).toHaveCount(1);
    await expect(status).toHaveText("Asistente guardado");
    await tenantPage.unroute("**/me/assistant");

    await tenantPage.reload();
    await expect(tenantPage).toHaveURL(/\/assistant$/);
    await expect(
      tenantPage.getByLabel("Personalidad", { exact: true }),
    ).toHaveValue(values.personality);
    await expect(
      tenantPage.getByLabel("Instrucciones", { exact: true }),
    ).toHaveValue(values.instructions);
    await expect(
      tenantPage.getByLabel("Restricciones", { exact: true }),
    ).toHaveValue(values.restrictions);
    await expect(
      tenantPage.getByLabel("Respuestas automáticas activas", {
        exact: true,
      }),
    ).toBeChecked();
    await expectNoHorizontalOverflow(tenantPage);

    const stalePersonality =
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

    await textareas.personality.fill(stalePersonality);
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
    await expect(textareas.personality).toHaveValue(values.personality);
    await expect(conflictAlert).toHaveCount(0);
    await expect(reloadConfiguration).toHaveCount(0);
    await expect(screen.getByRole("button")).toHaveCount(1);

    const refreshedPersonality = `${values.personality} Revisión actualizada.`;
    await textareas.personality.fill(refreshedPersonality);
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
  } finally {
    await tenantContext.close();
  }
});
