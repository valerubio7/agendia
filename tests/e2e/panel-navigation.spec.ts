import { expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { createBusinessInAdminUi, login, test } from "./support/fixtures";

const tenant = { name: "Estudio Navegación", email: "nav@example.test", password: "navigation tenant password" };
const shell = (page: Page) => page.locator('[data-ui="authenticated-shell"]');
const rail = (page: Page) => shell(page).locator('[data-ui="desktop-navigation"]');
async function expectPendingDestination(page: Page, title: string, region: string) {
  const destination = page.getByRole("main", { name: title, exact: true });
  await expect(destination).toHaveAttribute("aria-busy", "true", { timeout: 2_000 });
  await expect(destination.getByRole("heading", { name: title, level: 1, exact: true })).toBeVisible();
  await expect(destination.getByRole("region", { name: region, exact: true })).toBeVisible();
  await expect(destination.getByRole("listitem").first()).toBeVisible();
  await expect(page.getByText(/Cargando (panel|sección)…/)).toHaveCount(0);
  await expect(destination.locator("a, button, input")).toHaveCount(0);
}

// Hold a real server response, not a fabricated session or an arbitrary sleep.
async function holdRead(page: Page, path: string, check: () => Promise<void>, navigate: () => Promise<unknown>) {
  let observed!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { observed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pattern = `**/api${path}`;
  await page.route(pattern, async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    observed();
    await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  try {
    await navigate();
    await arrived;
    await check();
  } finally { release(); }
}

async function nameProfile(page: Page, name: string) {
  await rail(page).getByRole("link", { name: "Negocio" }).click();
  await page.getByRole("button", { name: "Editar información del negocio" }).click();
  await page.getByLabel("Nombre comercial", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Guardar cambios", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await rail(page).getByRole("link", { name: "Inicio" }).click();
  await expect(page.getByRole("heading", { name: "Próximo turno" })).toBeVisible();
}

async function rememberShell(page: Page) {
  await shell(page).evaluate(element => { Object.assign(window, { originalPanelShell: element }); });
}

async function sameShell(page: Page) {
  return page.evaluate(() => Object.getOwnPropertyDescriptor(window, "originalPanelShell")?.value === document.querySelector('[data-ui="authenticated-shell"]'));
}

async function paintedText(page: Page, selector: string) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const color = await page.locator(selector).evaluate(element => getComputedStyle(element).color);
    return { fonts: fonts.map(({ familyName }) => familyName), color };
  } finally { await cdp.detach(); }
}

test("business navigation keeps collapsed chrome through delayed section reads", async ({ browser, page, system }, info) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, tenant);
  const business = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const panel = await business.newPage();
  try {
    await login(panel, `${system.webUrl}/login`, tenant.email, tenant.password);
    await nameProfile(panel, tenant.name);
    await shell(panel).getByRole("button", { name: "Contraer navegación" }).click();
    await rememberShell(panel);
    const referencePath = process.env.AGENDIA_NAV_REFERENCE;
    const reference = referencePath ? await business.newPage() : null;
    const take = async (page: Page, name: string) => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
    };
    if (reference) {
      await reference.goto(pathToFileURL(referencePath!).href);
      await reference.locator('[data-action="role-business"]').click();
      await reference.locator('.app-side [data-action="brand-toggle"]').click();
    }
    const desktop = (name: string) => rail(panel).getByRole("link", { name, exact: true }).click();
    const pending = async (name: string, title: string, region: string) => {
      await take(panel, `1280-${name}-pending-app`);
      expect.soft(await sameShell(panel), `${name}: same shell node`).toBe(true);
      expect.soft(await shell(panel).getAttribute("data-rail", { timeout: 1_000 }).catch(() => null), name).toBe("collapsed");
      await expectPendingDestination(panel, title, region);
      await expect(shell(panel).getByRole("button", { name: "Cerrar sesión" })).toBeDisabled();
      await expect(panel.getByRole("heading", { name: tenant.name })).toHaveCount(0);
    };
    await holdRead(panel, "/auth/session", () => pending("agenda", "Agenda", "Calendario"), () => desktop("Agenda"));
    await expect(panel).toHaveURL(/\/turnos$/);
    await expect(panel.locator(".agenda-screen")).toBeVisible();
    await holdRead(panel, "/me/business-profile", () => pending("negocio", "Negocio", "Información del negocio"), () => desktop("Negocio"));
    await expect(panel.getByRole("heading", { name: tenant.name })).toBeVisible();
    const integration = panel.getByRole("link", { name: "Asistente IA", exact: true });
    await holdRead(panel, "/me/agent", () => pending("integration", "Asistente IA", "Configuración del asistente"), () => integration.click());
    const close = panel.getByRole("button", { name: "Cerrar panel" });
    await expect(close).toBeFocused();
    await holdRead(panel, "/me/business-profile", () => pending("close", "Negocio", "Información del negocio"), () => close.click());
    await expect(integration).toBeFocused();
    expect.soft(await sameShell(panel)).toBe(true);
    if (reference) {
      const compare = async (width: number, state: string) => {
        await take(reference, `${width}-${state}-reference`);
        await take(panel, `${width}-${state}-app`);
      };
      await reference.locator('.app-side [data-page="agenda"]').click();
      await reference.locator('.app-side [data-page="espacio"]').click();
      await compare(1280, "negocio");
      console.log("1280 Negocio heading (reference/app)", await paintedText(reference, ".page-content h1"), await paintedText(panel, ".negocio-card h1"));
      await reference.locator('[data-action="assistant-agent-open"]').click();
      await integration.click();
      await expect(close).toBeFocused();
      await compare(1280, "integration");
      await reference.locator('.float-close[data-action="close-float"]').click();
      await close.click();
      await expect(integration).toBeFocused();
      await reference.setViewportSize({ width: 360, height: 800 });
      // The prototype centers the compact brand even inside its mobile drawer if the rail was collapsed.
      await reference.locator('.nav-mobile-top [data-action="brand-toggle"]').click();
    }
    await panel.setViewportSize({ width: 360, height: 800 });
    const menu = panel.getByLabel("Menú", { exact: true });
    await menu.click();
    if (reference) {
      await take(reference, "360-drawer-reference");
      await take(panel, "360-drawer-app");
      await reference.locator('.app-side [data-page="agenda"]').click();
      const date = await reference.evaluate<string>("demoDate");
      await panel.clock.setFixedTime(new Date(`${date}T15:00:00Z`));
    }
    await holdRead(panel, "/auth/session", async () => {
      await take(panel, "360-agenda-pending-app");
      expect.soft(await menu.isVisible()).toBe(true);
      expect.soft(await sameShell(panel)).toBe(true);
      await expectPendingDestination(panel, "Agenda", "Calendario");
      await expect(menu).toBeFocused();
    }, () => panel.getByRole("link", { name: "Agenda", exact: true }).click());
    await expect(panel.locator(".agenda-screen")).toBeVisible();
    if (reference) {
      await take(reference, "360-agenda-reference");
      await take(panel, "360-agenda-app");
      console.log("360 Agenda Día tab (reference/app)", await paintedText(reference, '[data-action="agenda-dia"]'),
        await paintedText(panel, '.ag-view-switch button[aria-pressed="true"]'));
    }
  } finally { await business.close(); }
});

