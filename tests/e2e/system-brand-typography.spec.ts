import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

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

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
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
  await page.setViewportSize({ width: 1280, height: 900 });
  await zoom200();
  await noClipping(page);
  await resetZoom();

  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  const name = "Asesoramiento y planificación para pequeños negocios de Buenos Aires";
  const email = "brand-typography@example.test";
  const password = "brand typography password safe";
  await page.getByLabel("Nombre", { exact: true }).fill(name);
  await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
  await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
  await expect.soft(page.locator(".admin-timestamp").first()).toHaveCSS("font-weight", "450");
  await expect.soft(page.locator(".admin-timestamp").first()).toHaveCSS("font-variant-numeric", "tabular-nums");
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page.getByRole("button", { name: "Ingresar", exact: true })).toBeVisible();
  await login(page, system.webUrl, email, password);
  await expect(page).toHaveURL(/\/profile$/);
  const heading = page.getByRole("heading", { name: "Tu negocio, explicado con claridad.", exact: true });
  await expect(heading).toBeVisible();
  await expect.soft(heading).toHaveCSS("font-family", /"Source Sans 3"/);
  await expect.soft(heading).toHaveCSS("font-weight", "650");
  await expect.soft(page.locator(".profile-field__label").first()).toHaveCSS("font-weight", "650");
  await page.getByLabel("Nombre comercial", { exact: true }).fill(name);
  const hours = page.getByLabel("Horarios", { exact: true });
  await hours.fill("Lunes a viernes de 9:00 a 18:00; sábados de 10:00 a 13:00 con turno previo.");
  await expect.soft(hours).toHaveCSS("font-family", /"JetBrains Mono"/);
  await expect.soft(hours).toHaveCSS("font-weight", "450");
  await expect.soft(hours).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect.soft(page.locator('label[for="profile-businessHours"]')).toHaveCSS("font-weight", "700");
  await page.getByRole("button", { name: "Guardar perfil", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Perfil guardado");
  await loaded(page);
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
  await page.screenshot({ path: testInfo.outputPath("typography-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await zoom200();
  await noClipping(page);
  await expect(heading).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar perfil", exact: true })).toBeVisible();
  await resetZoom();
  await zoomSession.detach();
});
