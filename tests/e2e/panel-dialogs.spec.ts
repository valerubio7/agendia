import { expect, type Locator, type Page } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures";

const tenant = { name: "Panel Dialogs", email: "panel-dialogs@example.test", password: "panel dialogs password" };

async function openBusiness(page: Page, webUrl: string, admin: { email: string; password: string }) {
  const adminContext = await page.context().browser()!.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const adminPage = await adminContext.newPage();
    await login(adminPage, `${webUrl}/admin/login`, admin.email, admin.password);
    await createBusinessInAdminUi(adminPage, tenant);
  } finally { await adminContext.close(); }
  await login(page, `${webUrl}/login`, tenant.email, tenant.password);
  await expect(page).toHaveURL(/\/inicio$/);
}

async function outside(surface: Locator) {
  const candidates = await surface.evaluate(node => {
    const { left, top, right, bottom } = node.getBoundingClientRect();
    return ([[2, 2], [innerWidth - 3, 2], [2, innerHeight - 3], [innerWidth - 3, innerHeight - 3]] as const)
      .filter(([x, y]) => x < left || x > right || y < top || y > bottom);
  });
  expect(candidates, "a visible backdrop point").not.toHaveLength(0);
  const [x, y] = candidates[0]!;
  return { x, y };
}

async function entrance(surface: Locator, reduced = false, scrim?: Locator) {
  await expect(surface).toBeVisible();
  expect.soft(await surface.evaluate(node => {
    const { animationName, animationDuration, animationTimingFunction } = getComputedStyle(node);
    return { animationName, animationDuration, animationTimingFunction };
  })).toEqual(reduced ? { animationName: "none", animationDuration: "0s", animationTimingFunction: "ease" }
    : { animationName: "panel-float-in", animationDuration: "0.25s", animationTimingFunction: "cubic-bezier(0.2, 0.84, 0.27, 1)" });
  expect.soft(await (scrim ?? surface).evaluate((node, isScrim) => {
    const { animationName, animationDuration, animationTimingFunction } = getComputedStyle(node, isScrim ? null : "::backdrop");
    return { animationName, animationDuration, animationTimingFunction };
  }, !!scrim)).toEqual(reduced ? { animationName: "none", animationDuration: "0s", animationTimingFunction: "ease" }
    : { animationName: "panel-backdrop-in", animationDuration: "0.2s", animationTimingFunction: "ease" });
  await surface.evaluate(async node => { await Promise.allSettled(node.getAnimations().map(animation => animation.finished)); });
}

async function clickOutside(page: Page, surface: Locator) {
  const { x, y } = await outside(surface);
  await page.mouse.click(x, y);
}

for (const width of [1280, 360]) {
  test(`booking dismisses from the backdrop without swallowing an interior gesture (${width}px)`, async ({ page, system }) => {
    await page.setViewportSize({ width, height: 800 });
    await openBusiness(page, system.webUrl, system.admin);
    const opener = page.getByRole("button", { name: "Nuevo turno", exact: true });
    await opener.click();
    const booking = page.getByRole("dialog", { name: "Nuevo turno", exact: true });
    await entrance(booking);
    const date = booking.locator("#turnos-date");
    await date.click();
    await expect(date).toBeFocused();
    const box = (await booking.boundingBox())!;
    const point = await outside(booking);
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y);
    await page.mouse.up();
    await expect(booking).toBeVisible();
    await clickOutside(page, booking);
    await expect(booking).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

test("client dialog keeps a draft on an inside drag and restores focus after outside dismissal", async ({ page, system }) => {
  await openBusiness(page, system.webUrl, system.admin);
  await page.goto(`${system.webUrl}/clients`);
  const opener = page.getByRole("button", { name: "Nuevo cliente", exact: true });
  const dialog = page.getByRole("dialog", { name: "Nuevo cliente", exact: true });
  const name = dialog.getByRole("textbox", { name: "Nombre", exact: true });
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await opener.click();
    await entrance(dialog);
    await name.click();
    await expect(name).toBeFocused();
    await name.fill("Clara");
    const box = (await dialog.boundingBox())!;
    const point = await outside(dialog);
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y);
    await page.mouse.up();
    await expect(dialog, `inside drag at ${width}px`).toBeVisible();
    await expect(name).toHaveValue("Clara");
    await page.mouse.click(point.x, point.y);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  }
});

