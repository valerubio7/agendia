import { expect, type Locator, type Page } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

function choice(form: Locator, group: string, value: string) {
  return form.getByRole("group", { name: group, exact: true }).getByRole("radio")
    .and(form.locator(`input[value=${JSON.stringify(value)}]`));
}

async function feedbackMetrics(page: Page, selector: string) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    return { fonts, ...await page.locator(selector).evaluate(el => {
      const css = getComputedStyle(el);
      const { x, y, width, height } = el.getBoundingClientRect();
      return { font: css.font, color: css.color, background: css.backgroundColor,
        duration: css.animationDuration, easing: css.animationTimingFunction,
        keyframes: (el.getAnimations()[0]?.effect as KeyframeEffect | undefined)?.getKeyframes(),
        box: { x, y, width, height }, hit: el.contains(document.elementFromPoint(x + width / 2, y + height / 2)) };
    }) };
  } finally { await session.detach(); }
}

async function closeTurno(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Cerrar ventana de turno", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function provision(admin: Page, business: Page, system: { webUrl: string; admin: { email: string; password: string } }, suffix: string) {
  const email = `${suffix}@example.test`, password = "turnos isolated password";
  await login(admin, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(admin).toHaveURL(/\/solicitudes$/);
  await createBusinessInAdminUi(admin, { name: `Turnos ${suffix}`, email, password });
  await login(business, system.webUrl, email, password);
  await expect(business).toHaveURL(/\/inicio$/);
  const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
  expect(csrf).toBeTruthy();
  const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
  const create = async (path: string, data: object) => {
    const response = await business.request.post(`${system.webUrl}/api/me/${path}`, { headers, data });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const read = async (path: string) => {
    const response = await business.request.get(`${system.webUrl}/api/me/${path}`, { maxRetries: 1 });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const full = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
  const calendar = await business.request.put(`${system.webUrl}/api/me/business-calendar`, { headers, data: { weeklySchedule: full } });
  expect(calendar.status()).toBe(200);
  const client = await create("clients", { firstName: "Clara", lastName: "López", phone: "+5491123456777" });
  const service = await create("services", { name: "Servicio de prueba", durationMinutes: 30, priceArs: 0 });
  const resource = await create("resources", { name: "Recurso de prueba", serviceIds: [service.id], weeklySchedule: full });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + 2 * 86400000));
  const offers = await read(`appointments/availability?${new URLSearchParams({ serviceId: service.id, resourceId: resource.id, date })}`);
  const offer = offers.find((slot: { startMs: number }) => slot.startMs >= Date.parse(`${date}T10:00:00-03:00`));
  expect(offer).toBeDefined();
  return { email, password, headers, create, read, client, service, resource, date, offers, offer };
}

test("Floating Nuevo turno preserves business routes and focus without competing with integration modals", async ({ browser, page, system }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const { read } = await provision(page, business, system, "floating-turno");
    const writes: string[] = [];
    business.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/me/") && !["GET", "HEAD"].includes(request.method())) writes.push(`${request.method()} ${path}`);
    });
    const start = business.getByRole("button", { name: "Nuevo turno", exact: true });
    const booking = business.getByRole("dialog", { name: "Nuevo turno", exact: true });
    for (const [index, [path, integration]] of [
      ["/services"], ["/resources"], ["/profile"], ["/business-calendar"], ["/clients"],
      ["/agent", "Asistente IA"], ["/whatsapp", "WhatsApp"], ["/inicio"], ["/turnos"],
    ].entries()) {
      const mobile = index % 2 === 1;
      await business.setViewportSize({ width: mobile ? 360 : 1280, height: 900 });
      const entry = `${system.webUrl}${path}?from=booking-test`;
      const origin = integration ? `${system.webUrl}/profile` : entry;
      await business.goto(entry);
      if (integration) {
        const panel = business.getByRole("dialog", { name: integration, exact: true });
        const close = panel.getByRole("button", { name: "Cerrar panel", exact: true });
        await expect(business).toHaveURL(entry);
        await expect(panel.and(business.locator("dialog:modal"))).toBeVisible();
        await expect(business.getByRole("dialog")).toHaveCount(1);
        await expect(close).toBeFocused();
        await expect(start).toHaveCount(0);
        const backgroundFab = business.getByRole("button", { name: "Nuevo turno", exact: true, includeHidden: true });
        await expect(backgroundFab).toHaveCount(1);
        await expect(backgroundFab).toBeHidden();
        await backgroundFab.evaluate(button => (button as HTMLButtonElement).focus());
        await expect(close).toBeFocused();
        await expect(booking).toBeHidden();
        if (mobile) await business.keyboard.press("Escape");
        else await close.click();
        await expect(panel).toBeHidden();
        await expect(business).toHaveURL(origin);
        await expect(business.getByRole("link", { name: integration, exact: true })).toBeFocused();
      }
      await expect(start).toBeEnabled();
      await expect(start).toHaveCount(1);
      await expect(start).toHaveCSS("position", "fixed");
      await start.click();
      await expect(booking.getByRole("heading", { name: "Nuevo turno", exact: true })).toBeFocused();
      await expect(booking.getByRole("form", { name: "Crear turno", exact: true })).toBeVisible();
      await expect(business).toHaveURL(origin);
      if (mobile) await booking.getByRole("button", { name: "Cancelar formulario", exact: true }).click();
      else await business.keyboard.press("Escape");
      await expect(booking).toBeHidden();
      await expect(business).toHaveURL(origin);
      await expect(start).toBeFocused();
    }
    expect(writes).toEqual([]);
    expect(await read("appointments")).toEqual([]);
    await expect(page.getByRole("button", { name: "Nuevo turno", exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test("Inicio keeps the next appointment time inside its card without overlapping details", async ({ browser, page, system }, info) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const business = await context.newPage();
    const { client, service, resource, date, offer, create } = await provision(page, business, system, "inicio-time-fit");
    await create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    await business.clock.setFixedTime(new Date(`${date}T03:00:00Z`));
    await business.goto(`${system.webUrl}/inicio`);
    const card = business.getByRole("region", { name: "Próximo turno" }).getByRole("button");
    await expect(card.locator("time")).toHaveText("10:00");
    for (const widerFont of [false, true]) {
      if (widerFont) {
        // Exercise a wider system font deterministically, without depending on the host's installed faces.
        await business.addStyleTag({ content: `@font-face { font-family: "Test Wide Fallback"; src: url("/fonts/JetBrainsMono.ttf"); font-weight: 100 800; }
          .business-home__next time { font-family: "Test Wide Fallback", monospace; }` });
        await business.evaluate(() => document.fonts.load('760 62px "Test Wide Fallback"').then(() => undefined));
      }
      for (const width of [1280, 1051, 1050, 961, 960, 921, 920, 751, 750, 641, 640, 376, 375, 360, 320]) {
        await business.setViewportSize({ width, height: 900 });
        const geometry = await card.evaluate(button => {
          const time = button.querySelector("time")!;
          const text = document.createRange();
          text.selectNodeContents(time);
          const { left, right, top, bottom } = text.getBoundingClientRect();
          const card = button.getBoundingClientRect();
          const person = button.querySelector(".business-home__person")!.getBoundingClientRect();
          return { left, right, top, bottom, lines: text.getClientRects().length, cardLeft: card.left, cardRight: card.right,
            cardTop: card.top, cardBottom: card.bottom, personLeft: person.left, personTop: person.top,
            pageFits: document.documentElement.scrollWidth <= innerWidth };
        });
        const { left, right, top, bottom, cardLeft, cardRight, cardTop, cardBottom, personLeft, personTop, pageFits } = geometry;
        const message = `${width}px (${widerFont ? "wide fallback" : "default"}): ${JSON.stringify(geometry)}`;
        expect.soft(pageFits, message).toBe(true);
        expect.soft(geometry.lines, message).toBe(1);
        expect.soft(left >= cardLeft && right <= cardRight && top >= cardTop && bottom <= cardBottom, message).toBe(true);
        expect.soft(right <= personLeft || bottom <= personTop, message).toBe(true);
        if ([1280, 921, 360].includes(width)) await business.screenshot({ path: info.outputPath(`inicio-time-${width}-${widerFont ? "wide" : "default"}.png`) });
      }
    }
  } finally { await context.close(); }
});

test("Semana stacks every appointment in a busy day and opens the last one", async ({ browser, page, system }, info) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const business = await context.newPage();
    const { client, service, resource, date, offers, create } = await provision(page, business, system, "week-uncapped");
    const times = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"];
    for (const time of [...times].reverse()) {
      const slot = offers.find((slot: { startMs: number }) => slot.startMs === Date.parse(`${date}T${time}:00-03:00`));
      expect(slot).toBeDefined();
      await create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
        date, startRaw: slot.start, expectedTerms: slot.terms, confirmed: true });
    }
    await business.clock.setFixedTime(new Date(`${date}T03:00:00Z`));
    await business.goto(`${system.webUrl}/turnos`);
    await business.getByRole("button", { name: "Semana", exact: true }).click();
    const week = business.getByRole("region", { name: "Vista semanal" });
    const day = week.getByRole("group", { name: `Turnos ${date}`, exact: true });
    await expect(week.getByText("8 turnos", { exact: true }).last()).toBeVisible();
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      await expect.soft(day.locator("time"), `${width}px`).toHaveText(times, { timeout: 1500 });
      await expect.soft(day.getByText("+3 turnos", { exact: true })).toHaveCount(0, { timeout: 1500 });
      if (await day.getByRole("button").count() !== times.length) continue;
      const boxes = await day.getByRole("button").evaluateAll(rows => rows.map(row => {
        const { x, top, bottom } = row.getBoundingClientRect();
        return { x, top, bottom };
      }));
      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i]!.x).toBe(boxes[0]!.x);
        expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom);
      }
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const last = day.getByRole("button", { name: /13:30/ });
      await last.scrollIntoViewIfNeeded();
      await business.screenshot({ path: info.outputPath(`week-eight-appointments-${width}.png`), fullPage: true });
      await last.click();
      await expect(business.getByRole("region", { name: "Detalle del turno" }).getByText(/13:30/).first()).toBeVisible();
      await closeTurno(business);
      await expect(last).toBeFocused();
    }
  } finally { await context.close(); }
});

