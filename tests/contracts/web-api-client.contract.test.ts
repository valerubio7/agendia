import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Algorithm, hash } from "@node-rs/argon2";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApi } from "../../apps/api/src/app.ts";
import {
  ApiClient,
  ApiError,
  createBrowserApiTransport,
  formValues,
  type ApiTransport,
} from "../../apps/web/src/api-client.ts";
import {
  formatActivityTimestamp,
  runWhatsAppLinkMonitor,
} from "../../apps/web/src/live-panel.tsx";
import { renderWhatsAppQrDataUrl } from "../../apps/web/src/qr-code.ts";
import { createRuntimePools } from "@agendia/db";
import {
  createWhatsAppManager,
  type WhatsAppGateway,
} from "../../apps/whatsapp-manager/src/index.ts";
import {
  applyPostgresMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@agendia/test-support";

const ORIGIN = "https://panel.agendia.test";
const LINK_KEY = Buffer.alloc(32, 6);
let database: TestPostgres,
  pools: ReturnType<typeof createRuntimePools>,
  app: ReturnType<typeof buildApi>;
const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
let cookie = "",
  responseCacheControl = "";
const transport: ApiTransport = async (input, init) => {
  const path = input.replace("/api", "");
  requests.push({ path, init });
  const headers = new Headers(init?.headers),
    headerRecord: Record<string, string> = {};
  if (cookie) headers.set("cookie", cookie);
  if (init?.method && init.method !== "GET") headers.set("origin", ORIGIN);
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });
  const reply = await app.inject({
    method: (init?.method ?? "GET") as "GET",
    url: path,
    headers: headerRecord,
    payload: init?.body as string,
  });
  const setCookie = reply.headers["set-cookie"];
  if (setCookie)
    cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
      ";",
    )[0]!;
  responseCacheControl = String(reply.headers["cache-control"] ?? "");
  return new Response(reply.body, {
    status: reply.statusCode,
    headers: reply.headers as HeadersInit,
  });
};

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(
    database.sql,
    join(import.meta.dir, "../../packages/db/migrations"),
  );
  await database.sql`insert into auth_identities (normalized_email,password_phc,role) values (${"admin@web.test"},${await hash("correct horse battery staple", { algorithm: Algorithm.Argon2id })},'platform_admin')`;
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: ORIGIN, linkCodeKey: LINK_KEY });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pools?.end();
  await database?.stop();
});

