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

async function expectPair(locator: Locator, color: string, background: string) {
  await expect(locator).toHaveCSS("color", color);
  await expect(locator).toHaveCSS("background-color", background);
}

async function expectShellBrand(shell: Locator) {
  // The current channel workspace uses the official shell lockup, not a decorative bridge.
  const brand = shell.getByRole("img", { name: "agendIA", exact: true });
  const image = brand.locator('img[src="/brand/logo-inverse-outlined.svg"]');
  await expect(brand).toHaveCount(1);
  await expect(brand).toBeVisible();
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("alt", "");
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete &&
    el.naturalWidth > 0 && el.naturalHeight > 0)).toBe(true);
  for (const target of [brand, image]) {
    for (const property of ["box-shadow", "filter", "transform"] as const) {
      await expect(target).toHaveCSS(property, "none");
    }
  }
  await expect(image).toHaveCSS("object-fit", "contain");
  const fit = await image.evaluate((el: HTMLImageElement) => {
    const image = el.getBoundingClientRect(), brand = el.parentElement!.getBoundingClientRect();
    return { width: image.width, height: image.height, ratio: el.naturalWidth / el.naturalHeight,
      contained: image.left >= brand.left && image.right <= brand.right && image.top >= brand.top && image.bottom <= brand.bottom,
      inViewport: brand.left >= 0 && brand.right <= document.documentElement.clientWidth };
  });
  expect(fit.height).toBe(32);
  expect(Math.abs(fit.width / fit.height - fit.ratio)).toBeLessThan(0.01);
  expect(fit.contained).toBe(true);
  expect(fit.inViewport).toBe(true);
}

const paper = "rgb(243, 238, 225)";
const ink = "rgb(28, 38, 32)";
const muted = "rgb(76, 91, 83)";
const pine = "rgb(46, 107, 78)";
const pineDeep = "rgb(18, 55, 42)";
const pineSoft = "rgb(223, 233, 225)";
const coral = "rgb(255, 107, 73)";
const coralInk = "rgb(168, 58, 26)";
const dangerSoft = "rgb(243, 217, 211)";

test("the redesigned WhatsApp screen completes the real linking lifecycle responsively", async ({
  browser,
  page,
  system,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, system.webUrl, system.admin.email, system.admin.password);
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

    await expectShellBrand(shell);
    const symbolResponse = await tenantPage.request.get(new URL("/brand/logo-inverse-outlined.svg", tenantPage.url()).href);
    expect(symbolResponse.ok()).toBe(true);
    const symbol = await symbolResponse.text();
    expect(symbol).toContain('viewBox="0 0 388 120"');
    expect(symbol).toContain('fill="#F3EEE1"');
    expect(symbol).toContain('fill="#FF6B49"');
    await expect(screen.locator(".whatsapp-security-note")).toHaveText("El QR es temporal y no expone credenciales persistentes.");
    await expectPair(screen.locator(".whatsapp-security-note"), ink, "rgb(246, 232, 200)");
    await expect(hero.getByRole("heading", { level: 1 })).toHaveCSS("font-weight", "650");
    await expect(hero.getByRole("heading", { level: 1 })).toHaveCSS("font-family", /Source Sans 3/);
    await expect(metadata.locator("dd").first()).toHaveCSS("font-family", /Source Sans 3/);
    await expect(metadata.locator("dd").first()).toHaveCSS("font-weight", "600");
    await expect(metadata.locator("dd").first()).toHaveCSS("font-variant-numeric", "tabular-nums");
    const initialState = await statusPanel.getAttribute("data-status");
    await expectPair(currentStatus, initialState === "link_required" ? ink : muted,
      initialState === "link_required" ? "rgb(246, 232, 200)" : paper);

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

    await expectPair(action, ink, coral);
    await expect(action).toHaveCSS("font-weight", "600");
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
    await expect(action).toHaveCSS("outline-color", pine);
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
      await expectPair(currentStatus, coralInk, dangerSoft);
      await action.click();
      const pending = linkPanel.getByRole("button", { name: "Esperando conexión…", exact: true });
      await expect(pending).toBeDisabled();
      await expectPair(pending, muted, paper);
      await expect(pending).toHaveCSS("opacity", "1");
      await expect(pending).toHaveCSS("cursor", "default");
      await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-mocked-pending.png"), fullPage: true });
      releaseLink();
      const alert = screen.getByRole("alert");
      await expect(alert).toBeVisible();
      await expectPair(alert, coralInk, dangerSoft);
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
      await expectPair(currentStatus, muted, paper);
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
    await expectPair(action, muted, paper);
    await expectPair(screen.locator('.whatsapp-feedback [role="status"]'), pineDeep, pineSoft);
    await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-qr.png"), fullPage: true });

    await expect(currentStatus).toHaveText("Conectado", { timeout: 15_000 });
    await expect(
      screen.getByText("WhatsApp conectado correctamente.", { exact: true }),
    ).toBeVisible();
    await expect(qrImage).toBeHidden();
    await expect(action).toHaveText("WhatsApp vinculado");
    await expect(action).toBeDisabled();

    await expectPair(currentStatus, pineDeep, pineSoft);
    await expectPair(action, muted, paper);
    await expectPair(screen.locator('.whatsapp-feedback [role="status"]'), pineDeep, pineSoft);
    await expect(linkPanel.getByRole("heading", { name: "Canal vinculado", exact: true })).toBeVisible();
    await expect(linkPanel.getByText("Verificación completa", { exact: true })).toBeVisible();
    await tenantPage.screenshot({ path: testInfo.outputPath("whatsapp-connected.png"), fullPage: true });

    await tenantPage.setViewportSize({ width: 360, height: 800 });
    await expectReachable(hero);
    await expectShellBrand(shell);
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
