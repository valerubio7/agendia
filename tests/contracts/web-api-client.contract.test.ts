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
  type BusinessClosure,
  type BusinessClosureRequest,
} from "../../apps/web/src/api/api-client.ts";
import {
  formatActivityTimestamp,
  runWhatsAppLinkMonitor,
} from "../../apps/web/src/shell/live-panel.tsx";
import { renderWhatsAppQrDataUrl } from "../../apps/web/src/features/whatsapp/qr-code.ts";
import { formatArgentinaClosureDate, formatArgentinaClosureInstant } from "../../apps/web/src/features/business-calendar/argentina-closure-time.ts";
import { createRuntimePools } from "@agendia/db";
import {
  createWhatsAppManager,
  type WhatsAppGateway,
} from "../../apps/whatsapp-manager/src/index.ts";
import {
  applyPostgresMigrations,
  startTestPostgres,
  type TestPostgres,
} from "../support/index.ts";

test("independent cookie-only tabs recover CSRF during session lifecycle without replaying failed writes", async () => {
  const clients: ApiClient[] = [];
  let bootstraps = 0, writes = 0;
  const transport: ApiTransport = async (path, init) => {
    if (path === "/api/auth/session") return Response.json({ identityId: "i", role: "platform_admin", businessId: null });
    if (path === "/api/auth/csrf") {
      bootstraps++;
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("include");
      expect(init?.cache).toBe("no-store");
      expect(new Headers(init?.headers).get("x-csrf-bootstrap")).toBe("1");
      return Response.json({ csrfToken: "stable-recovered-token" });
    }
    writes++;
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("stable-recovered-token");
    return Response.json({ code: "FORBIDDEN" }, { status: 403 });
  };
  for (let tab = 0; tab < 2; tab++) clients.push(new ApiClient(transport));
  await Promise.all(clients.map(client => client.session()));
  expect(bootstraps).toBe(2);
  await expect(clients[0]!.logout()).rejects.toMatchObject({ status: 403 });
  expect(writes).toBe(1);
  expect(bootstraps).toBe(2);
  const unauthenticated = new ApiClient(async path => {
    expect(path).toBe("/api/auth/session");
    return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  });
  await expect(unauthenticated.session()).rejects.toMatchObject({ status: 401 });
});

test("operation dispatch is one-write scoped and receipt/fence wrappers retain transport protections", async () => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const signal = new AbortController().signal;
  const client = new ApiClient(async (path, init) => {
    calls.push({ path, ...(init ? { init } : {}) });
    return Response.json(path === "/api/auth/login" ? { csrfToken: "receipt-csrf" } : { id: "saved" });
  });
  await client.login("receipt@example.test", "receipt test password");
  calls.length = 0;
  const key = "12345678-1234-4234-8234-123456789abc";
  const captured: object[] = [];
  await client.withAppointmentOperation(key, operation => captured.push(operation), () =>
    client.appointmentNotes("record/slash", { notes: "One" }, signal));
  await client.appointmentNotes("record/slash", { notes: "Legacy" }, signal);
  await client.appointmentOperation("key/slash", signal);
  await client.cancelAppointmentOperation({ key, kind: "notes", target: "record", actor: "untrusted" } as { key: string; kind: "notes"; target: string }, signal);
  expect(captured).toEqual([{ key, kind: "notes", target: "record/slash" }]);
  expect(new Headers(calls[0]!.init?.headers).get("x-appointment-operation-key")).toBe(key);
  expect(new Headers(calls[1]!.init?.headers).has("x-appointment-operation-key")).toBe(false);
  expect(calls[2]!.path).toBe("/api/me/appointment-operations/key%2Fslash");
  expect(calls[2]!.init?.cache).toBe("no-store");
  expect(calls[2]!.init?.method).toBe("GET");
  expect(calls[3]!.path).toBe(`/api/me/appointment-operations/${key}/cancel`);
  expect(calls[3]!.init?.method).toBe("POST");
  expect(new Headers(calls[3]!.init?.headers).get("x-csrf-token")).toBe("receipt-csrf");
  expect(JSON.parse(String(calls[3]!.init?.body))).toEqual({ key, kind: "notes", target: "record" });
  for (const call of calls) { expect(call.init?.signal).toBe(signal); expect(call.init?.credentials).toBe("include"); }
  expect(() => client.withAppointmentOperation(key, () => { throw new Error("capture rejected"); }, () => client.appointmentNotes("a", { notes: null }))).toThrow("capture rejected");
  await client.appointmentOperation(key);
  expect(new Headers(calls.at(-1)!.init?.headers).has("x-appointment-operation-key")).toBe(false);
  await expect(client.appointmentOperation("..")).rejects.toThrow(TypeError);
  await expect(client.cancelAppointmentOperation({ key: "..", kind: "create", target: null })).rejects.toThrow(TypeError);
});