describe("Next web client against Fastify contracts", () => {
  test("allowlists form fields and never forwards tenant identity", () => {
    const form = new FormData();
    form.set("displayName", "Tenant");
    form.set("business_id", "hostile");
    form.set("active", "on");
    expect(formValues(form, ["displayName", "active"])).toEqual({
      displayName: "Tenant",
      active: true,
    });
  });

  test("validates API base and path composition before injected transport", async () => {
    let transportCalls = 0;
    const safeTransport: ApiTransport = async (input) => {
      transportCalls += 1;
      expect(input).toBe("/api/auth/session");
      return Response.json({ role: "platform_admin", businessId: null });
    };

    await expect(new ApiClient(safeTransport).session()).resolves.toEqual({
      role: "platform_admin",
      businessId: null,
    });
    expect(transportCalls).toBe(1);

    for (const base of [
      "https://attacker.test/api",
      "//attacker.test/api",
      "/api/../outside",
      "/api/%2e%2e/outside",
      "/api/%",
      "/not-api",
    ]) {
      const client = new ApiClient(safeTransport, base);
      await expect(client.session()).rejects.toBeInstanceOf(TypeError);
    }

    const client = new ApiClient(safeTransport);
    const call = (
      client as unknown as {
        call(path: string): Promise<unknown>;
      }
    ).call.bind(client);
    for (const path of [
      "//attacker.test/resource",
      "/../outside",
      "/%2e%2e/outside",
      "/resource/../../outside",
      "auth/session",
      "/malformed%",
    ]) {
      await expect(call(path)).rejects.toBeInstanceOf(TypeError);
    }
    expect(transportCalls).toBe(1);
  });

  test("default browser transport only fetches normalized same-origin API paths", async () => {
    const fetched: string[] = [];
    const browserTransport = createBrowserApiTransport(
      ORIGIN,
      async (input) => {
        fetched.push(input);
        return Response.json({ ok: true });
      },
    );

    await expect(
      browserTransport(`${ORIGIN}/api/auth/session?fresh=1`),
    ).resolves.toBeInstanceOf(Response);
    expect(fetched).toEqual(["/api/auth/session?fresh=1"]);

    for (const input of [
      "https://attacker.test/api/auth/session",
      "//attacker.test/api/auth/session",
      "/api/../outside",
      "/api/%2e%2e/outside",
      "/api/resource/../../outside",
      "/api/malformed%",
      "/not-api/auth/session",
    ]) {
      await expect(browserTransport(input)).rejects.toBeInstanceOf(TypeError);
    }
    expect(fetched).toEqual(["/api/auth/session?fresh=1"]);
  });

  test("login uses Next router replacement with static role destinations", async () => {
    const panel = await readFile(
      join(import.meta.dir, "../../apps/web/src/live-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain('import { useRouter } from "next/navigation"');
    expect(panel).toContain('router.replace("/businesses")');
    expect(panel).toContain('router.replace("/profile")');
    expect(panel).not.toContain("location.href");
  });

  test("uses cookie/CSRF and live admin, profile, assistant and WhatsApp contracts", async () => {
    const admin = new ApiClient(transport, "/api");
    expect(
      (await admin.login("admin@web.test", "correct horse battery staple"))
        .role,
    ).toBe("platform_admin");
    const business = await admin.createBusiness({
      name: "Web tenant",
      userEmail: "tenant@web.test",
      initialPassword: "tenant initial password safe",
    });
    await admin.createBusiness({
      name: "Other tenant",
      userEmail: "other@web.test",
      initialPassword: "other tenant password safe",
    });
    const createRequest = requests.find(
      ({ path }) => path === "/admin/businesses",
    );
    expect(
      new Headers(createRequest?.init?.headers).get("x-csrf-token"),
    ).toHaveLength(64);
    expect(createRequest?.init?.credentials).toBe("include");
    expect((await admin.businesses())[0]?.name).toBe("Web tenant");
    const activityAt = "2026-08-28T10:00:00.000Z";
    await database.sql`insert into technical_events(business_id,component,code,severity,occurred_at) values(${business.id},'whatsapp-manager','whatsapp.delivery_unknown','error',${activityAt})`;
    expect(
      (await admin.businesses()).find((row) => row.id === business.id)
        ?.lastTechnicalActivityAt,
    ).toBe(activityAt);
    expect(formatActivityTimestamp(activityAt)).toBe(
      "28 de ago de 2026, 10:00",
    );
    const adminScreen = await readFile(
      join(
        import.meta.dir,
        "../../apps/web/src/ui/admin-businesses-screen.tsx",
      ),
      "utf8",
    );
    expect(adminScreen).toContain("Última actividad técnica");
    expect(adminScreen).toContain("formatActivityTimestamp(");
    expect(adminScreen).toContain("business.lastTechnicalActivityAt");
    await admin.renameBusiness(business.id, "Web tenant renamed");
    await admin.replacePassword(business.id, "replacement tenant password");
    await admin.setBusinessStatus(business.id, "suspended");
    await expect(admin.businesses()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: business.id, status: "suspended" }),
      ]),
    );
    await admin.logout();
    await expect(
      admin.login("tenant@web.test", "replacement tenant password"),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(
      await admin.errorMessage(new ApiError("UNAUTHENTICATED", "", 401)),
    ).toContain("suspendido");
    await admin.login("admin@web.test", "correct horse battery staple");
    await admin.setBusinessStatus(business.id, "active");
    await admin.logout();

    const tenant = new ApiClient(transport, "/api");
    expect(
      (await tenant.login("tenant@web.test", "replacement tenant password"))
        .role,
    ).toBe("business_user");
    const profile = {
      displayName: "Tenant",
      description: "",
      address: "",
      contact: "",
      businessHours: "24h",
      offerings: "",
      faq: "",
      policies: "",
      additionalInfo: "",
    };
    await tenant.saveProfile(profile);
    expect((await tenant.profile()).displayName).toBe("Tenant");
    await expect(
      tenant.saveProfile({ ...profile, displayName: "" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await tenant.profile()).displayName).toBe("Tenant");
    const assistant = await tenant.saveAssistant({
      personality: "helpful",
      tone: "warm",
      instructions: "",
      knowledge: "",
      rules: "",
      restrictions: "",
      active: true,
      expectedRevision: 0,
    });
    expect(assistant).toMatchObject({ active: true, revision: 1 });
    await expect(
      tenant.saveAssistant({ ...assistant, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await tenant.whatsappStatus()).status).toBe("link_required");
    await tenant.requestWhatsAppLink();
    let releaseOpen = () => {},
      qrReady = () => {},
      emitEvent!: Parameters<WhatsAppGateway["connect"]>[1];
    const open = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      }),
      qr = new Promise<void>((resolve) => {
        qrReady = resolve;
      });
    const gateway: WhatsAppGateway = {
      connect: async (_id, emit) => {
        emitEvent = emit;
        await emit({ type: "qr", value: "tenant-owned-qr" });
        qrReady();
        await open;
        await emit({ type: "open", linkedNumber: "549111" });
      },
    };
    const manager = createWhatsAppManager({
      pools,
      ownerId: "web-contract",
      gateway,
      linkCodeKey: LINK_KEY,
    });
    const processing = manager.processNext();
    try {
      await qr;
      await expect(tenant.whatsappQr()).resolves.toEqual({
        qr: "tenant-owned-qr",
      });
      expect(requests.at(-1)?.init).toMatchObject({
        cache: "no-store",
        credentials: "include",
      });
      expect(responseCacheControl).toBe("no-store");
      await tenant.logout();
      await admin.login("admin@web.test", "correct horse battery staple");
      await expect(admin.whatsappQr()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await admin.logout();
      const other = new ApiClient(transport, "/api");
      await other.login("other@web.test", "other tenant password safe");
      await expect(other.whatsappQr()).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await other.logout();
      await tenant.login("tenant@web.test", "replacement tenant password");
      await database.sql`update whatsapp_link_codes set expires_at=now()-interval '1 second' where business_id=${business.id}`;
      await expect(tenant.whatsappQr()).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await emitEvent({ type: "qr", value: "replacement-qr" });
      await expect(tenant.whatsappQr()).resolves.toEqual({
        qr: "replacement-qr",
      });
      releaseOpen();
      await processing;
      await expect(tenant.whatsappQr()).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      releaseOpen();
      await processing.catch(() => undefined);
      await manager.stop();
    }
    expect(
      requests.some(({ init }) => String(init?.body).includes("business_id")),
    ).toBe(false);
    expect(
      requests.some(({ path }) => /conversations|messages/.test(path)),
    ).toBe(false);
  }, 120_000);

  test("waits through delayed QR availability with no-store requests", async () => {
    let calls = 0;
    const delays: number[] = [];
    const requestOptions: Array<RequestInit | undefined> = [];
    const client = new ApiClient(async (_input, init) => {
      requestOptions.push(init);
      calls += 1;
      if (calls < 4)
        return Response.json({ code: "NOT_FOUND" }, { status: 404 });
      return Response.json({ qr: "delayed-qr" });
    });

    await expect(
      client.waitForWhatsAppQr({
        attempts: 4,
        intervalMs: 125,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).resolves.toEqual({ qr: "delayed-qr" });
    expect(calls).toBe(4);
    expect(delays).toEqual([125, 125, 125]);
    expect(requestOptions.every((init) => init?.cache === "no-store")).toBe(
      true,
    );
  });

  test("resumes an active WhatsApp link after POST conflict", async () => {
    const methods: string[] = [];
    const client = new ApiClient(async (_input, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST")
        return Response.json({ code: "CONFLICT" }, { status: 409 });
      return Response.json({ qr: "existing-current-qr" });
    });

    await expect(
      client.requestOrResumeWhatsAppLink({ attempts: 1, intervalMs: 0 }),
    ).resolves.toEqual({ qr: "existing-current-qr" });
    expect(methods).toEqual(["POST", "GET"]);
  });

  test("request-or-resume fails closed for every non-conflict request error", async () => {
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["UNAUTHENTICATED", 401],
      ["INTERNAL_ERROR", 500],
    ] as const) {
      let calls = 0;
      const client = new ApiClient(async () => {
        calls += 1;
        return Response.json({ code }, { status });
      });

      await expect(
        client.requestOrResumeWhatsAppLink({ attempts: 1, intervalMs: 0 }),
      ).rejects.toMatchObject({ code, status });
      expect(calls).toBe(1);
    }

    const transportFailure = new Error("transport unavailable");
    const client = new ApiClient(async () => {
      throw transportFailure;
    });
    await expect(client.requestOrResumeWhatsAppLink()).rejects.toBe(
      transportFailure,
    );

    const spoofedConflict = Object.assign(new Error("not an API error"), {
      code: "CONFLICT",
    });
    const spoofedClient = new ApiClient(async () => {
      throw spoofedConflict;
    });
    await expect(spoofedClient.requestOrResumeWhatsAppLink()).rejects.toBe(
      spoofedConflict,
    );
  });

  test("keeps the current QR through rotation gaps, replaces it only on change, and clears it on connection", async () => {
    let displayedQr: string | null = "png:initial",
      now = 0,
      statusCalls = 0,
      qrCalls = 0,
      inFlight = 0,
      maxInFlight = 0;
    const snapshots: Array<string | null> = [];
    const renderedPayloads: string[] = [];
    const statuses = [
      "link_required",
      "link_required",
      "link_required",
      "link_required",
      "connected",
    ] as const;
    const qrResults = [
      "initial",
      new ApiError("NOT_FOUND", "rotating", 404),
      "rotated",
      "rotated",
    ];
    const enter = async <T>(value: T) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value;
    };

    await runWhatsAppLinkMonitor({
      initialQr: "initial",
      signal: new AbortController().signal,
      pollIntervalMs: 100,
      lifecycleMs: 1_000,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      getStatus: async () =>
        enter({ status: statuses[statusCalls++] ?? "connected" }),
      getQr: async () => {
        const result = await enter(qrResults[qrCalls++]);
        if (result instanceof Error) throw result;
        return { qr: result ?? "rotated" };
      },
      renderQr: async (qr) => {
        renderedPayloads.push(qr);
        return enter(`png:${qr}`);
      },
      onEvent: (event) => {
        if (event.type === "qr") displayedQr = event.dataUrl;
        if (event.type === "connected") displayedQr = null;
        snapshots.push(displayedQr);
      },
    });

    expect(snapshots).toEqual([
      "png:initial",
      "png:initial",
      "png:initial",
      "png:rotated",
      "png:rotated",
      "png:rotated",
      null,
    ]);
    expect(qrCalls).toBe(4);
    expect(renderedPayloads).toEqual(["rotated"]);
    expect(maxInFlight).toBe(1);
  });

  test("expires a still-unconnected QR at the lifecycle bound", async () => {
    let displayedQr: string | null = "png:initial",
      now = 0,
      expired = false;

    await runWhatsAppLinkMonitor({
      initialQr: "initial",
      signal: new AbortController().signal,
      pollIntervalMs: 100,
      lifecycleMs: 250,
      now: () => now,
      sleep: async (milliseconds) => {
        expect(displayedQr).toBe("png:initial");
        now += milliseconds;
      },
      getStatus: async () => ({ status: "link_required" }),
      getQr: async () => {
        throw new ApiError("NOT_FOUND", "rotating", 404);
      },
      renderQr: async () => {
        throw new Error("NOT_FOUND must not trigger rendering");
      },
      onEvent: (event) => {
        if (event.type === "expired") {
          displayedQr = null;
          expired = true;
        }
      },
    });

    expect(now).toBe(250);
    expect(expired).toBe(true);
    expect(displayedQr).toBeNull();
  });

  test("fails closed on non-NOT_FOUND monitor errors and honors cancellation", async () => {
    const events: string[] = [];
    for (const failure of [
      new ApiError("FORBIDDEN", "wrong role", 403),
      new ApiError("UNAUTHENTICATED", "expired session", 401),
      new Error("transport unavailable"),
    ]) {
      const eventStart = events.length;
      await expect(
        runWhatsAppLinkMonitor({
          initialQr: "initial",
          signal: new AbortController().signal,
          getStatus: async () => ({ status: "link_required" }),
          getQr: async () => {
            throw failure;
          },
          renderQr: async () => "must-not-render",
          onEvent: (event) => events.push(event.type),
        }),
      ).rejects.toBe(failure);
      expect(events.slice(eventStart)).toEqual(["status", "failed"]);
    }

    const controller = new AbortController();
    let statusCalls = 0;
    await runWhatsAppLinkMonitor({
      initialQr: "initial",
      signal: controller.signal,
      getStatus: async () => {
        statusCalls += 1;
        controller.abort();
        return { status: "link_required" };
      },
      getQr: async () => {
        throw new Error("cancelled monitor must not fetch another QR");
      },
      renderQr: async () => "must-not-render",
      onEvent: (event) => events.push(event.type),
    });
    expect(statusCalls).toBe(1);
    expect(events.at(-1)).toBe("cancelled");
  });

  test("renders a bounded scannable QR locally as a PNG data URI", async () => {
    const dataUrl = await renderWhatsAppQrDataUrl("local-test-pairing-payload");
    expect(dataUrl).toStartWith("data:image/png;base64,");

    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(384);
    expect(png.readUInt32BE(20)).toBe(384);
  });

  test("fails closed after the injected QR wait bound", async () => {
    let calls = 0;
    const client = new ApiClient(async () => {
      calls += 1;
      return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    });

    await expect(
      client.waitForWhatsAppQr({ attempts: 3, intervalMs: 0 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(calls).toBe(3);
  });

  test("surfaces safe validation, wrong-role and expired-session states", async () => {
    const client = new ApiClient(transport, "/api");
    await client.login("admin@web.test", "correct horse battery staple");
    await expect(client.saveProfile({} as never)).rejects.toEqual(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    await expect(client.whatsappQr()).rejects.toEqual(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    await client.logout();
    await expect(client.session()).rejects.toEqual(
      expect.objectContaining({ code: "UNAUTHENTICATED" }),
    );
    expect(
      await client.errorMessage(
        new ApiError("VALIDATION_FAILED", "Invalid profile fields", 400),
      ),
    ).toContain("Revisá");
  }, 120_000);
});
