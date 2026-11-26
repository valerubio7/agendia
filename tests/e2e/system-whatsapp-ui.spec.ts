import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Conversación Directa",
  email: "whatsapp-redesign@example.test",
  password: "tenant whatsapp password safe",
};

test("the WhatsApp deep link opens a modal with read-only entry and restores focus on dismissal", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, tenant);
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await login(page, system.webUrl, tenant.email, tenant.password);
  await expect(page).toHaveURL(/\/inicio$/);
  const writes: string[] = [];
  page.on("request", request => {
    if (request.url().includes("/api/me/whatsapp/") && request.method() !== "GET") writes.push(request.method());
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${system.webUrl}/whatsapp`);
  const panel = page.getByRole("dialog", { name: "WhatsApp", exact: true });
  const close = panel.getByRole("button", { name: "Cerrar panel", exact: true });
  await expect(panel, "the deep link opens the WhatsApp modal").toBeVisible({ timeout: 5_000 });
  await expect(close).toBeFocused();
  await expect(page.getByRole("button", { name: "Nuevo turno", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/profile$/);
  const card = page.getByRole("link", { name: "WhatsApp", exact: true });
  await expect(card).toBeFocused();
  await card.press("Enter");
  await expect(close).toBeFocused();
  await close.click();
  const booking = page.getByRole("button", { name: "Nuevo turno", exact: true });
  await booking.click();
  await expect(page.getByRole("dialog", { name: "Nuevo turno", exact: true }).getByRole("heading")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(booking).toBeFocused();
  expect(writes).toEqual([]);
});

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
  await expect(page).toHaveURL(/\/solicitudes$/);

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
    await expect(tenantPage).toHaveURL(/\/inicio$/);
    await tenantPage.goto(`${system.webUrl}/whatsapp`);
    await expect(tenantPage).toHaveURL(/\/whatsapp$/);

    const shell = tenantPage.locator(
      '[data-ui="authenticated-shell"][data-variant="business"]',
    );
    await expect(shell).toHaveCount(1);
    await expect(
      shell.getByTitle("agendIA", { exact: true }).locator('img[src="/brand/logo-symbol-inverse.svg"]'),
    ).toBeVisible();
    await expect(
      shell.getByRole("navigation", {
        name: "Navegación del negocio",
        exact: true,
      }),
    ).toBeVisible();

    const screen = shell.locator('[data-ui="whatsapp-screen"]');
    const statusPanel = screen.locator('[data-ui="whatsapp-status"]');
    const currentStatus = statusPanel.getByRole("status");
    const metadata = screen.locator('[data-ui="whatsapp-metadata"]');
    const linkPanel = screen.locator('[data-ui="whatsapp-link-panel"]');
    const qrImage = linkPanel.getByRole("img", {
      name: "Código QR temporal de WhatsApp",
      exact: true,
    });

    await expect(tenantPage.getByRole("dialog", { name: "WhatsApp", exact: true })).toBeVisible();
    await expect(statusPanel.getByText("Sin conexión", { exact: true })).toBeVisible();
    await expect(linkPanel.getByRole("list", { name: "Pasos para vincular", exact: true }).getByRole("listitem")).toHaveCount(3);
    await expect(currentStatus).toHaveText(/^(Requiere vinculación|Desconectado)$/);
    await expect(qrImage).toBeHidden();
    await expectNoHorizontalOverflow(tenantPage);
    await expect(screen.getByText("El QR es temporal y no expone credenciales persistentes.", { exact: true })).toBeVisible();
    const action = linkPanel.getByRole("button");
    await expect(action).toHaveText("Vincular WhatsApp");
    await expect(action).toBeEnabled();

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
    async function capture(state: "offline" | "qr" | "connected", width: number) {
      await tenantPage.evaluate(() => document.fonts.ready.then(() => undefined));
      const geometry = await screen.evaluate(dialog => {
        const selectors = {
          dialog: "", header: ".integration-head", title: "h2", card: ".wa-panel-status",
          summary: ".wa-panel-summary", badge: ".wa-panel-indicator", lower: ".wa-panel-lower", action: ".wa-panel-lower button",
          steps: ".wa-panel-steps", note: ".wa-panel-note", plate: ".wa-panel-qr", qr: ".wa-panel-qr img", caption: "figcaption",
        };
        return Object.fromEntries(Object.entries(selectors).flatMap(([key, selector]) => {
          const element = selector ? dialog.querySelector(selector) : dialog;
          if (!element) return [];
          const { x, y, width, height } = element.getBoundingClientRect();
          const css = getComputedStyle(element);
          return [[key, { x, y, width, height, text: element.childElementCount ? undefined : element.textContent?.trim(),
            background: css.backgroundColor, marginLeft: css.marginLeft, fontFamily: css.fontFamily }]];
        }));
      });
      await testInfo.attach(`whatsapp-${state}-${width}-geometry.json`, { contentType: "application/json", body: JSON.stringify(geometry) });
      await tenantPage.screenshot({ path: testInfo.outputPath(`whatsapp-${state}-${width}.png`) });
      expect.soft(geometry.dialog!.width, `${state} panel width`).toBe(width === 360 ? 340 : 578);
      expect.soft(geometry.badge!.marginLeft, `${state} mobile status badge spacing`).toBe(width === 360 ? "52px" : "0px");
      if (state === "qr") {
        expect.soft(geometry.qr?.width, "real QR plate width").toBe(width === 360 ? 112 : 140);
        await expect.soft(screen.locator(".wa-panel-lower").getByText("Vinculación solicitada. Escaneá el QR desde WhatsApp.", { exact: true })).toBeVisible({ timeout: 750 });
      }
      if (state === "connected") {
        expect.soft(geometry.action!.background, "connected confirmation uses the outlined treatment").toBe("rgba(0, 0, 0, 0)");
        if (width === 360) {
          const lines = await statusPanel.getByText("WhatsApp conectado", { exact: true }).evaluate(title =>
            title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight));
          expect.soft(lines, "connected title wraps at word boundaries").toBeCloseTo(2, 1);
        }
      }
      await expectNoHorizontalOverflow(tenantPage);
    }
    await capture("offline", 1280);
    await tenantPage.setViewportSize({ width: 360, height: 800 });
    await capture("offline", 360);
    await tenantPage.setViewportSize({ width: 1280, height: 900 });

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
    await capture("qr", 1280);
    await tenantPage.setViewportSize({ width: 360, height: 800 });
    await capture("qr", 360);
    await tenantPage.setViewportSize({ width: 1280, height: 900 });

    await expect(currentStatus).toHaveText("Conectado", { timeout: 15_000 });
    await expect(
      screen.getByText("WhatsApp conectado correctamente.", { exact: true }),
    ).toBeVisible();
    await expect(qrImage).toBeHidden();
    await expect(action).toHaveText("WhatsApp vinculado");
    await expect(action).toBeDisabled();

    await expect(statusPanel.getByText("WhatsApp conectado", { exact: true })).toBeVisible();
    await capture("connected", 1280);

    await tenantPage.setViewportSize({ width: 360, height: 800 });
    await capture("connected", 360);
    await linkPanel.getByText("Información del vínculo", { exact: true }).click();
    await expectMetadata(metadata);
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