test("Turnos wrappers allowlist wire bodies, encode queries and forward cancellation", async () => {
  const signal = new AbortController().signal;
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const client = new ApiClient(async (path, init) => {
    calls.push({ path, init });
    return Response.json({ id: "saved" });
  });
  const terms = { serviceId: "s", resourceId: "r", serviceName: "Servicio", resourceName: "Recurso", durationMinutes: 30, priceArs: 0 };
  const structure = { serviceId: "s", resourceId: "r", date: "2026-01-01", startRaw: "2026-01-01T10:00:00-03:00", expectedTerms: terms, confirmed: true as const };
  await client.appointments({ from: "2026-01-01T00:00:00+03:00", to: "2026-02-01T00:00:00Z" }, signal);
  await client.appointment("id/slash", signal);
  await client.appointmentAvailability({ serviceId: "s &?", resourceId: "r", date: "2026-01-01", appointmentId: "a" }, signal);
  await client.createAppointment({ ...structure, clientId: "c", businessId: "foreign" } as typeof structure & { clientId: string }, signal);
  await client.createAppointment({ ...structure, newClient: { firstName: "Ana", lastName: "Pérez", phone: "11 23456789", role: "admin" } } as typeof structure & { newClient: { firstName: string; lastName: string; phone: string } }, signal);
  await client.changeAppointment("id/slash", { ...structure, notes: "not structural" } as typeof structure, signal);
  await client.appointmentNotes("a", { notes: null, state: "done" } as { notes: null }, signal);
  await client.appointmentState("a", { state: "cancelled", confirmed: true, actor: "admin" } as { state: "cancelled"; confirmed: true }, signal);
  expect(calls[0]?.path).toBe("/api/me/appointments?from=2026-01-01T00%3A00%3A00%2B03%3A00&to=2026-02-01T00%3A00%3A00Z");
  expect(calls[1]?.path).toBe("/api/me/appointments/id%2Fslash");
  expect(calls[2]?.path).toBe("/api/me/appointments/availability?serviceId=s+%26%3F&date=2026-01-01&resourceId=r&appointmentId=a");
  expect(calls[5]?.path).toBe("/api/me/appointments/id%2Fslash");
  expect(calls.map(call => call.init?.method)).toEqual(["GET", "GET", "GET", "POST", "POST", "PATCH", "PATCH", "PATCH"]);
  expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ ...structure, clientId: "c" });
  expect(JSON.parse(String(calls[4]?.init?.body))).toEqual({ ...structure, newClient: { firstName: "Ana", lastName: "Pérez", phone: "11 23456789" } });
  expect(JSON.parse(String(calls[5]?.init?.body))).toEqual(structure);
  expect(JSON.parse(String(calls[6]?.init?.body))).toEqual({ notes: null });
  expect(JSON.parse(String(calls[7]?.init?.body))).toEqual({ state: "cancelled", confirmed: true });
  for (const call of calls) {
    expect(call.init?.signal).toBe(signal);
    expect(call.init?.credentials).toBe("include");
  }
  for (const id of [".", ".."]) {
    await expect(client.appointment(id)).rejects.toThrow(TypeError);
    await expect(client.changeAppointment(id, structure)).rejects.toThrow(TypeError);
  }
});