test("Agenda reads a 48-hour appointment overlapping Monday without listing a Monday start", async ({ page, browser, system }) => {
  const context = await browser.newContext();
  try {
    const business = await context.newPage();
    const setup = await provision(page, business, system, "agenda-overlap");
    const saturday = new Date(`${setup.date}T12:00:00Z`);
    saturday.setUTCDate(saturday.getUTCDate() + (6 - saturday.getUTCDay() + 7) % 7);
    const date = saturday.toISOString().slice(0, 10);
    const monday = new Date(saturday.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const service = await setup.create("services", { name: "Servicio prolongado", durationMinutes: 2880, priceArs: 0 });
    const resource = await setup.create("resources", { name: "Recurso continuo", serviceIds: [service.id],
      weeklySchedule: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]])) });
    const offers = await setup.read(`appointments/availability?${new URLSearchParams({ serviceId: service.id, resourceId: resource.id, date })}`);
    const noon = offers.find((slot: { startMs: number }) => slot.startMs === Date.parse(`${date}T12:00:00-03:00`));
    expect(noon).toBeDefined();
    const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: setup.client.id,
      date, startRaw: noon.start, expectedTerms: noon.terms, confirmed: true });
    const bounds = new URLSearchParams({ from: `${monday}T00:00:00-03:00`, to: `${monday}T23:59:59.999-03:00` });
    expect(await setup.read(`appointments?${bounds}`)).toEqual([]);
    await business.clock.setFixedTime(new Date(`${monday}T03:00:00Z`));
    await business.goto(`${system.webUrl}/inicio`);
    await expect(business.getByRole("region", { name: "Turnos de hoy" }).getByText("No hay turnos para hoy.")).toBeVisible();
    await business.goto(`${system.webUrl}/turnos`);
    await business.getByRole("button", { name: resource.name, exact: true }).click();
    const day = business.getByRole("region", { name: "Turnos del día" });
    await expect(day.getByText("12:00 — 24:00", { exact: true })).toBeVisible();
    await expect(day.getByText("No hay turnos para este día.")).toBeVisible();
    await expect(day.getByRole("button", { name: /Clara López/ })).toHaveCount(0);
    expect((await setup.read(`appointments?${bounds}&overlap=true`)).map((row: { id: string }) => row.id)).toEqual([saved.id]);
    await business.getByRole("button", { name: "Semana", exact: true }).click();
    const column = business.locator(".ag-week-col").first();
    await expect(column.getByText("12 h libres")).toBeVisible();
    await expect(column.getByLabel("Ocupación aproximada")).toHaveAttribute("aria-valuenow", "50");

    let started!: () => void, release!: () => void;
    const refreshing = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    await business.route("**/api/me/appointments?*", async route => { started(); await blocked; await route.continue(); });
    try {
      await business.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
      await refreshing;
      await expect(column.getByText("Sin datos de disponibilidad")).toBeVisible();
      await expect(column.getByLabel("Ocupación aproximada")).toHaveCount(0);
      await expect(column.getByText("Sin reservas")).toHaveCount(0);
      await expect(column.getByText("0 turnos")).toHaveCount(0);
    } finally { release(); }
    await expect(column.getByText("12 h libres")).toBeVisible();
  } finally { await context.close(); }
});

for (const width of [1280, 360]) {
  test(`Inicio books and shows the saved Argentina-day appointment at ${width}px`, async ({ browser, page, system }, testInfo) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "UTC" });
    const business = await context.newPage();
    try {
      const { client, service, resource, date, offer, read } = await provision(page, business, system, `inicio-${width}`);
      // The API uses real time. Freeze only the browser on the future fixture day.
      await business.clock.install({ time: new Date(`${date}T03:00:00Z`) });
      await business.reload();
      const today = business.getByRole("region", { name: "Turnos de hoy", exact: true });
      await expect(today.getByText("No hay turnos para hoy.", { exact: true })).toBeVisible();
      await business.screenshot({ path: testInfo.outputPath(`inicio-empty-${width}.png`) });
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const create = business.getByRole("button", { name: "Nuevo turno", exact: true });
      await expect(create).toBeEnabled();
      const fab = await create.getByText("Nuevo turno", { exact: true }).evaluate(async label => {
        await document.fonts.ready;
        const text = document.createRange();
        text.selectNodeContents(label);
        const { width, height, right, bottom } = label.closest("button")!.getBoundingClientRect();
        return { width, height, right, bottom, labelWidth: text.getBoundingClientRect().width, lines: text.getClientRects().length };
      });
      const mobile = width === 360;
      // The label follows the installed font; the padding, icon and gap do not.
      const chromeWidth = mobile ? 7 + 34 + 11 + 14 : 9 + 35 + 11 + 18;
      expect(fab.lines).toBe(1);
      expect(fab.width).toBeCloseTo(fab.labelWidth + chromeWidth, 1);
      expect(fab.height).toBe(mobile ? 52 : 56);
      expect(width - fab.right).toBe(mobile ? 14 : 24);
      expect(900 - fab.bottom).toBe(mobile ? 14 : 24);
      await expect(create).toHaveCSS("background-color", "rgb(255, 107, 73)");
      await create.screenshot({ path: testInfo.outputPath(`floating-button-${width}.png`) });
      await create.click();
      const dialog = business.getByRole("dialog", { name: "Nuevo turno", exact: true });
      await expect(dialog.getByRole("heading", { name: "Nuevo turno", exact: true })).toBeFocused();
      const form = dialog.getByRole("form", { name: "Crear turno", exact: true });
      await expect(form.getByLabel("Fecha", { exact: true })).toHaveValue(date);
      await business.screenshot({ path: testInfo.outputPath(`booking-${width}.png`) });
      const reviewButton = form.getByRole("button", { name: "Revisar turno", exact: true });
      await expect(reviewButton).toBeEnabled();
      await reviewButton.click();
      const validation = form.locator(".turno-error[role=alert]");
      await expect(validation).toHaveText("Elegí el servicio antes de guardar.");
      await expect(business.locator(".toast-area .toast")).toHaveText("Elegí el servicio antes de guardar.");
      expect(await read("appointments")).toEqual([]);
      await business.screenshot({ path: testInfo.outputPath(`validation-${width}.png`), animations: "disabled" });
      await form.getByLabel("Buscar cliente por nombre o teléfono", { exact: true }).fill(client.firstName);
      await form.getByRole("button", { name: "Buscar cliente", exact: true }).click();
      await form.getByRole("list", { name: "Resultados de clientes", exact: true }).getByRole("button", { name: /Clara López/ }).click();
      await choice(form, "Servicio", service.id).check();
      await form.getByRole("combobox", { name: "Recurso", exact: true }).selectOption(resource.id);
      await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
      await choice(form, "Horarios disponibles", offer.start).check();
      await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
      const confirm = form.getByRole("button", { name: "Confirmar turno", exact: true });
      const review = form.getByRole("region", { name: "Revisá el turno" });
      await expect(review).toContainText("Clara López");
      await expect(review).toContainText(service.name);
      await expect(form.getByRole("group", { name: "Servicio", exact: true })).toBeHidden();
      await expect(confirm).toBeFocused();
      await business.screenshot({ path: testInfo.outputPath(`review-${width}.png`) });
      expect(await read("appointments")).toHaveLength(0);
      const toast = business.locator(".toast-area[role=status] > .toast");
      await expect(validation).toBeEmpty();
      await expect(toast.filter({ hasText: "Turno guardado" })).toHaveCount(0);
      // Freeze the browser clock for the four-second lifetime without delaying the real POST.
      await business.clock.pauseAt(new Date(await business.evaluate(() => Date.now() + 1000)));
      await confirm.click();
      const detail = business.getByRole("region", { name: "Detalle del turno", exact: true });
      await expect(detail.getByRole("heading", { name: "Clara López", exact: true })).toBeFocused();
      await expect(toast).toHaveText("Turno guardado");
      await expect(toast).toHaveCSS("background-color", "rgb(30, 62, 42)");
      await expect(toast).toHaveCSS("font-size", "13px");
      await expect(toast).toHaveCSS("line-height", "18.85px");
      await expect(toast).toHaveCSS("animation-duration", "0.23s");
      await expect(toast).toHaveCSS("animation-timing-function", "ease-out");
      await business.screenshot({ path: testInfo.outputPath(`detail-${width}.png`), animations: "disabled" });
      const metrics = await feedbackMetrics(business, ".toast-area > .toast");
      await testInfo.attach("success-toast-metrics", { body: JSON.stringify(metrics), contentType: "application/json" });
      expect(width - metrics.box.x - metrics.box.width).toBeCloseTo(22, 1);
      expect(900 - metrics.box.y - metrics.box.height).toBeCloseTo(22, 1);
      expect(metrics.hit).toBe(true);
      await business.emulateMedia({ reducedMotion: "reduce" });
      await expect(toast).toHaveCSS("animation-name", "none");
      await business.keyboard.press("Escape");
      await expect(detail).toBeHidden();
      await expect(create).toBeFocused();
      expect(await toast.evaluate(el => {
        const { x, y, width, height } = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      })).toBe(true);
      await business.clock.runFor(3999);
      await expect(toast).toBeVisible();
      await business.clock.runFor(1);
      await expect(toast).toHaveCount(0);
      const row = today.getByRole("button", { name: /Clara López/ });
      await expect(row).toBeVisible();
      await business.reload();
      await row.click();
      await expect(detail.getByRole("heading", { name: "Clara López", exact: true })).toBeVisible();
      expect(await read("appointments")).toHaveLength(1);
    } finally { await context.close(); }
  });
}

