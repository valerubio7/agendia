import { expect, type Page } from "@playwright/test";
import { test } from "./support/fixtures.ts";

async function login(page: Page, url: string, email: string, password: string) {
  await page.goto(url);
  await page.getByLabel("Correo", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
}

test("Horario reads only the tenant calendar and retries safely", async ({ browser, page, system }, testInfo) => {
  const password = "calendar tenant password safe";
  const tenants = ["calendar-ui@example.test", "other-calendar-ui@example.test"];
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  for (const [index, email] of tenants.entries()) {
    await page.getByLabel("Nombre", { exact: true }).fill(`Estudio Horario ${index}`);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await expect(page.getByRole("cell", { name: `Estudio Horario ${index}`, exact: true })).toBeVisible();
  }
  const adminReads: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/me/business-calendar") adminReads.push(request.method());
  });
  await page.goto(`${system.webUrl}/business-calendar`);
  await expect(page.locator('main[data-state="denied"]')).toBeVisible();
  expect(adminReads).toEqual([]);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext();
  const business = await context.newPage();
  const other = await otherContext.newPage();
  try {
    await login(business, system.webUrl, tenants[0]!, password);
    await expect(business).toHaveURL(/\/profile$/);
    await login(other, system.webUrl, tenants[1]!, password);
    await expect(other).toHaveURL(/\/profile$/);
    const seed = async (target: Page, path: string, data: object) => {
      const csrf = await target.evaluate(() => sessionStorage.getItem("agendia.csrf"));
      expect(csrf).toBeTruthy();
      const response = await target.request.put(`${system.webUrl}/api/me/${path}`, {
        headers: { Origin: system.webUrl, "x-csrf-token": csrf! }, data,
      });
      expect(response.status()).toBe(200);
    };
    await seed(business, "business-profile", {
      displayName: "Horario propio", description: "", address: "", offerings: "", businessHours: "LEGACY 09:00 a 18:00",
    });
    await seed(other, "business-calendar", { weeklySchedule: {} });
    const methods: string[] = [];
    business.on("request", request => {
      if (new URL(request.url()).pathname === "/api/me/business-calendar") methods.push(request.method());
    });
    await business.getByRole("navigation", { name: "Navegación del negocio", exact: true })
      .getByRole("link", { name: "Horario", exact: true }).click();
    const screen = business.getByRole("main");
    await expect(screen.getByRole("heading", { name: "Horario sin configurar", exact: true })).toBeVisible();
    await expect(screen.getByText(/LEGACY/)).toHaveCount(0);
    await business.screenshot({ path: testInfo.outputPath("calendar-unconfigured.png"), fullPage: true });
    await other.goto(`${system.webUrl}/business-calendar`);
    await expect(other.getByRole("heading", { name: "Todos los días sin atención", exact: true })).toBeVisible();
    await expect(other.getByText("Sin atención", { exact: true })).toHaveCount(7);
    await other.screenshot({ path: testInfo.outputPath("calendar-all-off.png"), fullPage: true });
    const weeklySchedule = {
      1: [{ startMinute: 547, endMinute: 720 }, { startMinute: 660, endMinute: 780 }, { startMinute: 780, endMinute: 797 }],
      4: [{ startMinute: 1327, endMinute: 123 }],
      0: [{ startMinute: 0, endMinute: 1440 }],
    };
    await seed(business, "business-calendar", { weeklySchedule });
    const read = await business.request.get(`${system.webUrl}/api/me/business-calendar`);
    expect(await read.json()).toEqual({ weeklySchedule });
    await business.reload();
    await expect(screen.getByRole("heading", { name: "Horario semanal guardado", exact: true })).toBeVisible();
    const days = screen.locator(".resources-week div");
    await expect(days.locator("dt")).toHaveText(["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]);
    await expect(days.nth(0).locator("dd p")).toHaveText(["09:07 – 12:00", "11:00 – 13:00", "13:00 – 13:17"]);
    await expect(days.nth(3).locator("dd")).toHaveText("22:07 – 02:03 (día siguiente)");
    await expect(days.nth(6).locator("dd")).toHaveText("00:00 – 24:00");
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      if (width === 360) await business.locator('[data-ui="mobile-navigation"] summary').click();
      const nav = business.getByRole("navigation", { name: width === 360 ? "Navegación móvil del negocio" : "Navegación del negocio", exact: true });
      await expect(nav.getByRole("link", { name: "Horario", exact: true })).toHaveAttribute("aria-current", "page");
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`calendar-${width}.png`), fullPage: true });
      if (width === 360) {
        await business.locator('[data-ui="mobile-navigation"] summary').click();
        await business.screenshot({ path: testInfo.outputPath("calendar-360-closed.png"), fullPage: true });
      }
    }
    await other.reload();
    await expect(other.getByRole("heading", { name: "Todos los días sin atención", exact: true })).toBeVisible();
    let fail = true;
    await business.route("**/api/me/business-calendar", async route => {
      expect(route.request().method()).toBe("GET");
      if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "PRIVATE diagnostic" } }) });
      else await route.continue();
    });
    await business.reload();
    const error = business.locator('main[data-state="load-error"]');
    await expect(error.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await expect(business.getByText(/PRIVATE/)).toHaveCount(0);
    await business.screenshot({ path: testInfo.outputPath("calendar-error.png"), fullPage: true });
    const beforeRetry = methods.length;
    fail = false;
    await error.getByRole("button", { name: "Volver a intentar", exact: true }).click();
    await expect(screen.getByRole("heading", { name: "Horario semanal guardado", exact: true })).toBeVisible();
    expect(methods.length).toBe(beforeRetry + 1);
    expect(methods.every(method => method === "GET")).toBe(true);
    await expect(screen.getByRole("button", { name: "Editar horario", exact: true })).toHaveCount(1);
    await expect(screen.getByRole("button")).toHaveCount(2);
    await expect(screen.getByRole("button", { name: "Actualizar cierres", exact: true })).toHaveCount(1);
    await expect(screen.getByRole("form")).toHaveCount(0);
  } finally {
    await context.close();
    await otherContext.close();
  }
});

