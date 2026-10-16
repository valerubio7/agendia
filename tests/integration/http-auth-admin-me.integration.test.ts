import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hash, Algorithm } from "@node-rs/argon2";
import { join } from "node:path";
import { buildApi } from "../../apps/api/src/app.ts";
import { buildReceptionistMessages } from "../../apps/message-worker/src/receptionist.ts";
import { createRuntimePools } from "@agendia/db";
import type { PlatformAiInstructions } from "@agendia/contracts";
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
    const save = (csrf: string, origin = ORIGIN) => request("PUT", "/admin/ai-instructions", {
      cookie: auth.cookie, csrf, origin, body: { additionalInstructions: "" },
    });
    expect((await save(oldToken)).statusCode).toBe(200);
    expect((await save(recovered)).statusCode).toBe(200);
    expect((await save(recovered, "https://evil.test")).statusCode).toBe(403);
    expect((await save("wrong")).statusCode).toBe(403);
    expect((await request("POST", "/auth/logout", { cookie: auth.cookie, csrf: recovered, origin: ORIGIN })).statusCode).toBe(204);
    expect((await bootstrap(ORIGIN)).statusCode).toBe(401);
};

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

  test("requires an active assistant before requesting a WhatsApp link", async () => {
    await createBusiness("whatsapp-assistant-gate@example.test");
    const tenant = await login(
      "whatsapp-assistant-gate@example.test",
      "tenant initial password safe",
    );

    const missingAssistantLink = await request("POST", "/me/whatsapp/link", {
      ...tenant,
      origin: ORIGIN,
    });
    expect(missingAssistantLink.statusCode).toBe(409);
    expect(missingAssistantLink.json()).toMatchObject({ code: "CONFLICT" });

    expect(
      (
        await request("PUT", "/me/assistant", {
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

    const inactiveAssistantLink = await request("POST", "/me/whatsapp/link", {
      ...tenant,
      origin: ORIGIN,
    });
    expect(inactiveAssistantLink.statusCode).toBe(409);
    expect(inactiveAssistantLink.json()).toMatchObject({ code: "CONFLICT" });

    expect(
      (
        await request("PUT", "/me/assistant", {
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
        await request("PUT", "/me/assistant", {
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
    const savedAssistant = (await request("GET", "/me/assistant", authA)).json();
    const beforeInvalid = await database.sql`select * from assistant_configs where business_id=${a.business.id}`;
    for (const body of [
      { personality: "stale", tone: "", instructions: "", knowledge: "", rules: "", restrictions: "", active: false, expectedRevision: 1 },
      { style: "incomplete", active: false, expectedRevision: 1 },
    ]) {
      expect((await request("PUT", "/me/assistant", { ...authA, origin: ORIGIN, body })).statusCode).toBe(400);
      expect((await request("GET", "/me/assistant", authA)).json()).toEqual(savedAssistant);
    }
    expect([...(await database.sql`select * from assistant_configs where business_id=${a.business.id}`)]).toEqual([...beforeInvalid]);
    expect((await request("PUT", "/me/assistant", { ...authA, origin: ORIGIN, body: { ...savedAssistant, expectedRevision: 0 } })).statusCode).toBe(409);
    expect((await request("GET", "/me/assistant", authA)).json()).toEqual(savedAssistant);
    const maxText = "😀".repeat(8_000);
    const maximumAssistant = {
      style: `Personalidad:\n${maxText}\n\nTono:\n${maxText}`,
      businessInstructions: ["Instrucciones", "Conocimiento", "Reglas", "Restricciones"]
        .map(label => `${label}:\n${maxText}`).join("\n\n"),
      active: true,
      expectedRevision: 1,
    };
    const maximumSave = await request("PUT", "/me/assistant", {
      ...authA, origin: ORIGIN, body: maximumAssistant,
    });
    expect(maximumSave.statusCode).toBe(200);
    expect(maximumSave.json() as unknown).toEqual({
      style: maximumAssistant.style,
      businessInstructions: maximumAssistant.businessInstructions,
      active: true,
      revision: 2,
    });
    expect((await request("GET", "/me/assistant", authA)).json()).toEqual(maximumSave.json());
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

  test("restricts global instructions to admins and preserves raw additions with strict mutations", async () => {
    const url = "/admin/ai-instructions", admin = await adminLogin();
    expect((await request("GET", url)).statusCode).toBe(401);
    expect((await request("PUT", url, { body: { additionalInstructions: "" } })).statusCode).toBe(401);
    await createBusiness("global-denied@example.test");
    const user = await login("global-denied@example.test", "tenant initial password safe");
    expect((await request("GET", url, user)).statusCode).toBe(404);
    expect((await request("PUT", url, { ...user, origin: ORIGIN, body: { additionalInstructions: "" } })).statusCode).toBe(404);
    const initial = await request("GET", url, admin);
    expect(initial.statusCode).toBe(200);
    expect(initial.json().additionalInstructions).toBe("");
    const initialConfig = initial.json<PlatformAiInstructions>();
    const privateData = {
      business: "fixture-private-business", customer: "fixture-private-customer",
      history: "fixture-private-history", summary: "fixture-private-summary",
      assistant: "fixture-private-assistant", admin: "fixture-supplementary-guidance",
      identity: "fixture-private-identity", quote: "fixture-private-quote",
      evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64),
    };
    const runtimeMessages = buildReceptionistMessages({
      raw_text: privateData.customer, sequence: "4",
      profile: { display_name: privateData.business }, assistant: { style: privateData.assistant },
      currentGroup: [{ id: "4", sequence: "4", raw_text: privateData.customer }],
      turns: [{ id: "3", sequence: "3", direction: "outbound", processing_state: "sent", raw_text: privateData.history }],
      summaries: [{ covered_through: "2", structured_summary: {
        facts: [privateData.summary], requests: [], commitments: [], preferences: [], openItems: [],
      } }],
    }, privateData.admin, "2035-04-01T12:00:00Z", {
      pending: { clientId: privateData.identity, quote: { id: privateData.quote } },
      currentEvidence: privateData.customer,
      naturalConfirmation: { evidenceReference: privateData.evidenceReference, quoteFingerprint: privateData.quoteFingerprint },
    });
    const systemMessages = runtimeMessages.filter(message => message.role === "system");
    expect(systemMessages).toHaveLength(1);
    for (const token of Object.values(privateData)) {
      expect(JSON.stringify(runtimeMessages.slice(1))).toContain(token);
      expect(initialConfig.baseInstructions).not.toContain(token);
    }
    expect(initialConfig.baseInstructions).toBe(systemMessages[0]!.content!);
    const policy = { initialDelaySeconds: 0, activeDelaySeconds: 13, inactivityResetSeconds: 55 };
    expect(initial.json().replyPacing).toEqual({ initialDelaySeconds: 600, activeDelaySeconds: 90, inactivityResetSeconds: 3600 });
    const body = { additionalInstructions: "  Atención 😀\n\tfin  ", replyPacing: policy };
    expect((await request("PUT", url, { ...user, origin: ORIGIN, body })).statusCode).toBe(404);
    for (const protection of [
      { origin: "https://evil.test", csrf: admin.csrf },
      { origin: ORIGIN, csrf: "wrong" },
      { csrf: admin.csrf },
      { origin: ORIGIN },
    ]) {
      expect((await request("PUT", url, { cookie: admin.cookie, ...protection, body })).statusCode).toBe(403);
    }
    for (const invalid of [{}, { additionalInstructions: null }, { additionalInstructions: 1 }, { ...body, baseInstructions: "changed" }, { ...body, extra: true }]) {
      expect((await request("PUT", url, { ...admin, origin: ORIGIN, body: invalid })).statusCode).toBe(400);
    }
    expect((await request("PUT", url, { ...admin, origin: ORIGIN, body })).json<typeof initialConfig>()).toEqual({ ...initialConfig, ...body });
    expect((await request("GET", url, await adminLogin())).json<typeof initialConfig>()).toEqual({ ...initialConfig, ...body });
    const instructionOnly = { additionalInstructions: "instruction-only update" };
    expect((await request("PUT", url, { ...admin, origin: ORIGIN, body: instructionOnly })).json<PlatformAiInstructions>()).toEqual({ ...initialConfig, ...body, ...instructionOnly });
    for (const field of Object.keys(policy)) {
      for (const value of [-1, 0.5, 604801, "90", null]) {
        const invalid = { additionalInstructions: "must not persist", replyPacing: { ...policy, [field]: value } };
        expect((await request("PUT", url, { ...admin, origin: ORIGIN, body: invalid })).statusCode).toBe(400);
      }
    }
    for (const invalid of [null, {}, { ...policy, initialDelaySeconds: 86401 }, { ...policy, activeDelaySeconds: 86401 }, { ...policy, inactivityResetSeconds: 0 }, { ...policy, milliseconds: 600000 }]) {
      expect((await request("PUT", url, { ...admin, origin: ORIGIN, body: { additionalInstructions: "must not persist", replyPacing: invalid } })).statusCode).toBe(400);
    }
    expect((await request("GET", url, await adminLogin())).json<PlatformAiInstructions>()).toEqual({ ...initialConfig, ...body, ...instructionOnly });
    const cleared = await request("PUT", url, { ...admin, origin: ORIGIN, body: { additionalInstructions: "" } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().replyPacing).toEqual(policy);
  });
  test("CSRF bootstrap is origin/header/session protected, stable across tabs and compatible with old tokens", csrfBootstrapRegression);
});
