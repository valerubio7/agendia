import { afterAll, beforeAll, beforeEach, expect, test, spyOn } from "bun:test";
import { Algorithm, hash } from "@node-rs/argon2";
import * as auth from "@agendia/auth";
import { join } from "node:path";
import { buildApi } from "../../apps/api/src/app.ts";
import { createRuntimePools, PostgresRepositories } from "@agendia/db";
import { applyPostgresMigrations, createRoleLogin, startTestPostgres, type TestPostgres } from "../support/index.ts";

const ORIGIN = "https://panel.agendia.test";
let database: TestPostgres, pools: ReturnType<typeof createRuntimePools>;
let apps: ReturnType<typeof buildApi>[], secondPools: ReturnType<typeof createRuntimePools>;
beforeAll(async () => {
  database = await startTestPostgres();
  await applyPostgresMigrations(database.sql, join(import.meta.dir, "../../packages/db/migrations"));
  await database.sql`insert into auth_identities(normalized_email,password_phc,role) values('known@example.test',${await hash("correct horse battery staple", { algorithm: Algorithm.Argon2id })},'platform_admin')`;
  pools = createRuntimePools(await createRoleLogin(database, "throttle_api", "agendia_runtime"));
  secondPools = createRuntimePools(await createRoleLogin(database, "throttle_api_second", "agendia_runtime"));
  apps = [buildApi({ pools, expectedOrigin: ORIGIN }), buildApi({ pools: secondPools, expectedOrigin: ORIGIN })];
}, 120_000);
beforeEach(async () => {
  // Only disposable test data: force a fixed-window boundary without a runtime bypass.
  await database.sql`update login_throttle_global set attempts=0, resets_at=clock_timestamp()+interval '1 minute'`;
  await database.sql`update login_throttle_accounts set resets_at=clock_timestamp()-interval '1 second'`;
});
afterAll(async () => {
  for (const app of apps ?? []) await app.close();
  await pools?.end();
  await secondPools?.end();
  await database?.stop();
});
const login = (index: number, email = "known@example.test", origin: string | null = ORIGIN) => apps[index]!.inject({
  method: "POST", url: "/auth/login", payload: { email, password: "wrong password but long enough" },
  headers: { ...(origin ? { origin } : {}), "x-forwarded-for": `198.51.100.${index + 1}` },
});

test("two APIs atomically admit only twenty normalized-account attempts despite parallel requests and fake forwarded peers", async () => {
  const verifier = spyOn(auth, "verifyLoginPassword");
  try {
    const responses = await Promise.all(Array.from({ length: 26 }, (_, i) => login(i % 2, i % 2 ? "KNOWN@example.test" : "known@example.test")));
    expect(responses.filter(r => r.statusCode === 401)).toHaveLength(20);
    expect(responses.filter(r => r.statusCode === 429)).toHaveLength(6);
    expect(verifier).toHaveBeenCalledTimes(20);
    for (const response of responses.filter(r => r.statusCode === 429)) expect(response.headers["retry-after"]).toBe("900");
  } finally { verifier.mockRestore(); }
});

test("unknown accounts have the same per-account admission and denial contract", async () => {
  const responses = await Promise.all(Array.from({ length: 26 }, (_, i) => login(i % 2, "absent@example.test")));
  expect(responses.filter(r => r.statusCode === 401)).toHaveLength(20);
  expect(responses.filter(r => r.statusCode === 429)).toHaveLength(6);
  for (const response of responses.filter(r => r.statusCode === 429)) {
    expect(response.headers["retry-after"]).toBe("900");
    expect(response.json()).toMatchObject({ code: "FORBIDDEN", message: "Too many login attempts" });
  }
});

test("parallel arbitrary emails share the global budget and cannot allocate unbounded account rows", async () => {
  const responses = await Promise.all(Array.from({ length: 126 }, (_, i) => login(i % 2, `unknown-${i}@example.test`)));
  expect(responses.filter(r => r.statusCode === 401)).toHaveLength(120);
  expect(responses.filter(r => r.statusCode === 429)).toHaveLength(6);
  expect(await database.sql`select account_hash from login_throttle_accounts where resets_at>clock_timestamp()`).toHaveLength(120);
  expect((await database.sql`select attempts from login_throttle_global`)[0]!.attempts).toBe(120);
});

test("global hash budget bounds arbitrary-account growth; denial precedes identity lookup and verification", async () => {
  await database.sql`update login_throttle_global set attempts=120`;
  const lookup = spyOn(PostgresRepositories.prototype, "authIdentity");
  const verifier = spyOn(auth, "verifyLoginPassword");
  try {
    const responses = await Promise.all([login(0), login(1, "unknown@example.test"), login(0, "other@example.test")]);
    expect(responses.map(r => r.statusCode)).toEqual([429, 429, 429]);
    expect(lookup).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(responses.map(r => ({ ...r.json(), requestId: "ignored" }))).toEqual(Array(3).fill({ ...responses[0]!.json(), requestId: "ignored" }));
    expect(await database.sql`select * from login_throttle_accounts where resets_at>clock_timestamp()`).toHaveLength(0);
  } finally { lookup.mockRestore(); verifier.mockRestore(); }
});

test("Origin is required before throttle allocation; unavailable limiter fails closed with the same 429", async () => {
  expect((await login(0, "known@example.test", null)).statusCode).toBe(403);
  expect((await login(1, "known@example.test", "https://evil.test")).statusCode).toBe(403);
  expect((await database.sql`select attempts from login_throttle_global`)[0]!.attempts).toBe(0);
  const admission = spyOn(PostgresRepositories.prototype, "admitLogin").mockRejectedValue(new Error("disposable DB failure"));
  const lookup = spyOn(PostgresRepositories.prototype, "authIdentity");
  try {
    const response = await login(0);
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("900");
    expect(lookup).not.toHaveBeenCalled();
  } finally { admission.mockRestore(); lookup.mockRestore(); }
});

test("expired windows reset and indexed cleanup removes at most 128 expired accounts per request", async () => {
  await database.sql`insert into login_throttle_accounts(account_hash,attempts,resets_at)
    select md5(n::text)||md5(n::text),20,clock_timestamp()-interval '1 day' from generate_series(1,300) n on conflict do nothing`;
  const before = (await database.sql`select count(*)::int n from login_throttle_accounts where resets_at<clock_timestamp()`)[0]!.n;
  await database.sql`update login_throttle_global set attempts=120,resets_at=clock_timestamp()-interval '1 second'`;
  expect((await login(0)).statusCode).toBe(401);
  const after = (await database.sql`select count(*)::int n from login_throttle_accounts where resets_at<clock_timestamp()`)[0]!.n;
  expect(before - after).toBeGreaterThanOrEqual(128);
  expect(before - after).toBeLessThanOrEqual(129);
  expect((await database.sql`select attempts from login_throttle_global`)[0]!.attempts).toBe(1);
  expect((await database.sql`select indexdef from pg_indexes where indexname='login_throttle_accounts_expiry'`)[0]!.indexdef).toContain("resets_at");
  expect((await database.sql`select has_table_privilege('agendia_runtime','login_throttle_accounts','INSERT,UPDATE,DELETE') permitted`)[0]!.permitted).toBe(false);
  expect((await database.sql`select has_table_privilege('agendia_runtime','login_throttle_global','INSERT,UPDATE,DELETE') permitted`)[0]!.permitted).toBe(false);
});
