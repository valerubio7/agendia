import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

export const capabilities = [
  "agendia_runtime", "agendia_admin_runtime",
  "agendia_worker_runtime", "agendia_whatsapp_runtime",
] as const;
export const logins = [
  { name: "agendia_api", password: "API_DB_PASSWORD", roles: [capabilities[0]] },
  { name: "agendia_admin", password: "ADMIN_DB_PASSWORD", roles: [capabilities[1]] },
  { name: "agendia_worker", password: "WORKER_DB_PASSWORD", roles: [capabilities[2]] },
  // Manager uses both manager and worker RolePools; pg-boss uses the worker LOGIN.
  { name: "agendia_manager", password: "MANAGER_DB_PASSWORD", roles: [capabilities[3], capabilities[2]] },
] as const;

export function quoteIdentifier(value: string) {
  if (!value || value.includes("\0")) throw new Error("Invalid SQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}
export function quotePassword(value: string) {
  if (!value || value.includes("\0")) throw new Error("Invalid SQL password");
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}
export function loginStatements(name: string, password: string, roles: readonly string[]) {
  if (!roles.length || roles.some((role) => !capabilities.includes(role as typeof capabilities[number])))
    throw new Error("Invalid capability role");
  const identifier = quoteIdentifier(name);
  return [
    `ALTER ROLE ${identifier} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quotePassword(password)}`,
    `REVOKE ${capabilities.map(quoteIdentifier).join(", ")} FROM ${identifier}`,
    `GRANT ${roles.map(quoteIdentifier).join(", ")} TO ${identifier}`,
  ];
}

export async function provisionLogins(sql: postgres.Sql, env: Record<string, string | undefined>) {
  // Validate every credential before changing any role.
  const plans = logins.map((login) => ({
    name: login.name,
    statements: loginStatements(login.name, env[login.password] ?? "", login.roles),
  }));
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('agendia:production-setup'))`;
    for (const plan of plans) {
      const existing = await tx`select 1 from pg_roles where rolname=${plan.name}`;
      if (!existing.length) await tx.unsafe(`CREATE ROLE ${quoteIdentifier(plan.name)} NOLOGIN`);
      for (const statement of plan.statements) await tx.unsafe(statement);
    }
  });
}

async function migrate(sql: postgres.Sql) {
  // The existing db:migrate:dev runner replays non-idempotent SQL. Production records
  // checksums and applies only pending files, atomically, without changing that runner.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('agendia:production-setup'))`;
    await tx`create table if not exists public.agendia_production_migrations
      (name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
    for (const name of readdirSync("packages/db/migrations").filter((name) => name.endsWith(".sql")).sort()) {
      const source = readFileSync(`packages/db/migrations/${name}`, "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const [applied] = await tx`select checksum from public.agendia_production_migrations where name=${name}`;
      if (applied) {
        if (applied.checksum !== checksum) throw new Error("Applied migration changed");
        continue;
      }
      await tx.unsafe(source);
      await tx`insert into public.agendia_production_migrations(name,checksum) values(${name},${checksum})`;
    }
  });
}

if (import.meta.main) {
  let sql: postgres.Sql | undefined;
  try {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    sql = postgres(process.env.DATABASE_URL, { max: 1 });
    if (process.argv[2] === "migrate") await migrate(sql);
    else if (process.argv[2]) throw new Error("Unknown setup command");
    else await provisionLogins(sql, process.env);
    console.log("Production database setup completed");
  } catch {
    // Do not expose SQL/passwords or connection URLs in setup logs.
    console.error("Production database setup failed");
    process.exitCode = 1;
  } finally {
    await sql?.end();
  }
}
