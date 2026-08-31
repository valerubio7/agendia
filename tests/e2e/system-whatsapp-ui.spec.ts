import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Conversación Directa",
  email: "whatsapp-redesign@example.test",
  password: "tenant whatsapp password safe",
};

const metadataLabels = [
  "Número vinculado",
  "Vinculado desde",
  "Última conexión",
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

async function expectMetadata(metadata: Locator) {
  for (const label of metadataLabels) {
    const term = metadata.locator("dt").filter({ hasText: label });
    await expect(term).toHaveCount(1);
    await expect(term).toHaveText(label);
    await expect(term).toBeVisible();
    await expect(term.locator("xpath=following-sibling::dd[1]")).toBeVisible();
  }
}

test("the redesigned WhatsApp screen completes the real linking lifecycle responsively", async ({
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
    await tenantPage.goto(`${system.webUrl}/whatsapp`);
    await expect(tenantPage).toHaveURL(/\/whatsapp$/);

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

    const screen = shell.locator('[data-ui="whatsapp-screen"]');
    const hero = screen.locator('[data-ui="whatsapp-hero"]');
    const statusPanel = screen.locator('[data-ui="whatsapp-status"]');
    const currentStatus = statusPanel.getByRole("status");
    const metadata = screen.locator('[data-ui="whatsapp-metadata"]');
    const linkPanel = screen.locator('[data-ui="whatsapp-link-panel"]');
    const qrImage = linkPanel.getByRole("img", {
      name: "Código QR temporal de WhatsApp",
      exact: true,
    });

    await expect(screen).toHaveCount(1);
    await expect(hero).toBeVisible();
    await expect(
      hero.getByText("Canal de atención", { exact: true }),
    ).toBeVisible();
    await expect(
      hero.getByRole("heading", {
        level: 1,
        name: "Tu negocio, a una conversación de distancia.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(statusPanel).toBeVisible();
    await expect(currentStatus).toHaveText(
      /^(Requiere vinculación|Desconectado)$/,
    );
    await expect(metadata).toBeVisible();
    await expectMetadata(metadata);
    await expect(linkPanel).toBeVisible();
    await expect(qrImage).toBeHidden();
    await expectNoHorizontalOverflow(tenantPage);

    await expect(screen.locator("input, select, textarea, form")).toHaveCount(
      0,
    );
    await expect(screen.getByRole("button")).toHaveCount(1);
    const action = linkPanel.getByRole("button");
    await expect(action).toHaveCount(1);
    await expect(action).toHaveText("Vincular WhatsApp");
    await expect(action).toBeEnabled();
    await expect(screen.getByRole("link")).toHaveCount(0);
    await expect(
      screen.getByText(
        /Desvincular|Cambiar número|Número de teléfono|Restablecer|Chats? recientes?|Métricas|Historial/i,
      ),
    ).toHaveCount(0);

    await action.click();
    await expect(action).toHaveText("Esperando conexión…");
    await expect(action).toBeDisabled();

    await expect(qrImage).toBeVisible();
    await expect(qrImage).toHaveAttribute("src", /^data:image\/png;base64,/);

    await expect(currentStatus).toHaveText("Conectado", { timeout: 15_000 });
    await expect(
      screen.getByText("WhatsApp conectado correctamente.", { exact: true }),
    ).toBeVisible();
    await expect(qrImage).toBeHidden();
    await expect(action).toHaveText("WhatsApp vinculado");
    await expect(action).toBeDisabled();

    await tenantPage.setViewportSize({ width: 360, height: 800 });
    await expectReachable(hero);
    await expectReachable(statusPanel);
    await expect(currentStatus).toHaveText("Conectado");
    for (const label of metadataLabels) {
      await expectReachable(metadata.locator("dt").filter({ hasText: label }));
    }
    await expectReachable(action);
    await expect(action).toHaveText("WhatsApp vinculado");
    await expect(action).toBeDisabled();
    await expectNoHorizontalOverflow(tenantPage);
  } finally {
    await tenantContext.close();
  }
});
