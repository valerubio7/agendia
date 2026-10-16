import { expect, type APIResponse } from "@playwright/test";
import { test } from "./support/fixtures.ts";
import { assertSemanticBoundary, systemExposure } from "./support/system.ts";
import { formatActivityTimestamp } from "../../apps/web/src/live-panel.tsx";
import { receivedSenderEvidence } from "../../packages/domain/src/whatsapp-agenda.ts";

const ORIGIN = (system: { webUrl: string }) => system.webUrl;
const tenants = [
  {
    name: "Tenant Secreto Norte",
    email: "secure-a@example.test",
    password: "tenant secure a password",
    secret: "TENANT_A_PRIVATE_FACT",
  },
  {
    name: "Tenant Público Sur",
    email: "secure-b@example.test",
    password: "tenant secure b password",
    secret: "TENANT_B_OWN_FACT",
  },
];
type Auth = { cookie: string; csrf: string };

async function login(
  system: { apiUrl: string; webUrl: string },
  email: string,
  password: string,
): Promise<Auth> {
  const response = await fetch(`${system.apiUrl}/auth/login`, {
    method: "POST",
    headers: { origin: ORIGIN(system), "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    csrf: ((await response.json()) as { csrfToken: string }).csrfToken,
  };
}
async function api(
  system: { apiUrl: string; webUrl: string },
  auth: Auth,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
  origin = ORIGIN(system),
) {
  return fetch(`${system.apiUrl}${path}`, {
    method,
    headers: {
      cookie: auth.cookie,
      origin,
      "x-csrf-token": auth.csrf,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const assistant = (active: boolean, expectedRevision = 0) => ({
  style: "clara y amable",
  businessInstructions: "responder con conocimiento propio, solo texto y sin secretos",
  active,
  expectedRevision,
});
const profile = (tenant: (typeof tenants)[number]) => ({
  displayName: tenant.name,
  description: tenant.secret,
  address: "",
});
async function json(response: Response | APIResponse) {
  return response.json() as Promise<Record<string, unknown>>;
}

async function link(system: Parameters<typeof login>[0], auth: Auth) {
  expect((await api(system, auth, "/me/whatsapp/link", "POST")).status).toBe(
    202,
  );
  let qr = "";
  await expect
    .poll(async () => {
      const response = await api(system, auth, "/me/whatsapp/link");
      if (response.status === 200) qr = String((await json(response)).qr);
      return response.status;
    })
    .toBe(200);
  return qr;
}

test("contains hostile access and provider failures while preserving isolated recovery", async ({
  page,
  system,
}) => {
  test.setTimeout(300_000);
  expect(await system.readiness()).toEqual({
    postgres: true,
    api: true,
    web: true,
    manager: true,
    worker: true,
    baileys: true,
    deepSeek: true,
  });
  for (const origin of [undefined, "https://hostile.example"]) {
    const response = await fetch(`${system.apiUrl}/auth/login`, {
      method: "POST",
      headers: {
        ...(origin ? { origin } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: system.admin.email,
        password: system.admin.password,
      }),
    });
    expect(response.status).toBe(403);
  }
  const admin = await login(system, system.admin.email, system.admin.password);
  const ids: string[] = [];
  for (const tenant of tenants) {
    const response = await api(system, admin, "/admin/businesses", "POST", {
      name: tenant.name,
      userEmail: tenant.email,
      initialPassword: tenant.password,
    });
    expect(response.status).toBe(201);
    ids.push(String((await json(response)).id));
  }
  const tenantAuth = await Promise.all(
    tenants.map((tenant) => login(system, tenant.email, tenant.password)),
  );
  let authA = tenantAuth[0]!;
  const authB = tenantAuth[1]!;
  expect(
    (
      await api(
        system,
        authA,
        "/me/business-profile",
        "PUT",
        { ...profile(tenants[0]!), business_id: ids[1] },
        "https://hostile.example",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await api(
        system,
        { ...authA, csrf: "hostile-csrf" },
        "/me/business-profile",
        "PUT",
        profile(tenants[0]!),
      )
    ).status,
  ).toBe(403);
  expect((await api(system, admin, "/me/business-profile")).status).toBe(403);
  expect(
    (
      await api(system, authA, `/admin/businesses/${ids[1]}/status`, "PUT", {
        status: "suspended",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await api(system, authA, "/me/business-profile", "PUT", {
        ...profile(tenants[0]!),
        business_id: ids[1],
      })
    ).status,
  ).toBe(200);
  expect((await api(system, authB, "/me/business-profile")).status).toBe(200);
  expect(
    JSON.stringify(
      await json(await api(system, authB, "/me/business-profile")),
    ),
  ).not.toContain(tenants[0]!.secret);
  expect(
    (await api(system, authA, "/me/assistant", "PUT", assistant(true))).status,
  ).toBe(200);
  expect(
    (
      await api(
        system,
        authB,
        "/me/business-profile",
        "PUT",
        profile(tenants[1]!),
      )
    ).status,
  ).toBe(200);
  expect(
    (await api(system, authB, "/me/assistant", "PUT", assistant(true))).status,
  ).toBe(200);
  // Only the initial QR-isolation phase opts out of the 750ms auto-open.
  // Later recovery/reconnect sockets keep the double's default behavior.
  system.providers.baileys.holdSocket(1);
  system.providers.baileys.holdSocket(2);
  const freshQr = await Promise.all([link(system, authA), link(system, authB)]);
  expect([...freshQr].sort()).toEqual([
    "deterministic-qr-1",
    "deterministic-qr-2",
  ]);
  const adminQrStatus = (await api(system, admin, "/me/whatsapp/link")).status;
  expect(adminQrStatus).toBe(403);
  await system.expireLinkCode(tenants[0]!.email);
  const expiredQrStatus = (await api(system, authA, "/me/whatsapp/link"))
    .status;
  expect(expiredQrStatus).toBe(404);
  const ownerQr = await json(await api(system, authB, "/me/whatsapp/link"));
  expect(ownerQr).toEqual({ qr: freshQr[1] });
  await Promise.all([
    system.providers.baileys.openSocket(1),
    system.providers.baileys.openSocket(2),
  ]);
  await expect
    .poll(async () =>
      Promise.all(
        [authA, authB].map(
          async (auth) =>
            (await json(await api(system, auth, "/me/whatsapp/status"))).status,
        ),
      ),
    )
    .toEqual(["connected", "connected"]);
  const openedQrStatus = (await api(system, authB, "/me/whatsapp/link")).status;
  expect(openedQrStatus).toBe(404);
  expect((await api(system, authA, "/me/whatsapp/link", "POST")).status).toBe(
    409,
  );
  assertSemanticBoundary("qr-lifecycle-api", {
    ownerReceivedExactQr: ownerQr.qr === freshQr[1],
    adminForbidden: adminQrStatus === 403,
    expiredNotFound: expiredQrStatus === 404,
    openedNotFound: openedQrStatus === 404,
  });

  const linkedAssistantA = await json(
    await api(system, authA, "/me/assistant"),
  );
  expect(
    (
      await api(
        system,
        authA,
        "/me/assistant",
        "PUT",
        assistant(false, Number(linkedAssistantA.revision)),
      )
    ).status,
  ).toBe(200);

  await system.expireSessions(tenants[0]!.email);
  expect((await api(system, authA, "/auth/session")).status).toBe(401);
  authA = await login(system, tenants[0]!.email, tenants[0]!.password);
  expect(
    (
      await api(system, admin, `/admin/businesses/${ids[0]}/status`, "PUT", {
        status: "suspended",
      })
    ).status,
  ).toBe(200);
  expect((await api(system, authA, "/auth/session")).status).toBe(401);
  expect(
    (
      await system.receive(tenants[0]!.email, {
        providerMessageId: "suspended",
      })
    ).outcome,
  ).toBe("automation_inactive");
  expect(
    (
      await api(system, admin, `/admin/businesses/${ids[0]}/status`, "PUT", {
        status: "active",
      })
    ).status,
  ).toBe(200);
  authA = await login(system, tenants[0]!.email, tenants[0]!.password);
  const retained = await json(await api(system, authA, "/me/assistant"));
  expect(retained).toMatchObject({ active: false });
  expect(
    (
      await api(
        system,
        authA,
        "/me/assistant",
        "PUT",
        assistant(true, Number(retained.revision)),
      )
    ).status,
  ).toBe(200);

  const callsBeforeFilters = system.providers.deepSeek.calls.length,
    ingressBeforeFilters = system.providers.baileys.ingressIds.length;
  expect((await system.receiveUnknown()).outcome).toBe("unknown_session");
  expect(
    (
      await system.receive(tenants[0]!.email, {
        providerMessageId: "group",
        chatType: "group",
      })
    ).outcome,
  ).toBe("ignored_group");
  expect(
    (
      await system.receive(tenants[0]!.email, {
        providerMessageId: "own",
        fromMe: true,
      })
    ).outcome,
  ).toBe("ignored_from_me");
  expect(
    (
      await system.receive(tenants[0]!.email, {
        providerMessageId: "media",
        kind: "image",
        text: null,
      })
    ).outcome,
  ).toBe("ignored_non_text");
  expect(system.providers.deepSeek.calls).toHaveLength(callsBeforeFilters);
  assertSemanticBoundary("socket-ingress-filters", {
    allCrossedProviderSocket:
      system.providers.baileys.ingressIds.length === ingressBeforeFilters + 4,
    noAiBypass: system.providers.deepSeek.calls.length === callsBeforeFilters,
  });

  system.providers.deepSeek.nativeCalls = [{ name: "read_catalog", arguments: {} }];
  const agendaJid = "5491123456782@s.whatsapp.net";
  for (const [index, mode] of (["header-deadline", "body-deadline", "error"] as const).entries()) {
    const id = `agenda-${mode}`;
    const calls = system.providers.deepSeek.calls.length;
    const aborted = system.providers.deepSeek.agendaAborts;
    const failure = system.providers.deepSeek.configureAgendaTransport(mode);
    expect((await system.receive(tenants[0]!.email, {
      providerMessageId: id, remoteJid: `549112345678${index}@s.whatsapp.net`, text: "Consultar servicios",
    })).outcome).toBe("accepted");
    await system.releaseReply(tenants[0]!.email, id, 600, calls);
    // Observe the real abort (5s headers / enclosing 20s conversation deadline for body).
    await failure;
    const emptyFailure = {
      failureCode: mode === "error" ? "provider_unavailable" : "timeout",
      clients: 0, appointments: 0, receipts: 0, effects: 0, outbound: 0,
    };
    await expect.poll(() => system.agendaEvidence(tenants[0]!.email, id)).toEqual({
      ...emptyFailure, state: "retry",
    });
    const job = await system.agendaJobEvidence(tenants[0]!.email, id);
    expect(job).toMatchObject({
      id: job.outboxId, singletonKey: `ai:${id}`, data: { correlationId: `ai:${id}` },
      state: "retry", retryCount: 0, retryLimit: 2, retryDelay: 5, retryBackoff: true, scheduled: true,
    });
    // Drain this same published job before changing the double's global failure mode.
    for (const retryCount of [0, 1, 2]) {
      const state = retryCount === 2 ? "failed" : "retry";
      await expect.poll(() => system.agendaJobEvidence(tenants[0]!.email, id), {
        timeout: 30_000, intervals: [100, 250, 500],
      }).toEqual({ ...job, state, retryCount, scheduled: state === "retry" });
      expect(await system.agendaEvidence(tenants[0]!.email, id)).toEqual({ ...emptyFailure, state });
      expect(system.providers.deepSeek.calls).toHaveLength(calls + retryCount + 1);
      expect(system.providers.deepSeek.agendaAborts).toBe(aborted + (mode === "error" ? 0 : retryCount + 1));
      expect(system.providers.baileys.acks).toHaveLength(0);
      if (state === "retry") await system.releaseAgendaRetry(tenants[0]!.email, id, job.id, retryCount);
    }
    expect(JSON.parse(system.providers.deepSeek.calls[calls]!).tools.some((tool: { function: { name: string } }) => tool.function.name === "read_catalog")).toBe(true);
    expect(system.providers.baileys.acks).toHaveLength(0);
  }
  // Agenda failures escape to the queue; they do not commit a terminal ai.failed message.
  expect((await system.evidence()).audit.filter(row => row.type === "ai.failed")).toHaveLength(0);
  void system.providers.deepSeek.configureAgendaTransport("success");
  const recovered = await system.receiveText(tenants[0]!.email, agendaJid, "Consultar servicios");
  // Failed attempts retain the already released deadline: recovery must not need a second release.
  await expect.poll(() => system.providers.baileys.acks.length).toBe(1);
  expect(system.providers.baileys.acks[0]).toMatchObject({ jid: agendaJid, text: "No hay servicios activos registrados." });
  await expect.poll(() => system.agendaEvidence(tenants[0]!.email, recovered.providerMessageId)).toMatchObject({
    state: "completed", clients: 0, appointments: 0, receipts: 1, effects: 0, outbound: 1,
  });
  const silent = await system.evidence();

  system.providers.deepSeek.summaryNext = "timeout";
  const outboundBeforeSummary = silent.outbound.length;
  const callsBeforeSummary = system.providers.deepSeek.calls.length;
  const summaryInput = await system.receiveText(
    tenants[0]!.email,
    "summary-timeout@s.whatsapp.net",
    "largo " + "z".repeat(9_000),
  );
  await system.releaseReply(
    tenants[0]!.email, summaryInput.providerMessageId, 600, callsBeforeSummary,
  );
  await expect
    .poll(async () =>
      (await system.evidence()).technical.map((row) => row.code),
    )
    .toContain("ai.summary_failed");
  await expect
    .poll(async () => (await system.evidence()).outbound.length)
    .toBe(outboundBeforeSummary + 1);
  await system.restartWorker();
  await expect
    .poll(
      async () =>
        (await system.summaryEvidence()).some(
          (row) => row.email === tenants[0]!.email && row.coveredThrough === 1,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  assertSemanticBoundary("summary-fallback", {
    failureObserved: (await system.evidence()).technical.some(
      (row) => row.code === "ai.summary_failed",
    ),
    currentResponseContinued:
      (await system.evidence()).outbound.length === outboundBeforeSummary + 1,
    restartRecovered: (await system.summaryEvidence()).some(
      (row) => row.email === tenants[0]!.email && row.coveredThrough === 1,
    ),
  });

  const callsBeforeRejected = system.providers.deepSeek.calls.length;
  system.providers.baileys.next = "rejected";
  await system.receive(tenants[0]!.email, {
    providerMessageId: "send-rejected",
    text: "reject",
  });
  await system.releaseReply(tenants[0]!.email, "send-rejected", 600, callsBeforeRejected);
  await expect
    .poll(async () =>
      (await system.evidence()).outbound.map((row) => row.state),
    )
    .toContain("failed");
  const callsBeforeCrash = system.providers.deepSeek.calls.length;
  system.providers.baileys.next = "crash";
  await system.receive(tenants[0]!.email, {
    providerMessageId: "send-crash",
    text: "crash",
  });
  await system.releaseReply(tenants[0]!.email, "send-crash", 600, callsBeforeCrash);
  await expect
    .poll(async () =>
      (await system.evidence()).outbound.map((row) => row.state),
    )
    .toContain("delivery_unknown");
  const attemptsAfterCrash = system.providers.baileys.sendAttempts;
  system.providers.baileys.transientClose();
  await system.restartManager();
  expect(system.providers.baileys.sendAttempts).toBe(attemptsAfterCrash);
  expect(
    (await json(await api(system, authA, "/me/whatsapp/status"))).status,
  ).toBe("connected");

  const callsBeforeRecovery = system.providers.deepSeek.calls.length;
  const recoveryJid = "5491123456788@s.whatsapp.net";
  expect(receivedSenderEvidence({ remoteJid: recoveryJid })).toMatchObject({ phone: "+5491123456788" });
  await system.recoverWorker(tenants[1]!.email, {
    providerMessageId: "worker-recovery",
    remoteJid: recoveryJid,
    text: "Consultar servicios, recover",
  });
  // Restart must retain the initial deadline; only this explicit release makes
  // the durable outbox eligible for the recovered worker.
  await system.releaseReply(tenants[1]!.email, "worker-recovery", 600, callsBeforeRecovery);
  await expect
    .poll(
      async () =>
        (await system.evidence()).outbound.filter(
          (row) => row.email === tenants[1]!.email && row.state === "sent",
        ).length,
    )
    .toBe(1);
  assertSemanticBoundary(
    "durable-outbox-recovery",
    await system.outboxEvidence("worker-recovery"),
  );
  await expect
    .poll(async () => (await system.evidence()).audit.map((row) => row.type))
    .toEqual(
      expect.arrayContaining([
        "whatsapp.send_failed",
        "whatsapp.delivery_unknown",
      ]),
    );
  const evidence = await system.evidence();
  expect(evidence.tenants.every((row) => row.messages > 0)).toBe(true);
  for (const mode of ["header-deadline", "body-deadline", "error"]) {
    expect(await system.agendaEvidence(tenants[0]!.email, `agenda-${mode}`)).toEqual({
      state: "failed", failureCode: mode === "error" ? "provider_unavailable" : "timeout",
      clients: 0, appointments: 0, receipts: 0, effects: 0, outbound: 0,
    });
    expect(await system.agendaJobEvidence(tenants[0]!.email, `agenda-${mode}`)).toMatchObject({
      state: "failed", retryCount: 2,
    });
  }
  const recoveryRequest = system.providers.deepSeek.calls.slice(callsBeforeRecovery)
    .map(call => JSON.parse(call))
    .find(payload => Array.isArray(payload.tools) && payload.messages.at(-1)?.role === "user"
      && payload.messages.at(-1).content === "Consultar servicios, recover");
  expect(recoveryRequest, "Worker recovery must invoke the native provider, not a fixed fallback").toBeDefined();
  expect(JSON.parse(recoveryRequest.messages[1].content).runtime.currentEvidence).toBe("Consultar servicios, recover");
  expect(JSON.stringify(recoveryRequest)).not.toContain(tenants[0]!.secret);
  expect(await system.agendaEvidence(tenants[1]!.email, "worker-recovery")).toMatchObject({
    state: "completed", clients: 0, appointments: 0, receipts: 1, effects: 0, outbound: 1,
  });

  const adminBusinesses = (await json(
    await api(system, admin, "/admin/businesses"),
  )) as unknown as Array<{ lastTechnicalActivityAt: string | null }>;
  const activityAt = adminBusinesses.find(
    (business) => business.lastTechnicalActivityAt,
  )?.lastTechnicalActivityAt;
  expect(activityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await page.context().clearCookies();
  await page.goto(system.webUrl);
  await page.getByLabel("Correo").fill(system.admin.email);
  await page.getByLabel("Contraseña").fill(system.admin.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(/businesses$/);
  await expect(
    page
      .getByText(formatActivityTimestamp(activityAt!), { exact: true })
      .first(),
  ).toBeVisible();
  await expect(page.getByText(activityAt!, { exact: true })).toHaveCount(0);
  const exposed = systemExposure(
    await page.locator("body").innerText(),
    { evidence, adminBusinesses },
    system.logs,
  );
  const sensitive = [
    ...freshQr,
    authA.cookie,
    authA.csrf,
    "E2E_PROVIDER_SECRET",
    "summary-timeout@s.whatsapp.net",
    "reject",
    "crash",
    "provider rejected message",
    "socket lost after send started",
    "provider unavailable",
    "deterministic timeout",
    ...tenants.map((tenant) => tenant.secret),
  ];
  for (const value of sensitive) expect(exposed).not.toContain(value);
  assertSemanticBoundary("safe-audit-activity", {
    criticalAudit: ["whatsapp.send_failed", "whatsapp.delivery_unknown"].every(
      (type) => evidence.audit.some((row) => row.type === type),
    ),
    tenantScoped: evidence.audit
      .filter((row) =>
        ["whatsapp.send_failed", "whatsapp.delivery_unknown"].includes(
          row.type,
        ),
      )
      .every((row) => row.email === tenants[0]!.email),
    adminActivityVisible: Boolean(activityAt),
    rawTimestampHidden:
      (await page.getByText(activityAt!, { exact: true }).count()) === 0,
    secretsRedacted: sensitive.every((value) => !exposed.includes(value)),
  });
});
