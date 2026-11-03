import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools } from "@agendia/db";
import {
  applyPostgresMigrations,
  startTestPostgres,
  type TestPostgres,
} from "../support/index.ts";

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
const login = async (email: string, password: string, adminEntrance = false) => {
  const response = await request("POST", adminEntrance ? "/auth/admin/login" : "/auth/login", {
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
  login("admin@example.test", "correct horse battery staple", true);
const createBusiness = async (email: string, auth?: Awaited<ReturnType<typeof adminLogin>>) => {
  const admin = auth ?? await adminLogin();
  const response = await request("POST", "/auth/register", {
    origin: ORIGIN,
    body: { name: `Business ${email}`, email, password: "tenant initial password safe" },
  });
  expect(response.statusCode).toBe(202);
  const pending = await request("GET", "/admin/registrations", admin);
  expect(pending.statusCode).toBe(200);
  const business = (pending.json() as { id: string; email: string }[]).find(row => row.email === email);
  expect(business).toBeDefined();
  const approved = await request("POST", `/admin/registrations/${business!.id}/approve`, { ...admin, origin: ORIGIN });
  expect(approved.statusCode).toBe(200);
  return { business: business!, admin };
};

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(
    database.sql,
    join(import.meta.dir, "../../packages/db/migrations"),
  );
  await database.sql`insert into auth_identities (normalized_email,password_phc,role) values (${"admin@example.test"},${await hash("correct horse battery staple", { algorithm: Algorithm.Argon2id })},'platform_admin')`;
  await database.sql`insert into auth_identities (normalized_email,password_phc,role) values (${"override-admin@example.test"},${await hash("correct horse battery staple", { algorithm: Algorithm.Argon2id })},'platform_admin')`;
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: ORIGIN, absoluteTtlMs: 60_000 });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pools?.end();
  await database?.stop();
});

const csrfBootstrapRegression = async () => {
    const auth = await adminLogin();
    const bootstrap = (origin?: string, header = true, cookie = auth.cookie) => app.inject({
      method: "POST", url: "/auth/csrf", headers: {
        cookie, ...(origin ? { origin } : {}), ...(header ? { "x-csrf-bootstrap": "1" } : {}),
      },
    });
    for (const response of [await bootstrap(), await bootstrap("https://evil.test"), await bootstrap(ORIGIN, false)]) {
      expect(response.statusCode).toBe(403);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).not.toHaveProperty("csrfToken");
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect((await bootstrap(ORIGIN, true, "")).statusCode).toBe(401);
    // Model a session issued by the previous runtime; bootstrap must not rotate its random token.
    const oldToken = "previously-issued-random-token";
    const { digestOpaqueToken } = await import("@agendia/auth");
    await database.sql`update web_sessions set csrf_sha256=${digestOpaqueToken(oldToken)} where token_sha256=${digestOpaqueToken(auth.cookie.split("=")[1]!)}`;
    const tabs = await Promise.all([bootstrap(ORIGIN), bootstrap(ORIGIN)]);
    for (const tab of tabs) {
      expect(tab.statusCode).toBe(200);
      expect(tab.headers["cache-control"]).toBe("no-store");
      expect(tab.json().csrfToken).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(tab.json())).not.toContain(auth.cookie.split("=")[1]!);
    }
    const recovered = tabs[0]!.json().csrfToken;
    expect(tabs[1]!.json().csrfToken).toBe(recovered);
    const save = (csrf: string, origin = ORIGIN) => request("PUT", "/admin/response-timing", {
      cookie: auth.cookie, csrf, origin, body: { responseTiming: { initialDelaySeconds: 600, activeDelaySeconds: 90, inactivityResetSeconds: 3600 } },
    });
    expect((await save(oldToken)).statusCode).toBe(200);
    expect((await save(recovered)).statusCode).toBe(200);
    expect((await save(recovered, "https://evil.test")).statusCode).toBe(403);
    expect((await save("wrong")).statusCode).toBe(403);
    expect((await request("POST", "/auth/logout", { cookie: auth.cookie, csrf: recovered, origin: ORIGIN })).statusCode).toBe(204);
    expect((await bootstrap(ORIGIN)).statusCode).toBe(401);
};