test("business calendar GET preserves nullable raw schedules and forwards cancellation", async () => {
  const signal = new AbortController().signal;
  for (const weeklySchedule of [null, {}, { 1: [{ startMinute: 547, endMinute: 123 }] }]) {
    const client = new ApiClient(async (path, init) => {
      expect(path).toBe("/api/me/business-calendar");
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBe(signal);
      expect(init?.body).toBeUndefined();
      return Response.json({ weeklySchedule });
    });
    expect(await client.businessCalendar(signal)).toEqual({ weeklySchedule });
  }
});

test("business closures GET preserves ordered raw union DTOs and cancellation", async () => {
  const signal = new AbortController().signal;
  const closures: BusinessClosure[] = [
    { id: "b", kind: "date", date: "2035-02-02" },
    { id: "c", kind: "date", date: "2035-01-01" },
    { id: "d", kind: "interval", start: "2035-01-02T02:04:05.006+02:00", end: "2035-01-02T03:04:05.006+02:00" },
    { id: "e", kind: "interval", start: "2035-01-02T02:04:05.006+02:00", end: "2035-01-02T03:04:05.006+02:00" },
  ];
  const client = new ApiClient(async (path, init) => {
    expect(path).toBe("/api/me/business-calendar/closures");
    expect(init?.method).toBe("GET");
    expect(init?.signal).toBe(signal);
    expect(init?.body).toBeUndefined();
    return Response.json(closures);
  });
  expect(await client.businessClosures(signal)).toEqual(closures);
});

test("business closure POST returns confirmed raw DTOs and forwards cancellation", async () => {
  const signal = new AbortController().signal;
  const inputs: BusinessClosureRequest[] = [{ kind: "date", date: "2035-02-02" },
    { kind: "interval", start: "2035-01-02T03:04:05.006Z", end: "2035-01-02T04:04:05.007Z" }];
  for (const body of inputs) {
    const saved = { id: "confirmed", ...body };
    const client = new ApiClient(async (path, init) => {
      expect(path).toBe("/api/me/business-calendar/closures");
      expect(init?.method).toBe("POST");
      expect(init?.signal).toBe(signal);
      expect(JSON.parse(init!.body as string)).toEqual(body);
      return Response.json(saved, { status: 201 });
    });
    expect(await client.createBusinessClosure(body, signal)).toEqual(saved);
  }
});

test("closure PUT and DELETE encode identity, preserve raw bodies and use shared CSRF and cancellation", async () => {
  const signal = new AbortController().signal;
  const input: BusinessClosureRequest = { kind: "interval",
    start: "2008-01-07T13:00:05.123+02:00", end: "2008-01-07T14:00:06.789+02:00" };
  const saved = { id: "row/id", ...input };
  const calls: string[] = [];
  const client = new ApiClient(async (path, init) => {
    if (path === "/api/auth/login") return Response.json({ csrfToken: "closure-csrf" });
    if (path === "/api/auth/session") return Response.json({ role: "business_user", businessId: "tenant" });
    expect(path).toBe("/api/me/business-calendar/closures/row%2Fid");
    expect(init?.signal).toBe(signal);
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("closure-csrf");
    calls.push(init!.method!);
    if (init?.method === "PUT") {
      expect(JSON.parse(init.body as string)).toEqual(input);
      return Response.json(saved);
    }
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    return new Response(null, { status: 204 });
  });
  await client.login("closures@example.test", "safe test password");
  expect(await client.updateBusinessClosure(saved.id, input, signal)).toEqual(saved);
  expect(await client.deleteBusinessClosure(saved.id, signal)).toBeUndefined();
  expect(calls).toEqual(["PUT", "DELETE"]);
});