async function businessWrite(page: Page, path: string, data: object, method = "POST") {
  const csrf = await page.evaluate(() => sessionStorage.getItem("agendia.csrf"));
  expect(csrf).toBeTruthy();
  const url = new URL(`/api/me/${path}`, page.url());
  const response = await page.request.fetch(url.href, { method, headers: { Origin: url.origin, "x-csrf-token": csrf! }, data });
  expect(response.status()).toBe(method === "POST" ? 201 : 200);
}

async function holdWrite(page: Page, pattern: string, method: string) {
  let release!: () => void;
  let writes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(pattern, async route => {
    if (route.request().method() === method) {
      writes++;
      await held;
    }
    await route.continue();
  });
  return { release, writes: () => writes };
}

test("hours and closure editors dismiss at 360px without interrupting a held hours save", async ({ page, system }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openBusiness(page, system.webUrl, system.admin);
  await businessWrite(page, "business-calendar", { weeklySchedule: { 1: [{ startMinute: 540, endMinute: 1080 }] } }, "PUT");
  await page.goto(`${system.webUrl}/business-calendar`);
  const edit = page.getByRole("button", { name: "Editar horario", exact: true });
  const hours = page.getByRole("dialog", { name: "Editar horario", exact: true });
  const add = page.getByRole("button", { name: "Agregar cierre", exact: true });
  const closure = page.getByRole("dialog", { name: "Agregar cierre", exact: true });
  await add.click();
  await entrance(closure);
  await clickOutside(page, closure);
  await expect.soft(closure).toBeHidden();
  await expect.soft(add).toBeFocused();
  if (await closure.isVisible()) await page.keyboard.press("Escape");

  const write = await holdWrite(page, "**/api/me/business-calendar", "PUT");
  await edit.click();
  await entrance(hours);
  const start = hours.getByLabel("Inicio Lunes 1", { exact: true });
  await start.fill("08:30");
  const save = hours.getByRole("button", { name: "Guardar horario", exact: true });
  try {
    await save.click();
    await expect.poll(write.writes).toBe(1);
    await expect(save).toBeDisabled();
    await clickOutside(page, hours);
    await page.keyboard.press("Escape");
    await expect(hours).toBeVisible();
    await expect(start).toHaveValue("08:30");
  } finally { write.release(); }
  await expect(hours).toBeHidden();
  await expect(edit).toBeFocused();
  await expect(page.getByRole("button", { name: "Editar horario de Lunes", exact: true })).toContainText("08:30");
  expect(write.writes()).toBe(1);
  await edit.click();
  await entrance(hours);
  await clickOutside(page, hours);
  await expect(hours).toBeHidden();
  await expect(edit).toBeFocused();
});