test("Horario edits raw tenant schedules without defaults or cancel writes", async ({ browser, page, system }, testInfo) => {
  const password = "calendar editor password safe";
  const emails = ["calendar-editor@example.test", "other-editor@example.test"];
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  for (const [index, email] of emails.entries()) {
    await page.getByLabel("Nombre", { exact: true }).fill(`Editor Horario ${index}`);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await expect(page.getByRole("cell", { name: `Editor Horario ${index}`, exact: true })).toBeVisible();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext();
  const business = await context.newPage(), other = await otherContext.newPage();
  try {
    await login(business, system.webUrl, emails[0]!, password);
    await expect(business).toHaveURL(/\/profile$/);
    await login(other, system.webUrl, emails[1]!, password);
    await expect(other).toHaveURL(/\/profile$/);
    const seed = async (target: Page, weeklySchedule: object) => {
      const csrf = await target.evaluate(() => sessionStorage.getItem("agendia.csrf"));
      expect(csrf).toBeTruthy();
      const response = await target.request.put(`${system.webUrl}/api/me/business-calendar`, {
        headers: { Origin: system.webUrl, "x-csrf-token": csrf! }, data: { weeklySchedule },
      });
      expect(response.status()).toBe(200);
    };
    const read = async (target: Page) => {
      const response = await target.request.get(`${system.webUrl}/api/me/business-calendar`);
      expect(response.status()).toBe(200);
      return response.json();
    };
    await seed(other, {});
    await business.goto(`${system.webUrl}/business-calendar`);
    await expect(business.getByRole("heading", { name: "Horario sin configurar", exact: true })).toBeVisible();
    expect(await read(business)).toEqual({ weeklySchedule: null });
    const bodies: unknown[] = [];
    business.on("request", request => {
      if (new URL(request.url()).pathname === "/api/me/business-calendar" && request.method() === "PUT") bodies.push(request.postDataJSON());
    });
    const opener = business.getByRole("button", { name: "Editar horario", exact: true });
    const form = business.getByRole("form", { name: "Editar horario", exact: true });
    const editor = form.getByRole("group", { name: "Horario semanal", exact: true });
    await opener.focus();
    await opener.press("Enter");
    await expect(editor.getByRole("button", { name: "Agregar franja Lunes", exact: true })).toBeFocused();
    await expect(editor.getByRole("textbox")).toHaveCount(0);
    await expect(editor.getByText(/El estado se conserva/)).toHaveCount(0);
    await form.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(opener).toBeEnabled();
    await expect(opener).toBeFocused();
    expect(bodies).toEqual([]);
    expect(await read(business)).toEqual({ weeklySchedule: null });
    await opener.click();
    await form.getByRole("button", { name: "Guardar horario", exact: true }).click();
    await expect(business.getByRole("status")).toHaveText("Horario guardado");
    await expect(opener).toBeFocused();
    expect(bodies).toEqual([{ weeklySchedule: {} }]);
    expect(await read(business)).toEqual({ weeklySchedule: {} });
    await business.reload();
    await expect(business.getByRole("heading", { name: "Todos los días sin atención", exact: true })).toBeVisible();
    await opener.click();
    const add = async (day: string, index: number, start: string, end: string) => {
      await editor.getByRole("button", { name: `Agregar franja ${day}`, exact: true }).click();
      await expect(editor.getByLabel(`Inicio ${day} ${index}`, { exact: true })).toHaveValue("");
      await editor.getByLabel(`Inicio ${day} ${index}`, { exact: true }).fill(start);
      await editor.getByLabel(`Fin ${day} ${index}`, { exact: true }).fill(end);
    };
    await add("Lunes", 1, "09:07", "12:00");
    for (const [start, end] of [["09:07", "09:07"], ["9:07", "12:00"], ["24:00", "12:00"], ["09:07", "24:01"], ["09:07:00", "12:00"]]) {
      await editor.getByLabel("Inicio Lunes 1", { exact: true }).fill(start!);
      await editor.getByLabel("Fin Lunes 1", { exact: true }).fill(end!);
      await form.getByRole("button", { name: "Guardar horario", exact: true }).click();
      await expect(business.getByRole("main").getByRole("alert")).toContainText("HH:mm distintas");
      expect(bodies).toHaveLength(1);
    }
    expect(await read(business)).toEqual({ weeklySchedule: {} });
    await business.screenshot({ path: testInfo.outputPath("calendar-editor-invalid.png"), fullPage: true });
    await editor.getByLabel("Inicio Lunes 1", { exact: true }).fill("09:07");
    await editor.getByLabel("Fin Lunes 1", { exact: true }).fill("12:00");
    await add("Lunes", 2, "11:00", "13:00");
    await add("Lunes", 3, "13:00", "13:17");
    await add("Jueves", 1, "22:07", "02:03");
    await add("Domingo", 1, "23:01", "00:02");
    await add("Sábado", 1, "00:00", "24:00");
    const raw = {
      1: [{ startMinute: 547, endMinute: 720 }, { startMinute: 660, endMinute: 780 }, { startMinute: 780, endMinute: 797 }],
      4: [{ startMinute: 1327, endMinute: 123 }], 0: [{ startMinute: 1381, endMinute: 2 }],
      6: [{ startMinute: 0, endMinute: 1440 }],
    };
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`calendar-editor-${width}.png`), fullPage: true });
    }
    await form.getByRole("button", { name: "Guardar horario", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(bodies).toEqual([{ weeklySchedule: {} }, { weeklySchedule: raw }]);
    expect(await read(business)).toEqual({ weeklySchedule: raw });
    await business.reload();
    await expect(business.getByRole("heading", { name: "Horario semanal guardado", exact: true })).toBeVisible();
    expect(await read(business)).toEqual({ weeklySchedule: raw });
    // API-only seed adds an explicit empty day; untouched UI save must preserve it exactly.
    const withEmptyDay = { ...raw, 2: [] };
    await seed(business, withEmptyDay);
    await business.reload();
    await expect(opener).toBeVisible();
    await opener.click();
    await expect(editor.getByLabel("Inicio Lunes 1", { exact: true })).toHaveValue("09:07");
    await expect(editor.getByLabel("Fin Sábado 1", { exact: true })).toHaveValue("24:00");
    await form.getByRole("button", { name: "Guardar horario", exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(bodies).toEqual([{ weeklySchedule: {} }, { weeklySchedule: raw }, { weeklySchedule: withEmptyDay }]);
    expect(await read(business)).toEqual({ weeklySchedule: withEmptyDay });
    await other.goto(`${system.webUrl}/business-calendar`);
    await expect(other.getByRole("heading", { name: "Todos los días sin atención", exact: true })).toBeVisible();
    expect(await read(other)).toEqual({ weeklySchedule: {} });
    await other.reload();
    await expect(other.getByRole("heading", { name: "Todos los días sin atención", exact: true })).toBeVisible();
  } finally {
    await context.close();
    await otherContext.close();
  }
});

test("Horario serializes pending saves, guards suspended hours and recovers confirmed saves by GET only", async ({ browser, page, system }, testInfo) => {
  const email = "calendar-safety@example.test", password = "calendar safety password safe";
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  await page.getByLabel("Nombre", { exact: true }).fill("Horario Seguro");
  await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
  await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Horario Seguro", exact: true })).toBeVisible();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  let releasePut: (() => void) | undefined;
  let releaseGet: (() => void) | undefined;
  try {
    await login(business, system.webUrl, email, password);
    await expect(business).toHaveURL(/\/profile$/);
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
    const initialSchedule = { 1: [{ startMinute: 540, endMinute: 1080 }] };
    // Direct API setup is not a UI save and occurs before the page request listener.
    const seededCalendar = await business.request.put(`${system.webUrl}/api/me/business-calendar`, {
      headers, data: { weeklySchedule: initialSchedule },
    });
    expect(seededCalendar.status()).toBe(200);
    const createdResource = await business.request.post(`${system.webUrl}/api/me/resources`, {
      headers, data: { name: "Recurso suspendido con horario", serviceIds: [],
        weeklySchedule: { 1: [{ startMinute: 600, endMinute: 660 }] } },
    });
    expect(createdResource.status()).toBe(201);
    const resource = await createdResource.json();
    expect(resource.status).toBe("active");
    const suspended = await business.request.put(`${system.webUrl}/api/me/resources/${resource.id}/status`, {
      headers, data: { status: "suspended" },
    });
    expect(suspended.status()).toBe(200);
    const originalResource = await suspended.json();
    expect(originalResource).toEqual({ ...resource, status: "suspended" });
    const readCalendar = async () => {
      const response = await business.request.get(`${system.webUrl}/api/me/business-calendar`);
      expect(response.status()).toBe(200);
      return response.json();
    };
    const readResource = async () => {
      const response = await business.request.get(`${system.webUrl}/api/me/resources`);
      expect(response.status()).toBe(200);
      const records = await response.json() as Array<{ id: string }>;
      return records.find(record => record.id === resource.id);
    };
    await business.goto(`${system.webUrl}/business-calendar`);
    const screen = business.getByRole("main");
    const summary = screen.getByRole("region", { name: "Horario semanal", exact: true });
    await expect(summary).toContainText("09:00 – 18:00");
    expect(await readResource()).toEqual(originalResource);
    const counts = { PUT: 0, GET: 0 };
    const bodies: unknown[] = [];
    // Page events exclude APIRequestContext readbacks and all resolved setup/load traffic.
    business.on("request", request => {
      if (new URL(request.url()).pathname !== "/api/me/business-calendar") return;
      if (request.method() === "PUT") { counts.PUT++; bodies.push(request.postDataJSON()); }
      if (request.method() === "GET") counts.GET++;
    });
    const opener = screen.getByRole("button", { name: "Editar horario", exact: true });
    const form = screen.getByRole("form", { name: "Editar horario", exact: true });
    const start = form.getByLabel("Inicio Lunes 1", { exact: true });
    const end = form.getByLabel("Fin Lunes 1", { exact: true });
    const save = form.getByRole("button", { name: "Guardar horario", exact: true });
    const warning = screen.getByRole("region", { name: "Actualizar horario", exact: true });
    const capture = async (state: string) => {
      for (const width of [1280, 360]) {
        await business.setViewportSize({ width, height: 900 });
        expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await business.screenshot({ path: testInfo.outputPath(`calendar-safety-${state}-${width}.png`), fullPage: true });
      }
    };
    const heldPut = new Promise<void>(resolve => { releasePut = resolve; });
    let holdPut = true, failGet = false, holdGet = false;
    const heldGet = new Promise<void>(resolve => { releaseGet = resolve; });
    await business.route("**/api/me/business-calendar", async route => {
      const method = route.request().method();
      if (method === "PUT" && holdPut) await heldPut;
      if (method === "GET" && holdGet) await heldGet;
      if (method === "GET" && failGet) {
        await route.fulfill({ status: 500, contentType: "application/json",
          body: '{"code":"INTERNAL_ERROR","message":"PRIVATE refresh diagnostic"}' });
      } else await route.continue(); // Every PUT, including 409, reaches the actual server.
    });
    await opener.click();
    await expect(start).toBeFocused();
    await start.fill("08:07");
    const firstSchedule = { 1: [{ startMinute: 487, endMinute: 1080 }] };
    // Two synchronous submit events exercise request ownership before a React rerender.
    await form.evaluate(node => {
      node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(opener).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(form.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
    await expect(start).toBeDisabled();
    await expect(end).toBeDisabled();
    for (const button of await form.getByRole("button").all()) await expect(button).toBeDisabled();
    await expect(warning).toHaveCount(0);
    // Also dispatch a normal submit-button click while the request is held.
    await save.dispatchEvent("click");
    await expect.poll(() => counts.PUT).toBe(1);
    expect(counts).toEqual({ PUT: 1, GET: 0 });
    expect(bodies).toEqual([{ weeklySchedule: firstSchedule }]);
    expect(await readCalendar()).toEqual({ weeklySchedule: initialSchedule });
    await capture("pending");
    const firstResponse = business.waitForResponse(response => response.url().endsWith("/api/me/business-calendar")
      && response.request().method() === "PUT");
    holdPut = false;
    releasePut!();
    const confirmedFirst = await firstResponse;
    expect(confirmedFirst.status()).toBe(200);
    expect(await confirmedFirst.json()).toEqual({ weeklySchedule: firstSchedule });
    await expect(form).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(summary).toContainText("08:07 – 18:00");
    expect(counts).toEqual({ PUT: 1, GET: 1 });
    expect(await readCalendar()).toEqual({ weeklySchedule: firstSchedule });
    expect(await readResource()).toEqual(originalResource);

    await opener.click();
    await start.fill("11:01");
    await end.fill("17:03");
    const conflictResponse = business.waitForResponse(response => response.url().endsWith("/api/me/business-calendar")
      && response.request().method() === "PUT");
    await save.click();
    const conflict = await conflictResponse;
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "CONFLICT" });
    await expect(screen.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("aria-busy", "false");
    await expect(start).toHaveValue("11:01");
    await expect(end).toHaveValue("17:03");
    await expect(save).toBeEnabled();
    await expect(save).toBeFocused();
    expect(counts).toEqual({ PUT: 2, GET: 1 });
    expect(bodies).toEqual([{ weeklySchedule: firstSchedule },
      { weeklySchedule: { 1: [{ startMinute: 661, endMinute: 1023 }] } }]);
    expect(await readCalendar()).toEqual({ weeklySchedule: firstSchedule });
    expect(await readResource()).toEqual(originalResource);
    await capture("real-conflict");
    // Cancel consumes failed-save focus; a fresh edit focuses its first input, not Save.
    await form.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(counts).toEqual({ PUT: 2, GET: 1 });
    await opener.click();
    await expect(start).toBeFocused();
    await expect(start).toHaveValue("08:07");
    await expect(end).toHaveValue("18:00");
    await expect(save).not.toBeFocused();
    expect(counts).toEqual({ PUT: 2, GET: 1 });

    await start.fill("07:03");
    await end.fill("19:11");
    const expandedSchedule = { 1: [{ startMinute: 423, endMinute: 1151 }] };
    failGet = true; // Only the GET after the real successful mutation is mocked.
    const savedResponse = business.waitForResponse(response => response.url().endsWith("/api/me/business-calendar")
      && response.request().method() === "PUT");
    await save.click();
    const saved = await savedResponse;
    expect(saved.status()).toBe(200);
    expect(await saved.json()).toEqual({ weeklySchedule: expandedSchedule });
    await expect(form).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(screen.getByRole("status")).toHaveText("Horario guardado");
    await expect(summary).toContainText("07:03 – 19:11");
    await expect(warning.getByRole("alert")).toHaveText("El horario está guardado, pero no se pudo actualizar la vista.");
    await expect(screen.locator(':scope > [role="alert"]')).toHaveCount(0);
    await expect(screen.getByText(/PRIVATE/)).toHaveCount(0);
    expect(counts).toEqual({ PUT: 3, GET: 2 });
    expect(bodies).toEqual([{ weeklySchedule: firstSchedule },
      { weeklySchedule: { 1: [{ startMinute: 661, endMinute: 1023 }] } }, { weeklySchedule: expandedSchedule }]);
    // Readback and summary are asserted before allowing any GET recovery.
    expect(await readCalendar()).toEqual({ weeklySchedule: expandedSchedule });
    expect(await readResource()).toEqual(originalResource);
    await capture("saved-warning");
    failGet = false;
    holdGet = true;
    const retry = warning.getByRole("button", { name: "Actualizar horario", exact: true });
    await retry.click();
    await expect(retry).toBeDisabled();
    await expect(opener).toBeDisabled();
    await expect(form).toHaveCount(0);
    expect(counts).toEqual({ PUT: 3, GET: 3 });
    releaseGet!();
    await expect(warning).toHaveCount(0);
    await expect(opener).toBeEnabled();
    await expect(summary).toContainText("07:03 – 19:11");
    expect(counts).toEqual({ PUT: 3, GET: 3 });
    await business.reload();
    await expect(summary).toContainText("07:03 – 19:11");
    await expect(form).toHaveCount(0);
    await expect(warning).toHaveCount(0);
    expect(counts).toEqual({ PUT: 3, GET: 4 });
    expect(await readCalendar()).toEqual({ weeklySchedule: expandedSchedule });
    expect(await readResource()).toEqual(originalResource);
  } finally {
    releasePut?.();
    releaseGet?.();
    await context.close();
  }
});


test("Horario rejects exclusion of a real future confirmed booking independently of resource hours", async ({ browser, page, system }, testInfo) => {
  const email = "calendar-future-c2@example.test", password = "calendar future proof password";
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  await page.getByLabel("Nombre", { exact: true }).fill("Horario Futuro C2");
  await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
  await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Horario Futuro C2", exact: true })).toBeVisible();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    await login(business, system.webUrl, email, password);
    await expect(business).toHaveURL(/\/profile$/);
    const sessionResponse = await business.request.get(`${system.webUrl}/api/auth/session`);
    expect(sessionResponse.status()).toBe(200);
    const session = await sessionResponse.json();
    expect(session.role).toBe("business_user");
    expect(session.businessId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
    const full = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
    const calendarResponse = await business.request.put(`${system.webUrl}/api/me/business-calendar`, {
      headers, data: { weeklySchedule: full },
    });
    expect(calendarResponse.status()).toBe(200);
    const calendarBefore = await calendarResponse.json();
    expect(calendarBefore).toEqual({ weeklySchedule: full });
    const serviceResponse = await business.request.post(`${system.webUrl}/api/me/services`, {
      headers, data: { name: "Servicio futuro C2", durationMinutes: 45, priceArs: 10 },
    });
    expect(serviceResponse.status()).toBe(201);
    const service = await serviceResponse.json();
    const resourceResponse = await business.request.post(`${system.webUrl}/api/me/resources`, {
      headers, data: { name: "Recurso futuro C2", serviceIds: [service.id], weeklySchedule: full },
    });
    expect(resourceResponse.status()).toBe(201);
    const resource = await resourceResponse.json();
    expect(resource.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const date = new Date(Date.now() + 7 * 86400000 - 3 * 3600000).toISOString().slice(0, 10);
    const target = Date.parse(`${date}T10:00:00-03:00`);
    const available = await business.request.get(`${system.webUrl}/api/me/appointments/availability?serviceId=${service.id}&resourceId=${resource.id}&date=${date}`);
    expect(available.status()).toBe(200);
    const slots = await available.json() as Array<{ start: string; startMs: number; endMs: number; resourceId: string; terms: object }>;
    const slot = slots.find(offer => offer.startMs === target);
    expect(slot).toBeDefined();
    expect(slot!.resourceId).toBe(resource.id);
    const bookingResponse = await business.request.post(`${system.webUrl}/api/me/appointments`, {
      headers, data: { date, serviceId: service.id, resourceId: resource.id, startRaw: slot!.start,
        expectedTerms: slot!.terms, confirmed: true,
        newClient: { firstName: "Cliente", lastName: "Futuro C2", phone: "+5491123456787" } },
    });
    expect(bookingResponse.status()).toBe(201);
    const appointment = await bookingResponse.json();
    expect(appointment).toMatchObject({ state: "confirmed", origin: "manual", startMs: slot!.startMs,
      endMs: slot!.endMs, terms: slot!.terms });
    expect(appointment.terms).toMatchObject({ serviceId: service.id, resourceId: resource.id });
    expect(appointment.startMs).toBeGreaterThan(Date.now());
    expect(appointment.endMs - appointment.startMs).toBe(45 * 60000);
    const read = async (path: string) => {
      const response = await business.request.get(`${system.webUrl}/api/${path}`);
      expect(response.status()).toBe(200);
      return response.json();
    };
    expect(await read(`me/appointments/${appointment.id}`)).toEqual(appointment);
    // Resource API correctly blocks this after booking: owned fixture SQL isolates only the calendar guard.
    await system.relaxResourceHoursForCalendarGuardFixture(session.businessId, resource.id);
    const resourcesBefore = [{ ...resource, weeklySchedule: {} }];
    expect(await read("me/resources")).toEqual(resourcesBefore); // Exactly one live owned resource; no other envelope cause.
    expect(await read("me/business-calendar")).toEqual(calendarBefore);
    expect(await read(`me/appointments/${appointment.id}`)).toEqual(appointment);

    const counts = { PUT: 0, GET: 0 };
    const bodies: unknown[] = [];
    business.on("request", request => {
      if (new URL(request.url()).pathname !== "/api/me/business-calendar") return;
      if (request.method() === "PUT") { counts.PUT++; bodies.push(request.postDataJSON()); }
      if (request.method() === "GET") counts.GET++;
    });
    await business.goto(`${system.webUrl}/business-calendar`);
    const screen = business.getByRole("main");
    const opener = screen.getByRole("button", { name: "Editar horario", exact: true });
    await expect(opener).toBeEnabled();
    expect(counts).toEqual({ PUT: 0, GET: 1 });
    await opener.click();
    const form = screen.getByRole("form", { name: "Editar horario", exact: true });
    const day = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"][new Date(`${date}T12:00:00-03:00`).getUTCDay()]!;
    const start = form.getByLabel(`Inicio ${day} 1`, { exact: true });
    const end = form.getByLabel(`Fin ${day} 1`, { exact: true });
    await start.fill("11:01");
    await end.fill("17:03");
    const draft = { ...full, [new Date(`${date}T12:00:00-03:00`).getUTCDay()]: [{ startMinute: 661, endMinute: 1023 }] };
    expect(appointment.endMs).toBeLessThan(Date.parse(`${date}T11:01:00-03:00`));
    const save = form.getByRole("button", { name: "Guardar horario", exact: true });
    const pendingResponse = business.waitForResponse(response => response.url().endsWith("/api/me/business-calendar")
      && response.request().method() === "PUT");
    await save.click();
    const conflict = await pendingResponse;
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "CONFLICT" });
    await expect(screen.getByRole("alert")).toHaveText("Los datos cambiaron. Recargá y volvé a intentar.");
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute("aria-busy", "false");
    await expect(start).toHaveValue("11:01");
    await expect(end).toHaveValue("17:03");
    await expect(save).toBeEnabled();
    await expect(save).toBeFocused();
    expect(counts).toEqual({ PUT: 1, GET: 1 });
    expect(bodies).toEqual([{ weeklySchedule: draft }]);
    // APIRequestContext readbacks are separate from page-only GET/PUT measurements.
    expect(await read("me/business-calendar")).toEqual(calendarBefore);
    expect(await read(`me/appointments/${appointment.id}`)).toEqual(appointment);
    expect(await read("me/resources")).toEqual(resourcesBefore);
    expect(counts).toEqual({ PUT: 1, GET: 1 });
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`calendar-future-conflict-${width}.png`), fullPage: true });
    }
  } finally {
    await context.close();
  }
});

