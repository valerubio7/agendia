import { expect } from "@playwright/test";
import { createBusinessInAdminUi, login, test } from "./support/fixtures.ts";
import { scriptedAgentReply } from "./support/providers.ts";
import { assertSemanticBoundary } from "./support/system.ts";

const tenants = [
  {
    name: "Clínica Norte",
    email: "norte@example.test",
    password: "tenant norte password safe",
    description: "Atención clínica personalizada",
    address: "Avenida Norte 123",
  },
  {
    name: "Taller Sur",
    email: "sur@example.test",
    password: "tenant sur password safe",
    description: "Reparaciones y mantenimiento",
    address: "Calle Sur 456",
  },
];

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
    await createBusinessInAdminUi(page, tenant);
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
    await tenantPage.getByLabel("Descripción", { exact: true }).fill(tenant.description);
    await tenantPage.getByLabel("Dirección", { exact: true }).fill(tenant.address);
    for (const label of ["Horarios", "Servicios o productos"])
      await expect(tenantPage.getByLabel(label, { exact: true })).toHaveCount(0);
    await tenantPage.getByRole("button", { name: "Guardar perfil" }).click();
    await expect(tenantPage.locator(".profile-feedback").getByRole("status")).toHaveText("Perfil guardado");
    await tenantPage.reload();
    await expect(tenantPage.getByLabel("Nombre comercial")).toHaveValue(
      tenant.name,
    );
    await expect(tenantPage.getByLabel("Descripción", { exact: true })).toHaveValue(tenant.description);
    await expect(tenantPage.getByLabel("Dirección", { exact: true })).toHaveValue(tenant.address);
    await tenantPage.getByRole("link", { name: "Agente" }).click();
    await expect(tenantPage).toHaveURL(/\/agent$/);
    await tenantPage.getByLabel("Respuestas automáticas activas").check();
    await tenantPage.getByRole("button", { name: "Guardar y activar" }).click();
    await expect(tenantPage.locator(".agent-feedback").getByRole("status")).toHaveText(
      "Agente guardado",
    );
    await tenantPage.reload();
    await expect(
      tenantPage.getByLabel("Respuestas automáticas activas"),
    ).toBeChecked();
    await tenantPage.getByRole("link", { name: "Servicios", exact: true }).click();
    const serviceForm = tenantPage.getByRole("form", { name: "Crear servicio", exact: true });
    await serviceForm.getByLabel("Nombre", { exact: true }).fill(`Servicio ${tenant.name}`);
    await serviceForm.getByLabel("Duración (minutos)", { exact: true }).fill("30");
    await serviceForm.getByLabel("Precio (ARS)", { exact: true }).fill("1000");
    await serviceForm.getByRole("button", { name: "Crear servicio", exact: true }).click();
    await expect(serviceForm.getByRole("status")).toHaveText("Servicio creado");
    await expect(tenantPage.getByRole("list", { name: "Catálogo de servicios", exact: true })
      .getByRole("heading", { name: `Servicio ${tenant.name}`, exact: true })).toBeVisible();
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
      tenantPage.locator('[data-ui="whatsapp-status"]').getByRole("status"),
    ).toHaveText("Conectado", { timeout: 15_000 });
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
        `549112345678${index}@s.whatsapp.net`,
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
  for (const [index, item] of accepted.entries()) {
    await system.releaseReply(
      tenants[index]!.email, item.providerMessageId, 600, index,
    );
    await expect.poll(() => system.providers.baileys.acks.length).toBe(index + 1);
    expect(system.providers.deepSeek.calls).toHaveLength(index + 1);
  }
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
  expect(system.providers.baileys.acks.map(ack => ack.text)).toEqual(
    accepted.map(() => "No se guardó ningún cambio de agenda."),
  );
  system.providers.deepSeek.nativeCalls = [{ name: "read_catalog", arguments: {} }];
  for (const [index, tenant] of tenants.entries()) {
    const catalog = await system.receiveText(tenant.email, accepted[index]!.remoteJid, "Consultar servicios");
    await system.releaseReply(tenant.email, catalog.providerMessageId, 90, system.providers.deepSeek.calls.length);
    await expect.poll(() => system.providers.baileys.acks.length).toBe(3 + index);
    expect(system.providers.baileys.acks[2 + index]!.text).toBe(`Servicio ${tenant.name}: 30 minutos, ARS 1000`);
    expect(system.providers.baileys.acks[2 + index]!.jid).toBe(accepted[index]!.remoteJid);
    await expect.poll(() => system.agendaEvidence(tenant.email, catalog.providerMessageId)).toMatchObject({
      state: "completed", receipts: 1, clients: 0, appointments: 0, effects: 0, outbound: 1,
    });
  }
  expect(system.providers.deepSeek.calls[0]).toContain("Clínica Norte");
  expect(system.providers.deepSeek.calls[0]).not.toContain("Taller Sur");
  expect(system.providers.deepSeek.calls[1]).toContain("Taller Sur");
  expect(system.providers.deepSeek.calls[1]).not.toContain("Clínica Norte");

  const beforeSummaryAcks = system.providers.baileys.acks.length;
  const callsBeforeHistory = system.providers.deepSeek.calls.length;
  const history = await system.receiveText(
    tenants[0]!.email,
    accepted[0]!.remoteJid,
    "historial " + "x".repeat(9_000),
  );
  await system.releaseReply(
    tenants[0]!.email, history.providerMessageId, 90, callsBeforeHistory,
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
        coveredThrough: 5,
      }),
    ]);
  const callsBeforeGroup = system.providers.deepSeek.calls.length;
  const repliesBeforeGroup = system.providers.deepSeek.calls.filter(
    (call) => !call.includes("Resumen estructurado"),
  ).length;
  const acksBeforeGroup = system.providers.baileys.acks.length;
  const firstGroupText = "¿qué recordamos? [grupo-primero]";
  const latestGroupText = "Consultar servicios, último contexto del grupo [grupo-último]";
  const first = await system.receiveText(
    tenants[0]!.email,
    accepted[0]!.remoteJid,
    firstGroupText,
  );
  const firstPacing = await system.replyPacing(tenants[0]!.email, first.providerMessageId);
  const latest = await system.receiveText(
    tenants[0]!.email,
    accepted[0]!.remoteJid,
    latestGroupText,
  );
  const latestPacing = await system.replyPacing(tenants[0]!.email, latest.providerMessageId);
  expect(latestPacing.dueAt).toBe(firstPacing.dueAt);
  expect(latestPacing.outboxDueAt).toBe(firstPacing.outboxDueAt);
  await system.releaseReply(
    tenants[0]!.email, latest.providerMessageId, 90, callsBeforeGroup,
  );
  await expect.poll(() => system.providers.baileys.acks.length).toBe(acksBeforeGroup + 1);
  await expect
    .poll(async () =>
      Math.max(...(await system.summaryEvidence()).map((row) => row.version)),
    )
    .toBe(2);
  const summaries = await system.summaryEvidence();
  const groupRequest = system.providers.deepSeek.calls.slice(callsBeforeGroup).map(call => JSON.parse(call))
    .find(payload => Array.isArray(payload.tools) && payload.messages.at(-1)?.role === "user"
      && payload.messages.at(-1).content === `${firstGroupText}\n${latestGroupText}`);
  expect(groupRequest, "The latest grouped inbound must invoke the native tool provider").toBeDefined();
  const nextSummaryCall = system.providers.deepSeek.calls.findLast(call => call.includes("Resumen estructurado"));
  expect(nextSummaryCall).toContain("Resumen determinista");
  const groupContext = JSON.parse(groupRequest.messages[1].content);
  expect(groupContext.runtime.currentEvidence).toBe(latestGroupText);
  const receivedGroup = groupRequest.messages.at(-1).content.split("\n");
  expect(receivedGroup).toEqual([firstGroupText, latestGroupText]);
  expect(receivedGroup.filter((text: string) => text === firstGroupText)).toHaveLength(1);
  expect(receivedGroup.filter((text: string) => text === latestGroupText)).toHaveLength(1);
  expect(groupContext.business.displayName).toBe("Clínica Norte");
  expect(JSON.stringify(groupRequest)).not.toContain("Taller Sur");
  expect(system.providers.deepSeek.calls.filter(
    (call) => !call.includes("Resumen estructurado"),
  )).toHaveLength(repliesBeforeGroup + 2);
  assertSemanticBoundary("summary-update", {
    monotonic: summaries.some(
      (row) => row.version === 2 && row.coveredThrough > 5,
    ),
    usedByNextSummary: Boolean(nextSummaryCall?.includes("Resumen determinista")),
  });

  // Actual provider protocol → committed SQL receipts/effects → real API → panel.
  // No model-produced ID or synthetic provenance is accepted as delivery evidence.
  const businessPage = tenantPages[0]!;
  const csrf = await businessPage.evaluate(() => sessionStorage.getItem("agendia.csrf"));
  expect(csrf).toBeTruthy();
  const headers = { Origin: system.webUrl, "x-csrf-token": csrf! };
  const read = async (path: string) => {
    const response = await businessPage.request.get(`${system.webUrl}/api/me/${path}`);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const services = await read("services");
  const service = services.find((item: { name: string }) => item.name === `Servicio ${tenants[0]!.name}`);
  expect(service).toBeDefined();
  const schedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ startMinute: 0, endMinute: 1440 }]]));
  expect((await businessPage.request.put(`${system.webUrl}/api/me/business-calendar`, {
    headers, data: { weeklySchedule: schedule },
  })).status()).toBe(200);
  const resourceResponse = await businessPage.request.post(`${system.webUrl}/api/me/resources`, {
    headers, data: { name: "Native professional", serviceIds: [service.id], weeklySchedule: schedule },
  });
  expect(resourceResponse.status()).toBe(201);
  const resource = await resourceResponse.json();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86400000));
  const slots = await read(`appointments/availability?${new URLSearchParams({ serviceId: service.id, resourceId: resource.id, date })}`);
  const slot = slots.find((item: { startMs: number }) => item.startMs >= Date.parse(`${date}T10:00:00-03:00`));
  expect(slot).toBeDefined();
  const sendNative = async (text: string) => {
    const callsBefore = system.providers.deepSeek.calls.length;
    const acksBefore = system.providers.baileys.acks.length;
    const received = await system.receiveText(tenants[0]!.email, accepted[0]!.remoteJid, text);
    await system.releaseReply(tenants[0]!.email, received.providerMessageId, 90, callsBefore);
    await expect.poll(() => system.providers.baileys.acks.length).toBe(acksBefore + 1);
    const nativeRounds = system.providers.deepSeek.calls.slice(callsBefore)
      .map(call => JSON.parse(call)).filter(payload => Array.isArray(payload.tools));
    expect(nativeRounds).toHaveLength(2);
    expect(nativeRounds[0].messages.at(-1)).toMatchObject({ role: "user", content: text });
    expect(nativeRounds[1].messages.at(-1).role).toBe("tool");
    return received;
  };
  system.providers.deepSeek.nativeFinal = scriptedAgentReply;
  system.providers.deepSeek.nativeCalls = [{ name: "prepare_booking", arguments: {
    serviceId: service.id, resourceId: resource.id, startsAt: slot.start,
  } }];
  const prepared = await sendNative(`Reservar Servicio ${tenants[0]!.name} el ${date} a las 10:00`);
  expect(await system.agendaEvidence(tenants[0]!.email, prepared.providerMessageId)).toMatchObject({
    state: "completed", clients: 0, appointments: 0, effects: 0, receipts: 1,
  });
  system.providers.deepSeek.nativeCalls = [{ name: "confirm_quote", arguments: {} }];
  const quoted = await sendNative("Mi nombre es Clara López");
  expect(system.providers.baileys.acks.at(-1)!.text).toContain("30 minutos, ARS 1000");
  expect(await system.agendaEvidence(tenants[0]!.email, quoted.providerMessageId)).toMatchObject({ appointments: 0, effects: 0 });
  const delivery = await system.deliveryEvidence();
  expect(delivery.at(-1)).toMatchObject({ state: "sent" });
  let interpretedAcceptances = 0;
  system.providers.deepSeek.nativeCalls = messages => {
    const runtime = JSON.parse(messages[1]!.content!).runtime;
    expect(runtime.currentEvidence).toBe("dale reservame ese");
    expect(runtime.naturalConfirmation).not.toBeNull();
    interpretedAcceptances++;
    return [{ name: "confirm_quote_naturally", arguments: {
      evidence: runtime.currentEvidence, ...runtime.naturalConfirmation,
    } }];
  };
  const confirmed = await sendNative("dale reservame ese");
  expect(interpretedAcceptances).toBe(1);
  expect(await system.agendaEvidence(tenants[0]!.email, confirmed.providerMessageId)).toMatchObject({
    state: "completed", clients: 1, appointments: 1, receipts: 1, effects: 1, outbound: 1,
  });
  const appointmentPath = `appointments?${new URLSearchParams({ from: `${date}T00:00:00-03:00`, to: `${date}T23:59:59-03:00` })}`;
  const saved = await read(appointmentPath);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ origin: "ai", state: "confirmed", startsAt: slot.start,
    client: { firstName: "Clara", lastName: "López" }, terms: { serviceId: service.id, priceArs: 1000, durationMinutes: 30 } });
  await businessPage.getByRole("link", { name: "Turnos", exact: true }).click();
  const time = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(slot.startMs);
  for (const reload of [false, true]) {
    if (reload) await businessPage.reload();
    await businessPage.getByRole("button", { name: "Semana", exact: true }).click();
    const appointment = businessPage.getByRole("list", { name: `Turnos ${date}`, exact: true })
      .getByRole("button", { name: /Clara López/ });
    await expect(appointment).toHaveCount(1);
    await expect(appointment).toBeVisible();
    await expect(appointment.getByText(`Servicio ${tenants[0]!.name}`, { exact: true })).toBeVisible();
    await expect(appointment.getByText("Confirmado", { exact: true })).toBeVisible();
    await expect(appointment.locator("time")).toHaveAttribute("datetime", slot.start);
    await expect(appointment.locator("time")).toHaveText(time);
    const detailResponse = businessPage.waitForResponse(response =>
      response.url().endsWith(`/api/me/appointments/${saved[0].id}`) && response.status() === 200);
    await appointment.click();
    expect(await (await detailResponse).json()).toEqual(saved[0]);
    const dialog = businessPage.getByRole("dialog", { name: "Detalle del turno", exact: true });
    await expect(dialog).toBeVisible();
    const detail = dialog.getByRole("region", { name: "Detalle del turno", exact: true });
    await expect(detail.getByText("Confirmado", { exact: true })).toBeVisible();
    await expect(detail.getByText("IA", { exact: true })).toBeVisible();
  }
  expect(await read(appointmentPath)).toEqual(saved);
  expect(await system.agendaEvidence(tenants[0]!.email, confirmed.providerMessageId)).toMatchObject({
    state: "completed", clients: 1, appointments: 1, receipts: 1, effects: 1, outbound: 1,
  });
});