test("Clientes hands off an existing client to review and confirm a real booking", async ({ browser, page, system }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const { client, service, resource, date, offer, read } = await provision(page, business, system, "client-booking");
    const writes: Array<{ path: string; body: unknown }> = [];
    business.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/me/") && !["GET", "HEAD"].includes(request.method())) writes.push({ path, body: request.postDataJSON() });
    });
    await business.goto(`${system.webUrl}/clients?clientId=${crypto.randomUUID()}&firstName=Inventado`);
    const row = business.getByRole("list", { name: "Clientes del negocio" }).getByRole("button", { name: /Clara López/ });
    const card = business.getByRole("dialog", { name: "Cliente", exact: true });
    await row.click();
    const start = card.getByRole("button", { name: "Nuevo turno", exact: true });
    const close = card.getByRole("button", { name: "Cerrar", exact: true });
    const booking = business.getByRole("dialog", { name: "Nuevo turno", exact: true });
    const form = booking.getByRole("form", { name: "Crear turno", exact: true });
    for (const width of [1280, 360]) {
      await business.setViewportSize({ width, height: 900 });
      await expect(start).toBeEnabled();
      await card.evaluate(async dialog => {
        const finite = dialog.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
        await Promise.allSettled(finite.map(animation => animation.finished));
      });
      const centers = await close.or(start).evaluateAll(buttons => buttons.map(button => {
        const { y, height } = button.getBoundingClientRect();
        return y + height / 2;
      }));
      expect(centers).toHaveLength(2);
      expect(centers[0]!).toBeCloseTo(centers[1]!, 0);
      await business.screenshot({ path: testInfo.outputPath(`client-booking-footer-${width}.png`) });
      await start.click();
      await expect(booking.getByRole("heading", { name: "Nuevo turno", exact: true })).toBeFocused();
      await expect(form.getByRole("group", { name: "Cliente", exact: true })).toContainText("Clara López");
      await expect(form.getByRole("group", { name: "Cliente", exact: true })).toContainText(client.phone);
      await expect(form.getByText("Inventado")).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(await business.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await business.screenshot({ path: testInfo.outputPath(`client-booking-${width}.png`) });
      if (width === 1280) {
        await form.getByRole("button", { name: "Cancelar formulario" }).click();
        await expect(booking).toBeHidden();
        await expect(start).toBeFocused();
      }
    }
    await choice(form, "Servicio", service.id).check();
    await form.getByLabel("Recurso", { exact: true }).selectOption(resource.id);
    await form.getByLabel("Fecha", { exact: true }).fill(date);
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await choice(form, "Horarios disponibles", offer.start).check();
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    await expect(form.getByRole("region", { name: "Revisá el turno" })).toContainText("Clara López");
    await expect(form.getByRole("button", { name: "Confirmar turno" })).toBeFocused();
    expect(writes).toEqual([]);
    expect(await read("appointments")).toEqual([]);
    await form.getByRole("button", { name: "Confirmar turno" }).click();
    const saved = business.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(saved.getByRole("heading", { name: "Clara López" })).toBeFocused();
    await expect(saved.getByText("Confirmado", { exact: true })).toBeVisible();
    expect(writes).toEqual([{ path: "/api/me/appointments", body: expect.objectContaining({ clientId: client.id, confirmed: true }) }]);
    expect(writes[0]!.body).not.toHaveProperty("newClient");
    expect(await read("clients")).toEqual([client]);
    expect(await read("appointments")).toEqual([expect.objectContaining({ client, state: "confirmed", startMs: offer.startMs })]);
    await business.keyboard.press("Escape");
    await expect(start).toBeFocused();
    await expect(card.getByRole("list", { name: "Próximos turnos" }).getByRole("listitem")).toHaveCount(1);
    await close.click();
    await expect(row).toBeFocused();
    expect(writes).toHaveLength(1);
  } finally { await context.close(); }
});

