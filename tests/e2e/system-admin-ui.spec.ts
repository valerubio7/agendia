import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { test } from "./support/fixtures.ts";

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

test("the redesigned administration screen preserves the real business workflow responsively", async ({
  page,
  system,
}) => {
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
  } finally {
    releaseCreateRequest();
  }

  await expect(screen.getByRole("status")).toHaveText("Negocio creado");
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

  await page.unroute(renameRequest.url(), failedRenameRoute);
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
});