for (const entry of ["cold", "warm"] as const) {
  test(`Agenda keeps availability neutral during ${entry} entry and recovers from a failed read`, async ({ browser, page, system }) => {
    await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    await createBusinessInAdminUi(page, tenant);
    const business = await browser.newContext();
    try {
      const panel = await business.newPage();
      await login(panel, `${system.webUrl}/login`, tenant.email, tenant.password);
      await expect(panel.getByRole("region", { name: "Turnos de hoy", exact: true })).toBeVisible();
      const appointments = "/me/appointments?*";
      const agenda = panel.getByRole("main", { name: "Agenda", exact: true });
      const day = agenda.getByRole("region", { name: "Turnos del día" });
      const month = agenda.getByRole("region", { name: "Vista mensual" });
      const busy = agenda.locator(".agenda-studio");
      const assertUnknown = async () => {
        await expect(busy).toHaveAttribute("aria-busy", "true");
        await expect(agenda.getByRole("heading", { name: "Horarios libres", exact: true })).toBeVisible();
        await expect(agenda.locator(".ag-head-fact strong")).toHaveText("—");
        await expect(agenda.getByRole("alert")).toHaveCount(0);
        await expect(agenda.getByText(/No hay turnos|No hay intervalos libres|No se pudo verificar la disponibilidad|Disponibilidad no verificada/)).toHaveCount(0, { timeout: 2_000 });
      };
      await holdRead(panel, appointments, async () => {
        await expect(day).toBeVisible();
        await expect(day.locator(".ag-avail-display strong")).toHaveText("—");
        await assertUnknown();
      }, () => entry === "cold" ? panel.goto(`${system.webUrl}/turnos`) : rail(panel).getByRole("link", { name: "Agenda" }).click());
      await expect(day.getByText("No hay turnos para este día.")).toBeVisible();
      await expect(day.getByText("No hay intervalos libres para mostrar.")).toBeVisible();
      await expect(day.locator(".ag-head-fact strong")).toHaveText("0");
      await expect(busy).not.toHaveAttribute("aria-busy", "true");

      if (entry === "warm") {
        await holdRead(panel, appointments, async () => {
          await expect(month).toBeVisible();
          await assertUnknown();
        }, () => agenda.getByRole("button", { name: "Mes", exact: true }).click());
        await expect(month.getByText("No hay turnos registrados.")).toBeVisible();
        await expect(month.getByText("No hay intervalos libres visibles.")).toBeVisible();
      }

      const failedRead = entry === "cold" ? appointments : "/me/business-calendar";
      await panel.route(`**/api${failedRead}`, route => route.fulfill({ status: 503, json: { code: "INTERNAL_ERROR" } }), { times: 1 });
      const refresh = agenda.getByRole("button", { name: "Actualizar turnos", exact: true });
      await refresh.click();
      await expect(agenda.getByRole("alert")).toContainText(entry === "cold" ? "No se pudo completar la operación." : "No pudimos consultar los horarios y recursos.");
      await expect(busy).not.toHaveAttribute("aria-busy", "true");
      await expect(agenda.locator(".ag-head-fact strong")).toHaveText(entry === "cold" ? "—" : "0");
      await expect(agenda.getByText(/No hay intervalos libres/)).toHaveCount(0);
      await refresh.click();
      await expect(agenda.getByRole("alert")).toHaveCount(0);
      await expect(agenda.locator(".ag-head-fact strong")).toHaveText("0");
      await expect(agenda.getByText(/No hay intervalos libres/)).toBeVisible();
    } finally { await business.close(); }
  });
}

