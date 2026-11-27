import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { createBusinessInAdminUi, login, test } from "./support/fixtures";

const referencePath = process.env.AGENDIA_APPEARANCE_REFERENCE;

async function paintedType(page: Page, selector: string) {
  const locator = page.locator(selector);
  await expect(locator).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    const faces = [...new Set(fonts.filter(font => font.glyphCount > 0).map(font => font.familyName))].sort();
    expect(faces.length, `No painted glyphs at ${selector}`).toBeGreaterThan(0);
    return {
      faces,
      ...await locator.evaluate(element => {
        const { color, fontSize, fontWeight, letterSpacing, lineHeight } = getComputedStyle(element);
        return { color, fontSize, fontWeight, letterSpacing, lineHeight };
      }),
    };
  } finally { await session.detach(); }
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
}

async function motion(target: Locator, property?: string) {
  return target.evaluate((element, property) => {
    const anim = element.getAnimations().find(a => property ? a instanceof CSSTransition && a.transitionProperty === property : a instanceof CSSAnimation);
    if (!anim?.effect) return null;
    const effect = anim.effect as KeyframeEffect;
    const timing = effect.getTiming();
    const easing = property ? timing.easing : effect.getKeyframes()[0]?.easing;
    return { duration: timing.duration, easing };
  }, property);
}

async function color(target: Locator, property = "background-color", pseudo?: string) {
  return target.evaluate((element, { property, pseudo }) => getComputedStyle(element, pseudo).getPropertyValue(property), { property, pseudo });
}

test("Servicios matches the reference card hover and keyboard focus at both widths", async ({ browser, page, system }, info) => {
  test.skip(!referencePath, "Set AGENDIA_APPEARANCE_REFERENCE to the local read-only UX/UI HTML");
  const tenant = { name: "Hover Servicios", email: "service-hover@example.test", password: "service hover password" };
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, tenant);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "no-preference" });
  try {
    const actual = await context.newPage();
    const reference = await context.newPage();
    await login(actual, `${system.webUrl}/login`, tenant.email, tenant.password);
    await expect(actual).toHaveURL(/\/inicio$/);
    const csrf = await actual.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const service = await actual.request.post(`${system.webUrl}/api/me/services`, {
      headers: { Origin: system.webUrl, "x-csrf-token": csrf! },
      data: { name: "Corte", durationMinutes: 30, priceArs: 9500 },
    });
    expect(service.status()).toBe(201);
    for (const width of [1280, 360]) {
      for (const target of [actual, reference]) await target.setViewportSize({ width, height: 800 });
      await reference.goto(pathToFileURL(referencePath!).href);
      await reference.locator('[data-action="role-business"]').click();
      await reference.locator('.app-side [data-page="espacio"]').evaluate(control => (control as HTMLElement).click());
      await reference.locator('.biz-apps [data-page="oferta"]').click();
      await actual.goto(`${system.webUrl}/services`);
      const sample = reference.locator(".service-tile").first();
      const card = actual.locator(".service-tile").first();
      for (const tile of [sample, card]) {
        await expect(tile).toBeVisible();
        await tile.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
      }
      const point = { x: 26, y: 45 };
      await Promise.all([sample.hover({ position: point }), card.hover({ position: point })]);
      const [referenceMotion, actualMotion] = await Promise.all([motion(sample, "transform"), motion(card, "transform")]);
      expect.soft(referenceMotion, `${width}px reference hover transition`).not.toBeNull();
      expect.soft(actualMotion, `${width}px card hover transition`).toEqual(referenceMotion);
      for (const tile of [sample, card]) {
        expect(await tile.evaluate(element => element.matches(":hover"))).toBe(true);
        await tile.evaluate(async element => { await Promise.allSettled(element.getAnimations({ subtree: true }).map(a => a.finished)); });
      }
      for (const property of ["background-color", "color", "transform", "border-top-color", "box-shadow"]) {
        const value = await color(sample, property);
        expect.soft(await color(card, property), `${width}px hovered card ${property} vs reference`).toBe(value);
      }
      for (const property of ["background-color", "color"]) {
        expect.soft(await color(card.locator(".service-arrow"), property), `${width}px hovered arrow ${property}`)
          .toBe(await color(sample.locator(".service-arrow"), property));
      }
      await capture(reference, info, `services-hover-reference-${width}`);
      await capture(actual, info, `services-hover-app-${width}`);
      for (const [target, tile] of [[reference, sample], [actual, card]] as const) {
        await target.mouse.move(0, 0);
        await tile.focus();
        await target.keyboard.press("Shift+Tab");
        await target.keyboard.press("Tab");
        await expect(tile).toBeFocused();
        expect(await tile.evaluate(element => element.matches(":focus-visible") && !element.matches(":hover"))).toBe(true);
      }
      for (const property of ["outline-color", "outline-width", "outline-offset"]) {
        expect.soft(await color(card, property), `${width}px keyboard focus ${property}`).toBe(await color(sample, property));
      }
    }
  } finally { await context.close(); }
});