test("Closures read independently in Argentina time without calendar writes", async ({ browser, page, system }, testInfo) => {
  const password = "closures read password safe";
  const emails = ["closures-read@example.test", "other-closures-read@example.test"];
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  for (const [index, email] of emails.entries()) {
    await page.getByLabel("Nombre", { exact: true }).fill(`Cierres Lectura ${index}`);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await expect(page.getByRole("cell", { name: `Cierres Lectura ${index}`, exact: true })).toBeVisible();
  }
  const adminReads: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/me/business-calendar/closures") adminReads.push(request.method());
  });
  await page.goto(`${system.webUrl}/business-calendar`);
  await expect(page.locator('main[data-state="denied"]')).toBeVisible();
  expect(adminReads).toEqual([]);
  const context = await browser.newContext({ timezoneId: "UTC", viewport: { width: 1280, height: 900 } });
  const otherContext = await browser.newContext({ timezoneId: "UTC" });
  const business = await context.newPage(), other = await otherContext.newPage();
  try {
    await login(business, system.webUrl, emails[0]!, password);
    await expect(business).toHaveURL(/\/profile$/);
    await login(other, system.webUrl, emails[1]!, password);
    await expect(other).toHaveURL(/\/profile$/);
    const counts = { closureGET: 0, weeklyGET: 0, mutations: 0 };
    business.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path !== "/api/me/business-calendar/closures" && path !== "/api/me/business-calendar") return;
      if (request.method() !== "GET") counts.mutations++;
      else if (path.endsWith("/closures")) counts.closureGET++;
      else counts.weeklyGET++;
    });
    await business.goto(`${system.webUrl}/business-calendar`);
    const region = business.getByRole("region", { name: "Cierres del negocio", exact: true });
    await expect(region).toBeVisible();
    await expect(region.getByText("No hay cierres guardados. El horario semanal sigue siendo la referencia de atención.", { exact: true })).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("closures-empty.png"), fullPage: true });
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
    const endpoint = `${system.webUrl}/api/me/business-calendar/closures`;
    const dates: Array<{ id: string; kind: "date"; date: string }> = [];
    for (let index = 0; index < 2; index++) {
      const response = await business.request.post(endpoint, { headers, data: { kind: "date", date: "2035-02-02" } });
      expect(response.status()).toBe(201);
      dates.push(await response.json());
    }
    dates.sort((a, b) => a.id.localeCompare(b.id));
    for (const [index, record] of dates.entries()) {
      const response = await business.request.put(`${endpoint}/${record.id}`, {
        headers, data: { kind: "date", date: index === 0 ? "2035-02-02" : "2035-01-01" },
      });
      expect(response.status()).toBe(200);
    }
    const raw = [
      ["2035-01-02T02:04:05.006+02:00", "2035-01-02T03:04:05.006+02:00"],
      ["2035-01-02T02:04:05.006+02:00", "2035-01-02T03:04:05.006+02:00"],
      ["2035-01-02T02:34:05.006+02:00", "2035-01-02T03:34:05.006+02:00"],
      ["2035-01-02T03:04:05.006+02:00", "2035-01-02T04:04:05.006+02:00"],
    ];
    for (const [start, end] of raw) {
      const response = await business.request.post(endpoint, { headers, data: { kind: "interval", start, end } });
      expect(response.status()).toBe(201);
    }
    const response = await business.request.get(endpoint);
    expect(response.status()).toBe(200);
    const records = await response.json() as Array<{ id: string; kind: "date" | "interval"; date?: string; start?: string; end?: string }>;
    expect(records).toHaveLength(6);
    expect(records.map(record => record.id)).toEqual(records.map(record => record.id).sort());
    expect(records.filter(record => record.kind === "date").map(record => record.date)).toEqual(["2035-02-02", "2035-01-01"]);
    expect(records.filter(record => record.kind === "interval").map(record => [record.start, record.end]).sort()).toEqual([...raw].sort());
    await business.reload();
    const rows = region.locator("li");
    await expect(rows).toHaveCount(6);
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-closure-id")))).toEqual(records.map(record => record.id));
    const local: Record<string, string> = {
      "2035-01-02T02:04:05.006+02:00": "01/01/2035, 21:04:05.006 (Argentina, GMT-03:00)",
      "2035-01-02T03:04:05.006+02:00": "01/01/2035, 22:04:05.006 (Argentina, GMT-03:00)",
      "2035-01-02T02:34:05.006+02:00": "01/01/2035, 21:34:05.006 (Argentina, GMT-03:00)",
      "2035-01-02T03:34:05.006+02:00": "01/01/2035, 22:34:05.006 (Argentina, GMT-03:00)",
      "2035-01-02T04:04:05.006+02:00": "01/01/2035, 23:04:05.006 (Argentina, GMT-03:00)",
    };
    for (const [index, record] of records.entries()) {
      await expect(rows.nth(index).locator("p")).toHaveText(record.kind === "date" ?
        [`Día completo: ${record.date === "2035-02-02" ? "02/02/2035" : "01/01/2035"}`] :
        [`Desde: ${local[record.start!]}`, `Hasta: ${local[record.end!]}`]);
    }
    await other.goto(`${system.webUrl}/business-calendar`);
    await expect(other.getByRole("region", { name: "Cierres del negocio" }).getByText("No hay cierres guardados. El horario semanal sigue siendo la referencia de atención.", { exact: true })).toBeVisible();
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`closures-list-${width}.png`), fullPage: true });
    }
    let fail = true, hold = false;
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    await business.route("**/api/me/business-calendar/closures", async route => {
      expect(route.request().method()).toBe("GET");
      if (hold) await gate;
      if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "PRIVATE diagnostic" } }) });
      else await route.continue();
    });
    await business.reload();
    await expect(region.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await expect(business.getByText(/PRIVATE/)).toHaveCount(0);
    await expect(business.getByRole("heading", { name: "Horario sin configurar", exact: true })).toBeVisible();
    await business.getByRole("button", { name: "Editar horario", exact: true }).click();
    await expect(business.getByRole("form", { name: "Editar horario", exact: true })).toBeVisible();
    await business.getByRole("button", { name: "Cancelar", exact: true }).click();
    await business.screenshot({ path: testInfo.outputPath("closures-error.png"), fullPage: true });
    const retry = region.getByRole("button", { name: "Volver a cargar cierres", exact: true });
    const before = { ...counts };
    await retry.click();
    await expect(retry).toBeEnabled();
    await expect(retry).toBeFocused();
    expect(counts).toEqual({ ...before, closureGET: before.closureGET + 1 });
    fail = false;
    hold = true;
    await retry.evaluate(button => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await expect(region).toHaveAttribute("aria-busy", "true");
    await expect(retry).toBeDisabled();
    await expect.poll(() => counts.closureGET).toBe(before.closureGET + 2);
    expect(counts).toEqual({ ...before, closureGET: before.closureGET + 2 });
    await business.screenshot({ path: testInfo.outputPath("closures-retry-pending.png"), fullPage: true });
    release();
    await expect(rows).toHaveCount(6);
    await expect(region).toHaveAttribute("aria-busy", "false");
    await expect(region.getByRole("heading", { name: "Cierres del negocio", exact: true })).toBeFocused();
    expect(counts).toEqual({ ...before, closureGET: before.closureGET + 2 });
    expect(counts.mutations).toBe(0);
  } finally {
    await context.close();
    await otherContext.close();
  }
});