test("admin navigation keeps its collapsed shell while reads are pending", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
  await shell(page).getByRole("button", { name: "Contraer navegación" }).click();
  await rememberShell(page);
  for (const [name, title, region] of [
    ["Ajustes", "Ajustes", "Tiempos de respuesta"],
    ["Negocios", "Negocios", "Directorio de negocios"],
    ["Inicio", "Solicitudes pendientes", "Solicitudes de alta"],
  ] as const) {
    await holdRead(page, "/admin/response-timing", async () => {
      expect.soft(await sameShell(page), name).toBe(true);
      await expect(rail(page).getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
      await expectPendingDestination(page, title, region);
      await expect(page.locator('[data-ui="admin-screen"]')).toHaveCount(0);
    }, () => rail(page).getByRole("link", { name, exact: true }).click());
    await expect(page.locator('[data-ui="admin-screen"]')).toBeVisible();
    await expect.soft(shell(page)).toHaveAttribute("data-expanded", "false", { timeout: 1_000 });
  }
});

test("a response read before actor change cannot expose old tenant content or actions", async ({ browser, page, system }) => {
  const next = { ...tenant, name: "Otro Estudio", email: "nav-next@example.test" };
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, tenant);
  await createBusinessInAdminUi(page, next);
  const original = await browser.newContext();
  const replacement = await browser.newContext();
  try {
    const panel = await original.newPage();
    const other = await replacement.newPage();
    await login(panel, `${system.webUrl}/login`, tenant.email, tenant.password);
    await login(other, `${system.webUrl}/login`, next.email, next.password);
    await nameProfile(panel, tenant.name);
    await nameProfile(other, next.name);
    await holdRead(panel, "/me/business-profile", async () => {
      await original.addCookies(await replacement.cookies(system.webUrl));
      await expect(panel.getByRole("heading", { name: tenant.name })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Editar información del negocio" })).toHaveCount(0);
    }, () => rail(panel).getByRole("link", { name: "Negocio" }).click());
    await expect(panel.getByRole("heading", { name: "Tu sesión no está disponible" })).toBeVisible({ timeout: 3_000 });
    await expect(panel.getByRole("heading", { name: tenant.name })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Nuevo turno" })).toHaveCount(0);
    await holdRead(panel, "/auth/session", async () => {
      await expectPendingDestination(panel, "Negocio", "Información del negocio");
      await expect(shell(panel)).toBeHidden();
      await expect(panel.getByRole("link")).toHaveCount(0);
      await expect(panel.getByRole("heading", { name: next.name })).toHaveCount(0);
    }, () => panel.reload());
    await expect(panel.getByRole("heading", { name: next.name })).toBeVisible();

    await system.expireSessions(next.email);
    await holdRead(panel, "/auth/session", async () => {
      await expect(panel.getByRole("heading", { name: next.name })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Cerrar sesión" })).toBeDisabled();
    }, () => rail(panel).getByRole("link", { name: "Agenda" }).click());
    await expect(panel.getByRole("heading", { name: "Tu sesión no está disponible" })).toBeVisible();
    await expect(shell(panel)).toBeHidden();
  } finally {
    await original.close();
    await replacement.close();
  }
});