test("the authenticated panel matches rendered type, interactive colors and motion at both widths", async ({ browser, page, system }, info) => {
  test.skip(!referencePath, "Set AGENDIA_APPEARANCE_REFERENCE to the local read-only UX/UI HTML");
  const tenant = { name: "Estudio Oliva", email: "appearance@example.test", password: "appearance tenant password" };
  await login(page, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await createBusinessInAdminUi(page, tenant);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  try {
    const actual = await context.newPage();
    const reference = await context.newPage();
    actual.setDefaultTimeout(8_000);
    reference.setDefaultTimeout(8_000);
    for (const [role, path] of [["business", "/login"], ["admin", "/admin/login"]]) {
      const signedOut = await context.newPage();
      for (const width of [1280, 360]) {
        await signedOut.setViewportSize({ width, height: 800 });
        await signedOut.goto(`${system.webUrl}${path}`);
        await expect(signedOut.getByRole("button", { name: "Ingresar", exact: true })).toBeEnabled();
        await signedOut.evaluate(() => Promise.all(Array.from(document.images).filter(image => image.getClientRects().length).map(image => image.decode())));
        await capture(signedOut, info, `login-${role}-${width}`);
      }
      await signedOut.close();
    }
    await login(actual, `${system.webUrl}/login`, tenant.email, tenant.password);
    await expect(actual).toHaveURL(/\/inicio$/);
    const csrf = await actual.evaluate(() => sessionStorage.getItem("agendia.csrf"));
    expect(csrf).toBeTruthy();
    const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
    const profile = { displayName: tenant.name, description: "Un espacio de cuidado personal donde cada detalle cuenta.", address: "Av. Hipólito Yrigoyen 850, San Rafael, Mendoza" };
    expect((await actual.request.put(`${system.webUrl}/api/me/business-profile`, { headers, data: profile })).status()).toBe(200);
    const create = async (path: string, data: object) => {
      const response = await actual.request.post(`${system.webUrl}/api/me/${path}`, { headers, data });
      expect(response.status(), path).toBe(201);
      return response.json();
    };
    const weeklySchedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
    expect((await actual.request.put(`${system.webUrl}/api/me/business-calendar`, { headers, data: { weeklySchedule } })).status()).toBe(200);
    const client = await create("clients", { name: "Clara López", phone: "+5491123456777" });
    const service = await create("services", { name: "Corte", durationMinutes: 30, priceArs: 9500 });
    const resource = await create("resources", { name: "Consultorio", serviceIds: [service.id], weeklySchedule });
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(Date.now() + 2 * 86400000));
    const availability = await actual.request.get(`${system.webUrl}/api/me/appointments/availability?${new URLSearchParams({ serviceId: service.id, resourceId: resource.id, date })}`);
    expect(availability.ok()).toBe(true);
    const offers = await availability.json() as { startMs: number; start: string; terms: object }[];
    const offer = offers.find(slot => slot.startMs === Date.parse(`${date}T11:30:00-03:00`));
    if (!offer) throw new Error("Missing the seeded 11:30 appointment slot");
    await create("appointments", { serviceId: service.id, resourceId: resource.id, clientId: client.id, date, startRaw: offer.start, expectedTerms: offer.terms, confirmed: true });
    await actual.clock.setFixedTime(new Date(`${date}T13:00:00Z`));
    const writes: string[] = [];
    actual.on("request", request => {
      if (new URL(request.url()).pathname === "/api/me/appointments" && request.method() === "POST") writes.push(request.method());
    });
    for (const width of [1280, 360]) {
      for (const target of [actual, reference]) await target.setViewportSize({ width, height: 800 });
      await reference.goto(pathToFileURL(referencePath!).href);
      await reference.locator('[data-action="role-business"]').click();
      await actual.goto(`${system.webUrl}/inicio`);
      const compare = async (state: string, pairs: [string, string][]) => {
        await capture(reference, info, `${width}-${state}-reference`);
        await capture(actual, info, `${width}-${state}-app`);
        for (const [sample, target] of pairs) {
          const app = await paintedType(actual, target), prototype = await paintedType(reference, sample);
          console.log(`${width}px ${target}`, { app, prototype });
          expect.soft(app, `${width}px ${target}`).toEqual(prototype);
        }
      };
      const compareMotion = async (sample: Locator, target: Locator, property?: string) => {
        const prototype = await motion(sample, property), app = await motion(target, property);
        console.log(`${width}px ${target} ${property ?? "opening"} motion`, { app, prototype });
        expect.soft(prototype, `No running reference motion at ${sample}`).not.toBeNull();
        expect.soft(app, `${width}px ${target} motion`).toEqual(prototype);
      };
      const surfaces = async (sample: Locator, target: Locator, properties: string[], pseudo?: string) => {
        for (const control of [sample, target]) {
          await control.evaluate(async element => {
            await Promise.allSettled(element.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished));
          });
        }
        for (const property of properties) {
          const app = await color(target, property, pseudo), prototype = await color(sample, property);
          console.log(`${width}px ${target} ${property}: ${app} / ${prototype}`);
          expect.soft(app, `${width}px ${target} ${property}`).toBe(prototype);
        }
      };
      await compare("inicio", [
        [".start-day-number", ".business-home__date strong"],
        [".start-next-time", ".business-home__next time"],
        [".start-item:first-child .start-time", ".business-home__today li:first-child .business-home__row time"],
      ]);
      const referenceCard = reference.locator(".start-next");
      const card = actual.locator(".business-home__next");
      await surfaces(reference.locator(".side-main"), actual.locator(".authenticated-shell__workspace"), ["background-color"]);
      const corner = async (target: Locator, selector: string) => target.evaluate((element, selector) => {
        const { x, y } = element.getBoundingClientRect();
        const point = { x: x + 15, y: y + 12 };
        return { ...point, hit: !!document.elementFromPoint(point.x, point.y)?.closest(selector) };
      }, selector);
      const referenceHit = await corner(referenceCard, ".start-next");
      const appHit = await corner(actual.locator(".business-home__upcoming"), ".business-home__next");
      console.log(`${width}px Inicio card corner hit`, { appHit, referenceHit });
      expect(referenceHit.hit).toBe(true);
      expect.soft(appHit.hit).toBe(true);
      await Promise.all([
        reference.mouse.move(referenceHit.x, referenceHit.y), actual.mouse.move(appHit.x, appHit.y),
      ]);
      await compareMotion(referenceCard, card, "transform");
      await surfaces(referenceCard, card, ["background-color", "transform"]);
      await capture(reference, info, `${width}-inicio-hover-reference`);
      await capture(actual, info, `${width}-inicio-hover-app`);
      await reference.mouse.click(referenceHit.x, referenceHit.y);
      await actual.mouse.click(appHit.x, appHit.y);
      const detail = actual.getByRole("dialog", { name: "Detalle del turno", exact: true });
      await expect(detail.and(actual.locator("dialog:modal"))).toBeVisible();
      await expect(detail.getByText("Clara López", { exact: true })).toBeVisible();
      await reference.locator('[data-action="close-drawer"]').click();
      await actual.keyboard.press("Escape");
      await expect(card).toBeFocused();
      const refRow = reference.locator(".start-item").first(), row = actual.locator(".business-home__row").first();
      await Promise.all([refRow.hover(), row.hover()]);
      await compareMotion(refRow, row, "background-color");
      await surfaces(refRow, row, ["background-color", "margin-left", "padding-left"]);
      await Promise.all([
        reference.locator('.fab-booking').click(), actual.getByRole("button", { name: "Nuevo turno", exact: true }).click(),
      ]);
      const refBooking = reference.locator(".turno-modal"), booking = actual.locator(".turnos-dialog:modal");
      // Booking intentionally uses the profile entrance, not the prototype's booking-specific motion.
      await expect(booking).toHaveCSS("animation-name", "panel-float-in");
      await compare("nuevo-turno", [
        [".turno-modal .drawer-header h2", ".turnos-dialog__header h2"],
        [".turno-control-label[for='turno-date']", "label[for='turnos-date']"],
        [".turno-client-mode button[aria-pressed='true']", ".booking-mode button[aria-pressed='true']"],
      ]);
      for (const [sample, target] of [["#turno-date", "#turnos-date"], ["#turno-client-search", "#turnos-client-search"]] as const) {
        await surfaces(reference.locator(sample), actual.locator(target), ["font-family", "font-weight", "font-size", "color", "background-color", "border-top-color"]);
      }
      await surfaces(refBooking, booking, ["background-color", "border-radius"]);
      await surfaces(reference.locator(".overlay.centered"), booking, ["background-color"], "::backdrop");
      for (const mode of [false, true]) {
        await surfaces(reference.locator(`.turno-client-mode button[aria-pressed="${mode}"]`), actual.locator(`.booking-mode button[aria-pressed="${mode}"]`), ["background-color", "color"]);
      }
      await actual.getByRole("button", { name: "Nuevo cliente", exact: true }).click();
      await reference.locator('[data-turno-client-mode="new"]').click();
      await surfaces(reference.locator('[data-turno-client-mode="new"]'), actual.getByRole("button", { name: "Nuevo cliente", exact: true }), ["color", "background-color"]);
      await actual.getByRole("button", { name: "Cliente registrado", exact: true }).click();
      const review = actual.getByRole("button", { name: "Revisar turno", exact: true });
      await review.click();
      const error = "Elegí el servicio antes de guardar.";
      await expect(actual.locator(".toast-area .toast")).toHaveText(error);
      await reference.evaluate(message => {
        (window as unknown as { turnoError(message: string): void }).turnoError(message);
      }, error);
      await compare("validacion", [[".turno-error", ".turnos-screen .turno-error"], [".toast-area .toast", ".toast-area .toast"]]);
      await surfaces(reference.locator(".toast-area .toast"), actual.locator(".toast-area .toast"), ["background-color"]);
      const count = writes.length;
      await actual.locator("#turnos-client-search").fill(client.name);
      await booking.getByRole("button", { name: "Buscar cliente", exact: true }).click();
      await booking.getByRole("list", { name: "Resultados de clientes" }).getByRole("button", { name: /Clara López/ }).click();
      await booking.locator(`input[name="turnos-service"][value="${service.id}"]`).check();
      await booking.getByRole("combobox", { name: "Recurso", exact: true }).selectOption(resource.id);
      await booking.getByRole("button", { name: "Consultar horarios", exact: true }).click();
      const slot = offers.find(slot => slot.startMs === Date.parse(`${date}T${width === 1280 ? "12:00" : "12:30"}:00-03:00`));
      await booking.locator(`input[name="turnos-start"][value="${slot!.start}"]`).check();
      await review.click();
      expect(writes).toHaveLength(count);
      await booking.getByRole("button", { name: "Confirmar turno", exact: true }).click();
      await expect(actual.locator(".toast-area .toast")).toHaveText("Turno guardado");
      expect(writes).toHaveLength(count + 1);
      await reference.locator('[data-action="close-drawer"]').click();
      await reference.evaluate(() => {
        (window as unknown as { showToast(message: string): void }).showToast("Turno guardado");
      });
      await compare("guardado", [[".toast-area .toast", ".toast-area .toast"]]);
      await surfaces(reference.locator(".toast-area .toast"), actual.locator(".toast-area .toast"), ["background-color", "animation-duration", "animation-timing-function"]);
      await actual.keyboard.press("Escape");
      await expect(booking).toBeHidden();
      if (width === 360) {
        await reference.locator('.nav-mobile-top [data-action="brand-toggle"]').click();
        await actual.getByLabel("Menú", { exact: true }).click();
      }
      const menu = actual.locator(width === 360 ? ".business-shell__drawer" : ".business-shell__rail");
      const refNav = reference.locator('.app-side [data-page="espacio"]');
      const nav = menu.getByRole("link", { name: "Negocio", exact: true });
      await refNav.hover();
      await nav.hover();
      await surfaces(refNav, nav, ["color", "background-color"]);
      await capture(reference, info, `${width}-menu-hover-reference`);
      await capture(actual, info, `${width}-menu-hover-app`);
      await refNav.click();
      await nav.click();
      await expect(actual.locator(".negocio-card h1")).toHaveText(tenant.name);
      await compare("negocio", [[".biz-business-view h1", ".negocio-card h1"], [".biz-business-view p", ".negocio-card__copy p"]]);
      if (width === 360) {
        await reference.locator('.nav-mobile-top [data-action="brand-toggle"]').click();
        await actual.getByLabel("Menú", { exact: true }).click();
      }
      await surfaces(refNav, nav, ["color", "background-color"]);
      if (width === 360) {
        await refNav.click(); // Selecting the current prototype section closes its drawer.
        await actual.keyboard.press("Escape");
      }
      const edit = actual.getByRole("button", { name: "Editar información del negocio", exact: true });
      await Promise.all([reference.locator('[data-action="business-profile-open"]').click(), edit.click()]);
      await compareMotion(reference.locator(".float-dialog"), actual.locator(".negocio-dialog"));
      await expect(actual.locator(".negocio-dialog:modal")).toBeVisible();
      await compare("negocio-editor", [
        [".float-heading h2", ".negocio-dialog h2"],
        ['label[for="float-business-description"]', 'label[for="profile-description"]'],
      ]);
      await actual.keyboard.press("Escape");
      await expect(actual.locator(".negocio-dialog")).toBeHidden();
      await expect(edit).toBeFocused();
      await reference.locator('.float-close[data-action="close-float"]').click();
      for (const [path, sample, target, refTile, tile, refArrow, arrow] of [
        ["services", "oferta", "Servicios", ".service-tile", ".service-tile", ".service-arrow", ".service-arrow"],
        ["resources", "recursos", "Recursos", ".resource-tile", ".rd-tile", ".resource-tile-arrow", ".rd-arrow"],
      ] as const) {
        await reference.locator(`.biz-apps [data-page="${sample}"]`).click();
        await actual.getByRole("link", { name: target, exact: true }).click();
        const ref = reference.locator(refTile).first(), app = actual.locator(tile).first();
        // Stop the prototype's page-change smooth scroll before placing the pointer.
        for (const tile of [ref, app]) {
          await tile.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
        }
        const position = { x: 26, y: 45 };
        await Promise.all([ref.hover({ position }), app.hover({ position })]);
        await compareMotion(ref, app, "transform");
        await surfaces(ref, app, ["transform", "border-top-color", "box-shadow"]);
        for (const tile of [ref, app]) expect.soft(await tile.evaluate(element => element.matches(":hover"))).toBe(true);
        await surfaces(ref.locator(refArrow), app.locator(arrow), ["background-color", "color"]);
        await capture(reference, info, `${width}-${path}-hover-reference`);
        await capture(actual, info, `${width}-${path}-hover-app`);
        await actual.goto(`${system.webUrl}/profile`);
        if (width === 360) await reference.locator('.nav-mobile-top [data-action="brand-toggle"]').click();
        await refNav.click();
      }
    }
  } finally { await context.close(); }
});
