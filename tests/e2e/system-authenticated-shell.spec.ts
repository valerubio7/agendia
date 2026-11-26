import { writeFile } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Shell",
  email: "shell@example.test",
  password: "tenant shell password safe",
};

async function focusRing(control: Locator) {
  await control.focus();
  await control.page().keyboard.press("Tab");
  await control.page().keyboard.press("Shift+Tab");
  await expect(control).toBeFocused();
  expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  expect(await control.evaluate((element) => {
    const style = getComputedStyle(element);
    return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
  })).toBe(true);
}

function logoutPresentation(button: Locator) {
  return button.evaluate(element => {
    const styles = (target: Element, properties: string) => {
      const computed = getComputedStyle(target);
      return Object.fromEntries(properties.split(" ").map(property => [property, computed.getPropertyValue(property)]));
    };
    const { x, y, width, height } = element.getBoundingClientRect();
    const icon = element.querySelector("svg");
    const label = element.querySelector("span");
    return {
      hitBox: { x, y, width, height },
      focusVisible: element.matches(":focus-visible"),
      button: styles(element, "display align-items justify-content gap padding border border-radius color background-color font-family font-size font-weight line-height white-space cursor opacity outline-color outline-style outline-width outline-offset box-shadow"),
      icon: icon && {
        markup: icon.outerHTML,
        style: styles(icon, "width height margin-inline flex color stroke stroke-width"),
      },
      labelDisplay: label ? getComputedStyle(label).display : null,
    };
  });
}

async function sampleLogout(page: Page, admin: boolean, webUrl: string) {
  const shell = page.locator(`[data-ui="authenticated-shell"][data-variant="${admin ? "admin" : "business"}"]`);
  const collapse = shell.getByRole("button", { name: "Contraer navegación" });
  const button = shell.getByRole("button", { name: "Cerrar sesión", exact: true });
  const readStates = async (navigation: Locator) => {
    const lastLink = navigation.getByRole("link", { name: admin ? "Ajustes" : "Negocio", exact: true });
    await page.mouse.move(350, 100);
    await expect(button).toBeEnabled();
    const ready = await logoutPresentation(button);
    await button.hover();
    const hover = await logoutPresentation(button);
    await page.mouse.move(350, 100);
    await lastLink.focus();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    const focus = await logoutPresentation(button);
    expect(focus.focusVisible).toBe(true);
    return { ready, hover, focus };
  };
  const desktop = shell.locator('[data-ui="desktop-navigation"]');
  const mobile = shell.locator('[data-ui="mobile-navigation"]');
  if (admin) await expect(shell.locator("aside").getByText("ADMIN", { exact: true })).toBeVisible();
  const expanded = await readStates(desktop);
  await collapse.click();
  const collapsed = await readStates(desktop);
  await page.setViewportSize({ width: 360, height: 800 });
  await (admin ? shell.getByRole("button", { name: "Abrir navegación", exact: true }) : mobile.locator("summary")).click();
  if (admin) await expect(mobile.getByText("ADMIN", { exact: true })).toBeVisible();
  const drawer = await readStates(mobile.getByRole("navigation"));

  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/auth/logout", async route => {
    await held;
    await route.continue();
  });
  const pending = shell.getByRole("button", { name: "Cerrando sesión…", exact: true });
  let disabled;
  try {
    // Hit the button near its edge, not just on the label or icon.
    await button.click({ timeout: 5_000, position: { x: drawer.ready.hitBox.width - 4, y: drawer.ready.hitBox.height - 4 } });
    await expect(pending).toBeDisabled();
    disabled = await logoutPresentation(pending);
  } finally {
    release();
  }
  await expect(page).toHaveURL(webUrl + (admin ? "/admin/login" : "/"));
  return { expanded, collapsed, drawer, disabled };
}

test("business logout matches admin's Chromium presentation in both rails and the drawer", async ({
  browser, page, system,
}, testInfo) => {
  test.skip(browser.browserType().name() !== "chromium", "Chromium computed-style differential");
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, tenant);
  const admin = await sampleLogout(page, true, system.webUrl);
  await writeFile(testInfo.outputPath("admin-logout-presentation.json"), JSON.stringify(admin, null, 2));

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const businessPage = await context.newPage();
    await login(businessPage, `${system.webUrl}/login`, tenant.email, tenant.password);
    const business = await sampleLogout(businessPage, false, system.webUrl);
    await testInfo.attach("business-logout-presentation", { body: JSON.stringify(business, null, 2), contentType: "application/json" });
    for (const state of ["expanded", "collapsed", "drawer", "disabled"] as const) {
      expect.soft(business[state], `${state} logout presentation`).toEqual(admin[state]);
    }
  } finally {
    await context.close();
  }
});

