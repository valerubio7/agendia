import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { login, test } from "./support/fixtures.ts";

const tokens = {
  "--paper": "#f3eee1", "--surface": "#fcfaf3",
  "--ink": "#1c2620", "--ink-2": "#4c5b53",
  "--pine": "#2e6b4e", "--pine-deep": "#12372a", "--pine-soft": "#dfe9e1",
  "--coral": "#ff6b49", "--coral-ink": "#a83a1a", "--coral-soft": "#f9d9cd",
  "--honey": "#e9b44c", "--honey-soft": "#f6e8c8",
  "--sand": "#d8d0b8", "--line": "rgba(28, 38, 32, 0.16)",
  "--ok": "#2e7d4f", "--danger": "#b33a1f", "--danger-soft": "#f3d9d3",
  "--focus": "#a83a1a",
  "--font-body": '"Source Sans 3", system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-display": '"Source Sans 3", system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-logo": "Bricolage, system-ui, sans-serif",
  "--font-mono": '"JetBrains Mono", ui-monospace, Consolas, monospace',
};

async function loaded(page: Page) {
  await page.evaluate(() => document.fonts.ready);
}

async function noClipping(page: Page) {
  expect(await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth <= root.clientWidth;
  })).toBe(true);
  for (const control of await page.locator("input, textarea, button[type=submit]").all()) {
    await expect(control).toBeVisible();
    expect(await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= document.documentElement.clientWidth + 1;
    })).toBe(true);
  }
}

async function officialBrand(page: Page, selector: string, asset: string, height: number) {
  const wrapper = page.locator(selector);
  await expect(wrapper).toHaveAccessibleName("agendIA");
  await expect(wrapper.getByRole("img", { name: "agendIA", exact: true })).toHaveCount(0);
  const image = wrapper.locator(`img[src="/brand/${asset}.svg"]`);
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("alt", "");
  const geometry = await image.evaluate((element: HTMLImageElement) => {
    const box = element.getBoundingClientRect();
    const parent = element.parentElement!;
    const outer = parent.getBoundingClientRect();
    const style = getComputedStyle(element);
    const padding = getComputedStyle(parent);
    return {
      height: box.height, ratio: box.width / box.height,
      natural: [element.naturalWidth, element.naturalHeight],
      clearspace: [box.left - outer.left, outer.right - box.right,
        box.top - outer.top, outer.bottom - box.bottom],
      padding: [padding.paddingTop, padding.paddingRight, padding.paddingBottom, padding.paddingLeft].map(Number.parseFloat),
      effects: [style.filter, style.boxShadow, style.clipPath,
        padding.filter, padding.boxShadow, padding.clipPath],
      fits: outer.left >= 0 && outer.right <= document.documentElement.clientWidth + 1,
      text: parent.textContent?.trim(),
    };
  });
  const wordmark = asset.includes("wordmark");
  expect(geometry.natural).toEqual(wordmark ? [300, 90] : [300, 93]);
  const response = await page.request.get(new URL(`/brand/${asset}.svg`, page.url()).href);
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain(`viewBox="0 0 ${wordmark ? "300 90" : "388 120"}"`);
  expect(geometry.height).toBeCloseTo(height, 1);
  expect(geometry.height).toBeGreaterThanOrEqual(24);
  expect(geometry.ratio).toBeCloseTo(wordmark ? 300 / 90 : 388 / 120, 2);
  const spark = wordmark ? height * 110 * 56 / 58 / 90 : height * 110 / 120;
  for (const space of [...geometry.clearspace, ...geometry.padding])
    expect(space).toBeGreaterThanOrEqual(spark - 0.1);
  expect(geometry.effects).toEqual(Array(6).fill("none"));
  expect(geometry.fits).toBe(true);
  expect(geometry.text).toBe("");
  if (height < 32) expect(asset).toBe("logo-mono-outlined");
}

