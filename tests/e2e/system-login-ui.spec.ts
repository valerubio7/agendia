import { expect } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";

const passwordRecoveryName =
  /(?:olvid|recuper).*(?:contraseña|clave)|(?:contraseña|clave).*(?:olvid|recuper)/i;

test("administrators can sign in only through the administration entrance", async ({ page, system }) => {
  for (const path of ["/", "/login"]) {
    await page.goto(`${system.webUrl}${path}`);
    await page.getByLabel("Correo", { exact: true }).fill(system.admin.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(system.admin.password);
    await page.getByRole("button", { name: "Ingresar", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(`${system.webUrl}${path}`);
    expect((await page.context().cookies()).filter((cookie) => cookie.name === "__Host-agendia_session")).toHaveLength(0);
  }
  await page.goto(`${system.webUrl}/admin/login`);
  await page.getByLabel("Correo", { exact: true }).fill(system.admin.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(system.admin.password);
  await page.getByRole("checkbox", { name: "Mantener sesión iniciada" }).check();
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await expect(page).toHaveURL(/\/businesses$/);
  const cookie = (await page.context().cookies()).find(item => item.name === "__Host-agendia_session");
  expect(cookie?.secure).toBe(true);
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000);
  await expect(page.locator('[data-ui="authenticated-shell"]')).toBeVisible();
  const activity = page.waitForResponse(response => response.url().endsWith("/api/auth/activity") && response.request().method() === "POST");
  await page.keyboard.press("Tab");
  expect((await activity).status()).toBe(204);
});

for (const [status, code, message, expected] of [
  [401, "UNAUTHENTICATED", "Invalid credentials", "No se pudo iniciar sesión. Revisá tus datos o intentá nuevamente más tarde."],
  [429, "FORBIDDEN", "Too many login attempts", "No se pudo iniciar sesión. Intentá nuevamente más tarde."],
] as const) {
  for (const path of ["/login", "/admin/login"]) {
    test(`${path} shows neutral feedback for ${status}`, async ({ page, system }) => {
      await page.route(`**/api/auth/${path === "/admin/login" ? "admin/login" : "login"}`, route =>
        route.fulfill({ status, json: { code, message } }));
      await page.goto(`${system.webUrl}${path}`);
      await page.getByLabel("Correo", { exact: true }).fill("user@example.test");
      await page.getByLabel("Contraseña", { exact: true }).fill("invalid password here");
      await page.getByRole("button", { name: "Ingresar", exact: true }).click();
      await expect(page.locator("main").getByRole("alert")).toHaveText(expected);
      await expect(page).toHaveURL(`${system.webUrl}${path}`);
      await expect(page.getByRole("button", { name: "Ingresar", exact: true })).toBeEnabled();
    });
  }
}

test("login preserves its approved semantic, responsive, and pending-state contract", async ({
  page,
  system,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  for (const [path, title] of [
    ["/admin/login", "Acceso de administración"],
    ["/login", "Iniciar sesión"],
  ] as const) {
    await page.goto(`${system.webUrl}${path}`);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByLabel("Correo", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Contraseña", { exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Mantener sesión iniciada" })).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Ingresar", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.goto(system.webUrl);

  const formPanel = page;
  const form = page.locator("form").filter({ has: page.getByLabel("Correo", { exact: true }) });
  await expect(form).toHaveAttribute("aria-busy", "false");
  const remember = formPanel.getByRole("checkbox", { name: "Mantener sesión iniciada" });
  await expect(remember).not.toBeChecked();
  const email = formPanel.getByLabel("Correo", { exact: true });
  const password = formPanel.getByLabel("Contraseña", { exact: true });
  await expect(email).toHaveAttribute("name", "email");
  await expect(email).toHaveAttribute("type", "email");
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(email).toHaveAttribute("autocapitalize", "none");
  await expect(password).toHaveAttribute("name", "password");
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(email).toHaveAttribute("required", "");
  await expect(password).toHaveAttribute("required", "");
  expect(
    await email.evaluate(
      (element: HTMLInputElement) => element.labels?.length ?? 0,
    ),
  ).toBeGreaterThan(0);
  expect(
    await password.evaluate(
      (element: HTMLInputElement) => element.labels?.length ?? 0,
    ),
  ).toBeGreaterThan(0);
  await expect(password).toHaveAttribute("minlength", "16");

  const submit = formPanel.getByRole("button", {
    name: "Ingresar",
    exact: true,
  });
  await expect(submit).toBeEnabled();
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await email.focus();
    await page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(remember).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(submit).toBeFocused();
    for (const control of [email, password, remember, submit]) {
      await control.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(control).toBeFocused();
      expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      expect(await control.evaluate((element) => {
        const style = getComputedStyle(element);
        return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none";
      })).toBe(true);
    }
  }
  await expect(
    formPanel
      .getByRole("link", { name: passwordRecoveryName })
      .or(formPanel.getByRole("button", { name: passwordRecoveryName })),
  ).toHaveCount(0);

  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.goto(`${system.webUrl}/admin/login`);
  let loginRequestCount = 0;
  let observeLoginRequest!: () => void;
  const loginRequestObserved = new Promise<void>((resolve) => {
    observeLoginRequest = resolve;
  });
  let releaseLoginRequest!: () => void;
  const loginRequestReleased = new Promise<void>((resolve) => {
    releaseLoginRequest = resolve;
  });
  await page.route("**/auth/admin/login", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ email: system.admin.email, password: system.admin.password });
    loginRequestCount++;
    observeLoginRequest();
    await loginRequestReleased;
    await route.continue();
  });

  await submit.click();
  expect(await email.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
  expect(await password.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
  expect(loginRequestCount).toBe(0);
  await email.fill("not-an-email");
  await password.fill(system.admin.password);
  await submit.click();
  expect(await email.evaluate((element: HTMLInputElement) => element.validity.typeMismatch)).toBe(true);
  expect(loginRequestCount).toBe(0);
  await email.fill(system.admin.email);
  await password.fill("");
  await password.pressSequentially("short");
  await submit.click();
  expect(await password.evaluate((element: HTMLInputElement) => element.validity.tooShort)).toBe(true);
  expect(loginRequestCount).toBe(0);
  await expect(form).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await expect(page).toHaveURL(system.webUrl + "/admin/login");

  await password.fill(system.admin.password);
  await Promise.all([loginRequestObserved, password.press("Enter")]);

  try {
    const pendingSubmit = formPanel.getByRole("button", {
      name: "Ingresando…",
      exact: true,
    });
    await expect(pendingSubmit).toBeDisabled();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(email).toBeEnabled();
    await expect(password).toBeEnabled();
    await password.press("Enter");
    expect(loginRequestCount).toBe(1);
  } finally {
    releaseLoginRequest();
  }

  await expect(page).toHaveURL(/\/businesses$/);
  expect(loginRequestCount).toBe(1);
});

test("an active session skips the login screens", async ({ browser, system }) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await login(adminPage, `${system.webUrl}/admin/login`, system.admin.email, system.admin.password);
  await expect(adminPage).toHaveURL(/\/businesses$/);
  await createBusinessInAdminUi(adminPage, {
    name: "Clínica Centro",
    email: "centro@example.test",
    password: "tenant centro password safe",
  });
  for (const path of ["/", "/login"]) {
    await adminPage.goto(`${system.webUrl}${path}`);
    await expect(adminPage).toHaveURL(/\/businesses$/);
  }
  await adminPage.goto(`${system.webUrl}/admin/login`);
  await expect(adminPage.getByRole("button", { name: "Ingresar", exact: true })).toBeVisible();
  await adminContext.close();

  const tenantContext = await browser.newContext();
  const tenantPage = await tenantContext.newPage();
  await login(tenantPage, system.webUrl, "centro@example.test", "tenant centro password safe");
  await expect(tenantPage).toHaveURL(/\/profile$/);
  for (const path of ["/", "/login"]) {
    await tenantPage.goto(`${system.webUrl}${path}`);
    await expect(tenantPage).toHaveURL(/\/profile$/);
  }
  await tenantContext.close();
});
