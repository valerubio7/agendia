import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Perfil Claro",
  email: "profile-redesign@example.test",
  password: "tenant profile password safe",
};

const values = {
  displayName: "Estudio Perfil Claro",
  description: "Asesoramiento personalizado para pequeños negocios.",
  address: "Avenida Siempreviva 742, Buenos Aires",
  businessHours: "Lunes a viernes de 9:00 a 18:00; sábados con turno.",
  offerings: "Diagnóstico inicial, planificación y acompañamiento mensual.",
};

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

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
    const hero = screen.locator('[data-ui="profile-hero"]');
    const savePanel = screen.locator('[data-ui="profile-save-panel"]');
    await expect(screen).toHaveCount(1);
    await expect(hero).toBeVisible();
    await expect(
      hero.getByText("Base de conocimiento", { exact: true }),
    ).toBeVisible();
    await expect(
      hero.getByRole("heading", {
        level: 1,
        name: "Tu negocio, explicado con claridad.",
        exact: true,
      }),
    ).toBeVisible();
    const profileBrand = hero.locator(".profile-knowledge-map__brand");
    await expect(profileBrand).toHaveCount(1);
    await expect(profileBrand).toHaveAttribute("aria-hidden", "true");
    const profileBrandImage = profileBrand.locator('img.brand__image[src="/brand/logo-symbol-inverse.svg"]');
    await expect(profileBrandImage).toHaveAttribute("alt", "");
    await expect(profileBrandImage).toHaveCSS("width", "24px");
    await expect(profileBrandImage).toHaveCSS("height", "24px");
    await expect(hero.locator(".profile-knowledge-map__heading")).not.toContainText(/agendIA/i);

    const sectionHeadings = [
      "Identidad del negocio",
      "Operación diaria",
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

    const form = screen.locator("form#business-profile-form");
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
    const businessHours = form.getByLabel("Horarios", { exact: true });
    const offerings = form.getByLabel("Servicios o productos", { exact: true });
    for (const label of ["Contacto", "Preguntas frecuentes", "Políticas", "Información adicional"])
      await expect(screen.getByLabel(label, { exact: true })).toHaveCount(0);
    for (const name of ["contact", "faq", "policies", "additionalInfo"])
      await expect(form.locator(`[name="${name}"]`)).toHaveCount(0);
    const fields = [
      displayName,
      description,
      address,
      businessHours,
      offerings,
    ];

    await expect(form.locator("input, textarea, select")).toHaveCount(5);
    await expect(displayName).toHaveAttribute("required", "");
    for (const optionalField of fields.slice(1)) {
      await expect(optionalField).not.toHaveAttribute("required", /.*/);
    }
    // Pin the mounted Profile palette and typography, not shared-shell styles.
    await expect(hero).toHaveCSS("background-color", "rgb(18, 55, 42)");
    await expect(hero.locator("h1")).toHaveCSS("font-weight", "650");
    for (const selector of [".profile-hero__eyebrow", ".profile-hero__copy > p:last-child", ".profile-knowledge-map__heading", ".profile-knowledge-map__heading strong", ".profile-knowledge-map small", ".profile-knowledge-map li > span"]) {
      for (const element of await hero.locator(selector).all())
        await expect(element).toHaveCSS("color", "rgb(243, 238, 225)");
    }
    await expect(hero.locator(".profile-knowledge-map")).toHaveCSS("background-color", "rgb(18, 55, 42)");
    for (const section of sections) {
      await expect(section).toHaveCSS("background-color", "rgb(243, 238, 225)");
      await expect(section.locator("h2")).toHaveCSS("font-weight", "650");
    }
    await expect(form.locator('label[for="profile-displayName"]')).toHaveCSS("font-weight", "650");
    await expect(displayName).toHaveCSS("background-color", "rgb(243, 238, 225)");
    await expect(displayName).toHaveCSS("color", "rgb(28, 38, 32)");
    await expect(displayName).toHaveCSS("font-weight", "450");
    await expect(displayName).toHaveCSS("font-family", /Source Sans 3/);
    await expect(businessHours).toHaveCSS("font-family", /JetBrains Mono/);
    await expect(businessHours).toHaveCSS("font-variant-numeric", "tabular-nums");
    await expect(form.locator('label[for="profile-businessHours"]')).toHaveCSS("font-weight", "700");
    await expect(savePanel).toHaveCSS("background-color", "rgb(18, 55, 42)");
    await expect(savePanel.locator("p")).toHaveCSS("color", "rgb(243, 238, 225)");
    await expect(save).toHaveCSS("background-color", "rgb(168, 58, 26)");
    await expect(save).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(save).toHaveCSS("font-weight", "650");
    await expectTextInput(displayName, "160");
    await expectTextarea(description, "4000");
    await expectTextInput(address, "500");
    await expectTextarea(businessHours, "2000");
    await expect(form.locator('[name="businessHours"]')).toHaveCount(1);
    await expectTextarea(offerings, "8000");

    await expectNoHorizontalOverflow(tenantPage);
    await expect(hero).toBeVisible();
    for (const section of sections) await expect(section).toBeVisible();
    await expect(savePanel).toBeVisible();

    await displayName.fill(values.displayName);
    await description.fill(values.description);
    await address.fill(values.address);
    await businessHours.fill(values.businessHours);
    await offerings.fill(values.offerings);

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
    await offerings.click();
    await tenantPage.keyboard.press("Tab");
    await expect(save).toBeFocused();
    expect(await save.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    await expect(save).toHaveCSS("outline-color", "rgb(243, 238, 225)");
    await expect(save).toHaveCSS("outline-style", "solid");
    await Promise.all([saveRequestObserved, save.click()]);
    try {
      await expect(
        savePanel.getByRole("button", { name: "Guardando…", exact: true }),
      ).toBeDisabled();
      const pending = savePanel.getByRole("button", { name: "Guardando…", exact: true });
      await expect(pending).toHaveCSS("background-color", "rgb(168, 58, 26)");
      await expect(pending).toHaveCSS("color", "rgb(255, 255, 255)");
      await expect(form).toHaveAttribute("aria-busy", "true");
    } finally {
      releaseSaveRequest();
    }
    await expect(screen.getByRole("status")).toHaveText("Perfil guardado");
    await expect(screen.getByRole("status")).toHaveCSS("background-color", "rgb(46, 125, 79)");
    await expect(screen.getByRole("status")).toHaveCSS("color", "rgb(255, 255, 255)");
    await tenantPage.unroute("**/me/business-profile", saveHandler);

    await tenantPage.reload();
    await expect(tenantPage).toHaveURL(/\/profile$/);
    await expect(
      tenantPage.getByLabel("Nombre comercial", { exact: true }),
    ).toHaveValue(values.displayName);
    await expect(
      tenantPage.getByLabel("Servicios o productos", { exact: true }),
    ).toHaveValue(values.offerings);
    await expect(
      tenantPage.getByLabel("Horarios", { exact: true }),
    ).toHaveValue(values.businessHours);
    await expect(tenantPage.getByLabel("Descripción", { exact: true })).toHaveValue(values.description);
    await expect(tenantPage.getByLabel("Dirección", { exact: true })).toHaveValue(values.address);
    for (const name of ["contact", "faq", "policies", "additionalInfo"])
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
      await expect(alert).toHaveCSS("color", "rgb(255, 255, 255)");
      await expect(alert).toHaveCSS("background-color", "rgb(179, 58, 31)");
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
    await expect(screen.getByRole("status")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(screen.getByRole("status")).toHaveCSS("background-color", "rgb(46, 125, 79)");
    await expect(screen.getByRole("alert")).toHaveCount(0);
    expect(await readProfile()).toEqual(draft);
    await tenantPage.reload();
    for (const [name, value] of Object.entries(draft))
      await expect(form.locator(`[name="${name}"]`)).toHaveValue(value);
    await expectNoHorizontalOverflow(tenantPage);
    await tenantPage.screenshot({ path: testInfo.outputPath("profile-desktop.png"), fullPage: true });
    await tenantPage.setViewportSize({ width: 360, height: 800 });
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