test("Turnos navigation and real manual booking lifecycle", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const password = "turnos tenant password", email = "turnos@example.test";
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/solicitudes$/);
  await createBusinessInAdminUi(page, { name: "Estudio Turnos", email, password });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    await login(business, system.webUrl, email, password);
    await expect(business).toHaveURL(/\/inicio$/);
    const navigation = business.getByRole("navigation", { name: "Navegación del negocio", exact: true });
    await expect(navigation.getByRole("link", { name: "Inicio", exact: true })).toHaveAttribute("aria-current", "page");
    await navigation.getByRole("link", { name: "Agenda", exact: true }).click();
    await expect(business).toHaveURL(/\/turnos$/);
    await expect(business.getByRole("main").getByRole("heading", { name: "Agenda", exact: true })).toBeAttached();
    const views = business.getByRole("group", { name: "Vista de agenda", exact: true });
    await expect(views.getByRole("button", { pressed: true })).toHaveText("Día");
    await expect(business.getByRole("region", { name: "Turnos del día" }).getByText("No hay turnos para este día.", { exact: true })).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("turnos-empty-desktop.png"), fullPage: true });
    const csrf = await business.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
    const create = async (path: string, data: object) => {
      const response = await business.request.post(`${system.webUrl}/api/me/${path}`, { headers, data });
      expect(response.status()).toBe(201);
      return response.json();
    };
    const read = async (path: string) => {
      const response = await business.request.get(`${system.webUrl}/api/me/${path}`);
      expect(response.status()).toBe(200);
      return response.json();
    };
    const full = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
    const calendar = await business.request.put(`${system.webUrl}/api/me/business-calendar`, { headers, data: { weeklySchedule: full } });
    expect(calendar.status()).toBe(200);
    const client = await create("clients", { firstName: "Ana", lastName: "Pérez", phone: "+5491123456789" });
    const service = await create("services", { name: "Consulta original", durationMinutes: 30, priceArs: 1250.5 });
    const alternative = await create("services", { name: "Consulta distinta", durationMinutes: 45, priceArs: 5000 });
    const resource = await create("resources", { name: "Profesional uno", serviceIds: [service.id, alternative.id], weeklySchedule: full });
    const otherResource = await create("resources", { name: "Profesional dos", serviceIds: [service.id, alternative.id], weeklySchedule: full });
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + 7 * 86400000));
    const offers = await read(`appointments/availability?${new URLSearchParams({ serviceId: service.id, resourceId: resource.id, date })}`);
    const offer = offers.find((slot: { startMs: number }) => slot.startMs >= Date.parse(`${date}T10:00:00-03:00`));
    expect(offer).toBeDefined();
    const counts = { POST: 0, PATCH: 0, clientPOST: 0 };
    business.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/me/appointments" && request.method() === "POST") counts.POST++;
      if (path.startsWith("/api/me/appointments/") && request.method() === "PATCH") counts.PATCH++;
      if (path === "/api/me/clients" && request.method() === "POST") counts.clientPOST++;
    });
    const screen = business.locator("main.turnos-screen");
    const openCreate = async () => {
      if (await business.getByRole("dialog").isVisible()) await closeTurno(business);
      await screen.getByRole("button", { name: "Nuevo turno", exact: true }).click();
      const dialog = screen.getByRole("dialog", { name: "Nuevo turno", exact: true });
      const form = dialog.getByRole("form", { name: "Crear turno", exact: true });
      await expect(form).toBeVisible();
      await expect(dialog.getByRole("heading", { name: "Nuevo turno", exact: true })).toBeFocused();
      return form;
    };
    const chooseSlot = async (form: ReturnType<Page["getByRole"]>, resourceValue: string, start: string, serviceValue = service.id) => {
      await choice(form, "Servicio", serviceValue).check();
      await form.getByRole("combobox", { name: "Recurso", exact: true }).selectOption(resourceValue);
      await form.getByLabel("Fecha", { exact: true }).fill(date);
      await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
      await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
      await choice(form, "Horarios disponibles", start).check();
    };
    const form = await openCreate();
    await form.getByLabel("Buscar cliente por nombre o teléfono", { exact: true }).fill("Ana");
    await form.getByRole("button", { name: "Buscar cliente", exact: true }).click();
    await form.getByRole("list", { name: "Resultados de clientes", exact: true }).getByRole("button", { name: /Ana Pérez/ }).click();
    await chooseSlot(form, resource.id, offer.start);
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const confirm = form.getByRole("button", { name: "Confirmar turno", exact: true });
    await expect(confirm).toBeFocused();
    expect(counts.POST).toBe(0);
    await business.screenshot({ path: testInfo.outputPath("turnos-create-confirmation.png"), fullPage: true });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await business.route("**/api/me/appointments", async route => {
      if (route.request().method() === "POST") { await held; await route.continue(); }
      else await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
    });
    await business.route("**/api/me/appointments?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    const committed = business.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/appointments"));
    await confirm.click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(screen.getByText("Turno guardado", { exact: true })).toHaveCount(0);
    await form.evaluate(element => element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(counts.POST).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("turnos-create-pending.png"), fullPage: true });
    release();
    const response = await committed;
    expect(response.status()).toBe(201);
    const saved = await response.json();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByRole("heading", { name: "Ana Pérez", exact: true })).toBeFocused();
    await expect(screen.getByText("Turno guardado", { exact: true })).toBeVisible();
    await expect(screen.getByText("El turno se guardó, pero no pudimos actualizar la lista.", { exact: true })).toBeVisible();
    expect(counts.POST).toBe(1);
    await business.unroute("**/api/me/appointments");
    await business.unroute("**/api/me/appointments?*");
    await closeTurno(business);
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(screen.getByText("El turno se guardó, pero no pudimos actualizar la lista.", { exact: true })).toHaveCount(0);
    expect(counts.POST).toBe(1);
    expect((await read(`appointments/${saved.id}`)).client.id).toBe(client.id);
    expect(counts.clientPOST).toBe(0);

    // Same start on another resource remains a separate chronological row.
    const newForm = await openCreate();
    await newForm.getByRole("button", { name: "Nuevo cliente", exact: true }).click();
    await newForm.getByLabel("Nombre", { exact: true }).fill("Bruno");
    await newForm.getByLabel("Apellido", { exact: true }).fill("Díaz");
    await newForm.getByLabel("Teléfono", { exact: true }).fill("11 23456788");
    await chooseSlot(newForm, otherResource.id, offer.start);
    await newForm.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const newSaved = business.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/appointments"));
    await newForm.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    expect((await newSaved).status()).toBe(201);
    await expect(detail.getByRole("heading", { name: "Bruno Díaz", exact: true })).toBeVisible();
    const ownedClients = await read("clients");
    expect(ownedClients).toHaveLength(2);
    expect(ownedClients.find((row: { firstName: string }) => row.firstName === "Bruno").phone).toBe("+5491123456788");
    expect(counts.clientPOST).toBe(0);
    await closeTurno(business);
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByLabel("Elegir fecha de la agenda").fill(date);
    const dayList = screen.getByRole("group", { name: `Turnos ${date}`, exact: true });
    await expect(dayList.getByRole("button")).toHaveCount(2);
    await expect(dayList.getByText("Profesional uno", { exact: true })).toHaveCount(0);
    await dayList.getByRole("button", { name: /Ana Pérez/ }).click();
    await expect(detail.getByText("Profesional uno", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Marcar completado", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Marcar ausente", exact: true })).toBeDisabled();

    const updateService = await business.request.put(`${system.webUrl}/api/me/services/${service.id}`, {
      headers, data: { name: "Consulta actual", durationMinutes: 60, priceArs: 9000 },
    });
    expect(updateService.status()).toBe(200);
    await detail.getByRole("button", { name: "Modificar turno", exact: true }).click();
    const changeForm = screen.getByRole("form", { name: "Modificar turno", exact: true });
    await changeForm.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(changeForm.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    const later = offers.find((slot: { startMs: number }) => slot.startMs >= offer.endMs);
    await choice(changeForm, "Horarios disponibles", later.start).check();
    await expect(changeForm.getByRole("region", { name: "Condiciones ofrecidas", exact: true })).toContainText("30 min");
    await changeForm.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const changed = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}`));
    await changeForm.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    expect((await changed).status()).toBe(200);
    const rescheduled = await read(`appointments/${saved.id}`);
    expect(rescheduled.startMs).toBe(later.startMs);
    expect(rescheduled.terms).toEqual(saved.terms);
    await detail.getByRole("button", { name: "Modificar turno", exact: true }).click();
    await chooseSlot(changeForm, resource.id, later.start, alternative.id);
    await expect(changeForm.getByRole("region", { name: "Condiciones ofrecidas", exact: true })).toContainText("45 min");
    await changeForm.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const serviceChanged = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}`));
    await changeForm.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    expect((await serviceChanged).status()).toBe(200);
    expect((await read(`appointments/${saved.id}`)).terms.serviceId).toBe(alternative.id);
    await expect(detail.getByRole("definition").filter({ hasText: /^Consulta distinta/ })).toContainText("45 min");
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    const notesForm = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
    await expect(notesForm.getByLabel("Notas del turno", { exact: true })).toBeFocused();
    await notesForm.getByLabel("Notas del turno", { exact: true }).fill("Llegar con estudios");
    const notesSaved = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}/notes`));
    await notesForm.getByRole("button", { name: "Guardar notas", exact: true }).click();
    expect((await notesSaved).status()).toBe(200);
    await expect(detail.getByText("Llegar con estudios", { exact: true })).toBeVisible();
    const beforeCancel = counts.PATCH;
    const cancel = detail.getByRole("button", { name: "Cancelar turno", exact: true });
    await cancel.click();
    await expect(detail.getByRole("button", { name: "Volver sin cambiar", exact: true })).toBeFocused();
    await detail.getByRole("button", { name: "Volver sin cambiar", exact: true }).click();
    await expect(cancel).toBeFocused();
    expect(counts.PATCH).toBe(beforeCancel);
    await cancel.click();
    const cancelled = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}/state`));
    await detail.getByRole("button", { name: "Confirmar estado", exact: true }).click();
    expect((await cancelled).status()).toBe(200);
    await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toHaveCount(0);
    await closeTurno(business);
    const cancelledList = screen.locator("details.ag-cancelled");
    await expect(dayList.getByRole("button")).toHaveCount(1);
    await cancelledList.locator("summary").press("Enter");
    await expect(cancelledList.getByRole("button", { name: /Ana Pérez.*Cancelado/ })).toBeVisible();
    await screen.getByRole("button", { name: "Mes", exact: true }).click();
    const month = screen.getByRole("group", { name: "Días del mes", exact: true });
    await expect(month.getByRole("button", { pressed: true })).toHaveAccessibleName(/: 1 turno$/);
    await expect(screen.getByRole("region", { name: "Vista mensual" }).getByRole("button", { name: /Bruno Díaz/ })).toBeVisible();
    await business.screenshot({ path: testInfo.outputPath("turnos-month-desktop.png"), fullPage: true });
    await business.setViewportSize({ width: 360, height: 900 });
    await business.screenshot({ path: testInfo.outputPath("turnos-month-mobile.png"), fullPage: true });
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await business.reload();
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByLabel("Elegir fecha de la agenda").fill(date);
    await cancelledList.locator("summary").press("Enter");
    await cancelledList.getByRole("button", { name: /Ana Pérez.*Cancelado/ }).click();
    await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
    await expect(detail.getByText("Llegar con estudios", { exact: true })).toBeVisible();
    expect(counts.clientPOST).toBe(0);
  } finally { await context.close(); }
});

