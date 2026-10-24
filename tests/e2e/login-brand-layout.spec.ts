import { expect, test } from "@playwright/test";

// Exercise the live preview's origin; Next dev restricts assets on other hosts.
test.use({ baseURL: "http://localhost:3000" });
test.setTimeout(12_000);

for (const width of [320, 360, 640, 1024, 1280, 1440]) {
  test(`login logos have presence and the form logo is centered at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 640 ? 384 : width === 1024 ? 768 : 900 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);

    const card = page.locator(".login-card");
    const formLogo = card.locator(".brand__image");
    const storyLogo = page.locator(".login-story .brand__image");
    await expect(formLogo).toBeVisible();
    await expect(storyLogo).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("login.png"), fullPage: true });

    const formBox = (await formLogo.boundingBox())!;
    const storyBox = (await storyLogo.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    await expect.soft(card).toHaveCSS("box-shadow", "none", { timeout: 100 });
    await expect.soft(card).toHaveCSS("border-top-width", "0px", { timeout: 100 });
    await expect.soft(page.locator(".login-submit")).toHaveCSS("box-shadow", "none", { timeout: 100 });
    await expect.soft(page.locator("main")).toHaveCount(1);
    await expect.soft(page.getByRole("heading", { name: "Iniciar sesión", exact: true })).toHaveCSS("text-align", "center", { timeout: 100 });
    expect(formBox.height).toBeCloseTo(width >= 1024 ? 48 : 40, 1);
    const storyHeight = width >= 1024
      ? Math.max(72, Math.min(width * 0.08, 96))
      : 48;
    expect.soft(storyBox.height).toBeCloseTo(storyHeight, 1);
    if (width >= 1024) {
      const storyPanel = (await page.locator('[data-ui="login-story"]').boundingBox())!;
      expect.soft(storyPanel.x).toBeGreaterThanOrEqual(16);
      expect.soft(storyPanel.y).toBeGreaterThanOrEqual(16);
      expect.soft(storyPanel.y + storyPanel.height).toBeLessThanOrEqual((page.viewportSize()!.height) - 16);
      const headingSize = await page.locator(".login-story h2").evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
      expect.soft(headingSize).toBeGreaterThanOrEqual(48);
      expect.soft(headingSize).toBeLessThanOrEqual(64);
      const copyBox = (await page.locator(".login-story__content").boundingBox())!;
      // The official spark starts at x=6 in its 120-unit-high SVG.
      expect.soft(Math.abs(storyBox.x + storyBox.height * 6 / 120 - copyBox.x)).toBeLessThan(1);
    }
    expect(Math.abs(formBox.x + formBox.width / 2 - cardBox.x - cardBox.width / 2)).toBeLessThan(1);

    for (const selector of [".login-card .brand", ".login-story .brand"]) {
      const wrapper = page.locator(selector);
      await expect(wrapper).toHaveAccessibleName("agendIA");
      expect(await wrapper.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= document.documentElement.clientWidth;
      })).toBe(true);
      const geometry = await wrapper.evaluate((element) => {
        const image = element.querySelector("img")!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return {
          height: image.height,
          space: [image.left - box.left, box.right - image.right, image.top - box.top, box.bottom - image.bottom],
        };
      });
      for (const space of geometry.space)
        expect(space).toBeGreaterThanOrEqual(geometry.height * 110 / 120 - 0.1);
    }
    if (width < 1024) {
      const storyPanel = (await page.locator('[data-ui="login-story"]').boundingBox())!;
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(storyPanel.y);
    }
    for (const control of await page.locator("input, button[type=submit]").all()) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(240);
      expect(box.height).toBeGreaterThanOrEqual(48);
      expect(box.x).toBeGreaterThanOrEqual(16);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
      if (width >= 1024) expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    }
    await expect(page.getByLabel("Correo", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ingresar", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}

for (const width of [320, 1280]) {
  test(`login keeps validation, keyboard focus, pending and error feedback at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    page.on("pageerror", error => console.log("login-runtime-error:", error.message));
    page.on("response", response => {
      if (response.request().resourceType() === "script" && !response.ok())
        console.log("login-script-error:", response.status(), response.url());
    });
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/auth/login", async route => {
      requests++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ email: "login@example.test", password: "a synthetic long password" });
      await held;
      await route.fulfill({ status: 422, json: { code: "VALIDATION_FAILED" } });
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const email = page.getByLabel("Correo", { exact: true });
    const password = page.getByLabel("Contraseña", { exact: true });
    const submit = page.getByRole("button", { name: "Ingresar", exact: true });
    const form = page.locator(".login-card form");
    await expect(email).toHaveAttribute("autocomplete", "email");
    await expect(password).toHaveAttribute("autocomplete", "current-password");
    await expect(password).toHaveAttribute("minlength", "16");
    await submit.click();
    await expect(email).toBeFocused();
    await email.fill("no-es-un-correo");
    await submit.click();
    await expect(email).toBeFocused();
    await email.fill("login@example.test");
    await password.fill("corta");
    await submit.click();
    await expect(password).toBeFocused();
    expect(requests).toBe(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await password.fill("a synthetic long password");
    await email.focus();
    for (const control of [email, password, submit]) {
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("outline-style", "solid");
      await expect(control).toHaveCSS("outline-color", "rgb(168, 58, 26)");
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    try {
      const pending = page.getByRole("button", { name: "Ingresando…", exact: true });
      await expect(pending).toBeDisabled();
      await expect(form).toHaveAttribute("aria-busy", "true");
      await expect(pending).toHaveCSS("opacity", "1");
      await expect(pending).toHaveCSS("cursor", "wait");
      expect(requests).toBe(1);
    } finally {
      release();
    }
    await expect(page.getByRole("alert")).toHaveText("Revisá los campos indicados.");
    await expect(form).toHaveAttribute("aria-busy", "false");
    await expect(submit).toBeEnabled();
    await expect(email).toHaveValue("login@example.test");
    await expect(password).toHaveValue("a synthetic long password");
    await expect(page).toHaveURL(/\/$/);
    expect(requests).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("login-error.png"), fullPage: true });
  });
}
