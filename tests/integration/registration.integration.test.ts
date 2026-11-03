import { afterAll, beforeAll, expect, test } from "bun:test";
import { Algorithm, hash } from "@node-rs/argon2";
import { join } from "node:path";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools } from "@agendia/db";
import postgres from "postgres";
import { applyPostgresMigrations, createRoleLogin, startTestPostgres, type TestPostgres } from "../support/index.ts";

const origin = "https://panel.agendia.test";
const password = "secure registration password";
let database: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
let app: ReturnType<typeof buildApi>;
let admin: { cookie: string; csrf: string };

beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  await database.sql`insert into auth_identities(normalized_email,password_phc,role) values('admin@example.test',${await hash(password, { algorithm: Algorithm.Argon2id })},'platform_admin')`;
  pools = createRuntimePools(database.container.getConnectionUri());
  app = buildApi({ pools, expectedOrigin: origin });
  const response = await app.inject({ method: "POST", url: "/auth/admin/login", headers: { origin }, payload: { email: "admin@example.test", password } });
  admin = { cookie: String(response.headers["set-cookie"]).split(";")[0]!, csrf: response.json().csrfToken };
}, 120_000);
afterAll(async () => { await app?.close(); await pools?.end(); await database?.stop(); });

const register = (email: string, overrides = {}) => app.inject({ method: "POST", url: "/auth/register", headers: { origin }, payload: { name: "My business", email, password, ...overrides } });
const login = (email: string) => app.inject({ method: "POST", url: "/auth/login", headers: { origin }, payload: { email, password } });
const list = () => app.inject({ method: "GET", url: "/admin/registrations", headers: { cookie: admin.cookie } });
const decide = (id: string, decision: "approve" | "reject", authenticated = true) => app.inject({ method: "POST", url: `/admin/registrations/${id}/${decision}`, headers: authenticated ? { origin, cookie: admin.cookie, "x-csrf-token": admin.csrf } : { origin } });

test("registration remains pending without a session until administrator approval", async () => {
  const created = await register("Approve@Example.test");
  expect(created.statusCode).toBe(202);
  expect(created.headers["set-cookie"]).toBeUndefined();
  const pendingLogin = await login("approve@example.test");
  expect(pendingLogin.statusCode).toBe(401);
  expect(pendingLogin.headers["set-cookie"]).toBeUndefined();
  const pending = (await list()).json() as { id: string; email: string }[];
  const request = pending.find(row => row.email === "approve@example.test");
  expect(request).toBeDefined();
  expect(JSON.stringify(pending)).not.toContain(password);
  expect(JSON.stringify(pending)).not.toContain("$argon2");
  expect((await decide(request!.id, "approve", false)).statusCode).toBe(401);
  expect((await decide(request!.id, "approve")).statusCode).toBe(200);
  expect((await login("approve@example.test")).statusCode).toBe(200);
  expect((await list()).json().find((row: { id: string }) => row.id === request!.id)).toBeUndefined();
});

test("rejecting a pending request releases the email for a new registration", async () => {
  expect((await register("reject@example.test")).statusCode).toBe(202);
  const pending = (await list()).json() as { id: string; email: string }[];
  const id = pending.find(row => row.email === "reject@example.test")!.id;
  expect((await decide(id, "reject")).statusCode).toBe(200);
  expect((await login("reject@example.test")).statusCode).toBe(401);
  expect((await register("reject@example.test")).statusCode).toBe(202);
  expect((await list()).json().filter((row: { email: string }) => row.email === "reject@example.test")).toHaveLength(1);
});

test("registration validates origin and input; administrative manual creation is unavailable", async () => {
  const invalidOrigin = await app.inject({ method: "POST", url: "/auth/register", payload: { name: "X", email: "x@example.test", password } });
  expect(invalidOrigin.statusCode).toBe(403);
  expect((await register("invalid", { password: "short" })).statusCode).toBe(400);
  const manual = await app.inject({ method: "POST", url: "/admin/businesses", headers: { origin, cookie: admin.cookie, "x-csrf-token": admin.csrf }, payload: { name: "X", userEmail: "manual@example.test", initialPassword: password } });
  expect(manual.statusCode).toBe(404);
});

