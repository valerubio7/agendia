import { expect, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

const tenant = {
  name: "Estudio Shell",
  email: "shell@example.test",
  password: "tenant shell password safe",
};

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
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

  const adminNavigation = adminShell.getByRole("navigation", {
    name: "Navegación administrativa",
    exact: true,
  });
  await expect(adminNavigation).toHaveCount(1);
  await expect(adminNavigation.getByRole("link")).toHaveText(["Negocios"]);
  await expect(
    adminNavigation.getByRole("link", { name: "Negocios", exact: true }),
  ).toHaveAttribute("aria-current", "page");
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

    const businessNavigation = businessShell.getByRole("navigation", {
      name: "Navegación del negocio",
      exact: true,
    });
    await expect(businessNavigation.getByRole("link")).toHaveText([
      "Perfil",
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
    await expect(mobileLinks).toHaveText(["Perfil", "Asistente", "WhatsApp"]);
    for (const name of ["Perfil", "Asistente", "WhatsApp"] as const) {
      const link = mobileNavigation.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await link.focus();
      await expect(link).toBeFocused();
    }

    const logout = mobileNavigation.getByRole("button", {
      name: "Cerrar sesión",
      exact: true,
    });
    await expect(logout).toBeVisible();
    await logout.focus();
    await expect(logout).toBeFocused();
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
      await expect(
        mobileNavigation.getByRole("button", {
          name: "Cerrando sesión…",
          exact: true,
        }),
      ).toBeDisabled();
    } finally {
      releaseLogoutRequest();
    }

    await expect(businessPage).toHaveURL(system.webUrl + "/");
  } finally {
    await businessContext.close();
  }
});