test("cold admin entry shows the directory structure before the session read resolves", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, tenant);
  let observed!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { observed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/auth/session", async route => {
    observed();
    await gate;
    await route.continue();
  }, { times: 1 });
  try {
    await page.reload();
    await arrived;
    const destination = page.getByRole("main", { name: "Negocios", exact: true });
    await expect(destination).toHaveAttribute("aria-busy", "true", { timeout: 2_000 });
    await expect(destination.getByRole("heading", { name: "Negocios", exact: true, level: 1 })).toBeVisible();
    await expect(destination.getByRole("region", { name: "Directorio de negocios" }).getByText("Estado operativo", { exact: true })).toBeVisible();
    await expect(page.getByText(/Cargando (panel|sección)…|Aún no hay negocios/)).toHaveCount(0);
    await expect(page.getByText(tenant.name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("link").or(page.getByRole("button"))).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole("button", { name: `Información del negocio: ${tenant.name}`, exact: true })).toBeVisible({ timeout: 15_000 });
});

test("role-aware authenticated shells recover safely and expose only valid navigation", async ({
  browser,
  page,
  system,
}) => {
  await page.goto(`${system.webUrl}/profile`);

  const sessionRecovery = page.locator('main[data-state="session-recovery"]');
  await expect(
    sessionRecovery.getByRole("heading", {
      name: "Tu sesión no está disponible",
      exact: true,
    }),
  ).toBeVisible();
  await expect(sessionRecovery.getByRole("alert")).toHaveText(
    "Tu sesión expiró o el negocio está suspendido. Iniciá sesión nuevamente.",
  );
  await expect(
    sessionRecovery.getByRole("link", {
      name: "Ir a iniciar sesión",
      exact: true,
    }),
  ).toHaveAttribute("href", "/");
  await expect(
    sessionRecovery.getByText("Cargando panel…", { exact: true }),
  ).toHaveCount(0);

  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const recoveryLink = sessionRecovery.getByRole("link", { name: "Ir a iniciar sesión", exact: true });
    await focusRing(recoveryLink);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${system.webUrl}/businesses`);
  const adminRecovery = page.locator('main[data-state="session-recovery"]');
  const adminRecoveryLink = adminRecovery.getByRole("link", { name: "Ir a iniciar sesión", exact: true });
  await expect(adminRecoveryLink).toHaveAttribute("href", "/admin/login");
  await adminRecoveryLink.click();
  await expect(page).toHaveURL(`${system.webUrl}/admin/login`);
  await expect(page.getByRole("heading", { name: "Acceso de administración", exact: true })).toBeVisible();
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/solicitudes$/);

  const adminShell = page.locator(
    '[data-ui="authenticated-shell"][data-variant="admin"]',
  );
  await expect(adminShell).toHaveCount(1);
  await expect(
    adminShell.getByRole("img", { name: "agendIA", exact: true }),
  ).toHaveCount(1);

  const navigation = adminShell.getByRole("navigation", { name: "Navegación administrativa", exact: true });
  await expect(navigation.getByRole("link")).toHaveText(["Inicio", "Negocios", "Ajustes"]);
  const inicioLink = navigation.getByRole("link", { name: "Inicio", exact: true });
  await expect(inicioLink).toHaveAttribute("aria-current", "page");
  await focusRing(inicioLink);
  await expect(
    adminShell.getByRole("link", {
      name: /^(?:Perfil|Agente|WhatsApp|Dashboard)$/i,
    }),
  ).toHaveCount(0);
  await expect(
    adminShell
      .getByRole("link", { name: /detalle/i })
      .or(adminShell.getByRole("button", { name: /detalle/i })),
  ).toHaveCount(0);
  await expect(
    adminShell.getByRole("button", { name: "Cerrar sesión", exact: true }),
  ).toBeVisible();

  await createBusinessInAdminUi(page, tenant);

  await adminShell.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page).toHaveURL(`${system.webUrl}/admin/login`);
  await expect(page.getByRole("heading", { name: "Acceso de administración", exact: true })).toBeVisible();
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/solicitudes$/);

  const protectedProfileRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/me/business-profile") {
      protectedProfileRequests.push(request.url());
    }
  });
  await page.goto(`${system.webUrl}/profile`);

  const denied = page.locator('main[data-state="denied"]');
  await expect(
    denied.getByRole("heading", {
      name: "No tenés acceso a este panel",
      exact: true,
    }),
  ).toBeVisible();
  await expect(denied.getByRole("alert")).toHaveText(
    "Tu rol no permite acceder a este panel.",
  );
  await expect(
    denied.getByRole("link", {
      name: "Ir a iniciar sesión",
      exact: true,
    }),
  ).toHaveAttribute("href", "/");
  await expect(
    denied.getByText("Cargando panel…", { exact: true }),
  ).toHaveCount(0);
  expect(protectedProfileRequests).toEqual([]);

  const businessContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const businessPage = await businessContext.newPage();

  try {
    await login(businessPage, `${system.webUrl}/login`, tenant.email, tenant.password);
    await expect(businessPage).toHaveURL(/\/inicio$/);

    const businessShell = businessPage.locator(
      '[data-ui="authenticated-shell"][data-variant="business"]',
    );
    await expect(businessShell).toHaveCount(1);
    const rail = businessShell.locator('[data-ui="desktop-navigation"]');
    const mobileNavigation = businessShell.locator('[data-ui="mobile-navigation"]');
    const menu = mobileNavigation.locator("summary");
    const logout = mobileNavigation.getByRole("button", { name: "Cerrar sesión", exact: true });
    const mobileInicio = mobileNavigation.getByRole("link", { name: "Inicio", exact: true });

    await businessPage.setViewportSize({ width: 360, height: 800 });
    await expect(menu).toHaveAccessibleName("Menú");
    await focusRing(menu);
    await menu.press("Enter");
    await mobileInicio.click();
    await expect(mobileNavigation).not.toHaveAttribute("open", "");
    await expect(menu).toBeFocused();
    await expect(businessPage).toHaveURL(/\/inicio$/);
    await menu.press("Space");
    await logout.focus();
    await businessPage.keyboard.press("Tab");
    await expect(menu).toBeFocused();
    await businessPage.keyboard.press("Shift+Tab");
    await expect(logout).toBeFocused();
    await focusRing(logout);
    await expect(mobileNavigation).toHaveAttribute("open", "");
    await logout.press("Escape");
    await expect(menu).toBeFocused();

    await businessPage.setViewportSize({ width: 1280, height: 800 });
    await expect(rail.getByRole("link")).toHaveText(["Inicio", "Agenda", "Negocio"]);
    const collapse = businessShell.getByRole("button", { name: "Contraer navegación" });
    await expect(rail.getByRole("link", { name: "Inicio", exact: true })).toHaveAttribute("aria-current", "page");
    await focusRing(collapse);
    await collapse.press("Enter");
    const expand = businessShell.getByRole("button", { name: "Expandir navegación" });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(rail.getByRole("link", { name: "Agenda", exact: true })).toBeVisible();
    await expand.press("Space");
    await expect(collapse).toHaveAttribute("aria-expanded", "true");
    await rail.getByRole("link", { name: "Negocio", exact: true }).click();
    await expect(businessPage).toHaveURL(/\/profile$/);

    // A separately created tab shares only the HttpOnly cookie, not sessionStorage.
    const freshTab = await businessContext.newPage();
    try {
      await freshTab.goto(`${system.webUrl}/profile`);
      await freshTab.getByRole("button", { name: "Editar información del negocio", exact: true }).click();
      await expect(freshTab.getByLabel("Nombre comercial", { exact: true })).toBeVisible();
      await freshTab.getByLabel("Nombre comercial", { exact: true }).fill("Perfil desde otra pestaña");
      const freshSave = freshTab.waitForResponse(response => response.url().endsWith("/api/me/business-profile") && response.request().method() === "PUT");
      await freshTab.getByRole("button", { name: "Guardar cambios", exact: true }).click();
      expect((await freshSave).status()).toBe(200);
      // Bootstrap in the new tab must not invalidate the first tab's already issued token.
      await businessPage.getByRole("button", { name: "Editar información del negocio", exact: true }).click();
      await businessPage.getByLabel("Nombre comercial", { exact: true }).fill("Perfil desde pestaña original");
      const originalSave = businessPage.waitForResponse(response => response.url().endsWith("/api/me/business-profile") && response.request().method() === "PUT");
      await businessPage.getByRole("button", { name: "Guardar cambios", exact: true }).click();
      expect((await originalSave).status()).toBe(200);
    } finally { await freshTab.close(); }
    // Recover again in the original tab; the existing logout flow below uses that recovered token.
    await businessPage.evaluate(() => sessionStorage.clear());
    await businessPage.reload();
    await expect(businessShell).toHaveCount(1);

    const hub = businessShell.getByRole("navigation", { name: "Gestión del negocio", exact: true });
    const breadcrumb = businessShell.getByRole("navigation", { name: "Ruta de navegación", exact: true });
    await expect(rail.getByRole("link", { name: "Negocio", exact: true })).toHaveAttribute("aria-current", "page");
    for (const [name, path, breadcrumbLabel] of [["Clientes", "/clients"], ["Servicios", "/services"], ["Recursos", "/resources"], ["Horarios", "/business-calendar"], ["Asistente IA", "/agent", "Agente"], ["WhatsApp", "/whatsapp"]] as const) {
      const destination = hub.getByRole("link", { name, exact: true });
      await expect(destination).toHaveAttribute("href", path);
      await destination.click();
      await expect(businessPage).toHaveURL(system.webUrl + path);
      if (path === "/agent" || path === "/whatsapp") {
        const panel = businessPage.getByRole("dialog", { name, exact: true });
        const close = panel.getByRole("button", { name: "Cerrar panel", exact: true });
        await expect(close).toBeFocused();
        await expect(breadcrumb).toBeHidden();
        await close.click();
        await expect(businessPage).toHaveURL(/\/profile$/);
        await expect(destination).toBeFocused();
        continue;
      }
      await expect(rail.getByRole("link", { name: "Negocio", exact: true })).toHaveAttribute("aria-current", "location");
      await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(breadcrumbLabel ?? name);
      await breadcrumb.getByRole("link", { name: "Negocio", exact: true }).click();
      await expect(businessPage).toHaveURL(/\/profile$/);
    }

    await businessPage.setViewportSize({ width: 360, height: 800 });
    await expect(rail).toBeHidden();
    await menu.press("Space");
    await expect(mobileNavigation.getByRole("link")).toHaveText(["Inicio", "Agenda", "Negocio"]);
    await mobileInicio.focus();
    await mobileInicio.press("Escape");
    await expect(mobileNavigation).not.toHaveAttribute("open", "");
    await expect(menu).toBeFocused();
    await menu.click();
    await businessPage.mouse.click(340, 70);
    await expect(mobileNavigation).not.toHaveAttribute("open", "");
    await expect(menu).toBeFocused();
    await menu.press("Space");
    await mobileInicio.press("Enter");
    await expect(businessPage).toHaveURL(/\/inicio$/);
    await expect(mobileNavigation).not.toHaveAttribute("open", "");
    await menu.click();
    await mobileNavigation.getByRole("link", { name: "Negocio", exact: true }).click();
    await expect(businessPage).toHaveURL(/\/profile$/);
    await expect(mobileNavigation).not.toHaveAttribute("open", "");
    await hub.getByRole("link", { name: "WhatsApp", exact: true }).click();
    await expect(businessPage).toHaveURL(/\/whatsapp$/);
    const whatsapp = businessPage.getByRole("dialog", { name: "WhatsApp", exact: true });
    await expect(whatsapp.getByRole("button", { name: "Cerrar panel", exact: true })).toBeFocused();
    await businessPage.keyboard.press("Escape");
    await expect(businessPage).toHaveURL(/\/profile$/);
    await expect(hub.getByRole("link", { name: "WhatsApp", exact: true })).toBeFocused();
    await menu.click();
    await expect(mobileNavigation.getByRole("link", { name: "Negocio", exact: true })).toHaveAttribute("aria-current", "page");
    await focusRing(logout);
    expect(
      await businessPage.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);

    let observeLogoutRequest!: () => void;
    const logoutRequestObserved = new Promise<void>((resolve) => {
      observeLogoutRequest = resolve;
    });
    let releaseLogoutRequest!: () => void;
    const logoutRequestReleased = new Promise<void>((resolve) => {
      releaseLogoutRequest = resolve;
    });
    await businessPage.route("**/auth/logout", async (route) => {
      observeLogoutRequest();
      await logoutRequestReleased;
      await route.continue();
    });

    await Promise.all([logoutRequestObserved, logout.click()]);
    try {
      const pendingLogout = mobileNavigation.getByRole("button", {
        name: "Cerrando sesión…",
        exact: true,
      });
      await expect(pendingLogout).toBeDisabled();
    } finally {
      releaseLogoutRequest();
    }

    await expect(businessPage).toHaveURL(system.webUrl + "/");
    await expect(businessPage.getByRole("heading", { name: "Iniciar sesión", exact: true })).toBeVisible();

    await login(businessPage, `${system.webUrl}/admin/login`, tenant.email, tenant.password);
    await expect(businessPage).toHaveURL(/\/inicio$/);
    for (const path of ["/businesses", "/solicitudes", "/ajustes"]) {
      await businessPage.goto(`${system.webUrl}${path}`);
      const adminDenied = businessPage.locator('main[data-state="denied"]');
      await expect(adminDenied.getByRole("heading", { name: "No tenés acceso a este panel", exact: true })).toBeVisible();
      await expect(adminDenied.getByRole("link", { name: "Ir a iniciar sesión", exact: true })).toHaveAttribute("href", "/admin/login");
    }
  } finally {
    await businessContext.close();
  }
});
