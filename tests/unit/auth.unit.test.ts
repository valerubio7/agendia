import { describe, expect, test } from "bun:test";
import { AuthService, InMemoryAuthStore, sessionCookie, validateMutationRequest } from "../../packages/auth/src/index.ts";
import { buildApi } from "../../apps/api/src/app.ts";

describe("opaque authentication", () => {
  test("stores Argon2id passwords and only a SHA-256 session digest", async () => {
    const store = new InMemoryAuthStore();
    const auth = new AuthService(store, { absoluteTtlMs: 60_000, idleTtlMs: 30_000 });
    const identity = await auth.createIdentity({ email: "Admin@Example.com", password: "correct horse battery staple", role: "platform_admin", businessId: null });
    expect(identity.passwordHash.startsWith("$argon2id$")).toBe(true);
    const login = await auth.login("admin@example.com", "correct horse battery staple", 1_000);
    expect(login.token).toMatch(/^[a-f0-9]{64}$/);
    expect(store.sessions[0]?.tokenHash).not.toBe(login.token);
    expect((await auth.authenticate(login.token, 2_000))?.identityId).toBe(identity.id);
  });

  test("rejects expired, revoked and disabled identities", async () => {
    const store = new InMemoryAuthStore();
    const auth = new AuthService(store, { absoluteTtlMs: 100, idleTtlMs: 50 });
    const identity = await auth.createIdentity({ email: "user@example.com", password: "correct horse battery staple", role: "business_user", businessId: "11111111-1111-4111-8111-111111111111" });
    const login = await auth.login(identity.email, "correct horse battery staple", 1_000);
    expect(await auth.authenticate(login.token, 1_101)).toBeNull();
    const second = await auth.login(identity.email, "correct horse battery staple", 2_000);
    await auth.logout(second.token);
    expect(await auth.authenticate(second.token, 2_001)).toBeNull();
    identity.active = false;
    await expect(auth.login(identity.email, "correct horse battery staple", 3_000)).rejects.toThrow("Invalid credentials");
  });

  test("allows the operational administrator bootstrap exactly once", async () => {
    const auth = new AuthService(new InMemoryAuthStore());
    const admin = await auth.bootstrapAdmin("owner@example.com", "correct horse battery staple");
    expect(admin.role).toBe("platform_admin");
    await expect(auth.bootstrapAdmin("second@example.com", "another correct horse battery staple")).rejects.toThrow("Bootstrap already consumed");
  });

  test("enforces host-only cookie, CSRF and strict origin", () => {
    expect(sessionCookie("token")).toMatchObject({ name: "__Host-agendia_session", secure: true, httpOnly: true, sameSite: "lax", path: "/" });
    expect(validateMutationRequest({ origin: "https://panel.agendia.test", expectedOrigin: "https://panel.agendia.test", csrfHeader: "csrf", csrfSession: "csrf" })).toBe(true);
    expect(validateMutationRequest({ origin: "https://evil.test", expectedOrigin: "https://panel.agendia.test", csrfHeader: "csrf", csrfSession: "csrf" })).toBe(false);
  });

  test("unknown-account verification performs valid dummy Argon2id work", async () => {
    const { verifyLoginPassword } = await import("../../packages/auth/src/index.ts");
    await expect(verifyLoginPassword(undefined, "unknown account password")).resolves.toBe(false);
  });

  test("stable recovery tokens coexist with previously issued random CSRF tokens", async () => {
    const { deriveSessionCsrf } = await import("../../packages/auth/src/index.ts");
    const auth = new AuthService(new InMemoryAuthStore());
    await auth.createIdentity({ email: "tabs@example.test", password: "correct horse battery staple", role: "platform_admin", businessId: null });
    const login = await auth.login("tabs@example.test", "correct horse battery staple");
    expect(deriveSessionCsrf(login.token)).toBe(login.csrfToken);
    expect(deriveSessionCsrf(login.token)).not.toBe(login.token);
    expect(deriveSessionCsrf(login.token)).not.toBe(deriveSessionCsrf("another-session"));
    const old = "old-random-csrf";
    for (const csrfHeader of [old, deriveSessionCsrf(login.token)]) {
      expect(validateMutationRequest({ origin: "https://panel.test", expectedOrigin: "https://panel.test", csrfHeader, csrfSession: old, sessionToken: login.token })).toBe(true);
      expect(validateMutationRequest({ origin: "https://evil.test", expectedOrigin: "https://panel.test", csrfHeader, csrfSession: old, sessionToken: login.token })).toBe(false);
    }
  });

  test("exposes login/logout/session but no registration or recovery", async () => {
    const api = buildApi(new AuthService(new InMemoryAuthStore()));
    expect((await api.inject({ method: "POST", url: "/auth/register" })).statusCode).toBe(404);
    expect((await api.inject({ method: "POST", url: "/auth/recover" })).statusCode).toBe(404);
    expect((await api.inject({ method: "GET", url: "/auth/session" })).statusCode).toBe(401);
    const csrf = await api.inject({ method: "POST", url: "/auth/csrf" });
    expect(csrf.statusCode).toBe(401);
    expect(csrf.headers["cache-control"]).toBe("no-store");
    expect(csrf.json()).not.toHaveProperty("csrfToken");
    await api.close();
  });
});
