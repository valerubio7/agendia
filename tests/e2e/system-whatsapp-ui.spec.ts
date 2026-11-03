import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

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
    const loginResponse = await fetch(`${system.apiUrl}/auth/login`, {
      method: "POST",
      headers: { origin: system.webUrl, "content-type": "application/json" },
      body: JSON.stringify({ email: tenant.email, password: tenant.password }),
    });
    expect(loginResponse.status).toBe(200);
    const cookie = loginResponse.headers.get("set-cookie")!.split(";")[0]!;
    const { csrfToken } = (await loginResponse.json()) as {
      csrfToken: string;
    };
    const agentResponse = await fetch(`${system.apiUrl}/me/agent`, {
      method: "PUT",
      headers: {
        cookie,
        origin: system.webUrl,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        style: "clara y amable",
        businessInstructions: "responder con conocimiento propio, solo texto y sin secretos",
        active: true,
        expectedRevision: 0,
      }),
    });
    expect(agentResponse.status).toBe(200);

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
      hero.getByRole("heading", { level: 1, name: "WhatsApp", exact: true }),
    ).toBeVisible();
    await expect(statusPanel.getByRole("heading", { name: "Conexión del canal", exact: true })).toBeVisible();
    await expect(screen.getByRole("heading", { name: "Información del vínculo", exact: true })).toBeVisible();
    await expect(linkPanel.getByRole("heading", { name: "Conectá con un código temporal", exact: true })).toBeVisible();
    await expect(linkPanel.getByRole("list", { name: "Pasos para vincular", exact: true }).getByRole("listitem")).toHaveCount(3);
    await expect(linkPanel.getByText("QR aún no solicitado", { exact: true })).toBeVisible();
    await expect(statusPanel).toBeVisible();
    await expect(currentStatus).toHaveText(
      /^(Requiere vinculación|Desconectado)$/,
    );
    await expect(metadata).toBeVisible();
    await expectMetadata(metadata);
    await expect(linkPanel).toBeVisible();
    await expect(qrImage).toBeHidden();
    await expectNoHorizontalOverflow(tenantPage);

    await expect(screen.locator(".whatsapp-security-note")).toHaveText("El QR es temporal y no expone credenciales persistentes.");

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

    // Real keyboard modality, never programmatic focus or forced DOM state.
    for (let attempt = 0; attempt < 12 && !(await action.evaluate((el) => el === document.activeElement)); attempt++) {
      await tenantPage.keyboard.press("Tab");
    }
    await expect(action).toBeFocused();
    await tenantPage.keyboard.press("Shift+Tab");
    await expect(action).not.toBeFocused();
    await tenantPage.keyboard.press("Tab");
    await expect(action).toBeFocused();
    expect(await action.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    expect(await action.evaluate((element) => {
      const style = getComputedStyle(element);
      return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
    })).toBe(true);
    await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-desktop.png"), fullPage: true });

    // Schema-correct mocked UI-state coverage; not a real provider failure.
    const statusUrl = "**/api/me/whatsapp/status";
    const linkUrl = "**/api/me/whatsapp/link";
    const errorStatus = (route: Route) => route.fulfill({
      status: 200, json: { status: "error", linkedNumber: null, linkedAt: null, lastConnectedAt: null },
    });
    let releaseLink!: () => void;
    const linkGate = new Promise<void>((resolve) => { releaseLink = resolve; });
    const linkFailure = async (route: Route) => {
      if (route.request().method() !== "POST") return route.continue();
      await linkGate;
      await route.fulfill({ status: 503, json: { code: "INTERNAL_ERROR", message: "Mocked link failure" } });
    };
    await tenantPage.route(statusUrl, errorStatus);
    await tenantPage.route(linkUrl, linkFailure);
    try {
      await tenantPage.reload();
      await expect(statusPanel).toHaveAttribute("data-status", "error");
      await expect(currentStatus).toHaveText("Error de conexión");
      await action.click();
      const pending = linkPanel.getByRole("button", { name: "Esperando conexión…", exact: true });
      await expect(pending).toBeDisabled();
      await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-mocked-pending.png"), fullPage: true });
      releaseLink();
      const alert = screen.getByRole("alert");
      await expect(alert).toBeVisible();
      await expect(action).toBeEnabled();
      await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-mocked-error.png"), fullPage: true });
    } finally {
      releaseLink();
      await tenantPage.unroute(statusUrl, errorStatus);
      await tenantPage.unroute(linkUrl, linkFailure);
    }
    // Schema-correct mocked disconnected UI state, not a provider transition.
    const disconnectedStatus = (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200, json: { status: "disconnected", linkedNumber: null, linkedAt: null, lastConnectedAt: null },
      });
    };
    await tenantPage.route(statusUrl, disconnectedStatus);
    try {
      await tenantPage.reload();
      await expect(statusPanel).toHaveAttribute("data-status", "disconnected");
      await expect(currentStatus).toHaveText("Desconectado");
      await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-mocked-disconnected.png"), fullPage: true });
    } finally {
      await tenantPage.unroute(statusUrl, disconnectedStatus);
    }
    await tenantPage.reload();
    await expect(currentStatus).toHaveText(/^(Requiere vinculación|Desconectado)$/);
    await expect(screen.getByRole("alert")).toHaveCount(0);

    // Original real API/database lifecycle uses deterministic provider doubles.
    await action.click();
    await expect(action).toHaveText("Esperando conexión…");
    await expect(action).toBeDisabled();

    await expect(qrImage).toBeVisible();
    await expect(qrImage).toHaveAttribute("src", /^data:image\/png;base64,/);
    await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-qr.png"), fullPage: true });

    await expect(currentStatus).toHaveText("Conectado", { timeout: 15_000 });
    await expect(
      screen.getByText("WhatsApp conectado correctamente.", { exact: true }),
    ).toBeVisible();
    await expect(qrImage).toBeHidden();
    await expect(action).toHaveText("WhatsApp vinculado");
    await expect(action).toBeDisabled();

    await expect(linkPanel.getByRole("heading", { name: "Canal vinculado", exact: true })).toBeVisible();
    await expect(linkPanel.getByText("Verificación completa", { exact: true })).toBeVisible();
    await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-connected.png"), fullPage: true });

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
    await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-mobile.png"), fullPage: true });
  } finally {
    await tenantContext.close();
  }
});
