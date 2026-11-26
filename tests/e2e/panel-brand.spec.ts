import { expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test as webTest } from "./support/fixtures";
import { captureWebDiagnostics, webRuntimeEnv } from "./support/web-runtime";

const test = webTest.extend<{ app: string }>({
  app: async ({ webBuild }, use) => {
    // The production Next build serves the actual routes. No API server or database is started.
    const server = spawn("bun", ["--bun", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", "0"], {
      cwd: webBuild.cwd, env: { ...webRuntimeEnv(webBuild.root), NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const diagnostics = captureWebDiagnostics(server);
    try {
      await expect.poll(() => diagnostics.logs.join(""), { timeout: 15_000 }).toMatch(/Local:\s+http:\/\/[^\s]+:\d+/);
      const port = diagnostics.logs.join("").match(/Local:\s+http:\/\/[^\s]+:(\d+)/)?.[1];
      await use(`http://127.0.0.1:${port}`);
    } finally {
      if (server.exitCode === null && server.signalCode === null && server.pid) {
        const exit = once(server, "exit");
        server.kill();
        await exit;
      }
    }
  },
});

test.use({ contextOptions: { reducedMotion: "reduce" }, deviceScaleFactor: 1, colorScheme: "light" });
const referencePath = process.env.AGENDIA_BRAND_REFERENCE;
const widths = [1280, 360] as const;

async function stubPanel(page: Page, role: "admin" | "business" | "signed-out") {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/activity") return route.fulfill({ status: 204 });
    if (path === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "visual-fixture" } });
    if (route.request().method() !== "GET") return route.abort();
    if (path === "/api/auth/session") return role === "signed-out"
      ? route.fulfill({ status: 401, json: { code: "UNAUTHENTICATED" } })
      : route.fulfill({ json: { sessionId: `visual-${role}-session`, identityId: role, role: role === "admin" ? "platform_admin" : "business_user", businessId: role === "business" ? "test-business" : null } });
    if (path === "/api/admin/response-timing") return route.fulfill({ json: { responseTiming: { initialDelaySeconds: 0, activeDelaySeconds: 0, inactivityResetSeconds: 60 } } });
    if (["/api/admin/businesses", "/api/admin/registrations", "/api/me/appointments"].includes(path)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
}

async function differingPixels(page: Page, first: Buffer, second: Buffer, tolerance = 0) {
  return page.evaluate(async ({ a, b, tolerance }) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const decode = async (image: string) => {
      const element = new Image();
      element.src = `data:image/png;base64,${image}`;
      await element.decode();
      canvas.width = element.naturalWidth;
      canvas.height = element.naturalHeight;
      context.drawImage(element, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const left = await decode(a), right = await decode(b);
    if (left.width !== right.width || left.height !== right.height) return -1;
    let changed = 0;
    for (let i = 0; i < left.data.length; i += 4) {
      if ([0, 1, 2, 3].some(offset => Math.abs(left.data[i + offset]! - right.data[i + offset]!) > tolerance)) changed++;
    }
    return changed;
  }, { a: first.toString("base64"), b: second.toString("base64"), tolerance });
}

test("business and admin paint the official outlined wordmark in the existing panel colors", async ({ context, app }, info) => {
  for (const role of ["admin", "business"] as const) {
    const actual = await context.newPage();
    await stubPanel(actual, role);
    for (const width of widths) {
      await actual.setViewportSize({ width, height: 800 });
      await actual.goto(`${app}${role === "admin" ? "/businesses" : "/inicio"}`);
      await expect(actual.locator(`[data-ui="authenticated-shell"][data-variant="${role}"]`)).toBeVisible();
      const verify = async (state: string, control: ReturnType<Page["getByRole"]>) => {
        const brand = control.locator(".panel-brand");
        await expect(brand.locator(".panel-brand__mark path")).toHaveAttribute("fill", "#F3EEE1");
        await expect(brand.locator(".panel-brand__mark circle")).toHaveAttribute("fill", "#FF6B49");
        const image = brand.locator("img");
        const name = `${role}-${width}-${state}`;
        if (state === "collapsed") {
          await expect(image).toBeHidden();
        } else {
          await expect.soft(image, `${name} outlined wordmark`).toBeVisible({ timeout: 1000 });
          if (await image.isVisible()) {
            const geometry = await image.evaluate(async element => {
              const img = element as HTMLImageElement;
              await img.decode();
              const readPaths = async (url: string) => {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Wordmark not available at ${url}`);
                const doc = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
                if (doc.querySelector("text")) throw new Error("Wordmark must use outlines");
                return Array.from(doc.querySelectorAll("path"), path => ({ d: path.getAttribute("d"), fill: path.getAttribute("fill") }));
              };
              const [panel, official] = await Promise.all([readPaths(img.currentSrc), readPaths("/brand/logo-wordmark-outlined.svg")]);
              return { panel, official };
            });
            expect(geometry.panel.map(path => path.d)).toEqual(geometry.official.map(path => path.d));
            expect(geometry.panel.map(path => path.fill)).toEqual(["#F3EEE1", "#FF6B49"]);
          }
        }
        await brand.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
      };
      if (width === 1280) {
        const collapse = actual.getByRole("button", { name: "Contraer navegación" });
        await expect(collapse).toHaveAttribute("aria-expanded", "true");
        await verify("expanded", collapse);
        await collapse.click();
        const expand = actual.getByRole("button", { name: "Expandir navegación" });
        await expect(expand).toHaveAttribute("aria-expanded", "false");
        await verify("collapsed", expand);
      } else {
        const menu = role === "admin" ? actual.getByRole("button", { name: "Abrir navegación" }) : actual.getByLabel("Menú", { exact: true });
        await expect(menu).toBeVisible();
        await verify("header", menu);
        await menu.click();
        const drawer = role === "admin" ? actual.getByRole("dialog", { name: "Menú de administración" })
          : actual.getByRole("navigation", { name: "Navegación móvil del negocio" });
        await expect(drawer).toBeVisible();
        await verify("drawer", role === "admin" ? drawer.getByRole("button", { name: "Cerrar navegación" }) : menu);
        await actual.keyboard.press("Escape");
        await expect(menu).toBeFocused();
      }
    }
    await actual.close();
  }
});

test("both login entrances retain their approved branding", async ({ page, app }, info) => {
  await stubPanel(page, "signed-out");
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    for (const [role, path, title] of [["business", "/login", "Iniciar sesión"], ["admin", "/admin/login", "Acceso de administración"]] as const) {
      await page.goto(`${app}${path}`);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      const frame = page.locator('[data-ui="login-frame"]');
      const sources = await frame.locator('img[src^="/brand/"]').evaluateAll(images => images.map(img => img.getAttribute("src")));
      expect(sources).toEqual(["/brand/logo-primary-outlined.svg", "/brand/logo-inverse-outlined.svg"]);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).filter(img => img.getClientRects().length).map(img => img.decode()));
      });
      const name = `login-${role}-${width}.png`;
      const shot = await page.screenshot({ path: info.outputPath(name), animations: "disabled" });
      const baseline = process.env.AGENDIA_BRAND_LOGIN_BASELINE;
      if (baseline) expect(await differingPixels(page, await readFile(join(baseline, name)), shot), name).toBe(0);
    }
  }
});

test("registration and panel recovery use the same accessible identity as the prototype", async ({ page, context, app }) => {
  test.skip(!referencePath, "Set AGENDIA_BRAND_REFERENCE to the local read-only UX/UI HTML");
  const reference = await context.newPage();
  await reference.goto(pathToFileURL(referencePath!).href);
  const mark = reference.locator('.app-side .official-brand-mark svg');
  const path = await mark.locator("path").getAttribute("d");
  await stubPanel(page, "signed-out");
  for (const entry of ["/register", "/inicio", "/businesses"]) {
    await page.goto(`${app}${entry}`);
    const logo = page.getByRole("img", { name: "agendIA", exact: true });
    await expect(logo).toBeVisible();
    await expect.soft(logo.locator("svg path")).toHaveAttribute("d", path!, { timeout: 1000 });
  }
  await reference.close();
});