for (const interruption of ["initial", "retry"] as const) {
  test(`Closures recover after failed logout interrupts ${interruption} GET`, async ({ browser, page, system }, testInfo) => {
    const email = `closures-logout-${interruption}@example.test`, password = "closure logout safe password";
    await login(page, system.webUrl, system.admin.email, system.admin.password);
    await expect(page).toHaveURL(/\/businesses$/);
    await page.getByLabel("Nombre", { exact: true }).fill(`Cierres Logout ${interruption}`);
    await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
    await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
    await expect(page.getByRole("cell", { name: `Cierres Logout ${interruption}`, exact: true })).toBeVisible();
    const context = await browser.newContext({ timezoneId: "UTC", viewport: { width: 1280, height: 900 } });
    const business = await context.newPage();
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await login(business, system.webUrl, email, password);
      await expect(business).toHaveURL(/\/profile$/);
      const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
      expect(csrf).toBeTruthy();
      const endpoint = `${system.webUrl}/api/me/business-calendar/closures`;
      const seeded = await business.request.post(endpoint, {
        headers: { Origin: system.webUrl, "x-csrf-token": csrf! }, data: { kind: "date", date: "2035-01-01" },
      });
      expect(seeded.status()).toBe(201);
      const record = await seeded.json();
      const counts = { closureGET: 0, weeklyGET: 0, mutations: 0, logoutPOST: 0 };
      business.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (path === "/api/auth/logout" && request.method() === "POST") counts.logoutPOST++;
        if (path !== "/api/me/business-calendar/closures" && path !== "/api/me/business-calendar") return;
        if (request.method() !== "GET") counts.mutations++;
        else if (path.endsWith("/closures")) counts.closureGET++;
        else counts.weeklyGET++;
      });
      let hold = interruption === "initial", fail = interruption === "retry";
      await business.route("**/api/me/business-calendar/closures", async route => {
        expect(route.request().method()).toBe("GET");
        if (hold) await gate;
        if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "PRIVATE closure" } }) });
        else {
          try { await route.continue(); } catch (cause) {
            if (route.request().failure()?.errorText !== "net::ERR_ABORTED") throw cause;
          }
        }
      });
      await business.route("**/api/auth/logout", route => route.fulfill({ status: 500, contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "PRIVATE logout" } }) }));
      await business.goto(`${system.webUrl}/business-calendar`);
      const region = business.getByRole("region", { name: "Cierres del negocio", exact: true });
      const retry = region.getByRole("button", { name: "Volver a cargar cierres", exact: true });
      if (interruption === "retry") {
        await expect(region.getByRole("alert")).toHaveText("No se pudo completar la operación.");
        fail = false;
        hold = true;
        await retry.click();
      }
      await expect(region).toHaveAttribute("aria-busy", "true");
      await expect(retry).toBeDisabled();
      const before = { ...counts };
      const logout = business.getByRole("button", { name: "Cerrar sesión", exact: true });
      await logout.click();
      await expect(logout).toBeEnabled();
      await expect(retry).toBeEnabled();
      await expect(region).toHaveAttribute("aria-busy", "false");
      await expect(region.getByRole("alert")).toHaveText("No se pudo completar la operación.");
      await expect(business.getByText(/PRIVATE/)).toHaveCount(0);
      await expect(business.getByRole("heading", { name: "Horario sin configurar", exact: true })).toBeVisible();
      await business.screenshot({ path: testInfo.outputPath(`closures-${interruption}-logout-recovery.png`), fullPage: true });
      hold = false;
      release();
      await retry.click();
      await expect(region.locator("li")).toHaveAttribute("data-closure-id", record.id);
      await expect(region.getByText("Día completo: 01/01/2035", { exact: true })).toBeVisible();
      await business.getByRole("button", { name: "Editar horario", exact: true }).click();
      await business.getByRole("button", { name: "Cancelar", exact: true }).click();
      expect(counts).toEqual({ ...before, closureGET: before.closureGET + 1, logoutPOST: 1 });
    } finally {
      release();
      await context.close();
    }
  });
}

