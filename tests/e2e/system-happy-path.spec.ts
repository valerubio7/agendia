import { expect } from "@playwright/test";
import { test } from "./support/fixtures.ts";
import { assertSemanticBoundary } from "./support/system.ts";

const tenants = [
  {
    name: "Clínica Norte",
    email: "norte@example.test",
    password: "tenant norte password safe",
    hours: "Lunes a viernes",
  },
  {
    name: "Taller Sur",
    email: "sur@example.test",
    password: "tenant sur password safe",
    hours: "Cerrado ahora",
  },
];

async function login(
  page: import("@playwright/test").Page,
  url: string,
  email: string,
  password: string,
) {
  await page.goto(url);
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

test("real services complete the deterministic multi-tenant happy path", async ({
  browser,
  page,
  system,
}) => {
  expect(await system.readiness()).toEqual({
    postgres: true,
    api: true,
    web: true,
    manager: true,
    worker: true,
    baileys: true,
    deepSeek: true,
  });
  await login(page, system.webUrl, system.admin.email, system.admin.password);
  await expect(page).toHaveURL(/\/businesses$/);
  for (const tenant of tenants) {
    await page.getByLabel("Nombre", { exact: true }).fill(tenant.name);
    await page.getByLabel("Correo del usuario").fill(tenant.email);
    await page.getByLabel("Contraseña inicial").fill(tenant.password);
    await page.getByRole("button", { name: "Crear negocio" }).click();
    await expect(
      page.getByRole("cell", { name: tenant.name, exact: true }),
    ).toBeVisible();
  }

  const tenantPages: import("@playwright/test").Page[] = [];
  let visibleQr = 0,
    connectedUi = 0;
  for (const tenant of tenants) {
    const context = await browser.newContext();
    const tenantPage = await context.newPage();
    tenantPages.push(tenantPage);
    await login(tenantPage, system.webUrl, tenant.email, tenant.password);
    await expect(tenantPage).toHaveURL(/\/profile$/);
    await tenantPage.getByLabel("Nombre comercial").fill(tenant.name);
    await tenantPage.getByLabel("Horarios").fill(tenant.hours);
    await tenantPage.getByRole("button", { name: "Guardar perfil" }).click();
    await expect(tenantPage.getByRole("status")).toHaveText("Perfil guardado");
    await tenantPage.reload();
    await expect(tenantPage.getByLabel("Nombre comercial")).toHaveValue(
      tenant.name,
    );
    await expect(tenantPage.getByLabel("Horarios")).toHaveValue(tenant.hours);
    await tenantPage.getByRole("link", { name: "Asistente" }).click();
    await expect(tenantPage).toHaveURL(/\/assistant$/);
    await tenantPage.getByLabel("Respuestas automáticas activas").check();
    await tenantPage.getByRole("button", { name: "Guardar y activar" }).click();
    await expect(tenantPage.getByRole("status")).toHaveText(
      "Asistente guardado",
    );
    await tenantPage.reload();
    await expect(
      tenantPage.getByLabel("Respuestas automáticas activas"),
    ).toBeChecked();
    await tenantPage.getByRole("link", { name: "WhatsApp" }).click();
    await expect(tenantPage).toHaveURL(/\/whatsapp$/);
    await tenantPage.getByRole("button", { name: "Vincular WhatsApp" }).click();
    await expect(
      tenantPage.getByRole("button", { name: "Esperando conexión…" }),
    ).toBeDisabled();
    const qrImage = tenantPage.getByRole("img", {
      name: "Código QR temporal de WhatsApp",
    });
    await expect(qrImage).toBeVisible();
    await expect(qrImage).toHaveAttribute("src", /^data:image\/png;base64,/);
    visibleQr++;
    await expect(
      tenantPage.getByText("Conectado", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(qrImage).toBeHidden();
    await expect(
      tenantPage.getByRole("button", { name: "WhatsApp vinculado" }),
    ).toBeDisabled();
    connectedUi++;
  }

  const accepted = await Promise.all(
    tenants.map((tenant, index) =>
      system.receiveText(
        tenant.email,
        `chat-${index}@s.whatsapp.net`,
        `consulta ${tenant.name}`,
      ),
    ),
  );
  expect(accepted.map(({ outcome }) => outcome)).toEqual([
    "accepted",
    "accepted",
  ]);
  assertSemanticBoundary("qr-visible-ui", {
    bothQrVisible: visibleQr === 2,
    bothConnected: connectedUi === 2,
  });
  assertSemanticBoundary("socket-ingress", {
    providerObservedEveryMessage: accepted.every(({ providerMessageId }) =>
      system.providers.baileys.ingressIds.includes(providerMessageId),
    ),
    productionAcceptedBoth: accepted.every(
      ({ outcome }) => outcome === "accepted",
    ),
  });
  expect(await system.receiveGroup(tenants[0]!.email)).toBe("ignored_group");
  await expect.poll(() => system.providers.deepSeek.calls.length).toBe(2);
  await expect.poll(() => system.providers.baileys.acks.length).toBe(2);
  expect(system.providers.baileys.acks.map(({ jid }) => jid)).toEqual(
    accepted.map(({ remoteJid }) => remoteJid),
  );
  const emptyRejected = await system.providers.baileys.rejectsRecipient("");
  assertSemanticBoundary("exact-recipient", {
    emptyRejected,
    exactJids: system.providers.baileys.acks.every(
      (ack, index) => ack.jid === accepted[index]?.remoteJid,
    ),
  });
  const evidence = await system.deliveryEvidence();
  expect(evidence).toEqual(
    expect.arrayContaining(
      accepted.map((item) =>
        expect.objectContaining({
          connection_id: item.connectionId,
          state: "sent",
        }),
      ),
    ),
  );
  expect(system.providers.deepSeek.calls[0]).toContain("Clínica Norte");
  expect(system.providers.deepSeek.calls[0]).not.toContain("Taller Sur");
  expect(system.providers.deepSeek.calls[1]).toContain("Taller Sur");
  expect(system.providers.deepSeek.calls[1]).not.toContain("Clínica Norte");

  const beforeSummaryAcks = system.providers.baileys.acks.length;
  await system.receiveText(
    tenants[0]!.email,
    "chat-0@s.whatsapp.net",
    "historial " + "x".repeat(9_000),
  );
  await expect
    .poll(() => system.providers.baileys.acks.length)
    .toBe(beforeSummaryAcks + 1);
  await expect
    .poll(() => system.summaryEvidence())
    .toEqual([
      expect.objectContaining({
        email: tenants[0]!.email,
        version: 1,
        coveredThrough: 3,
      }),
    ]);
  await system.receiveText(
    tenants[0]!.email,
    "chat-0@s.whatsapp.net",
    "¿qué recordamos?",
  );
  await expect
    .poll(async () =>
      Math.max(...(await system.summaryEvidence()).map((row) => row.version)),
    )
    .toBe(2);
  const summaries = await system.summaryEvidence(),
    contextCall = system.providers.deepSeek.calls.findLast(
      (call) => !call.includes("Resumen estructurado"),
    );
  expect(contextCall).toContain("Resumen determinista");
  assertSemanticBoundary("summary-update", {
    monotonic: summaries.some(
      (row) => row.version === 2 && row.coveredThrough >= 3,
    ),
    usedByResponse: Boolean(contextCall?.includes("Resumen determinista")),
  });
});