test("Argentina closure display retains local days, precision and per-instant offsets", () => {
  expect(formatArgentinaClosureDate("2035-01-01")).toBe("01/01/2035");
  expect(formatArgentinaClosureInstant("2035-01-02T02:04:05.006+02:00"))
    .toBe("01/01/2035, 21:04:05.006 (Argentina, GMT-03:00)");
  expect(formatArgentinaClosureInstant("2009-01-02T00:00:00.007Z"))
    .toBe("01/01/2009, 22:00:00.007 (Argentina, GMT-02:00)");
});

test("standalone client POST allowlists raw input and returns the canonical DTO with transport protections", async () => {
  const signal = new AbortController().signal;
  const calls: { path: string; init?: RequestInit }[] = [];
  const saved = { id: "owned-client", firstName: "Alicia", lastName: "Gómez", phone: "+5491123456789" };
  const client = new ApiClient(async (path, init) => {
    if (path === "/api/auth/login") return Response.json({ csrfToken: "create-client-csrf" });
    if (path === "/api/auth/session") return Response.json({ role: "business_user", businessId: "tenant" });
    calls.push({ path, ...(init === undefined ? {} : { init }) });
    return Response.json(saved, { status: 201 });
  });
  await client.login("create-client@example.test", "safe test password");
  const input = { firstName: " Alicia ", lastName: " Gómez ", phone: "11 2345-6789",
    businessId: "foreign", id: "untrusted", role: "admin" };
  expect(await client.createClient(input, signal)).toEqual(saved);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.path).toBe("/api/me/clients");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(calls[0]?.init?.signal).toBe(signal);
  expect(calls[0]?.init?.credentials).toBe("include");
  const headers = new Headers(calls[0]?.init?.headers);
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("x-csrf-token")).toBe("create-client-csrf");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
    firstName: " Alicia ", lastName: " Gómez ", phone: "11 2345-6789",
  });
});

