import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools } from "@agendia/db";
import {
  applyPostgresMigrations,
  startTestPostgres,
  type TestPostgres,
} from "@agendia/test-support";

const ORIGIN = "https://panel.agendia.test";
let database: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
let app: ReturnType<typeof buildApi>;
const request = (
  method: "GET" | "POST" | "PUT",
  url: string,
  options: {
    cookie?: string;
    csrf?: string;
    origin?: string;
    body?: object;
  } = {},
) =>
  app.inject({
    method,
    url,
    ...(options.body ? { payload: options.body } : {}),
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.csrf ? { "x-csrf-token": options.csrf } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
  });
const login = async (email: string, password: string) => {
  const response = await request("POST", "/auth/login", {
    origin: ORIGIN,
    body: { email, password },
  });
  const setCookie = response.headers["set-cookie"]!;
  return {
    response,
    cookie: (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(
      ";",
    )[0]!,
    csrf: response.json().csrfToken as string,
  };
};
const adminLogin = () =>
  login("admin@example.test", "correct horse battery staple");
const createBusiness = async (email: string) => {
  const admin = await adminLogin();
  const response = await request("POST", "/admin/businesses", {
    ...admin,
    origin: ORIGIN,
    body: {
      name: `Business ${email}`,
      userEmail: email,
      initialPassword: "tenant initial password safe",
    },
  });
  expect(response.statusCode).toBe(201);
  return { business: response.json() as { id: string }, admin };
};

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(
    database.sql,
    join(import.meta.dir, "../../packages/db/migrations"),
  );
  await database.sql`insert into auth_identities (normalized_email,password_phc,role) values (${"admin@example.test"},${await hash("correct horse battery staple", { algorithm: Algorithm.Argon2id })},'platform_admin')`;
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: ORIGIN, absoluteTtlMs: 60_000 });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pools?.end();
  await database?.stop();
});