test("duplicate pending and existing account registrations cannot replace credentials", async () => {
  expect((await register("duplicate@example.test")).statusCode).toBe(202);
  expect((await register("DUPLICATE@example.test", { password: "another secure password" })).statusCode).toBe(409);
  expect((await register("admin@example.test", { password: "another secure password" })).statusCode).toBe(409);
  const rows = (await list()).json() as { id: string; email: string }[];
  const matches = rows.filter(row => row.email === "duplicate@example.test");
  expect(matches).toHaveLength(1);
  expect((await decide(matches[0]!.id, "approve")).statusCode).toBe(200);
  expect((await register("duplicate@example.test", { password: "another secure password" })).statusCode).toBe(409);
  expect((await login("duplicate@example.test")).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/auth/admin/login", headers: { origin }, payload: { email: "admin@example.test", password } })).statusCode).toBe(200);
});

test("anonymous callers cannot list or decide registrations", async () => {
  expect((await app.inject({ method: "GET", url: "/admin/registrations" })).statusCode).toBe(401);
  expect((await decide("00000000-0000-4000-8000-000000000001", "reject", false)).statusCode).toBe(401);
});

test("real runtime roles cannot read pending hashes or directly mutate registrations", async () => {
  const api = postgres(await createRoleLogin(database, "registration_api_test", "agendia_runtime"));
  const adminDb = postgres(await createRoleLogin(database, "registration_admin_test", "agendia_admin_runtime"));
  try {
    await expect((async () => await api`select * from pending_registrations`)()).rejects.toThrow();
    await expect((async () => await api`delete from pending_registrations`)()).rejects.toThrow();
    await expect((async () => await api`select decide_registration(gen_random_uuid(), true)`)()).rejects.toThrow();
    await expect((async () => await adminDb`select password_phc from pending_registrations`)()).rejects.toThrow();
    await expect((async () => await adminDb`delete from pending_registrations`)()).rejects.toThrow();
    await expect((async () => await adminDb`select submit_registration('X','x@example.test','hash')`)()).rejects.toThrow();
    await expect((async () => await api`select append_runtime_audit(null,'auth.registration_approved','success','api',null,'forged')`)()).rejects.toThrow();
    expect(await adminDb`select id,name,email,created_at from pending_registrations`).toBeDefined();
  } finally { await api.end(); await adminDb.end(); }
});

test("business user cannot administer requests; suspension and reactivation still work", async () => {
  expect((await register("suspend@example.test")).statusCode).toBe(202);
  const id = ((await list()).json() as { id: string; email: string }[]).find(row => row.email === "suspend@example.test")!.id;
  expect((await decide(id, "approve")).statusCode).toBe(200);
  const signedIn = await login("suspend@example.test");
  expect(signedIn.statusCode).toBe(200);
  const cookie = String(signedIn.headers["set-cookie"]).split(";")[0]!;
  const csrf = signedIn.json().csrfToken;
  expect((await app.inject({ method: "GET", url: "/admin/registrations", headers: { cookie } })).statusCode).toBe(404);
  expect((await app.inject({ method: "POST", url: `/admin/registrations/${id}/reject`, headers: { origin, cookie, "x-csrf-token": csrf } })).statusCode).toBe(404);
  const status = (value: string) => app.inject({ method: "PUT", url: `/admin/businesses/${id}/status`, headers: { origin, cookie: admin.cookie, "x-csrf-token": admin.csrf }, payload: { status: value } });
  expect((await status("suspended")).statusCode).toBe(200);
  expect((await login("suspend@example.test")).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } })).statusCode).toBe(401);
  expect((await status("active")).statusCode).toBe(200);
  expect((await login("suspend@example.test")).statusCode).toBe(200);
});

test("decision requires origin and CSRF and preserves pending state on rejection", async () => {
  expect((await register("csrf@example.test")).statusCode).toBe(202);
  const id = ((await list()).json() as { id: string; email: string }[]).find(row => row.email === "csrf@example.test")!.id;
  expect((await app.inject({ method: "POST", url: `/admin/registrations/${id}/reject`, headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf } })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: `/admin/registrations/${id}/reject`, headers: { origin, cookie: admin.cookie } })).statusCode).toBe(403);
  expect(((await list()).json() as { id: string }[]).some(row => row.id === id)).toBe(true);
  expect((await decide(id, "reject")).statusCode).toBe(200);
});

test("approval conflict leaves an existing identity and request intact", async () => {
  expect((await register("collision@example.test")).statusCode).toBe(202);
  const id = ((await list()).json() as { id: string; email: string }[]).find(row => row.email === "collision@example.test")!.id;
  await database.sql`insert into auth_identities(normalized_email,password_phc,role) values('collision@example.test',${await hash(password, { algorithm: Algorithm.Argon2id })},'platform_admin')`;
  const before = await database.sql`select count(*)::int count from audit_events where event_type='auth.registration_approved'`;
  expect((await decide(id, "approve")).statusCode).toBe(409);
  expect((await database.sql`select count(*)::int count from audit_events where event_type='auth.registration_approved'`)[0]!.count).toBe(before[0]!.count);
  expect(((await list()).json() as { id: string }[]).some(row => row.id === id)).toBe(true);
  expect((await database.sql`select id from businesses where id=${id}`).length).toBe(0);
  expect((await app.inject({ method: "POST", url: "/auth/admin/login", headers: { origin }, payload: { email: "collision@example.test", password } })).statusCode).toBe(200);
  expect((await decide(id, "reject")).statusCode).toBe(200);
});

test("concurrent duplicate registrations yield only one pending request", async () => {
  const results = await Promise.all([register("parallel@example.test"), register("PARALLEL@example.test")]);
  expect(results.map(result => result.statusCode).sort()).toEqual([202, 409]);
  expect(((await list()).json() as { email: string }[]).filter(row => row.email === "parallel@example.test")).toHaveLength(1);
});

test("registration input bounds and separate pre-hash admission preserve login", async () => {
  expect((await register("length@example.test", { name: "x".repeat(161) })).statusCode).toBe(400);
  expect((await register("length@example.test", { password: "x".repeat(1025) })).statusCode).toBe(400);
  await database.sql`update registration_throttle set attempts=30,resets_at=clock_timestamp()+interval '1 minute'`;
  try {
    const denied = await register("throttled@example.test");
    expect(denied.statusCode).toBe(429);
    expect(denied.headers["set-cookie"]).toBeUndefined();
    expect(((await list()).json() as { email: string }[]).some(row => row.email === "throttled@example.test")).toBe(false);
    expect((await app.inject({ method: "POST", url: "/auth/admin/login", headers: { origin }, payload: { email: "admin@example.test", password } })).statusCode).toBe(200);
  } finally { await database.sql`update registration_throttle set attempts=0,resets_at=clock_timestamp()`; }
});

test("concurrent approval and rejection cannot both succeed", async () => {
  await register("race@example.test");
  const id = ((await list()).json() as { id: string; email: string }[]).find(row => row.email === "race@example.test")!.id;
  const results = await Promise.all([decide(id, "approve"), decide(id, "reject")]);
  expect(results.filter(response => response.statusCode === 200)).toHaveLength(1);
  expect(results.filter(response => response.statusCode === 404)).toHaveLength(1);
});