for (const width of [1280, 360]) test(`Turnos real atomic conflicts and changed quotes preserve the draft at ${width}px`, async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const business = await context.newPage();
  try {
    const setup = await provision(page, business, system, `turnos-conflicts-${width}`);
    const { client, service, resource, date, offer, offers, headers, read } = setup;
    await expect(business).toHaveURL(/\/inicio$/);
    const screen = business.locator("main.turnos-screen");
    await screen.getByRole("button", { name: "Nuevo turno", exact: true }).click();
    const form = screen.getByRole("form", { name: "Crear turno", exact: true });
    await form.getByRole("button", { name: "Nuevo cliente", exact: true }).click();
    await form.getByLabel("Nombre", { exact: true }).fill("Nueva");
    await form.getByLabel("Apellido", { exact: true }).fill("Persona");
    await form.getByLabel("Teléfono", { exact: true }).fill(client.phone);
    await choice(form, "Servicio", service.id).check();
    await form.getByRole("combobox", { name: "Recurso", exact: true }).selectOption(resource.id);
    await form.getByLabel("Fecha", { exact: true }).fill(date);
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await choice(form, "Horarios disponibles", offer.start).check();
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const confirm = form.getByRole("button", { name: "Confirmar turno", exact: true });
    const postResponse = () => business.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/me/appointments"));
    const duplicateClient = postResponse();
    await confirm.click();
    expect((await duplicateClient).status()).toBe(409);
    const inline = form.locator(".turno-error[role=alert]");
    const rejection = "Los datos cambiaron. Recargá y volvé a intentar.";
    await expect(inline).toHaveText(rejection);
    await expect(inline).toHaveCSS("color", "rgb(168, 51, 37)");
    await expect(inline).toHaveCSS("font-size", "12px");
    await expect(inline).toHaveCSS("font-weight", "650");
    await expect(inline).toHaveCSS("margin-top", "12px");
    await expect(inline).toHaveCSS("padding", "0px");
    await expect(inline).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const toast = screen.locator(".toast-area > .toast");
    await expect(toast).toHaveText(rejection);
    await expect(toast).toHaveCSS("background-color", "rgb(159, 60, 36)");
    await expect(toast).toHaveCSS("animation-duration", "0.23s");
    await expect(confirm).toBeEnabled();
    await expect(confirm).toBeFocused();
    await expect(form.getByRole("region", { name: "Revisá el turno" })).toContainText(client.phone);
    expect(await read("clients")).toHaveLength(1);
    expect(await read("appointments")).toHaveLength(0);
    await business.screenshot({ path: testInfo.outputPath("turnos-atomic-client-conflict.png"), animations: "disabled" });
    const toastMetrics = await feedbackMetrics(business, ".toast-area > .toast");
    await testInfo.attach("rejection-feedback-metrics", {
      body: JSON.stringify({ toast: toastMetrics, inline: await feedbackMetrics(business, "form > .turno-error") }),
      contentType: "application/json",
    });
    if (width === 360) expect(toastMetrics.box.x).toBe(0); // Reference shrink-to-fit at the viewport edge.
    expect(toastMetrics.hit).toBe(true);
    await expect(toast).toHaveCount(0, { timeout: 6000 });
    await expect(inline).toHaveText(rejection);
    await form.getByRole("button", { name: "Volver al formulario", exact: true }).click();
    await form.getByLabel("Teléfono", { exact: true }).fill("11 23456776");
    await expect(form.getByRole("group", { name: "Horarios disponibles" })).toHaveCount(0);
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await choice(form, "Horarios disponibles", offer.start).check();
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    // Occupy the previously offered slot through the actual API, not a mocked 409.
    const occupied = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    const capacityConflict = postResponse();
    await confirm.click();
    expect((await capacityConflict).status()).toBe(409);
    expect(await read("clients")).toHaveLength(1);
    expect(await read("appointments")).toHaveLength(1);
    expect((await read(`appointments/${occupied.id}`)).startMs).toBe(offer.startMs);
    await expect(confirm).toBeFocused();
    await form.getByRole("button", { name: "Volver al formulario", exact: true }).click();
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    const later = offers.find((slot: { startMs: number }) => slot.startMs >= offer.endMs);
    await choice(form, "Horarios disponibles", later.start).check();
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const changedTerms = await business.request.put(`${system.webUrl}/api/me/services/${service.id}`, {
      headers, data: { name: service.name, durationMinutes: 45, priceArs: 3000 },
    });
    expect(changedTerms.status()).toBe(200);
    const quoteConflict = postResponse();
    await confirm.click();
    expect((await quoteConflict).status()).toBe(409);
    expect(await read("clients")).toHaveLength(1);
    expect(await read("appointments")).toHaveLength(1);
    await expect(form.getByRole("region", { name: "Revisá el turno" })).toContainText("Nueva Persona");
    await expect(confirm).toBeFocused();
    await business.screenshot({ path: testInfo.outputPath("turnos-real-quote-conflict.png"), fullPage: true });
    await form.getByRole("button", { name: "Volver al formulario", exact: true }).click();
    await expect(choice(form, "Horarios disponibles", later.start)).toBeChecked();
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await choice(form, "Horarios disponibles", later.start).check();
    await expect(form.getByRole("region", { name: "Condiciones ofrecidas", exact: true })).toContainText("45 min");
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    const fresh = postResponse();
    await confirm.click();
    const freshResponse = await fresh;
    expect(freshResponse.status()).toBe(201);
    const newSaved = await freshResponse.json();
    expect(newSaved.terms.durationMinutes).toBe(45);
    expect(newSaved.terms.priceArs).toBe(3000);
    expect(await read("clients")).toHaveLength(2);
    expect(await read("appointments")).toHaveLength(2);
    await closeTurno(business);
    await screen.getByRole("link", { name: "Ver agenda completa", exact: true }).click();
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByLabel("Elegir fecha de la agenda", { exact: true }).fill(date);
    const dayBookings = screen.getByRole("group", { name: `Turnos ${date}`, exact: true }).getByRole("button");
    await expect(dayBookings).toHaveCount(2);
    await expect(dayBookings.filter({ hasText: "Clara López" })).toBeVisible();
    await dayBookings.filter({ hasText: "Nueva Persona" }).click();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByRole("heading", { name: "Nueva Persona", exact: true })).toBeVisible();
    await expect(detail).toContainText("45 min");
  } finally { await context.close(); }
});

test("Turnos mounted read recovery, stale availability, session ownership and unknown outcomes", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const setup = await provision(page, business, system, "turnos-ownership");
    const { client, service, resource, date, offer } = setup;
    const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    let listGET = 0, post = 0;
    business.on("request", request => {
      if (new URL(request.url()).pathname === "/api/me/appointments") {
        if (request.method() === "GET") listGET++;
        if (request.method() === "POST") post++;
      }
    });
    await business.route("**/api/me/appointments?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await business.goto(`${system.webUrl}/turnos`);
    const screen = business.locator("main.turnos-screen");
    await expect(screen.getByRole("alert")).toHaveText("No se pudo completar la operación.");
    await business.unroute("**/api/me/appointments?*");
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(screen.getByRole("alert")).toHaveCount(0);
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByLabel("Elegir fecha de la agenda").fill(date);
    const dayList = screen.getByRole("group", { name: `Turnos ${date}`, exact: true });
    await dayList.getByRole("button", { name: /Clara López/ }).click();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByRole("heading", { name: "Clara López", exact: true })).toBeFocused();
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    const notes = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
    await notes.getByLabel("Notas del turno", { exact: true }).fill("Guardado antes del GET");
    let patch = 0;
    business.on("request", request => { if (request.method() === "PATCH") patch++; });
    await business.route(`**/api/me/appointments/${saved.id}`, async route => {
      if (route.request().method() === "GET") await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
      else await route.continue();
    });
    const noteResponse = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}/notes`));
    await notes.getByRole("button", { name: "Guardar notas", exact: true }).click();
    expect((await noteResponse).status()).toBe(200);
    await expect(detail.getByText("Guardado antes del GET", { exact: true })).toBeVisible();
    await expect(screen.getByText("El turno se guardó, pero no pudimos actualizar el detalle.", { exact: true })).toBeVisible();
    expect(patch).toBe(1);
    await business.screenshot({ path: testInfo.outputPath("turnos-saved-detail-refresh-warning.png"), fullPage: true });
    await business.unroute(`**/api/me/appointments/${saved.id}`);
    await screen.getByRole("button", { name: "Actualizar detalle", exact: true }).click();
    await expect(screen.getByText("El turno se guardó, pero no pudimos actualizar el detalle.", { exact: true })).toHaveCount(0);
    expect(patch).toBe(1);
    await closeTurno(business);

    let releaseList!: () => void;
    const heldList = new Promise<void>(resolve => { releaseList = resolve; });
    await business.route("**/api/me/appointments?*", async route => { await heldList; await route.continue(); });
    const beforeGET = listGET;
    const refresh = screen.getByRole("button", { name: "Actualizar turnos", exact: true });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await refresh.evaluate(element => { (element as HTMLButtonElement).click(); });
    expect(listGET).toBe(beforeGET + 1);
    await expect(dayList.getByRole("button")).toHaveCount(1);
    releaseList();
    await expect(refresh).toBeEnabled();
    await business.unroute("**/api/me/appointments?*");

    await screen.getByRole("button", { name: "Nuevo turno", exact: true }).click();
    const form = screen.getByRole("form", { name: "Crear turno", exact: true });
    await form.getByRole("button", { name: "Nuevo cliente", exact: true }).click();
    await form.getByLabel("Nombre", { exact: true }).fill("Incierta");
    await form.getByLabel("Apellido", { exact: true }).fill("Persona");
    await form.getByLabel("Teléfono", { exact: true }).fill("11 23456775");
    await choice(form, "Servicio", service.id).check();
    await form.getByRole("combobox", { name: "Recurso", exact: true }).selectOption(resource.id);
    await form.getByLabel("Fecha", { exact: true }).fill(date);
    let releaseSlots!: () => void;
    const heldSlots = new Promise<void>(resolve => { releaseSlots = resolve; });
    await business.route("**/api/me/appointments/availability?*", async route => { await heldSlots; await route.continue(); });
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toBeVisible();
    const nextDate = new Date(`${date}T12:00:00Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    await form.getByLabel("Fecha", { exact: true }).fill(nextDate.toISOString().slice(0, 10));
    releaseSlots();
    await expect(form.getByRole("group", { name: "Horarios disponibles" })).toHaveCount(0);
    await business.unroute("**/api/me/appointments/availability?*");
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await form.getByRole("group", { name: "Horarios disponibles" }).getByRole("radio").first().check();
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    let lostCreate: { key: string; body: object } | null = null;
    await business.route("**/api/me/appointments", async route => {
      lostCreate = { key: route.request().headers()["x-appointment-operation-key"]!, body: route.request().postDataJSON() };
      await route.abort("failed");
    });
    await form.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("El turno podría haberse guardado");
    await expect(screen.locator(".toast-area")).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Confirmar turno", exact: true })).toBeDisabled();
    expect(post).toBe(1);
    await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toBeVisible();
    const newTurn = screen.getByRole("button", { name: "Nuevo turno", exact: true, includeHidden: true });
    const uncertaintyWarning = screen.locator('.turnos-feedback > [role="alert"]').filter({ hasText: "El turno podría haberse guardado" });
    await expect(newTurn).toBeDisabled(); // An ambiguous write must not be bypassed by opening a fresh form.
    await newTurn.evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await expect(form.getByRole("button", { name: "Confirmar turno", exact: true })).toBeDisabled();
    await business.screenshot({ path: testInfo.outputPath("turnos-unknown-network-outcome.png"), fullPage: true });
    await closeTurno(business);
    await business.unroute("**/api/me/appointments");
    const appointmentListRoute = /\/api\/me\/appointments(?:\?.*)?$/;
    await business.route(appointmentListRoute, route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(screen.getByText("Actualizando turnos…", { exact: true })).toHaveCount(0);
    await expect(uncertaintyWarning).toBeVisible();
    await expect(newTurn).toBeDisabled();
    await business.unroute(appointmentListRoute);
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    await expect(screen.getByText("Actualizando turnos…", { exact: true })).toHaveCount(0);
    // Successful absence from the list still cannot establish rollback of an in-flight write.
    await expect(uncertaintyWarning).toBeVisible();
    await expect(newTurn).toBeDisabled();
    await dayList.getByRole("button", { name: /Clara López/ }).click();
    await expect(detail.getByText("Guardado antes del GET", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toBeEnabled();
    await expect(uncertaintyWarning).toBeVisible();
    await expect(newTurn).toBeDisabled();
    // Navigation remounts the screen but remains in the same authenticated business scope.
    await business.goto(`${system.webUrl}/profile`);
    await business.goto(`${system.webUrl}/turnos`);
    await expect(uncertaintyWarning).toBeVisible();
    await expect(newTurn).toBeDisabled();
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByLabel("Elegir fecha de la agenda").fill(date);
    await expect(dayList.getByRole("button")).toHaveCount(1);
    expect(post).toBe(1);
    expect(patch).toBe(1);
    expect(await setup.read("clients")).toHaveLength(1); // This routed abort did not reach persistence.
    await business.screenshot({ path: testInfo.outputPath("turnos-uncertainty-readonly-inspection.png"), fullPage: true });
    await screen.getByRole("button", { name: "Consultar resultado guardado", exact: true }).click();
    await expect(screen.getByText(/Todavía no hay una recepción confirmada/)).toBeVisible();
    await expect(newTurn).toBeDisabled();
    expect(post).toBe(1);
    await screen.getByRole("button", { name: "Cancelar solicitud pendiente", exact: true }).click();
    await expect(screen.getByText(/No cancela un turno ni revierte/)).toBeVisible();
    const fenceResponse = business.waitForResponse(response => response.request().method() === "POST" && /appointment-operations\/.*\/cancel$/.test(response.url()));
    await screen.getByRole("button", { name: "Confirmar cancelación de solicitud", exact: true }).click();
    expect((await fenceResponse).status()).toBe(200);
    await expect(newTurn).toBeEnabled();
    await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toHaveCount(0);
    expect(lostCreate).not.toBeNull();
    const lost = lostCreate as unknown as { key: string; body: object };
    const late = await business.request.post(`${system.webUrl}/api/me/appointments`, {
      headers: { ...setup.headers, "x-appointment-operation-key": lost.key }, data: lost.body,
    });
    expect(late.status()).toBe(409);
    expect(await setup.read("clients")).toHaveLength(1);
    expect(await setup.read("appointments")).toHaveLength(1);
    expect(post).toBe(1);

    // Delayed detail completion cannot revive the former session after logout.
    let releaseDetail!: () => void;
    const heldDetail = new Promise<void>(resolve => { releaseDetail = resolve; });
    let detailCompleted!: () => void, detailRejected!: (error: unknown) => void;
    const detailCompletion = new Promise<void>((resolve, reject) => {
      detailCompleted = resolve; detailRejected = reject;
    });
    let logoutAsserted = false;
    await business.route(`**/api/me/appointments/${saved.id}`, async route => {
      await heldDetail;
      try {
        await route.continue();
        detailCompleted();
      } catch (error) {
        if (logoutAsserted && error instanceof Error && error.message === "route.continue: Route is already handled!")
          detailCompleted();
        else detailRejected(error);
      }
    });
    await dayList.getByRole("button", { name: /Clara López/ }).click();
    await expect(screen.getByText("Actualizando detalle…", { exact: true })).toBeVisible();
    await closeTurno(business);
    await business.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
    await expect(business).toHaveURL(system.webUrl + "/");
    logoutAsserted = true;
    releaseDetail();
    await detailCompletion;
    await business.unroute(`**/api/me/appointments/${saved.id}`);
    await login(business, system.webUrl, setup.email, setup.password);
    await expect(business).toHaveURL(/\/inicio$/);
    await business.goto(`${system.webUrl}/turnos`);
    await expect(screen.getByRole("region", { name: "Detalle del turno", exact: true })).toHaveCount(0);
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByLabel("Elegir fecha de la agenda").fill(date);
    await expect(dayList.getByRole("button")).toHaveCount(1);
    await dayList.getByRole("button", { name: /Clara López/ }).click();
    await expect(detail.getByText("Guardado antes del GET", { exact: true })).toBeVisible();
    expect(post).toBe(1);
    // Platform administrators are denied the business-only route, even if they know the URL.
    await page.goto(`${system.webUrl}/turnos`);
    await expect(page.locator('main[data-state="denied"]')).toBeVisible();
  } finally { await context.close(); }
});