describe("PostgreSQL-backed Fastify auth, admin and me API", () => {
  test("sets a secure opaque cookie and enforces expiration, logout, CSRF and Origin", async () => {
    expect(
      (
        await request("POST", "/auth/login", {
          body: {
            email: "admin@example.test",
            password: "correct horse battery staple",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request("POST", "/auth/login", {
          origin: "https://evil.test",
          body: {
            email: "admin@example.test",
            password: "correct horse battery staple",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request("POST", "/auth/login", {
          origin: ORIGIN,
          body: {
            email: "admin@example.test",
            password: "wrong password safe",
          },
        })
      ).statusCode,
    ).toBe(401);
    const auth = await adminLogin();
    expect(
      (
        await database.sql<
          { event_type: string }[]
        >`select event_type from audit_events where business_id is null order by occurred_at`
      ).map((row) => row.event_type),
    ).toEqual(["auth.login_failed", "auth.login"]);
    expect(auth.response.headers["set-cookie"]).toContain(
      "__Host-agendia_session=",
    );
    expect(auth.response.headers["set-cookie"]).toContain("Secure");
    expect(auth.response.headers["set-cookie"]).toContain("HttpOnly");
    expect((await request("GET", "/auth/session", auth)).json()).toMatchObject({
      role: "platform_admin",
      businessId: null,
    });
    expect(
      (
        await request("POST", "/auth/logout", {
          cookie: auth.cookie,
          origin: ORIGIN,
          csrf: "wrong",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await request("POST", "/auth/logout", { ...auth, origin: ORIGIN }))
        .statusCode,
    ).toBe(204);
    expect((await request("GET", "/auth/session", auth)).statusCode).toBe(401);
    const audit = await database.sql<
      { event_type: string; source: string; metadata: object }[]
    >`select event_type,source,metadata from audit_events where business_id is null order by occurred_at`;
    expect(audit.at(-1)).toEqual({
      event_type: "auth.logout",
      source: "api",
      metadata: {},
    });
    for (const sensitive of [
      "wrong password safe",
      "correct horse battery staple",
      auth.cookie,
      auth.csrf,
    ])
      expect(JSON.stringify(audit)).not.toContain(sensitive);
    const expired = await adminLogin();
    await database.sql`update web_sessions set absolute_expires_at=now()-interval '1 second'`;
    expect((await request("GET", "/auth/session", expired)).statusCode).toBe(
      401,
    );
  });

  test("supports admin CRUD, user password replacement, status and safe role/ID rejection", async () => {
    const { business, admin } = await createBusiness("admin-flow@example.test");
    expect(
      (await request("GET", "/admin/businesses", admin)).json() as unknown,
    ).toEqual([expect.objectContaining({ id: business.id, status: "active" })]);
    expect(
      (
        await request("PUT", `/admin/businesses/${business.id}`, {
          ...admin,
          origin: ORIGIN,
          body: { name: "Renamed" },
        })
      ).json().name,
    ).toBe("Renamed");
    expect(
      (
        await request("POST", "/auth/login", {
          origin: ORIGIN,
          body: {
            email: "admin-flow@example.test",
            password: "wrong tenant password",
          },
        })
      ).statusCode,
    ).toBe(401);
    const tenant = await login(
      "admin-flow@example.test",
      "tenant initial password safe",
    );
    expect(
      (
        await request("POST", "/admin/businesses", {
          ...tenant,
          origin: ORIGIN,
          body: { name: "Denied" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await database.sql<
          { event_type: string; outcome: string }[]
        >`select event_type,outcome from audit_events where business_id=${business.id} and event_type like 'auth.%' order by stream_sequence`
      ).map((row) => ({ ...row })),
    ).toEqual([
      { event_type: "auth.login_failed", outcome: "denied" },
      { event_type: "auth.login", outcome: "success" },
    ]);
    expect(
      (
        await request(
          "PUT",
          "/admin/businesses/99999999-9999-4999-8999-999999999999/status",
          { ...admin, origin: ORIGIN, body: { status: "suspended" } },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request("PUT", `/admin/businesses/${business.id}/user`, {
          ...admin,
          origin: ORIGIN,
          body: { password: "replacement password secure" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await request("GET", "/auth/session", tenant)).statusCode).toBe(
      401,
    );
    expect(
      await database.sql`select id from audit_events where business_id=${business.id} and event_type='business_user.password_replaced'`,
    ).toHaveLength(1);
    expect(
      (
        await request("POST", "/auth/login", {
          origin: ORIGIN,
          body: {
            email: "admin-flow@example.test",
            password: "tenant initial password safe",
          },
        })
      ).statusCode,
    ).toBe(401);
    const replacement = await login(
      "admin-flow@example.test",
      "replacement password secure",
    );
    expect(replacement.response.statusCode).toBe(200);
    expect(
      (
        await request("POST", "/auth/logout", {
          ...replacement,
          origin: ORIGIN,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      await database.sql`select id from audit_events where business_id=${business.id} and event_type='auth.logout' and outcome='success'`,
    ).toHaveLength(1);
    const activeReplacement = await login(
      "admin-flow@example.test",
      "replacement password secure",
    );
    expect(
      (
        await request("PUT", `/admin/businesses/${business.id}/status`, {
          ...admin,
          origin: ORIGIN,
          body: { status: "suspended" },
        })
      ).json().status,
    ).toBe("suspended");
    expect(
      (await request("GET", "/auth/session", activeReplacement)).statusCode,
    ).toBe(401);
  });

  test("derives tenant only from session for profile, assistant and WhatsApp routes", async () => {
    const a = await createBusiness("tenant-a@example.test");
    const b = await createBusiness("tenant-b@example.test");
    const authA = await login(
      "tenant-a@example.test",
      "tenant initial password safe",
    );
    const authB = await login(
      "tenant-b@example.test",
      "tenant initial password safe",
    );
    const profile = {
      displayName: "Tenant A",
      description: "A",
      address: "",
      contact: "",
      businessHours: "24h",
      offerings: "",
      faq: "",
      policies: "",
      additionalInfo: "",
      business_id: b.business.id,
    };
    expect(
      (
        await request("PUT", "/me/business-profile", {
          ...authA,
          origin: ORIGIN,
          body: profile,
        })
      ).json().displayName,
    ).toBe("Tenant A");
    expect(
      (await request("GET", "/me/business-profile", authB)).json() as unknown,
    ).toEqual({});
    expect(
      (
        await request("PUT", "/me/business-profile", {
          ...authA,
          origin: ORIGIN,
          body: { ...profile, description: "x".repeat(4_001) },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await request("GET", "/me/business-profile", authA)).json().description,
    ).toBe("A");
    expect(
      (
        await request("PUT", "/me/assistant", {
          ...authA,
          origin: ORIGIN,
          body: {
            personality: "",
            tone: "",
            instructions: "",
            knowledge: "",
            rules: "",
            restrictions: "",
            active: true,
            expectedRevision: 0,
            business_id: b.business.id,
          },
        })
      ).json(),
    ).toMatchObject({ active: true, revision: 1 });
    expect(
      (await request("GET", "/me/assistant", authB)).json() as unknown,
    ).toEqual({});
    expect(
      (await request("GET", "/me/whatsapp/status", authA)).json(),
    ).toMatchObject({ status: "link_required" });
    expect(
      (
        await request("POST", "/me/whatsapp/link", {
          ...authA,
          csrf: authA.csrf,
          origin: "https://evil.test",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await request("POST", "/me/whatsapp/link", { ...authA, origin: ORIGIN }))
        .statusCode,
    ).toBe(202);
    const firstLinkEvents = await database.sql<
      { stable_key: string }[]
    >`select stable_key from outbox_events where business_id=${a.business.id} and topic='whatsapp.link_requested'`;
    expect(firstLinkEvents).toHaveLength(1);
    expect(firstLinkEvents[0]?.stable_key).toMatch(
      /^whatsapp\.link_requested:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(
      (await request("POST", "/me/whatsapp/link", { ...authA, origin: ORIGIN }))
        .statusCode,
    ).toBe(202);
    const retriedLinkEvents = await database.sql<
      { stable_key: string }[]
    >`select stable_key from outbox_events where business_id=${a.business.id} and topic='whatsapp.link_requested'`;
    expect(retriedLinkEvents).toHaveLength(2);
    expect(
      new Set(retriedLinkEvents.map((event) => event.stable_key)).size,
    ).toBe(2);
    expect(
      retriedLinkEvents.every((event) =>
        /^whatsapp\.link_requested:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          event.stable_key,
        ),
      ),
    ).toBe(true);
    expect(
      (
        await request("PUT", "/me/assistant", {
          ...authA,
          csrf: authA.csrf,
          body: {},
        })
      ).statusCode,
    ).toBe(403);
  });
});
