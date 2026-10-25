import { expect, type Locator } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Shell",
  email: "shell@example.test",
  password: "tenant shell password safe",
};

async function primaryPair(control: Locator) {
  await expect(control).toHaveCSS("background-color", "rgb(46, 107, 78)");
  await expect(control).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(control).toHaveCSS("font-weight", "650");
}

async function focusRing(control: Locator, color = "rgb(168, 58, 26)") {
  await control.focus();
  await control.page().keyboard.press("Tab");
  await control.page().keyboard.press("Shift+Tab");
  await expect(control).toBeFocused();
  expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect(control).toHaveCSS("outline-color", color);
  await expect(control).toHaveCSS("outline-style", "solid");
}

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
    await expect(sessionRecovery).toHaveCSS("background-color", "rgb(243, 238, 225)");
    await expect(sessionRecovery.locator("h1")).toHaveCSS("font-weight", "650");
    await expect(sessionRecovery.getByRole("alert")).toHaveCSS("color", "rgb(168, 58, 26)");
    await expect(sessionRecovery.getByRole("alert")).toHaveCSS("background-color", "rgb(243, 238, 225)");
    const recoveryLink = sessionRecovery.getByRole("link", { name: "Ir a iniciar sesión", exact: true });
    await primaryPair(recoveryLink);
    await focusRing(recoveryLink);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);

  const adminShell = page.locator(
    '[data-ui="authenticated-shell"][data-variant="admin"]',
  );
  await expect(adminShell).toHaveCount(1);
  await expect(
    adminShell.getByRole("img", { name: "agendIA", exact: true }),
  ).toHaveCount(1);

  // Admin workspaces now use tabs; the legacy route navigation is not exposed.
  const adminNavigation = adminShell.locator('[data-ui="desktop-navigation"]');
  await expect(adminNavigation).toBeHidden();
  await expect(adminShell.getByRole("navigation")).toHaveCount(0);
  await expect(adminNavigation.locator("a")).toHaveText(["Negocios"]);
  await expect(adminNavigation.locator("a")).toHaveAttribute("href", "/businesses");
  await expect(adminNavigation.locator("a")).toHaveAttribute("aria-current", "page");
  await expect(adminShell.locator(".authenticated-shell__sidebar")).toHaveCSS("background-color", "rgb(18, 55, 42)");
  await expect(adminShell.locator(".authenticated-shell__sidebar")).toHaveCSS("color", "rgb(243, 238, 225)");
  const workspaces = adminShell.getByRole("tablist", { name: "Espacios de administración", exact: true });
  await expect(workspaces.getByRole("tab")).toHaveText(["Negocios", "Configuración de IA"]);
  const businessesTab = workspaces.getByRole("tab", { name: "Negocios", exact: true });
  await expect(businessesTab).toHaveAttribute("aria-selected", "true");
  await expect(businessesTab).toHaveAttribute("aria-controls", "admin-businesses-panel");
  await expect(businessesTab).toHaveCSS("font-weight", "650");
  await focusRing(businessesTab, "rgb(46, 107, 78)");
  await expect(
    adminShell.getByRole("link", {
      name: /^(?:Perfil|Asistente|WhatsApp|Inicio|Dashboard)$/i,
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
    await login(businessPage, system.webUrl, tenant.email, tenant.password);
    await expect(businessPage).toHaveURL(/\/profile$/);

    const businessShell = businessPage.locator(
      '[data-ui="authenticated-shell"][data-variant="business"]',
    );
    await expect(businessShell).toHaveCount(1);

    // A separately created tab shares only the HttpOnly cookie, not sessionStorage.
    const freshTab = await businessContext.newPage();
    try {
      await freshTab.goto(`${system.webUrl}/profile`);
      await expect(freshTab.getByLabel("Nombre comercial", { exact: true })).toBeVisible();
      await freshTab.getByLabel("Nombre comercial", { exact: true }).fill("Perfil desde otra pestaña");
      const freshSave = freshTab.waitForResponse(response => response.url().endsWith("/api/me/business-profile") && response.request().method() === "PUT");
      await freshTab.getByRole("button", { name: "Guardar perfil", exact: true }).click();
      expect((await freshSave).status()).toBe(200);
      // Bootstrap in the new tab must not invalidate the first tab's already issued token.
      await businessPage.getByLabel("Nombre comercial", { exact: true }).fill("Perfil desde pestaña original");
      const originalSave = businessPage.waitForResponse(response => response.url().endsWith("/api/me/business-profile") && response.request().method() === "PUT");
      await businessPage.getByRole("button", { name: "Guardar perfil", exact: true }).click();
      expect((await originalSave).status()).toBe(200);
    } finally { await freshTab.close(); }
    // Recover again in the original tab; the existing logout flow below uses that recovered token.
    await businessPage.evaluate(() => sessionStorage.clear());
    await businessPage.reload();
    await expect(businessShell).toHaveCount(1);

    const businessNavigation = businessShell.getByRole("navigation", {
      name: "Navegación del negocio",
      exact: true,
    });
    await expect(businessNavigation.getByRole("link")).toHaveText([
      "Turnos",
      "Perfil",
      "Servicios",
      "Recursos",
      "Horario",
      "Clientes",
      "Asistente",
      "WhatsApp",
    ]);
    await expect(
      businessNavigation.getByRole("link", { name: "Inicio", exact: true }),
    ).toHaveCount(0);
    await expect(
      businessNavigation.getByRole("link", { name: /dashboard/i }),
    ).toHaveCount(0);
    await expect(
      businessNavigation.getByRole("link", { name: "Perfil", exact: true }),
    ).toHaveAttribute("aria-current", "page");

    const desktopNavigation = businessShell.locator(
      '[data-ui="desktop-navigation"]',
    );
    await expect(desktopNavigation).toBeVisible();
    await primaryPair(desktopNavigation.locator('[aria-current="page"]'));

    await businessNavigation
      .getByRole("link", { name: "Asistente", exact: true })
      .click();
    await expect(businessPage).toHaveURL(/\/assistant$/);
    await expect(businessShell).toHaveCount(1);
    await expect(
      businessNavigation.getByRole("link", {
        name: "Asistente",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      businessNavigation.getByRole("link", { name: "Perfil", exact: true }),
    ).not.toHaveAttribute("aria-current", "page");

    await businessNavigation
      .getByRole("link", { name: "WhatsApp", exact: true })
      .click();
    await expect(businessPage).toHaveURL(/\/whatsapp$/);
    await expect(businessShell).toHaveCount(1);
    await expect(
      businessNavigation.getByRole("link", {
        name: "WhatsApp",
        exact: true,
      }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      businessNavigation.getByRole("link", {
        name: "Asistente",
        exact: true,
      }),
    ).not.toHaveAttribute("aria-current", "page");

    await businessPage.setViewportSize({ width: 360, height: 800 });
    await expect(desktopNavigation).toBeHidden();

    const mobileNavigation = businessShell.locator(
      '[data-ui="mobile-navigation"]',
    );
    await expect(mobileNavigation).toBeVisible();
    expect(
      await mobileNavigation.evaluate(
        (element) => element instanceof HTMLDetailsElement,
      ),
    ).toBe(true);

    const menu = mobileNavigation.locator("summary");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAccessibleName("Menú");
    await menu.click();
    await expect(mobileNavigation).toHaveAttribute("open", "");

    const mobileLinks = mobileNavigation.getByRole("link");
    await expect(mobileLinks).toHaveText(["Turnos", "Perfil", "Servicios", "Recursos", "Horario", "Clientes", "Asistente", "WhatsApp"]);
    await primaryPair(mobileNavigation.locator('[aria-current="page"]'));
    await expect(businessShell.locator(".authenticated-shell__mobile-menu")).toHaveCSS("background-color", "rgb(252, 250, 243)");
    for (const name of ["Perfil", "Asistente", "WhatsApp"] as const) {
      const link = mobileNavigation.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await link.focus();
      await expect(link).toBeFocused();
      await focusRing(link, "rgb(46, 107, 78)");
    }

    const logout = mobileNavigation.getByRole("button", {
      name: "Cerrar sesión",
      exact: true,
    });
    await expect(logout).toBeVisible();
    await logout.focus();
    await expect(logout).toBeFocused();
    await primaryPair(logout);
    await focusRing(logout, "rgb(46, 107, 78)");
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
      await primaryPair(pendingLogout);
      await expect(pendingLogout).toHaveCSS("opacity", "0.65");
      await expect(pendingLogout).toHaveCSS("cursor", "wait");
    } finally {
      releaseLogoutRequest();
    }

    await expect(businessPage).toHaveURL(system.webUrl + "/");
  } finally {
    await businessContext.close();
  }
});
