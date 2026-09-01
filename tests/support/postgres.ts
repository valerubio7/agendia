import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  sql: Sql;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const sql = postgres(container.getConnectionUri(), { max: 4 });
  return {
    container,
    sql,
    async stop() {
      await sql.end();
      await container.stop();
    },
  };
}

export function testTenantContext(
  businessId: string,
  role: "business_user" | "internal_worker" = "business_user",
) {
  const suffix = businessId[0];
  return {
    businessId,
    actorId: `${role}-${suffix}`,
    role,
    requestId: `test-${suffix}`,
  } as const;
}

export async function createRoleLogin(
  database: TestPostgres,
  login: string,
  membership: `agendia_${string}`,
): Promise<string> {
  if (!/^[a-z][a-z0-9_]+$/.test(login) || !/^agendia_[a-z_]+$/.test(membership))
    throw new Error("Unsafe PostgreSQL test role");
  const password = "test-only-password";
  await database.sql.unsafe(
    `create role "${login}" login password '${password}' in role ${membership}`,
  );
  const url = new URL(database.container.getConnectionUri());
  url.username = login;
  url.password = password;
  return url.toString();
}

function migrationNames(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export async function applyPostgresMigrations(
  sql: Sql,
  directory: string,
): Promise<number> {
  const names = migrationNames(directory);
  if (names.length === 0) throw new Error("No migrations found");
  for (const name of names) {
    try {
      await sql.unsafe(readFileSync(join(directory, name), "utf8"));
    } catch (cause) {
      throw new Error(`Migration ${name} failed`, { cause });
    }
  }
  return names.length;
}
