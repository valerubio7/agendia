import { expect, type Locator, type Page } from "@playwright/test";
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
  contact: "hola@perfil-claro.example · +54 11 5555 0142",
  businessHours: "Lunes a viernes de 9:00 a 18:00; sábados con turno.",
  offerings: "Diagnóstico inicial, planificación y acompañamiento mensual.",
  faq: "¿Trabajan de forma remota? Sí, en todo el país.",
  policies: "Los turnos se reprograman con 24 horas de anticipación.",
  additionalInfo: "Atención en español y seguimiento por correo electrónico.",
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

    const sectionHeadings = [
      "Identidad y contacto",
      "Operación diaria",
      "Conocimiento para responder",
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
    const contact = form.getByLabel("Contacto", { exact: true });
    const businessHours = form.getByLabel("Horarios", { exact: true });
    const offerings = form.getByLabel("Servicios o productos", { exact: true });
    const faq = form.getByLabel("Preguntas frecuentes", { exact: true });
    const policies = form.getByLabel("Políticas", { exact: true });
    const additionalInfo = form.getByLabel("Información adicional", {
      exact: true,
    });
    const fields = [
      displayName,
      description,
      address,
      contact,
      businessHours,
      offerings,
      faq,
      policies,
      additionalInfo,
    ];

        await expect(form.locator("input, textarea, select")).toHaveCount(9);
        await expect(displayName).toHaveAttribute("required", "");
        for (const optionalField of fields.slice(1)) {
          await expect(optionalField).not.toHaveAttribute("required", /.*/);
        }
        await expectTextInput(displayName, "160");
        await expectTextarea(description, "4000");
    await expectTextInput(address, "500");
    await expectTextInput(contact, "500");
    await expectTextarea(businessHours, "2000");
    await expect(form.locator('[name="businessHours"]')).toHaveCount(1);
    await expectTextarea(offerings, "8000");
    await expectTextarea(faq, "8000");
    await expectTextarea(policies, "8000");
    await expectTextarea(additionalInfo, "8000");

    await expectNoHorizontalOverflow(tenantPage);
    await expect(hero).toBeVisible();
    for (const section of sections) await expect(section).toBeVisible();
    await expect(savePanel).toBeVisible();

    await displayName.fill(values.displayName);
    await description.fill(values.description);
    await address.fill(values.address);
    await contact.fill(values.contact);
    await businessHours.fill(values.businessHours);
    await offerings.fill(values.offerings);
    await faq.fill(values.faq);
    await policies.fill(values.policies);
    await additionalInfo.fill(values.additionalInfo);

    let observeSaveRequest!: () => void;
    const saveRequestObserved = new Promise<void>((resolve) => {
      observeSaveRequest = resolve;
    });
    let releaseSaveRequest!: () => void;
    const saveRequestReleased = new Promise<void>((resolve) => {
      releaseSaveRequest = resolve;
    });
    await tenantPage.route("**/me/business-profile", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      observeSaveRequest();
      await saveRequestReleased;
      await route.continue();
    });

    await Promise.all([saveRequestObserved, save.click()]);
    try {
      await expect(
        savePanel.getByRole("button", { name: "Guardando…", exact: true }),
      ).toBeDisabled();
    } finally {
      releaseSaveRequest();
    }
    await expect(screen.getByRole("status")).toHaveText("Perfil guardado");

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
    await expect(
      tenantPage.getByLabel("Información adicional", { exact: true }),
    ).toHaveValue(values.additionalInfo);
    await expectNoHorizontalOverflow(tenantPage);

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
  } finally {
    await tenantContext.close();
  }
});