describe("PostgreSQL-backed Fastify auth, admin and me API", () => {
  test("session checks and rejected requests do not renew human inactivity", async () => {
    const auth = await adminLogin();
    const { digestOpaqueToken } = await import("@agendia/auth");
    const tokenHash = digestOpaqueToken(auth.cookie.split("=")[1]!);
    await database.sql`update web_sessions set last_seen_at=now()-interval '1 minute', idle_expires_at=now()+interval '5 minutes' where token_sha256=${tokenHash}`;
    const snapshot = async () => (await database.sql`select last_seen_at,idle_expires_at from web_sessions where token_sha256=${tokenHash}`)[0];
    const before = await snapshot();
    expect((await request("GET", "/auth/session", auth)).statusCode).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await app.inject({ method: "POST", url: "/auth/csrf", headers: { cookie: auth.cookie, origin: ORIGIN, "x-csrf-bootstrap": "1" } })).statusCode).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await request("POST", "/auth/logout", { ...auth, origin: "https://evil.test" })).statusCode).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
  test("role and remember choice select session deadlines and cookie persistence", async () => {
    await createBusiness("policy@example.test");
    const policyApp = buildApi({ pools, expectedOrigin: ORIGIN });
    try {
      for (const [email, password, entrance, remember, absoluteMs, idleMs] of [
        ["policy@example.test", "tenant initial password safe", false, false, 7 * 86400000, 2 * 86400000],
        ["policy@example.test", "tenant initial password safe", true, true, 0, 30 * 86400000],
        ["admin@example.test", "correct horse battery staple", true, false, 8 * 3600000, 30 * 60000],
        ["admin@example.test", "correct horse battery staple", true, true, 7 * 86400000, 86400000],
      ] as const) {
        const response = await policyApp.inject({ method: "POST", url: entrance ? "/auth/admin/login" : "/auth/login", headers: { origin: ORIGIN }, payload: { email, password, remember } });
        expect(response.statusCode).toBe(200);
        const cookie = String(response.headers["set-cookie"]);
        expect(cookie.includes("Expires=")).toBe(remember);
        expect(cookie).toContain("Secure");
        const token = cookie.split(";")[0]!.split("=")[1]!;
        const { digestOpaqueToken } = await import("@agendia/auth");
        const [row] = await database.sql<{ created_at: Date; absolute_expires_at: Date; idle_expires_at: Date }[]>`select created_at,absolute_expires_at,idle_expires_at from web_sessions where token_sha256=${digestOpaqueToken(token)}`;
        const created = row!.created_at.getTime();
        const expectedAbsolute = new Date(created);
        if (absoluteMs) expectedAbsolute.setTime(created + absoluteMs);
        else { const day = expectedAbsolute.getUTCDate(); expectedAbsolute.setUTCDate(1); expectedAbsolute.setUTCMonth(expectedAbsolute.getUTCMonth() + 7, 0); expectedAbsolute.setUTCDate(Math.min(day, expectedAbsolute.getUTCDate())); }
        expect(Math.abs(row!.absolute_expires_at.getTime() - expectedAbsolute.getTime())).toBeLessThan(5000);
        expect(Math.abs(row!.idle_expires_at.getTime() - created - idleMs)).toBeLessThan(5000);
        if (remember) {
          const expiry = new Date(cookie.match(/Expires=([^;]+)/)![1]!).getTime();
          expect(expiry).toBeLessThanOrEqual(row!.absolute_expires_at.getTime());
          expect(row!.absolute_expires_at.getTime() - expiry).toBeLessThan(1000);
        }
        await database.sql`update web_sessions set idle_expires_at=now()+interval '10 seconds' where token_sha256=${digestOpaqueToken(token)}`;
        const activityTime = Date.now();
        const activity = await policyApp.inject({ method: "POST", url: "/auth/activity", headers: { origin: ORIGIN, cookie: cookie.split(";")[0]!, "x-csrf-token": response.json().csrfToken } });
        expect(activity.statusCode).toBe(204);
        const [renewed] = await database.sql<{ idle_expires_at: Date }[]>`select idle_expires_at from web_sessions where token_sha256=${digestOpaqueToken(token)}`;
        expect(Math.abs(renewed!.idle_expires_at.getTime() - Math.min(activityTime + idleMs, row!.absolute_expires_at.getTime()))).toBeLessThan(5000);
      }
    } finally { await policyApp.close(); }
  });

  for (const admin of [false, true]) for (const remember of [false, true]) {
    test(`explicit idle timeout applies to ${admin ? "admin" : "business"}, remember=${remember}`, async () => {
      const email = admin ? "override-admin@example.test" : `override-${remember}@example.test`;
      if (!admin) await createBusiness(email, await login("override-admin@example.test", "correct horse battery staple", true));
      const overrideApp = buildApi({ pools, expectedOrigin: ORIGIN, idleTtlMs: 120_000 });
      try {
        const response = await overrideApp.inject({ method: "POST", url: admin ? "/auth/admin/login" : "/auth/login", headers: { origin: ORIGIN }, payload: { email, password: admin ? "correct horse battery staple" : "tenant initial password safe", remember } });
        expect(response.statusCode).toBe(200);
        const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
        const { digestOpaqueToken } = await import("@agendia/auth");
        const tokenHash = digestOpaqueToken(cookie.split("=")[1]!);
        const [row] = await database.sql<{ created_at: Date; idle_expires_at: Date }[]>`select created_at,idle_expires_at from web_sessions where token_sha256=${tokenHash}`;
        expect(Math.abs(row!.idle_expires_at.getTime() - row!.created_at.getTime() - 120_000)).toBeLessThan(5000);
        await database.sql`update web_sessions set idle_expires_at=now()+interval '10 seconds' where token_sha256=${tokenHash}`;
        const activityTime = Date.now();
        const activity = await overrideApp.inject({ method: "POST", url: "/auth/activity", headers: { origin: ORIGIN, cookie, "x-csrf-token": response.json().csrfToken } });
        expect(activity.statusCode).toBe(204);
        const [renewed] = await database.sql<{ idle_expires_at: Date }[]>`select idle_expires_at from web_sessions where token_sha256=${tokenHash}`;
        expect(Math.abs(renewed!.idle_expires_at.getTime() - activityTime - 120_000)).toBeLessThan(5000);
      } finally { await overrideApp.close(); }
    });
  }

  test("activity requires origin and CSRF and cannot revive expired or revoked sessions", async () => {
    const auth = await adminLogin();
    const { digestOpaqueToken } = await import("@agendia/auth");
    const tokenHash = digestOpaqueToken(auth.cookie.split("=")[1]!);
    const snapshot = async () => (await database.sql`select last_seen_at,idle_expires_at from web_sessions where token_sha256=${tokenHash}`)[0];
    await database.sql`update web_sessions set idle_expires_at=now()+interval '10 seconds' where token_sha256=${tokenHash}`;
    const before = await snapshot();
    for (const protection of [{ origin: "https://evil.test", csrf: auth.csrf }, { origin: ORIGIN, csrf: "wrong" }]) {
      expect((await request("POST", "/auth/activity", { cookie: auth.cookie, ...protection })).statusCode).toBe(403);
      expect(await snapshot()).toEqual(before);
    }
    expect((await request("POST", "/auth/activity", { ...auth, origin: ORIGIN })).statusCode).toBe(204);
    expect((await snapshot())!.idle_expires_at > before!.idle_expires_at).toBe(true);
    await database.sql`update web_sessions set idle_expires_at=now()-interval '1 second' where token_sha256=${tokenHash}`;
    const expired = await snapshot();
    expect((await request("POST", "/auth/activity", { ...auth, origin: ORIGIN })).statusCode).toBe(401);
    expect(await snapshot()).toEqual(expired);
    await database.sql`update web_sessions set idle_expires_at=now()+interval '10 seconds', revoked_at=now() where token_sha256=${tokenHash}`;
    const revoked = await snapshot();
    expect((await request("POST", "/auth/activity", { ...auth, origin: ORIGIN })).statusCode).toBe(401);
    expect(await snapshot()).toEqual(revoked);
  });

  test("activity racing with revocation or expiration cannot revive a session", async () => {
    const { digestOpaqueToken } = await import("@agendia/auth");
    for (const outcome of ["revoked", "expired"] as const) {
      const auth = await adminLogin();
      const tokenHash = digestOpaqueToken(auth.cookie.split("=")[1]!);
      let activity!: ReturnType<typeof request>;
      await database.sql.begin(async tx => {
        await tx`select id from web_sessions where token_sha256=${tokenHash} for update`;
        activity = request("POST", "/auth/activity", { ...auth, origin: ORIGIN });
        let blocked = false;
        for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
          await tx`select pg_stat_clear_snapshot()`;
          const [row] = await tx<{ blocked: boolean }[]>`select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%update web_sessions s set last_seen_at%') blocked`;
          blocked = row!.blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        if (outcome === "revoked") await tx`update web_sessions set revoked_at=now() where token_sha256=${tokenHash}`;
        else await tx`update web_sessions set idle_expires_at=now()-interval '1 second' where token_sha256=${tokenHash}`;
      });
      const [before] = await database.sql`select last_seen_at,idle_expires_at,revoked_at from web_sessions where token_sha256=${tokenHash}`;
      expect((await activity).statusCode).toBe(401);
      const [after] = await database.sql`select last_seen_at,idle_expires_at,revoked_at from web_sessions where token_sha256=${tokenHash}`;
      expect(after).toEqual(before);
    }
  });

  test("previously issued sessions retain their stored deadline and can renew activity", async () => {
    const auth = await adminLogin();
    const { digestOpaqueToken } = await import("@agendia/auth");
    const tokenHash = digestOpaqueToken(auth.cookie.split("=")[1]!);
    await database.sql`update web_sessions set idle_ttl_ms=null, idle_expires_at=now()+interval '10 seconds' where token_sha256=${tokenHash}`;
    expect((await request("GET", "/auth/session", auth)).statusCode).toBe(200);
    expect((await request("POST", "/auth/activity", { ...auth, origin: ORIGIN })).statusCode).toBe(204);
    const [row] = await database.sql<{ absolute_expires_at: Date; idle_expires_at: Date }[]>`select absolute_expires_at,idle_expires_at from web_sessions where token_sha256=${tokenHash}`;
    expect(row!.idle_expires_at.getTime()).toBe(row!.absolute_expires_at.getTime());
  });

  test("rejects administrators at the business login without issuing a session", async () => {
    const response = await request("POST", "/auth/login", {
      origin: ORIGIN,
      body: { email: "admin@example.test", password: "correct horse battery staple" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).not.toHaveProperty("csrfToken");
  });
  test("agent endpoint requires authentication and removes the old route without mutation", async () => {
    const before = [...await database.sql`select * from agent_configs`];
    expect((await request("GET", "/me/agent")).statusCode).toBe(401);
    expect((await request("PUT", "/me/agent", { origin: ORIGIN, body: {} })).statusCode).toBe(401);
    for (const method of ["GET", "PUT"] as const)
      expect((await request(method, "/me/assistant", { origin: ORIGIN, body: {} })).statusCode).toBe(404);
    expect([...await database.sql`select * from agent_configs`]).toEqual(before);
  });
  test("sets a secure opaque cookie and enforces expiration, logout, CSRF and Origin", async () => {
    const priorAuditCount = (await database.sql`select event_type from audit_events where business_id is null`).length;
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
      ).map((row) => row.event_type).slice(priorAuditCount),
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
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: business.id, status: "active" })]));
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

  test("requires an active agent before requesting a WhatsApp link", async () => {
    await createBusiness("whatsapp-agent-gate@example.test");
    const tenant = await login(
      "whatsapp-agent-gate@example.test",
      "tenant initial password safe",
    );

    const missingAgentLink = await request("POST", "/me/whatsapp/link", {
      ...tenant,
      origin: ORIGIN,
    });
    expect(missingAgentLink.statusCode).toBe(409);
    expect(missingAgentLink.json()).toMatchObject({ code: "CONFLICT" });

    expect(
      (
        await request("PUT", "/me/agent", {
          ...tenant,
          origin: ORIGIN,
          body: {
            style: "",
            businessInstructions: "",
            active: false,
            expectedRevision: 0,
          },
        })
      ).json(),
    ).toMatchObject({ active: false, revision: 1 });

    const inactiveAgentLink = await request("POST", "/me/whatsapp/link", {
      ...tenant,
      origin: ORIGIN,
    });
    expect(inactiveAgentLink.statusCode).toBe(409);
    expect(inactiveAgentLink.json()).toMatchObject({ code: "CONFLICT" });

    expect(
      (
        await request("PUT", "/me/agent", {
          ...tenant,
          origin: ORIGIN,
          body: {
            style: "",
            businessInstructions: "",
            active: true,
            expectedRevision: 1,
          },
        })
      ).json(),
    ).toMatchObject({ active: true, revision: 2 });
    expect(
      (
        await request("POST", "/me/whatsapp/link", {
          ...tenant,
          origin: ORIGIN,
        })
      ).statusCode,
    ).toBe(202);
  });

  test("derives tenant only from session for profile, agent and WhatsApp routes", async () => {
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
    await database.sql`insert into business_profiles(business_id,display_name) values(${a.business.id},'Old name')`;
    expect(await database.sql`select column_name from information_schema.columns
      where table_schema='public' and table_name='business_profiles'
      and column_name in ('business_hours','offerings','contact','faq','policies','additional_info')`).toHaveLength(0);
    const profile = {
      displayName: "Tenant A",
      description: "A",
      address: "",
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
    const { business_id: _hostileTenant, ...retained } = profile;
    for (const description of ["A", "Updated", "A"]) {
      const saved = await request("PUT", "/me/business-profile", {
        ...authA,
        origin: ORIGIN,
        body: {
          ...profile, description,
          businessHours: "Discard hours", offerings: "Discard offerings",
          contact: "Discard contact", faq: "Discard FAQ",
          policies: "Discard policies", additionalInfo: "Discard info",
        },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json() as unknown).toEqual({ ...retained, description });
      expect((await request("GET", "/me/business-profile", authA)).json() as unknown).toEqual({ ...retained, description });
      expect((await database.sql`select display_name,description,address
        from business_profiles where business_id=${a.business.id}`)[0]).toEqual({
        display_name: retained.displayName, description, address: retained.address,
      });
    }
    expect(
      (await request("GET", "/me/business-profile", authB)).json() as unknown,
    ).toEqual({});
    const fresh = await request("PUT", "/me/business-profile", {
      ...authB, origin: ORIGIN, body: { ...retained, displayName: "Tenant B" },
    });
    expect(fresh.statusCode).toBe(200);
    expect((await request("GET", "/me/business-profile", authB)).json() as unknown).toEqual({
      ...retained, displayName: "Tenant B",
    });
    expect((await request("GET", "/me/business-profile", authA)).json() as unknown).toEqual(retained);
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
        await request("PUT", "/me/agent", {
          ...authA,
          origin: ORIGIN,
          body: {
            style: " \nTenant style ",
            businessInstructions: "Tenant instructions\n ",
            active: true,
            expectedRevision: 0,
            business_id: b.business.id,
          },
        })
      ).json(),
    ).toMatchObject({ style: " \nTenant style ", businessInstructions: "Tenant instructions\n ", active: true, revision: 1 });
    const savedAgent = (await request("GET", "/me/agent", authA)).json();
    const beforeInvalid = await database.sql`select * from agent_configs where business_id=${a.business.id}`;
    for (const body of [
      { personality: "stale", tone: "", instructions: "", knowledge: "", rules: "", restrictions: "", active: false, expectedRevision: 1 },
      { style: "incomplete", active: false, expectedRevision: 1 },
    ]) {
      expect((await request("PUT", "/me/agent", { ...authA, origin: ORIGIN, body })).statusCode).toBe(400);
      expect((await request("GET", "/me/agent", authA)).json()).toEqual(savedAgent);
    }
    expect([...(await database.sql`select * from agent_configs where business_id=${a.business.id}`)]).toEqual([...beforeInvalid]);
    expect((await request("PUT", "/me/agent", { ...authA, origin: ORIGIN, body: { ...savedAgent, expectedRevision: 0 } })).statusCode).toBe(409);
    expect((await request("GET", "/me/agent", authA)).json()).toEqual(savedAgent);
    const maxText = "😀".repeat(8_000);
    const maximumAgent = {
      style: `Personalidad:\n${maxText}\n\nTono:\n${maxText}`,
      businessInstructions: ["Instrucciones", "Conocimiento", "Reglas", "Restricciones"]
        .map(label => `${label}:\n${maxText}`).join("\n\n"),
      active: true,
      expectedRevision: 1,
    };
    const maximumSave = await request("PUT", "/me/agent", {
      ...authA, origin: ORIGIN, body: maximumAgent,
    });
    expect(maximumSave.statusCode).toBe(200);
    expect(maximumSave.json() as unknown).toEqual({
      style: maximumAgent.style,
      businessInstructions: maximumAgent.businessInstructions,
      active: true,
      revision: 2,
    });
    expect((await request("GET", "/me/agent", authA)).json()).toEqual(maximumSave.json());
    expect(
      (await request("GET", "/me/agent", authB)).json() as unknown,
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
        await request("PUT", "/me/agent", {
          ...authA,
          csrf: authA.csrf,
          body: {},
        })
      ).statusCode,
    ).toBe(403);
  });

  test("response timing is admin-only, CSRF-protected, strict and replaces the old route", async () => {
    const url = "/admin/response-timing", admin = await adminLogin();
    const policy = { initialDelaySeconds: 0, activeDelaySeconds: 23, inactivityResetSeconds: 75 };
    const before = [...await database.sql`select * from operational_controls`];
    expect((await request("GET", url)).statusCode).toBe(401);
    expect((await request("PUT", url, { body: { responseTiming: policy } })).statusCode).toBe(401);
    await createBusiness("global-denied@example.test");
    const user = await login("global-denied@example.test", "tenant initial password safe");
    expect((await request("GET", url, user)).statusCode).toBe(404);
    expect((await request("PUT", url, { ...user, origin: ORIGIN, body: { responseTiming: policy } })).statusCode).toBe(404);
    for (const protection of [{ origin: "https://evil.test", csrf: admin.csrf }, { origin: ORIGIN, csrf: "wrong" }, { csrf: admin.csrf }, { origin: ORIGIN }])
      expect((await request("PUT", url, { cookie: admin.cookie, ...protection, body: { responseTiming: policy } })).statusCode).toBe(403);
    for (const invalid of [{}, { additionalInstructions: "legacy" }, { responseTiming: {} }, { responseTiming: { ...policy, activeDelaySeconds: -1 } }, { responseTiming: policy, extra: true }])
      expect((await request("PUT", url, { ...admin, origin: ORIGIN, body: invalid })).statusCode).toBe(400);
    expect([...await database.sql`select * from operational_controls`]).toEqual(before);
    expect((await request("GET", "/admin/ai-instructions", admin)).statusCode).toBe(404);
    expect((await request("PUT", "/admin/ai-instructions", { ...admin, origin: ORIGIN, body: { additionalInstructions: "legacy" } })).statusCode).toBe(404);
    expect((await request("PUT", url, { ...admin, origin: ORIGIN, body: { responseTiming: policy } })).json<{ responseTiming: typeof policy }>()).toEqual({ responseTiming: policy });
    expect((await request("GET", url, admin)).json<{ responseTiming: typeof policy }>()).toEqual({ responseTiming: policy });
  });
  test("CSRF bootstrap is origin/header/session protected, stable across tabs and compatible with old tokens", csrfBootstrapRegression);
});