test("Turnos uncapped all-state calendars and clock locks with UI-mocked attendance; real tenant isolation", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  try {
    const setup = await provision(page, business, system, "turnos-calendar");
    const { client, service, resource, date, offer } = setup;
    const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    await createBusinessInAdminUi(page, {
      name: "Turnos otra identidad", email: "turnos-other@example.test", password: setup.password,
    });
    await login(other, system.webUrl, "turnos-other@example.test", setup.password);
    await expect(other).toHaveURL(/\/inicio$/);
    await other.goto(`${system.webUrl}/turnos`);
    await expect(other.getByText("No hay turnos para este día.", { exact: true })).toBeVisible();
    const foreign = await other.request.get(`${system.webUrl}/api/me/appointments/${saved.id}`);
    expect(foreign.status()).toBe(404);
    const foreignList = await other.request.get(`${system.webUrl}/api/me/appointments`);
    expect(foreignList.status()).toBe(200);
    expect(await foreignList.json()).toEqual([]);
    const clock = Date.now();
    await business.clock.install({ time: new Date(clock) });
    const startMs = clock + 120000;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(clock));
    let projection = { ...saved, startMs, endMs: startMs + 1800000, startsAt: new Date(startMs).toISOString() };
    const many = Array.from({ length: 105 }, (_, index) => ({ ...projection,
      id: index === 0 ? saved.id : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      client: index === 0 ? saved.client : { ...saved.client, firstName: `Ejemplo ${index}` },
      state: index === 0 ? "confirmed" : ["confirmed", "cancelled", "done", "no_show"][index % 4],
    }));
    let patch = 0;
    await business.route("**/api/me/appointments?*", route => route.fulfill({ json: many }));
    await business.route(`**/api/me/appointments/${saved.id}`, route => route.fulfill({ json: projection }));
    await business.route(`**/api/me/appointments/${saved.id}/state`, async route => {
      patch++;
      const body = route.request().postDataJSON();
      expect(body).toEqual({ state: "done", confirmed: true });
      projection = { ...projection, state: "done" };
      many[0] = projection;
      await route.fulfill({ json: projection }); // UI-only: no real past appointment can be created through this API.
    });
    await business.goto(`${system.webUrl}/turnos`);
    const screen = business.locator("main.turnos-screen");
    const todayList = screen.getByRole("region", { name: "Turnos del día", exact: true });
    await expect(todayList.getByRole("button")).toHaveCount(79);
    await expect(todayList.getByText(/ · Finalizado$/)).toHaveCount(26);
    await expect(todayList.getByText(/ · No asistió$/)).toHaveCount(26);
    const cancelledList = screen.locator("details.ag-cancelled");
    await cancelledList.getByText("Turnos cancelados").click();
    await expect(cancelledList.getByRole("button", { name: /Cancelado$/ })).toHaveCount(26);
    await todayList.getByRole("button", { name: /Clara López/ }).click();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByText("Recurso de prueba", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Marcar completado", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Marcar ausente", exact: true })).toBeDisabled();
    await business.clock.setSystemTime(new Date(startMs));
    await business.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Cancelar turno", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Marcar completado", exact: true })).toBeEnabled();
    await expect(detail.getByRole("button", { name: "Marcar ausente", exact: true })).toBeEnabled();
    expect(patch).toBe(0); // The clock must never transition attendance automatically.
    await business.screenshot({ path: testInfo.outputPath("turnos-started-lock-attendance-mocked.png"), fullPage: true });
    await detail.getByRole("button", { name: "Marcar completado", exact: true }).click();
    await detail.getByRole("button", { name: "Volver sin cambiar", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Marcar completado", exact: true })).toBeFocused();
    expect(patch).toBe(0);
    await detail.getByRole("button", { name: "Marcar completado", exact: true }).click();
    await detail.getByRole("button", { name: "Confirmar estado", exact: true }).click();
    await expect(detail.getByText("Completado", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button")).toHaveCount(0);
    expect(patch).toBe(1);
    await closeTurno(business);
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    const week = screen.getByRole("region", { name: "Vista semanal" });
    const weekToday = week.getByRole("group", { name: `Turnos ${today}`, exact: true });
    await expect(week.getByRole("group", { name: /^Turnos \d/ })).toHaveCount(7);
    const weekBookings = weekToday.getByRole("button");
    await expect(weekBookings).toHaveCount(79);
    await expect(weekToday.getByText(/^\+\d+ turnos?$/)).toHaveCount(0);
    await screen.getByRole("button", { name: "Anterior", exact: true }).click();
    await expect(weekToday).toHaveCount(0);
    await screen.getByRole("button", { name: "Esta semana", exact: true }).click();
    await expect(weekBookings).toHaveCount(79);
    await screen.getByRole("button", { name: "Mes", exact: true }).click();
    const month = screen.getByRole("group", { name: "Días del mes", exact: true });
    await expect(month.getByRole("button", { pressed: true })).toHaveAccessibleName(/: 79 turnos$/);
    await expect(screen.getByRole("region", { name: "Vista mensual" }).getByRole("button", { name: /Servicio de prueba/ })).toHaveCount(79);
    await business.setViewportSize({ width: 360, height: 900 });
    await business.screenshot({ path: testInfo.outputPath("turnos-uncapped-mobile-mocked.png"), fullPage: true });
    expect(await business.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); await otherContext.close(); }
});

test("Turnos mounted read recovery resolves a persisted PATCH without blocking unrelated writes", async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const setup = await provision(page, business, system, "turnos-uncertain-patch");
    const { client, service, resource, date, offer } = setup;
    const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
      date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    await business.goto(`${system.webUrl}/turnos`);
    const screen = business.locator("main.turnos-screen");
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByLabel("Elegir fecha de la agenda").fill(date);
    const dayList = screen.getByRole("group", { name: `Turnos ${date}`, exact: true });
    const row = dayList.getByRole("button", { name: /Clara López/ });
    await row.click();
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    const notes = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
    await notes.getByLabel("Notas del turno", { exact: true }).fill("Persistió sin respuesta al navegador");
    let writes = 0;
    business.on("request", request => {
      if (["POST", "PATCH"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/me/appointments")) writes++;
    });
    await business.route(`**/api/me/appointments/${saved.id}/notes`, async route => {
      const response = await route.fetch(); // The actual API commits before the browser loses the response.
      expect(response.status()).toBe(200);
      expect((await response.json()).notes).toBe("Persistió sin respuesta al navegador");
      await route.abort("failed");
    });
    await notes.getByRole("button", { name: "Guardar notas", exact: true }).click();
    const warning = screen.locator('.turnos-feedback > [role="alert"]').filter({ hasText: "El turno podría haberse guardado" });
    await expect(warning).toBeVisible();
    expect((await setup.read(`appointments/${saved.id}`)).notes).toBe("Persistió sin respuesta al navegador");
    expect(writes).toBe(1);
    await business.unroute(`**/api/me/appointments/${saved.id}/notes`);
    const newTurn = screen.getByRole("button", { name: "Nuevo turno", exact: true, includeHidden: true });
    await expect(newTurn).toBeEnabled(); // A PATCH on one record does not block unrelated create intents.
    // A second real appointment remains writable while the first PATCH outcome is unresolved.
    const nextOffer = setup.offers.find((slot: { startMs: number }) => slot.startMs >= offer.endMs);
    const unrelatedClient = await setup.create("clients", { firstName: "Otro", lastName: "Cliente", phone: "+5491123456774" });
    const unrelated = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: unrelatedClient.id,
      date, startRaw: nextOffer.start, expectedTerms: nextOffer.terms, confirmed: true });
    await closeTurno(business);
    await screen.getByRole("button", { name: "Actualizar turnos", exact: true }).click();
    const otherRow = dayList.getByRole("button", { name: /Otro Cliente/ });
    await otherRow.click();
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    await notes.getByLabel("Notas del turno", { exact: true }).fill("Cambio independiente");
    const otherSaved = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${unrelated.id}/notes`));
    await notes.getByRole("button", { name: "Guardar notas", exact: true }).click();
    expect((await otherSaved).status()).toBe(200);
    expect((await setup.read(`appointments/${unrelated.id}`)).notes).toBe("Cambio independiente");
    expect(writes).toBe(2);
    await closeTurno(business);
    await row.click(); // Read-only selection must not erase uncertainty.
    await expect(detail.getByText("Persistió sin respuesta al navegador", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Modificar turno", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeDisabled();
    await expect(detail.getByRole("button", { name: "Cancelar turno", exact: true })).toBeDisabled();
    await expect(warning).toBeVisible();
    let detailGET = 0;
    await business.route(`**/api/me/appointments/${saved.id}`, async route => {
      detailGET++;
      await route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' });
    });
    await closeTurno(business);
    await row.click();
    await expect(screen.getByText("Actualizando detalle…", { exact: true })).toHaveCount(0);
    expect(detailGET).toBe(1);
    await expect(warning).toBeVisible();
    await expect(newTurn).toBeEnabled();
    expect(writes).toBe(2);
    await business.unroute(`**/api/me/appointments/${saved.id}`);
    await closeTurno(business);
    await row.click();
    await expect(screen.getByText("Actualizando detalle…", { exact: true })).toHaveCount(0);
    await expect(detail.getByText("Persistió sin respuesta al navegador", { exact: true })).toBeVisible();
    await expect(warning).toBeVisible();
    await expect(newTurn).toBeEnabled();
    expect(writes).toBe(2); // Domain GET alone does not authorize repeating this record's write.
    await business.screenshot({ path: testInfo.outputPath("turnos-persisted-patch-uncertainty.png"), fullPage: true });
    await business.reload();
    await expect(warning).toBeVisible();
    await expect(newTurn).toBeEnabled();
    await screen.getByRole("button", { name: "Semana", exact: true }).click();
    await screen.getByLabel("Elegir fecha de la agenda").fill(date);
    await row.click();
    await expect(detail.getByText("Persistió sin respuesta al navegador", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeDisabled();
    expect(writes).toBe(2);
    await screen.getByRole("button", { name: "Consultar resultado guardado", exact: true }).click();
    await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toBeEnabled();
    await expect(warning).toHaveCount(0);
    expect(writes).toBe(2);
    await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
    await notes.getByLabel("Notas del turno", { exact: true }).fill("Nuevo cambio tras recepción confirmada");
    const nextSave = business.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/appointments/${saved.id}/notes`));
    await notes.getByRole("button", { name: "Guardar notas", exact: true }).click();
    expect((await nextSave).status()).toBe(200);
    await expect(detail.getByText("Nuevo cambio tras recepción confirmada", { exact: true })).toBeVisible();
    expect(writes).toBe(3);
  } finally { await context.close(); }
});

