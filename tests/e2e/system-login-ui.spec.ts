import { expect } from "@playwright/test";
import { test } from "./support/fixtures.ts";

const passwordRecoveryName =
  /(?:olvid|recuper).*(?:contraseña|clave)|(?:contraseña|clave).*(?:olvid|recuper)/i;

test("login preserves its approved semantic, responsive, and pending-state contract", async ({
  page,
  system,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(system.webUrl);

  await expect(page).toHaveTitle("agendIA");
  await expect(page.locator("main")).toHaveCount(1);

  const frame = page.locator('[data-ui="login-frame"]');
  await expect(frame).toHaveCount(1);

  const story = frame.locator('[data-ui="login-story"]');
  const formPanel = frame.locator('[data-ui="login-form-panel"]');
  await expect(story).toHaveCount(1);
  await expect(formPanel).toHaveCount(1);
  await expect(
    story.getByRole("img", { name: "agendIA", exact: true }),
  ).toHaveCount(1);
  await expect(
    formPanel.getByRole("img", { name: "agendIA", exact: true }),
  ).toHaveCount(1);

  const storyLockup = story.getByRole("img", {
    name: "agendIA",
    exact: true,
  });
  const formLockup = formPanel.getByRole("img", {
    name: "agendIA",
    exact: true,
  });
  const storyLockupBox = await storyLockup.boundingBox();
  const formLockupBox = await formLockup.boundingBox();
  expect(storyLockupBox).not.toBeNull();
  expect(formLockupBox).not.toBeNull();
  expect(storyLockupBox!.width).toBeGreaterThanOrEqual(
    formLockupBox!.width * 1.5,
  );

  await expect(
    frame.getByRole("heading", {
      name: "Atendé mejor. Sin estar pendiente.",
      exact: true,
    }),
  ).toBeVisible();

  const storyHeading = story.getByRole("heading", {
    name: "Atendé mejor. Sin estar pendiente.",
    exact: true,
  });
  const primaryHeadingLine = storyHeading.locator(
    '[data-ui="login-story-heading-primary"]',
  );
  const accentHeadingLine = storyHeading.locator(
    '[data-ui="login-story-heading-accent"]',
  );
  await expect(primaryHeadingLine).toHaveText("Atendé mejor.");
  await expect(accentHeadingLine).toHaveText("Sin estar pendiente.");

  const primaryHeadingLineBox = await primaryHeadingLine.boundingBox();
  const accentHeadingLineBox = await accentHeadingLine.boundingBox();
  expect(primaryHeadingLineBox).not.toBeNull();
  expect(accentHeadingLineBox).not.toBeNull();
  expect(accentHeadingLineBox!.y).toBeGreaterThanOrEqual(
    primaryHeadingLineBox!.y + primaryHeadingLineBox!.height,
  );

  const semanticHeadingColors = await page.evaluate(() => {
    const resolveColor = (cssVariable: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${cssVariable})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };

    return {
      paper: resolveColor("--paper"),
      pineDeep: resolveColor("--pine-deep"),
    };
  });
  const [primaryHeadingColor, accentHeadingColor] = await Promise.all([
    primaryHeadingLine.evaluate((element) => getComputedStyle(element).color),
    accentHeadingLine.evaluate((element) => getComputedStyle(element).color),
  ]);
  expect(primaryHeadingColor).toBe(semanticHeadingColors.paper);
  expect(accentHeadingColor).toBe(semanticHeadingColors.paper);
  await expect(story).toHaveCSS("background-color", semanticHeadingColors.pineDeep);
  await expect(
    story.getByText(
      "Menos tiempo pendiente del teléfono. Más tiempo para dedicarle a tu negocio.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    formPanel.getByRole("heading", {
      name: "Iniciar sesión",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/^Ingresá para administrar/)).toHaveCount(0);

  const email = formPanel.getByLabel("Correo", { exact: true });
  const password = formPanel.getByLabel("Contraseña", { exact: true });
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
  // Approved pairs and roles must hold across the actual responsive layouts.
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(submit).toHaveCSS("background-color", "rgb(46, 107, 78)");
    await expect(submit).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(submit).toHaveCSS("font-weight", "650");
    await expect(storyHeading).toHaveCSS("font-weight", "650");
    await expect(frame.locator(".login-story__eyebrow")).toHaveCSS("font-family", /"JetBrains Mono"/);
    await expect(frame.locator(".login-story__eyebrow")).toHaveCSS("font-weight", "700");
    await expect(frame.locator(".login-story__eyebrow")).toHaveCSS("font-variant-numeric", "tabular-nums");
    await expect(frame.locator(".login-story__copy")).toHaveCSS("color", semanticHeadingColors.paper);
    await expect(formPanel.locator("h1")).toHaveCSS("font-weight", "650");
    await expect(formPanel.locator(".login-field").first()).toHaveCSS("font-weight", "650");
    await expect(email).toHaveCSS("font-weight", "450");
    await expect(email).toHaveCSS("color", "rgb(28, 38, 32)");
    await expect(email).toHaveCSS("background-color", semanticHeadingColors.paper);
    for (const control of [email, submit]) {
      await control.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(control).toBeFocused();
      expect(await control.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      await expect(control).toHaveCSS("outline-color", "rgb(168, 58, 26)");
      await expect(control).toHaveCSS("outline-style", "solid");
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

  let observeLoginRequest!: () => void;
  const loginRequestObserved = new Promise<void>((resolve) => {
    observeLoginRequest = resolve;
  });
  let releaseLoginRequest!: () => void;
  const loginRequestReleased = new Promise<void>((resolve) => {
    releaseLoginRequest = resolve;
  });
  await page.route("**/auth/login", async (route) => {
    observeLoginRequest();
    await loginRequestReleased;
    await route.continue();
  });

  await email.fill(system.admin.email);
  await password.fill(system.admin.password);
  await Promise.all([loginRequestObserved, submit.click()]);

  try {
    const pendingSubmit = formPanel.getByRole("button", {
      name: "Ingresando…",
      exact: true,
    });
    await expect(pendingSubmit).toBeDisabled();
    await expect(pendingSubmit).toHaveCSS("background-color", "rgb(46, 107, 78)");
    await expect(pendingSubmit).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(pendingSubmit).toHaveCSS("opacity", "1");
    await expect(pendingSubmit).toHaveCSS("cursor", "wait");
  } finally {
    releaseLoginRequest();
  }

  await expect(page).toHaveURL(/\/businesses$/);
});