test("resource backdrop dismisses only the top dialog and restores each opener", async ({ page, system }) => {
  await openBusiness(page, system.webUrl, system.admin);
  await businessWrite(page, "resources", { name: "Consultorio", serviceIds: [], weeklySchedule: {} });
  await page.goto(`${system.webUrl}/resources`);
  const tile = page.getByRole("button", { name: "Ver Consultorio", exact: true });
  await tile.click();
  const details = page.getByRole("dialog", { name: "Recurso", exact: true });
  await entrance(details);
  await details.getByRole("button", { name: "Editar recurso", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Editar recurso", exact: true });
  const suspend = editor.getByRole("button", { name: "Suspender", exact: true });
  await suspend.click();
  const confirm = page.getByRole("dialog", { name: "Suspender Consultorio", exact: true });
  await entrance(confirm);
  await clickOutside(page, confirm);
  await expect(confirm).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(suspend).toBeFocused();
  await clickOutside(page, editor);
  await expect(editor).toBeHidden();
  await expect(tile).toBeFocused();
  expect(await tile.getAttribute("data-status")).toBe("active");
});

test("admin backdrop unwinds confirmation, but hides a held write without aborting it", async ({ page, system }) => {
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  const row = (await createBusinessInAdminUi(page, tenant)).getByRole("button", { name: `Información del negocio: ${tenant.name}` });
  await page.setViewportSize({ width: 360, height: 800 });
  await row.click();
  const details = page.getByRole("dialog", { name: "Información del negocio", exact: true });
  await entrance(details);
  const suspend = details.getByRole("button", { name: "Suspender negocio", exact: true });
  await suspend.click();
  const confirm = page.getByRole("alertdialog", { name: "¿Suspender este negocio?", exact: true });
  await entrance(confirm);
  await clickOutside(page, confirm);
  await expect.soft(confirm).toBeHidden();
  await expect.soft(details).toBeVisible();
  if (await confirm.isVisible()) await page.keyboard.press("Escape");
  await expect(details.getByRole("button", { name: "Cerrar", exact: true }).first()).toBeFocused();
  await clickOutside(page, details);
  await expect.soft(details).toBeHidden();
  await expect.soft(row).toBeFocused();
  if (await details.isVisible()) await page.keyboard.press("Escape");
  await row.click();
  await suspend.click();
  const write = await holdWrite(page, "**/admin/businesses/*/status", "PUT");
  const save = confirm.getByRole("button", { name: "Suspender negocio", exact: true });
  try {
    await save.click();
    await expect.poll(write.writes).toBe(1);
    await expect(confirm.getByRole("button", { name: "Procesando…" })).toBeDisabled();
    await clickOutside(page, confirm);
    await expect(confirm).toBeHidden();
    await expect(details).toBeHidden();
    await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Procesando…" })).toBeVisible();
    await expect(row).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Negocios", exact: true })).toBeFocused();
  } finally { write.release(); }
  await expect(row).toContainText("Suspendido");
  await expect(row).toBeEnabled();
  expect(write.writes()).toBe(1);
});

test("reduced-motion profile, service and integration panels restore their opener", async ({ page, system }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openBusiness(page, system.webUrl, system.admin);
  await page.goto(`${system.webUrl}/profile`);
  const edit = page.getByRole("button", { name: "Editar información del negocio", exact: true });
  const profile = page.getByRole("dialog", { name: "Información del negocio", exact: true });
  await edit.click();
  await entrance(profile, true);
  const box = (await profile.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  const point = await outside(profile);
  await page.mouse.move(point.x, point.y);
  await page.mouse.up();
  await expect.soft(profile).toBeVisible();
  if (await profile.isVisible()) await clickOutside(page, profile);
  await expect(profile).toBeHidden();
  await expect(edit).toBeFocused();
  for (const name of ["Asistente IA", "WhatsApp"]) {
    const link = page.getByRole("link", { name, exact: true });
    await link.click();
    const integration = page.getByRole("dialog", { name, exact: true });
    await entrance(integration, true);
    await clickOutside(page, integration);
    await expect(page).toHaveURL(/\/profile$/);
    await expect(integration).toBeHidden();
    await expect(link).toBeFocused();
  }
  await page.goto(`${system.webUrl}/services`);
  const create = page.getByRole("button", { name: "Nuevo servicio", exact: true });
  await create.click();
  const service = page.getByRole("dialog", { name: "Nuevo servicio", exact: true });
  await entrance(service, true);
  await clickOutside(page, service);
  await expect(service).toBeHidden();
  await expect(create).toBeFocused();
});

test.use({ hasTouch: true });

for (const role of ["business", "admin"] as const) {
  test(`${role} mobile drawer keeps an inside drag and dismisses on an outside tap`, async ({ page, system }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    if (role === "business") await openBusiness(page, system.webUrl, system.admin);
    else await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
    const menu = page.getByLabel(role === "business" ? "Menú" : "Abrir navegación", { exact: true });
    const drawer = page.locator(role === "business" ? ".business-shell__drawer" : ".adm-drawer");
    const scrim = role === "business" ? page.locator(".business-shell__scrim") : undefined;
    await menu.click();
    await entrance(drawer, false, scrim);
    const box = (await drawer.boundingBox())!;
    const point = await outside(drawer);
    await page.mouse.move(box.x + box.width - 8, box.y + 170);
    await page.mouse.down();
    await page.mouse.move(point.x, point.y);
    await page.mouse.up();
    await expect.soft(drawer).toBeVisible();
    if (await drawer.isVisible()) await page.touchscreen.tap(point.x, point.y);
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await menu.click();
    await entrance(drawer, true, scrim);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(menu).toBeFocused();
  });
}