test("Turnos stale receipt never replaces current state and requires GET-only freshness recovery", async ({ browser, system }, testInfo) => {
  test.setTimeout(180_000);
  for (const inspected of [true, false]) {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const business = await context.newPage();
    try {
      const setup = await provision(adminPage, business, system, `stale-receipt-${inspected}`);
      const { client, service, resource, date, offer } = setup;
      const saved = await setup.create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id,
        date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
      await business.goto(`${system.webUrl}/turnos`);
      const screen = business.locator("main.turnos-screen");
      await screen.getByRole("button", { name: "Semana", exact: true }).click();
      await screen.getByLabel("Elegir fecha de la agenda").fill(date);
      const row = screen.getByRole("group", { name: `Turnos ${date}`, exact: true }).getByRole("button", { name: /Clara López/ });
      await row.click();
      const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
      await detail.getByRole("button", { name: "Editar notas", exact: true }).click();
      const form = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
      await form.getByLabel("Notas del turno", { exact: true }).fill("Historical receipt notes");
      let writes = 0;
      business.on("request", request => { if (request.method() === "PATCH") writes++; });
      let lossCompleted!: () => void, lossRejected!: (cause: unknown) => void;
      const lossCompletion = new Promise<void>((resolve, reject) => { lossCompleted = resolve; lossRejected = reject; });
      await business.route(`**/api/me/appointments/${saved.id}/notes`, async route => {
        try {
          const committed = await route.fetch(); expect(committed.status()).toBe(200);
          await route.abort("failed"); lossCompleted();
        } catch (cause) { lossRejected(cause); }
      });
      await form.getByRole("button", { name: "Guardar notas", exact: true }).click();
      await lossCompletion;
      await expect(screen.locator('.turnos-feedback > [role="alert"]').filter({ hasText: "El turno podría haberse guardado" })).toBeVisible();
      await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toBeVisible();
      await business.unroute(`**/api/me/appointments/${saved.id}/notes`);
      // Another authenticated session advances the record after the receipt was committed.
      const other = await browser.newContext();
      try {
        const otherPage = await other.newPage();
        await login(otherPage, system.webUrl, setup.email, setup.password);
        await expect(otherPage).toHaveURL(/\/inicio$/);
        const csrf = await otherPage.evaluate(() => sessionStorage.getItem("agendia.csrf"));
        const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
        const note = await otherPage.request.patch(`${system.webUrl}/api/me/appointments/${saved.id}/notes`, { headers, data: { notes: "Current newer notes" } });
        expect(note.status()).toBe(200);
        const cancel = await otherPage.request.patch(`${system.webUrl}/api/me/appointments/${saved.id}/state`, { headers, data: { state: "cancelled", confirmed: true } });
        expect(cancel.status()).toBe(200);
      } finally { await other.close(); }
      if (inspected) {
        await closeTurno(business);
        await row.click();
        await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
        await expect(detail.getByText("Current newer notes", { exact: true })).toBeVisible();
      }
      await business.route(`**/api/me/appointments/${saved.id}`, route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
      await business.route("**/api/me/appointments?*", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"INTERNAL_ERROR"}' }));
      await screen.getByRole("button", { name: "Consultar resultado guardado", exact: true }).click();
      await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toHaveCount(0);
      await expect(screen.getByText(/No pudimos verificar el estado actual del turno/)).toBeVisible();
      if (inspected) {
        await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
        await expect(detail.getByText("Current newer notes", { exact: true })).toBeVisible();
        await expect(detail.getByText("Historical receipt notes", { exact: true })).toHaveCount(0);
      } else {
        await expect(detail.getByText("Confirmado", { exact: true })).toBeVisible();
        await expect(detail.getByText("Sin notas", { exact: true })).toBeVisible(); // Retained saved projection, not the editor draft.
        const retainedEditor = detail.getByRole("form", { name: "Editar notas del turno", exact: true });
        const draft = retainedEditor.getByLabel("Notas del turno", { exact: true });
        await expect(draft).toHaveValue("Historical receipt notes"); // User input is retained, never installed as current saved notes.
        await expect(draft).toBeDisabled();
        await expect(retainedEditor.getByRole("button", { name: "Guardar notas", exact: true })).toBeDisabled();
        await expect(retainedEditor.getByRole("button", { name: "Cancelar notas", exact: true })).toBeDisabled();
        for (const name of ["Cancelar turno", "Marcar completado", "Marcar ausente"])
          await expect(detail.getByRole("button", { name, exact: true })).toBeDisabled();
        const savedNotes = detail.getByRole("region", { name: "Notas internas", exact: true });
        await expect(savedNotes.locator("p")).toHaveText("Sin notas");
      }
      await expect(screen.getByRole("button", { name: "Nuevo turno", exact: true, includeHidden: true })).toBeEnabled();
      expect(writes).toBe(1);
      await business.screenshot({ path: testInfo.outputPath(`stale-receipt-${inspected}-get-fault.png`), fullPage: true });
      await business.unroute(`**/api/me/appointments/${saved.id}`);
      await business.unroute("**/api/me/appointments?*");
      await screen.getByRole("button", { name: "Actualizar estado actual", exact: true }).click();
      await expect(screen.getByText(/No pudimos verificar el estado actual del turno/)).toHaveCount(0);
      await expect(detail.getByText("Cancelado", { exact: true })).toBeVisible();
      await expect(detail.getByText("Current newer notes", { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Editar notas", exact: true })).toHaveCount(0);
      expect(writes).toBe(1);
      await business.screenshot({ path: testInfo.outputPath(`stale-receipt-${inspected}-fresh.png`), fullPage: true });
    } finally { await context.close(); await adminContext.close(); }
  }
});

for (const path of ["/turnos", "/inicio", "/services"] as const) test(`Turnos mounted read recovery resolves atomic new-client POST response loss with one saved booking on ${path}`, async ({ browser, page, system }, testInfo) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const business = await context.newPage();
  try {
    const setup = await provision(page, business, system, `${path.slice(1)}-lost-create`);
    const midnight = new Date(`${setup.date}T03:00:00Z`);
    if (path === "/inicio") await business.clock.setFixedTime(new Date(midnight.getTime() - 60_000));
    await business.goto(`${system.webUrl}${path}`);
    const screen = business.locator(".turnos-screen");
    const origin = business.url();
    const today = screen.getByRole("region", { name: "Turnos de hoy", exact: true });
    if (path === "/inicio") await expect(today.getByText("No hay turnos para hoy.")).toBeVisible();
    if (path === "/turnos") await screen.getByLabel("Elegir fecha de la agenda").fill(setup.date);
    const agenda = screen.locator('.ag-main-surface[aria-label="Turnos del día"]');
    await screen.getByRole("button", { name: "Nuevo turno", exact: true }).click();
    const form = screen.getByRole("form", { name: "Crear turno", exact: true });
    await form.getByRole("button", { name: "Nuevo cliente", exact: true }).click();
    await form.getByLabel("Nombre", { exact: true }).fill("Nueva");
    await form.getByLabel("Apellido", { exact: true }).fill("Guardada");
    await form.getByLabel("Teléfono", { exact: true }).fill("11 23456773");
    await choice(form, "Servicio", setup.service.id).check();
    await form.getByRole("combobox", { name: "Recurso", exact: true }).selectOption(setup.resource.id);
    await form.getByLabel("Fecha", { exact: true }).fill(setup.date);
    await form.getByRole("button", { name: "Consultar horarios", exact: true }).click();
    await expect(form.getByText("Consultando disponibilidad…", { exact: true })).toHaveCount(0);
    await choice(form, "Horarios disponibles", setup.offer.start).check();
    await form.getByRole("button", { name: "Revisar turno", exact: true }).click();
    expect(await setup.read("appointments")).toHaveLength(0);
    expect(await setup.read("clients")).toHaveLength(1);
    let post = 0, key = "", savedId = "";
    const reads: Array<string | null> = [];
    business.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname !== "/api/me/appointments") return;
      if (request.method() === "POST") post++;
      if (request.method() === "GET") reads.push(url.searchParams.get("from"));
    });
    await business.route("**/api/me/appointments", async route => {
      if (route.request().method() !== "POST") return route.continue();
      key = route.request().headers()["x-appointment-operation-key"]!;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      savedId = (await response.json()).id;
      if (path === "/inicio") {
        // Hold the committed response until the browser crosses local midnight during the write.
        await business.clock.setFixedTime(midnight);
        await business.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(screen.locator(`time[datetime="${setup.date}"]`)).toBeAttached();
      }
      await route.abort("failed");
    });
    await form.getByRole("button", { name: "Confirmar turno", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("El turno podría haberse guardado");
    expect(post).toBe(1);
    expect(await setup.read("appointments")).toHaveLength(1);
    expect(await setup.read("clients")).toHaveLength(2);
    await business.unroute("**/api/me/appointments");
    const newTurn = screen.getByRole("button", { name: "Nuevo turno", exact: true, includeHidden: true });
    await expect(newTurn).toBeDisabled();
    if (path === "/inicio") {
      await closeTurno(business);
      expect(reads).not.toContain(midnight.toISOString());
      const refresh = today.getByRole("button", { name: "Actualizar turnos", exact: true });
      await expect(refresh).toBeEnabled();
      await expect(today.getByText("Actualizando turnos…")).toHaveCount(0);
      const readNewDay = business.waitForResponse(response => {
        const url = new URL(response.url());
        return response.request().method() === "GET" && url.pathname === "/api/me/appointments" && url.searchParams.get("from") === midnight.toISOString();
      });
      await refresh.click();
      expect((await readNewDay).status()).toBe(200);
      await expect(today.getByRole("button", { name: /Nueva Guardada/ })).toBeVisible();
      await expect(screen.getByRole("alert")).toContainText("El turno podría haberse guardado");
      await expect(newTurn).toBeDisabled();
      expect(post).toBe(1);
    }
    let currentStart = setup.offer.startMs;
    if (path === "/turnos") {
      await closeTurno(business);
      await expect(agenda.getByText("No hay turnos para este día.")).toHaveCount(0);
      await expect(agenda.locator(".ag-head-fact strong")).not.toHaveText("0");
      await expect(agenda.locator(".ag-avail-line")).toHaveCount(0);
      const later = setup.offers.find((slot: { startMs: number }) => slot.startMs > setup.offer.endMs);
      expect(later).toBeDefined();
      const moved = await business.request.patch(`${system.webUrl}/api/me/appointments/${savedId}`, { headers: setup.headers,
        data: { serviceId: setup.service.id, resourceId: setup.resource.id, date: setup.date, startRaw: later.start, expectedTerms: later.terms, confirmed: true } });
      expect(moved.status()).toBe(200);
      currentStart = later.startMs;
      await business.route(`**/api/me/appointments/${savedId}`, route => route.fulfill({ status: 503, json: { code: "INTERNAL_ERROR" } }));
    }
    const receiptResponse = business.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith(`/appointment-operations/${key}`), { timeout: 10_000 });
    await screen.getByRole("button", { name: "Consultar resultado guardado", exact: true }).press("Enter");
    const receipt = await receiptResponse;
    expect(receipt.status()).toBe(200);
    expect(await receipt.json()).toMatchObject({ state: "completed", appointment: { id: savedId, startMs: setup.offer.startMs } });
    if (path === "/turnos") {
      await expect(screen.getByText(/No pudimos verificar el estado actual del turno/)).toBeVisible();
      await expect(agenda.locator(".ag-avail-line")).toHaveCount(0);
      await expect(agenda.locator(".ag-head-fact strong")).toHaveText("—");
      await expect(agenda.getByText("No hay turnos para este día.")).toHaveCount(0);
      expect(post).toBe(1);
      await business.unroute(`**/api/me/appointments/${savedId}`);
      const detailGET = business.waitForResponse(r => r.request().method() === "GET" && r.url().endsWith(`/me/appointments/${savedId}`), { timeout: 10_000 });
      await screen.getByRole("button", { name: "Actualizar estado actual", exact: true }).press("Enter");
      expect(await (await detailGET).json()).toMatchObject({ id: savedId, startMs: currentStart });
      await expect(agenda.locator(".ag-avail-line")).toHaveCount(2);
      await expect(agenda.locator(".ag-day-appointments time")).toHaveAttribute("datetime", new Date(currentStart).toISOString());
      await expect(screen.getByText("Turno guardado", { exact: true })).toBeVisible();
      await agenda.getByRole("button", { name: /Nueva Guardada/ }).click();
    }
    await expect(form).toHaveCount(0);
    await expect(newTurn).toBeEnabled();
    if (path === "/inicio") {
      await expect(screen.getByText("Turno guardado", { exact: true })).toBeVisible();
      await today.getByRole("button", { name: /Nueva Guardada/ }).click();
    }
    const detail = screen.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByRole("heading", { name: "Nueva Guardada", exact: true })).toBeFocused();
    await expect(detail.getByText("Confirmado", { exact: true })).toBeVisible();
    expect(post).toBe(1);
    expect(await setup.read("appointments")).toHaveLength(1);
    expect(await setup.read("clients")).toHaveLength(2);
    await business.screenshot({ path: testInfo.outputPath("turnos-create-receipt-recovered.png"), fullPage: true });
    if (path === "/services") {
      await closeTurno(business);
      await expect(business).toHaveURL(origin);
      await expect(newTurn).toBeFocused();
    }
    await business.reload();
    await expect(screen.getByRole("button", { name: "Nuevo turno", exact: true })).toBeEnabled();
    await expect(screen.getByRole("button", { name: "Consultar resultado guardado", exact: true })).toHaveCount(0);
    expect(post).toBe(1);
  } finally { await context.close(); }
});