test("Closures retain ordered records through refresh failure and interrupted logout", async ({ browser, page, system }, testInfo) => {
  const email = "closures-refresh@example.test", password = "closure refresh safe password";
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  await page.getByLabel("Nombre", { exact: true }).fill("Cierres Actualizar");
  await page.getByLabel("Correo del usuario", { exact: true }).fill(email);
  await page.getByLabel("Contraseña inicial", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Crear negocio", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Cierres Actualizar", exact: true })).toBeVisible();
  const context = await browser.newContext({ timezoneId: "UTC", viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  let release = () => {};
  let gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await login(business, system.webUrl, email, password);
    await expect(business).toHaveURL(/\/profile$/);
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const endpoint = `${system.webUrl}/api/me/business-calendar/closures`;
    const inputs = [
      { kind: "date", date: "2035-02-02" },
      { kind: "interval", start: "2035-01-02T02:04:05.006+02:00", end: "2035-01-02T03:04:05.006+02:00" },
      { kind: "date", date: "2035-02-02" },
    ];
    for (const data of inputs) {
      const response = await business.request.post(endpoint, { headers: { Origin: system.webUrl, "x-csrf-token": csrf! }, data });
      expect(response.status()).toBe(201);
    }
    const readback = await business.request.get(endpoint);
    expect(readback.status()).toBe(200);
    const records = await readback.json() as Array<{ id: string }>;
    await business.goto(`${system.webUrl}/business-calendar`);
    const region = business.getByRole("region", { name: "Cierres del negocio", exact: true });
    const rows = region.locator("li");
    await expect(rows).toHaveCount(3);
    const original = await rows.allTextContents();
    const counts = { GET: 0, mutations: 0, weeklyGET: 0 };
    business.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/me/business-calendar/closures") {
        if (request.method() === "GET") counts.GET++; else counts.mutations++;
      } else if (path === "/api/me/business-calendar") {
        if (request.method() === "GET") counts.weeklyGET++; else counts.mutations++;
      }
    });
    const refresh = region.getByRole("button", { name: "Actualizar cierres", exact: true });
    await expect(refresh).toBeVisible(); // RED: the ready list has no refresh control on the base.
    let hold = true, fail = true;
    await business.route("**/api/me/business-calendar/closures", async route => {
      expect(route.request().method()).toBe("GET");
      if (hold) await gate;
      if (fail) await route.fulfill({ status: 500, contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "PRIVATE refresh" } }) });
      else await route.continue();
    });
    await refresh.evaluate(button => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect(region).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toBeDisabled();
    await expect(rows).toHaveText(original);
    await expect.poll(() => counts.GET).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("closures-refresh-pending.png"), fullPage: true });
    release();
    await expect(region).toHaveAttribute("aria-busy", "false");
    await expect(region.getByRole("alert")).toHaveText("No se pudo actualizar la lista de cierres. Los datos visibles pueden estar desactualizados.");
    await expect(rows).toHaveText(original);
    await expect(business.getByText(/PRIVATE/)).toHaveCount(0);
    const retry = region.getByRole("button", { name: "Volver a cargar cierres", exact: true });
    await expect(retry).toBeEnabled();
    await expect(retry).toBeFocused();
    await expect(business.getByRole("heading", { name: "Horario sin configurar", exact: true })).toBeVisible();
    await business.getByRole("button", { name: "Editar horario", exact: true }).click();
    await business.getByRole("button", { name: "Cancelar", exact: true }).click();
    await business.screenshot({ path: testInfo.outputPath("closures-refresh-warning.png"), fullPage: true });
    hold = false;
    fail = false;
    await retry.click();
    await expect(region.getByRole("alert")).toHaveCount(0);
    await expect(refresh).toBeEnabled();
    await expect(region.getByRole("heading", { name: "Cierres del negocio", exact: true })).toBeFocused();
    await expect(rows).toHaveText(original);
    expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-closure-id")))).toEqual(records.map(record => record.id));
    expect(counts).toEqual({ GET: 2, mutations: 0, weeklyGET: 0 });
    await business.screenshot({ path: testInfo.outputPath("closures-refresh-recovered.png"), fullPage: true });
    gate = new Promise<void>(resolve => { release = resolve; });
    hold = true;
    await business.route("**/api/auth/logout", route => route.fulfill({ status: 500, contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "PRIVATE logout" } }) }));
    await refresh.click();
    await expect(region).toHaveAttribute("aria-busy", "true");
    const logout = business.getByRole("button", { name: "Cerrar sesión", exact: true });
    await logout.click();
    await expect(logout).toBeEnabled();
    await expect(region).toHaveAttribute("aria-busy", "false");
    await expect(retry).toBeEnabled();
    await expect(rows).toHaveText(original);
    await expect(region.getByRole("alert")).toHaveText("No se pudo actualizar la lista de cierres. Los datos visibles pueden estar desactualizados.");
    await business.screenshot({ path: testInfo.outputPath("closures-refresh-logout-warning.png"), fullPage: true });
    // Settle the old aborted route without issuing a late real GET.
    fail = true;
    release();
    await expect.poll(() => counts.GET).toBe(3);
    hold = false;
    fail = false;
    await retry.click();
    await expect(region.getByRole("alert")).toHaveCount(0);
    await expect(rows).toHaveText(original);
    await expect(region.getByRole("heading", { name: "Cierres del negocio", exact: true })).toBeFocused();
    expect(counts).toEqual({ GET: 4, mutations: 0, weeklyGET: 0 });
  } finally {
    release();
    await context.close();
  }
});