test("client query encoding preserves literal search and history identity without admitting unsafe paths", async () => {
  const signal = new AbortController().signal;
  const paths: string[] = [];
  const transport = createBrowserApiTransport("https://panel.agendia.test", async (path, init) => {
    paths.push(path);
    expect(init?.signal).toBe(signal);
    expect(init?.method).toBe("GET");
    return Response.json([]);
  });
  const client = new ApiClient(transport);
  for (const q of ["  Ana  María  ", "%_\\\\", "../?q=#&+", "https://evil.test/path"]) {
    await client.clients(q, signal);
    const destination = new URL(paths.at(-1)!, "https://panel.agendia.test");
    expect(destination.pathname).toBe("/api/me/clients");
    expect(destination.searchParams.get("q")).toBe(q.trim());
    expect([...destination.searchParams.keys()]).toEqual(["q"]);
  }
  await client.clients("  ", signal);
  expect(paths.at(-1)).toBe("/api/me/clients");
  await client.clientAppointments("row/id?x=#", signal);
  expect(paths.at(-1)).toBe("/api/me/appointments?clientId=row%2Fid%3Fx%3D%23");
  const calls: RequestInit[] = [];
  const saved = { id: "stable-id", firstName: "Ana", lastName: "María", phone: "+5491123456789" };
  const writer = new ApiClient(async (path, init) => {
    if (path === "/api/auth/login") return Response.json({ csrfToken: "client-csrf" });
    if (path === "/api/auth/session") return Response.json({ role: "business_user", businessId: "tenant" });
    expect(path).toBe("/api/me/clients/stable-id");
    calls.push(init!);
    return Response.json(saved);
  });
  await writer.login("clients@example.test", "safe test password");
  expect(await writer.updateClient(saved.id, { ...saved }, signal)).toEqual(saved);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe("PUT");
  expect(calls[0]?.signal).toBe(signal);
  expect(new Headers(calls[0]?.headers).get("x-csrf-token")).toBe("client-csrf");
  expect(JSON.parse(calls[0]!.body as string)).toEqual({ firstName: saved.firstName, lastName: saved.lastName, phone: saved.phone });
  for (const id of ["..", "."]) {
    await expect(writer.updateClient(id, saved, signal)).rejects.toBeInstanceOf(TypeError);
  }
});

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

  test("profile payload only forwards retained fields even from a legacy caller", async () => {
    const profile = {
      displayName: "Tenant", description: "Description", address: "Address",
    };
    const client = new ApiClient(async (input, init) => {
      if (input.endsWith("/auth/login") || input.endsWith("/auth/session"))
        return Response.json({ role: "business_user", businessId: "tenant", csrfToken: "csrf" });
      expect(input).toBe("/api/me/business-profile");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual(profile);
      return Response.json(profile);
    });
    await client.login("tenant@example.test", "safe password");
    const legacyProfile = {
      ...profile, businessHours: "old hours", offerings: "old offerings", contact: "old contact", faq: "old faq",
      policies: "old policies", additionalInfo: "old info", business_id: "hostile",
    };
    await expect(client.saveProfile(legacyProfile)).resolves.toEqual(profile);
  });

  test("validates API base and path composition before injected transport", async () => {
    let transportCalls = 0;
    const safeTransport: ApiTransport = async (input) => {
      transportCalls += 1;
      if (input === "/api/auth/csrf") return Response.json({ csrfToken: "bootstrap-csrf" });
      expect(input).toBe("/api/auth/session");
      return Response.json({ role: "platform_admin", businessId: null, identityId: "admin-identity" });
    };

    await expect(new ApiClient(safeTransport).session()).resolves.toEqual({
      role: "platform_admin",
      businessId: null,
      identityId: "admin-identity",
    });
    expect(transportCalls).toBe(2);

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
    expect(transportCalls).toBe(2);
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
      join(import.meta.dir, "../../apps/web/src/shell/live-panel.tsx"),
      "utf8",
    );
    expect(panel).toContain('import { useRouter } from "next/navigation"');
    expect(panel).toContain('router.replace("/businesses")');
    expect(panel).toContain('router.replace("/profile")');
    expect(panel).not.toContain("location.href");
  });

  test("uses cookie/CSRF and live admin, profile, agent and WhatsApp contracts", async () => {
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
        "../../apps/web/src/features/administration/admin-businesses-screen.tsx",
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
    const [identity] = await database.sql`select id from auth_identities where normalized_email = ${"tenant@web.test"}`;
    expect(identity).toBeDefined();
    if (!identity) throw new Error("Expected the authenticated tenant identity row");
    expect(await tenant.session()).toEqual({ role: "business_user", businessId: business.id, identityId: identity.id });
    const repeatedSession = await tenant.login("tenant@web.test", "replacement tenant password");
    expect(repeatedSession.identityId).toBe(identity.id);
    const profile = {
      displayName: "Tenant",
      description: "",
      address: "",
    };
    await tenant.saveProfile(profile);
    expect((await tenant.profile()).displayName).toBe("Tenant");
    await expect(
      tenant.saveProfile({ ...profile, displayName: "" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await tenant.profile()).displayName).toBe("Tenant");
    const agent = await tenant.saveAgent({
      style: " helpful\n warm ",
      businessInstructions: " business guidance\n ",
      active: true,
      expectedRevision: 0,
    });
    expect(agent).toEqual({ style: " helpful\n warm ", businessInstructions: " business guidance\n ", active: true, revision: 1 });
    expect(await tenant.agent()).toEqual(agent);
    await expect(
      tenant.saveAgent({ ...agent, expectedRevision: 0 }),
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
        return Response.json({ code: "CONFLICT", message: "WhatsApp connection already linked" }, { status: 409 });
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
