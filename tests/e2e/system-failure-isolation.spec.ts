import { expect, type APIResponse } from "@playwright/test";
import { test } from "./support/fixtures.ts";
import { assertSemanticBoundary, systemExposure } from "./support/system.ts";
import { formatActivityTimestamp } from "../../apps/web/src/live-panel.tsx";

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
  personality: "clara",
  tone: "amable",
  instructions: "responder",
  knowledge: "propio",
  rules: "texto",
  restrictions: "sin secretos",
  active,
  expectedRevision,
});
const profile = (tenant: (typeof tenants)[number]) => ({
  displayName: tenant.name,
  description: tenant.secret,
  address: "",
  contact: "",
  businessHours: "cerrado",
  offerings: "servicio",
  faq: "",
  policies: "",
  additionalInfo: "",
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

  system.providers.deepSeek.next = "timeout";
  await system.receive(tenants[0]!.email, {
    providerMessageId: "ai-timeout",
    text: "timeout",
  });
  await expect
    .poll(async () =>
      (await system.evidence()).technical.map((row) => row.code),
    )
    .toContain("ai.timeout");
  system.providers.deepSeek.next = "error";
  await system.receive(tenants[0]!.email, {
    providerMessageId: "ai-error",
    text: "error",
  });
  await expect
    .poll(async () =>
      (await system.evidence()).technical.map((row) => row.code),
    )
    .toContain("ai.provider_unavailable");
  const silent = await system.evidence();
  expect(silent.outbound).toHaveLength(0);
  expect(
    silent.technical
      .filter((row) => row.code.startsWith("ai."))
      .every((row) => row.email === tenants[0]!.email),
  ).toBe(true);

  system.providers.deepSeek.summaryNext = "timeout";
  const outboundBeforeSummary = silent.outbound.length;
  await system.receiveText(
    tenants[0]!.email,
    "summary-timeout@s.whatsapp.net",
    "largo " + "z".repeat(9_000),
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

  system.providers.baileys.next = "rejected";
  await system.receive(tenants[0]!.email, {
    providerMessageId: "send-rejected",
    text: "reject",
  });
  await expect
    .poll(async () =>
      (await system.evidence()).outbound.map((row) => row.state),
    )
    .toContain("failed");
  system.providers.baileys.next = "crash";
  await system.receive(tenants[0]!.email, {
    providerMessageId: "send-crash",
    text: "crash",
  });
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

  await system.recoverWorker(tenants[1]!.email, {
    providerMessageId: "worker-recovery",
    text: "recover",
  });
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
  expect(
    evidence.audit.filter((row) => row.type === "ai.failed").length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    system.providers.deepSeek.calls.find((call) => call.includes("recover")),
  ).not.toContain(tenants[0]!.secret);

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