test("official local faces, root tokens and shared roles survive real login/profile reflow", async ({
  page, system,
}, testInfo) => {
  const fontResponses: Array<{ url: string; status: number }> = [];
  const externalFonts: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/fonts/"))
      fontResponses.push({ url: response.url(), status: response.status() });
  });
  page.on("request", (request) => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(request.url())) externalFonts.push(request.url());
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(system.webUrl);
  await expect(page.getByRole("heading", { name: "Iniciar sesión", exact: true })).toBeVisible();
  await loaded(page);
  await expect(page.locator('.login-card img[src="/brand/logo-primary-outlined.svg"]')).toBeVisible();
  await expect(page.locator('.login-story img[src="/brand/logo-inverse-outlined.svg"]')).toBeVisible();
  const favicon = page.locator('link[rel="icon"][href="/brand/favicon.svg"]');
  await expect(favicon).toHaveAttribute("type", "image/svg+xml");
  const faviconResponse = await page.request.get(`${system.webUrl}/brand/favicon.svg`);
  expect(faviconResponse.status()).toBe(200);
  expect(await faviconResponse.text()).toContain('viewBox="0 0 64 64"');
  await officialBrand(page, ".login-card .brand", "logo-primary-outlined", 48);
  await officialBrand(page, ".login-story .brand", "logo-inverse-outlined", 96);
  await expect(page.getByRole("img", { name: "agendIA", exact: true })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("brand-login-desktop.png"), fullPage: true });
  const actualTokens = await page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
  }, Object.keys(tokens));
  // Next's CSS optimizer serializes this rgba token as equivalent eight-digit hex.
  expect.soft(actualTokens).toEqual({ ...tokens, "--line": expect.stringMatching(/^(rgba\(28, 38, 32, 0\.16\)|#1c262029)$/) });
  await expect.soft(page.locator("body")).toHaveCSS("font-family", /"Source Sans 3"/);
  await expect.soft(page.locator("body")).toHaveCSS("font-weight", "400");
  await expect.soft(page.locator("html")).toHaveCSS("background-color", "rgb(243, 238, 225)");
  await expect.soft(page.locator("html")).toHaveCSS("color", "rgb(28, 38, 32)");
  await expect.soft(page.locator(".login-card h1")).toHaveCSS("font-weight", "650");
  await expect.soft(page.locator(".login-field").first()).toHaveCSS("font-weight", "650");
  expect.soft(readFileSync("apps/web/app/layout.tsx", "utf8")).not.toContain("next/font/google");
  expect.soft(await page.evaluate(() => {
    const faces: Array<{ family: string; weight: string; style: string; display: string }> = [];
    document.fonts.forEach((face) => faces.push({
      family: face.family.replaceAll('"', ""), weight: face.weight,
      style: face.style, display: face.display,
    }));
    return faces;
  })).toEqual(expect.arrayContaining([
    { family: "Source Sans 3", weight: "200 900", style: "normal", display: "swap" },
    { family: "JetBrains Mono", weight: "100 800", style: "normal", display: "swap" },
    { family: "Bricolage", weight: "200 800", style: "normal", display: "swap" },
  ]));
  // Emulate browser zoom: halve CSS viewport, double device scale (media queries reflow).
  const zoomSession = await page.context().newCDPSession(page);
  async function zoom200() {
    await zoomSession.send("Emulation.setDeviceMetricsOverride", {
      width: 640, height: 450, deviceScaleFactor: 2, mobile: false,
    });
  }
  async function resetZoom() {
    await zoomSession.send("Emulation.clearDeviceMetricsOverride");
  }
  // Login controls remain usable with actual Spanish content at 200% scale.
  await noClipping(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await noClipping(page);
  await officialBrand(page, ".login-card .brand", "logo-primary-outlined", 40);
  await officialBrand(page, ".login-story .brand", "logo-inverse-outlined", 48);
  await page.screenshot({ path: testInfo.outputPath("brand-login-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await zoom200();
  await noClipping(page);
  await resetZoom();

  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  await page.goto(`${system.webUrl}/profile`);
  await expect(page.locator('.authenticated-terminal[data-state="denied"]')).toBeVisible();
  await officialBrand(page, ".authenticated-terminal .branded-name", "logo-wordmark-outlined", 32);
  await expect(page.getByRole("img", { name: "agendIA", exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("brand-terminal-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await officialBrand(page, ".authenticated-terminal .branded-name", "logo-wordmark-outlined", 32);
  const terminalBox = await page.locator('.authenticated-terminal[data-state="denied"]').evaluate((terminal) => {
    const rect = terminal.getBoundingClientRect();
    const style = getComputedStyle(terminal);
    return {
      clientWidth: document.documentElement.clientWidth,
      mainBox: {
        boxSizing: style.boxSizing,
        left: rect.left, right: rect.right, width: rect.width,
      },
    };
  });
  await noClipping(page);
  const mainBox = terminalBox.mainBox;
  expect(mainBox.boxSizing).toBe("border-box");
  expect(mainBox.left).toBeGreaterThanOrEqual(0);
  expect(mainBox.right).toBeLessThanOrEqual(terminalBox.clientWidth);
  expect(mainBox.width).toBe(terminalBox.clientWidth - 32);
  await page.screenshot({ path: testInfo.outputPath("brand-terminal-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${system.webUrl}/businesses`);
  const name = "Asesoramiento y planificación para pequeños negocios de Buenos Aires";
  const email = "brand-typography@example.test";
  const password = "brand typography password safe";
  await page.locator('[aria-controls="admin-create"]').click();
  const create = page.locator('[data-ui="admin-create"] form');
  await expect(create).toBeVisible();
  await create.getByLabel(/^Nombre/).fill(name);
  await create.getByLabel("Correo del usuario", { exact: true }).fill(email);
  await create.getByLabel(/^Contraseña inicial/).fill(password);
  await create.getByRole("button", { name: "Crear negocio", exact: true }).click();
  const business = page.locator(".admin-directory").getByRole("listitem").filter({
    has: page.getByText(name, { exact: true }),
  });
  await expect(business).toBeVisible();
  await expect(page.locator(".admin-feedback").getByRole("status")).toHaveText("Negocio creado");
  await business.locator("summary").click();
  const timestamp = business.locator(".admin-technical-details dd").first();
  await expect(timestamp).toBeVisible();
  await expect.soft(timestamp).toHaveCSS("font-family", /"Source Sans 3"/);
  await expect.soft(timestamp).toHaveCSS("font-weight", "400");
  await expect.soft(timestamp).toHaveCSS("font-variant-numeric", "tabular-nums");
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ingresar", exact: true })).toBeVisible();
  await login(page, system.webUrl, email, password);
  await expect(page).toHaveURL(/\/profile$/);
  const heading = page.getByRole("heading", { level: 1, name: "Perfil del negocio", exact: true });
  await expect(heading).toBeVisible();
  await expect.soft(heading).toHaveCSS("font-family", /"Source Sans 3"/);
  await expect.soft(heading).toHaveCSS("font-weight", "650");
  await expect.soft(page.locator(".profile-field__label").first()).toHaveCSS("font-weight", "650");
  await page.getByLabel("Nombre comercial", { exact: true }).fill(name);
  const description = page.getByLabel("Descripción", { exact: true });
  await description.fill("Asesoramiento personalizado para pequeños negocios.");
  await expect.soft(description).toHaveCSS("font-family", /"Source Sans 3"/);
  await expect.soft(description).toHaveCSS("font-weight", "400");
  for (const label of ["Horarios", "Servicios o productos"])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Guardar perfil", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Perfil guardado");
  await loaded(page);
  await officialBrand(page, ".authenticated-shell__sidebar .brand", "logo-inverse-outlined", 32);
  await expect(page.getByRole("img", { name: "agendIA", exact: true })).toHaveCount(1);
  expect.soft(await page.evaluate(() => [
    document.fonts.check('650 16px "Source Sans 3"'),
    document.fonts.check('450 16px "JetBrains Mono"'),
  ])).toEqual([true, true]);
  expect.soft(await page.evaluate(() => {
    const loadedFamilies: string[] = [];
    document.fonts.forEach((face) => {
      if (face.status === "loaded") loadedFamilies.push(face.family.replaceAll('"', ""));
    });
    return loadedFamilies;
  })).toEqual(expect.arrayContaining(["Source Sans 3", "JetBrains Mono"]));
  for (const filename of ["SourceSans3.ttf", "JetBrainsMono.ttf"])
    expect.soft(fontResponses).toContainEqual({ url: `${system.webUrl}/fonts/${filename}`, status: 200 });
  expect.soft(fontResponses.some(({ url }) => url.endsWith("Bricolage.ttf"))).toBe(false);
  expect.soft(externalFonts).toEqual([]);
  expect.soft(await page.locator('link[rel="preload"][as="font"]').evaluateAll(
    (links) => links.map((link) => (link as HTMLLinkElement).href),
  )).not.toEqual(expect.arrayContaining([expect.stringContaining("Bricolage")]));
  expect.soft(await page.locator("body *").evaluateAll((elements) =>
    elements.some((element) => getComputedStyle(element).fontFamily.includes("Bricolage")),
  )).toBe(false);
  // Inspect the declarations as well as loads: computed family alone can be fallback.
  const css = readFileSync("apps/web/app/styles.css", "utf8");
  for (const filename of ["SourceSans3.ttf", "JetBrainsMono.ttf", "Bricolage.ttf"])
    expect.soft(css).toContain(`url("/fonts/${filename}") format("truetype")`);
  await noClipping(page);
  await page.screenshot({ path: testInfo.outputPath("typography-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await noClipping(page);
  await expect(heading).toBeVisible();
  await officialBrand(page, ".authenticated-shell__sidebar .brand", "logo-inverse-outlined", 32);
  await expect(page.locator('.authenticated-shell__mobile-brand')).toBeHidden();
  await expect(page.getByRole("img", { name: "agendIA", exact: true })).toHaveCount(1);
  const menu = page.locator('[data-ui="mobile-navigation"]');
  await menu.locator("summary").click();
  await expect(menu).toHaveAttribute("open", "");
  const profileLink = menu.getByRole("link", { name: "Perfil", exact: true });
  await expect(profileLink).toHaveAttribute("href", "/profile");
  await expect(profileLink).toHaveAttribute("aria-current", "page");
  await noClipping(page);
  await menu.locator("summary").click();
  await expect(profileLink).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("typography-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await zoom200();
  await noClipping(page);
  await expect(heading).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar perfil", exact: true })).toBeVisible();
  await resetZoom();
  await zoomSession.detach();
});
