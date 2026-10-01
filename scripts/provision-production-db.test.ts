import { expect, test } from "bun:test";
import { capabilities, logins, loginStatements, provisionLogins, quoteIdentifier, quotePassword } from "./provision-production-db.ts";
import type postgres from "postgres";

test("SQL quoting contains hostile identifiers and passwords", () => {
  expect(quoteIdentifier('a"; DROP ROLE x;--')).toBe('"a""; DROP ROLE x;--"');
  expect(quotePassword("a'\\;--")).toBe("E'a''\\\\;--'");
  for (const value of ["", "a\0b"]) {
    expect(() => quoteIdentifier(value)).toThrow();
    expect(() => quotePassword(value)).toThrow();
  }
});

test("runtime logins have only their required capabilities and no privileged flags", () => {
  expect(logins.map((login) => [...login.roles])).toEqual([
    ["agendia_runtime"], ["agendia_admin_runtime"],
    ["agendia_worker_runtime"], ["agendia_whatsapp_runtime", "agendia_worker_runtime"],
  ]);
  for (const login of logins) {
    const statements = loginStatements(login.name, "synthetic-password", login.roles);
    expect(statements[0]).toContain("LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    expect(statements[1]).toBe(`REVOKE ${capabilities.map(quoteIdentifier).join(", ")} FROM "${login.name}"`);
    expect(statements[2]).toBe(`GRANT ${login.roles.map(quoteIdentifier).join(", ")} TO "${login.name}"`);
  }
  expect(() => loginStatements("x", "secret", ["postgres"])).toThrow();
  expect(() => loginStatements("x", "secret", [])).toThrow();
});

test("provisioning can repeat without recreating logins, and validates before mutation", async () => {
  const existing = new Set<string>();
  const commands: string[] = [];
  const tx = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    if (parts.join("").includes("pg_roles")) return existing.has(String(values[0])) ? [{}] : [];
    return [];
  }, { unsafe: async (statement: string) => {
    commands.push(statement);
    const match = statement.match(/^CREATE ROLE "([^"]+)"/);
    if (match) existing.add(match[1]!);
  } });
  const sql = { begin: async (work: (transaction: typeof tx) => Promise<void>) => work(tx) } as unknown as postgres.Sql;
  const env = Object.fromEntries(logins.map((login) => [login.password, "synthetic-password"]));
  await provisionLogins(sql, env);
  await provisionLogins(sql, env);
  expect(commands.filter((command) => command.startsWith("CREATE ROLE"))).toHaveLength(4);
  expect(commands.filter((command) => command.startsWith("ALTER ROLE"))).toHaveLength(8);
  const count = commands.length;
  await expect(provisionLogins(sql, { ...env, MANAGER_DB_PASSWORD: "" })).rejects.toThrow();
  expect(commands).toHaveLength(count);
});
