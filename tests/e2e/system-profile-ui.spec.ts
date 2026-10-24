import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { login, test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Perfil Claro",
  email: "profile-redesign@example.test",
  password: "tenant profile password safe",
};

const values = {
  displayName: "Estudio Perfil Claro",
  description: "Asesoramiento personalizado para pequeños negocios.",
  address: "Avenida Siempreviva 742, Buenos Aires",
};

async function expectTextInput(field: Locator, maxlength: string) {
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("maxlength", maxlength);
  expect(
    await field.evaluate((element) => ({
      tagName: element.tagName,
      type: (element as HTMLInputElement).type,
    })),
  ).toEqual({ tagName: "INPUT", type: "text" });
}

async function expectTextarea(field: Locator, maxlength: string) {
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute("maxlength", maxlength);
  expect(await field.evaluate((element) => element.tagName)).toBe("TEXTAREA");
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

test("the redesigned Profile screen preserves the real profile workflow responsively", async ({
  browser,
  page,
  system,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);

  await page.locator('[aria-controls="admin-create"]').click();
  const create = page.locator('[data-ui="admin-create"] form');
  await expect(create).toBeVisible();
  await create.getByLabel(/^Nombre/).fill(tenant.name);
  await create.getByLabel("Correo del usuario", { exact: true }).fill(tenant.email);
  await create.getByLabel(/^Contraseña inicial/).fill(tenant.password);
  await create.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.locator(".admin-directory").getByRole("listitem").filter({
    has: page.getByText(tenant.name, { exact: true }),
  })).toBeVisible();
  await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Negocio creado");

  const tenantContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const tenantPage = await tenantContext.newPage();

  try {
    await login(
      tenantPage,
      system.webUrl,
      tenant.email,
      tenant.password,
    );
    await expect(tenantPage).toHaveURL(/\/profile$/);

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

    const screen = shell.locator('[data-ui="profile-screen"]');
    const heading = screen.getByRole("heading", { level: 1, name: "Perfil del negocio", exact: true });
    const savePanel = screen.locator('[data-ui="profile-save-panel"]');
    await expect(screen).toHaveCount(1);
    await expect(heading).toBeVisible();
    const profileBrand = shell.locator(".authenticated-shell__sidebar .brand");
    await expect(profileBrand).toHaveAccessibleName("agendIA");
    const profileBrandImage = profileBrand.locator('img.brand__image[src="/brand/logo-inverse-outlined.svg"]');
    await expect(profileBrandImage).toHaveAttribute("alt", "");
    await expect(profileBrandImage).toBeVisible();
    await expect(profileBrandImage).toHaveCSS("height", "32px");

    const form = screen.getByRole("form", { name: "Perfil del negocio", exact: true });
    await expect(form).toHaveAttribute("id", "business-profile-form");
    await expect(form).toHaveCount(1);
    await expect(savePanel).toBeVisible();
    const save = savePanel.getByRole("button", {
      name: "Guardar perfil",
      exact: true,
    });
    await expect(save).toHaveAttribute("type", "submit");
    await expect(save).toHaveAttribute("form", "business-profile-form");
    await expect(
      screen
        .getByRole("button", { name: /Cancelar|Restablecer/i })
        .or(screen.getByRole("link", { name: /Cancelar|Restablecer/i })),
    ).toHaveCount(0);

    const displayName = form.getByLabel("Nombre comercial", { exact: true });
    const description = form.getByLabel("Descripción", { exact: true });
    const address = form.getByLabel("Dirección", { exact: true });
    for (const label of ["Horarios", "Servicios o productos", "Contacto", "Preguntas frecuentes", "Políticas", "Información adicional"])
      await expect(screen.getByLabel(label, { exact: true })).toHaveCount(0);
    for (const name of ["businessHours", "offerings", "contact", "faq", "policies", "additionalInfo"])
      await expect(form.locator(`[name="${name}"]`)).toHaveCount(0);
    const fields = [
      displayName,
      description,
      address,
    ];

    await expect(form.locator("input, textarea, select")).toHaveCount(3);
    await expect(displayName).toHaveAttribute("required", "");
    for (const optionalField of fields.slice(1)) {
      await expect(optionalField).not.toHaveAttribute("required", /.*/);
    }
    // Pin the current editing workspace and its visible field guidance.
    await expect(heading).toHaveCSS("color", "rgb(28, 38, 32)");
    await expect(heading).toHaveCSS("font-weight", "650");
    await expect(heading).toHaveCSS("font-family", /Source Sans 3/);
    await expect(form).toHaveCSS("background-color", "rgb(252, 250, 243)");
    for (const field of fields) {
      const name = await field.getAttribute("name");
      await expect(field).toHaveAttribute("aria-describedby", `profile-${name}-hint`);
      await expect(form.locator(`#profile-${name}-hint`)).toBeVisible();
    }
    await expect(form.locator('label[for="profile-displayName"]')).toHaveCSS("font-weight", "650");
    await expect(displayName).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(displayName).toHaveCSS("color", "rgb(28, 38, 32)");
    await expect(displayName).toHaveCSS("font-weight", "450");
    await expect(displayName).toHaveCSS("font-family", /Source Sans 3/);
    await expect(savePanel).toHaveCSS("border-top-color", "rgb(216, 208, 184)");
    await expect(savePanel.locator(".profile-save-panel__action > p")).toHaveCSS("color", "rgb(76, 91, 83)");
    await expect(save).toHaveCSS("background-color", "rgb(255, 107, 73)");
    await expect(save).toHaveCSS("color", "rgb(28, 38, 32)");
    await expect(save).toHaveCSS("font-weight", "650");
    await expectTextInput(displayName, "160");
    await expectTextarea(description, "4000");
    await expectTextInput(address, "500");

    await expectNoHorizontalOverflow(tenantPage);
    await expect(heading).toBeVisible();
    await expect(form).toBeVisible();
    await expect(savePanel).toBeVisible();

    await displayName.fill(values.displayName);
    await description.fill(values.description);
    await address.fill(values.address);

    let observeSaveRequest!: () => void;
    const saveRequestObserved = new Promise<void>((resolve) => {
      observeSaveRequest = resolve;
    });
    let releaseSaveRequest!: () => void;
    const saveRequestReleased = new Promise<void>((resolve) => {
      releaseSaveRequest = resolve;
    });
    const saveHandler = async (route: Route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      expect(route.request().postDataJSON()).toEqual(values);
      observeSaveRequest();
      await saveRequestReleased;
      await route.continue();
    };
    await tenantPage.route("**/me/business-profile", saveHandler);

    // Enter keyboard modality through the last field, then genuinely Tab to save.
    await address.click();
    await tenantPage.keyboard.press("Tab");
    await expect(save).toBeFocused();
    expect(await save.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    await expect(save).toHaveCSS("outline-color", "rgb(46, 107, 78)");
    await expect(save).toHaveCSS("outline-style", "solid");
    await Promise.all([saveRequestObserved, save.click()]);
    try {
      await expect(
        savePanel.getByRole("button", { name: "Guardando…", exact: true }),
      ).toBeDisabled();
      const pending = savePanel.getByRole("button", { name: "Guardando…", exact: true });
      await expect(pending).toHaveCSS("background-color", "rgb(255, 107, 73)");
      await expect(pending).toHaveCSS("color", "rgb(28, 38, 32)");
      await expect(form).toHaveAttribute("aria-busy", "true");
    } finally {
      releaseSaveRequest();
    }
    await expect(screen.getByRole("status")).toHaveText("Perfil guardado");
    await expect(screen.getByRole("status")).toHaveCSS("background-color", "rgb(223, 233, 225)");
    await expect(screen.getByRole("status")).toHaveCSS("color", "rgb(18, 55, 42)");
    await tenantPage.unroute("**/me/business-profile", saveHandler);

    await tenantPage.reload();
    await expect(tenantPage).toHaveURL(/\/profile$/);
    await expect(
      tenantPage.getByLabel("Nombre comercial", { exact: true }),
    ).toHaveValue(values.displayName);
    for (const label of ["Horarios", "Servicios o productos"])
      await expect(tenantPage.getByLabel(label, { exact: true })).toHaveCount(0);
    await expect(tenantPage.getByLabel("Descripción", { exact: true })).toHaveValue(values.description);
    await expect(tenantPage.getByLabel("Dirección", { exact: true })).toHaveValue(values.address);
    for (const name of ["businessHours", "offerings", "contact", "faq", "policies", "additionalInfo"])
      await expect(tenantPage.locator(`#business-profile-form [name="${name}"]`)).toHaveCount(0);
    await expectNoHorizontalOverflow(tenantPage);

    // Exercise the real API's parse-before-write rejection with a valid UI draft.
    const readProfile = async () => {
      const response = await tenantContext.request.get(`${system.webUrl}/api/me/business-profile`);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const baseline = await readProfile();
    expect(baseline).toEqual(values);
    const draft = { ...values, description: "Descripción vigente para reintentar el guardado." };
    await description.fill(draft.description);
    let observeFault!: () => void;
    const faultObserved = new Promise<void>((resolve) => { observeFault = resolve; });
    let releaseFault!: () => void;
    const faultReleased = new Promise<void>((resolve) => { releaseFault = resolve; });
    const faultHandler = async (route: Route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const payload = route.request().postDataJSON();
      expect(payload).toEqual(draft);
      observeFault();
      await faultReleased;
      await route.continue({ postData: JSON.stringify({ ...payload, description: "x".repeat(4001) }) });
    };
    await tenantPage.route("**/api/me/business-profile", faultHandler);
    const rejectedResponse = tenantPage.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/me/business-profile" && response.request().method() === "PUT",
    );
    try {
      await Promise.all([faultObserved, save.click()]);
      await expect(savePanel.getByRole("button", { name: "Guardando…", exact: true })).toBeDisabled();
      await expect(form).toHaveAttribute("aria-busy", "true");
      releaseFault();
      const response = await rejectedResponse;
      expect(response.status()).toBe(400);
      expect(await response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
      const alert = screen.getByRole("alert");
      await expect(alert).toHaveText("Revisá los campos indicados.");
      await expect(alert).toHaveCSS("color", "rgb(168, 58, 26)");
      await expect(alert).toHaveCSS("background-color", "rgb(243, 217, 211)");
      await expect(description).toHaveValue(draft.description);
      await expect(form).toHaveAttribute("aria-busy", "false");
      await expect(save).toBeEnabled();
      await expect(screen.getByRole("status")).toHaveCount(0);
      expect(await readProfile()).toEqual(baseline);
      await tenantPage.screenshot({ path: testInfo.outputPath("profile-error.png"), fullPage: true });
    } finally {
      releaseFault();
      await tenantPage.unroute("**/api/me/business-profile", faultHandler);
    }
    await save.click();
    await expect(screen.getByRole("status")).toHaveText("Perfil guardado");
    await expect(screen.getByRole("status")).toHaveCSS("color", "rgb(18, 55, 42)");
    await expect(screen.getByRole("status")).toHaveCSS("background-color", "rgb(223, 233, 225)");
    await expect(screen.getByRole("alert")).toHaveCount(0);
    expect(await readProfile()).toEqual(draft);
    await tenantPage.reload();
    for (const [name, value] of Object.entries(draft))
      await expect(form.locator(`[name="${name}"]`)).toHaveValue(value);
    await expectNoHorizontalOverflow(tenantPage);
    await tenantPage.screenshot({ path: testInfo.outputPath("profile-desktop.png"), fullPage: true });
    await tenantPage.setViewportSize({ width: 360, height: 800 });
    const mobileMenu = shell.locator('[data-ui="mobile-navigation"]');
    await mobileMenu.getByText("Menú", { exact: true }).click();
    const mobileNavigation = mobileMenu.getByRole("navigation", { name: "Navegación móvil del negocio", exact: true });
    await expect(mobileNavigation).toBeVisible();
    const profileLink = mobileNavigation.getByRole("link", { name: "Perfil", exact: true });
    await expect(profileLink).toHaveAttribute("href", "/profile");
    await expect(profileLink).toHaveAttribute("aria-current", "page");
    await mobileMenu.locator("summary").click();
    await expect(mobileNavigation).toBeHidden();
    for (const field of fields) {
      const label = await field.getAttribute("name");
      const mobileField = tenantPage.locator(
        `#business-profile-form [name="${label}"]`,
      );
      await mobileField.scrollIntoViewIfNeeded();
      await expect(mobileField).toBeVisible();
    }
    const mobileSavePanel = tenantPage.locator(
      '[data-ui="profile-save-panel"]',
    );
    const mobileSave = mobileSavePanel.getByRole("button", {
      name: "Guardar perfil",
      exact: true,
    });
    await mobileSave.scrollIntoViewIfNeeded();
    await expect(mobileSave).toBeVisible();
    await expect(mobileSave).toBeEnabled();
    await expectNoHorizontalOverflow(tenantPage);
    await tenantPage.screenshot({ path: testInfo.outputPath("profile-mobile.png"), fullPage: true });
  } finally {
    await tenantContext.close();
  }
});
