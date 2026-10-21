import postgres, { type Sql } from "postgres";
import { PostgresRepositories } from "./repositories.ts";
import type { TenantContext } from "./tenant-context.ts";

export type RuntimeRole =
  | "agendia_runtime"
  | "agendia_admin_runtime"
  | "agendia_whatsapp_runtime"
  | "agendia_worker_runtime";

export class RolePool {
  private readonly lockSessions = new Set<Sql>();
  private ending = false;
  private shutdown?: Promise<void>;
  constructor(
    private readonly sql: Sql,
    readonly role: RuntimeRole,
    private readonly lockUrl?: string,
  ) {}
  run<T>(
    context: TenantContext | undefined,
    work: (repositories: PostgresRepositories) => Promise<T>,
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${this.role}`);
      if (context)
        for (const [key, value] of Object.entries({
          tenant_id: context.businessId,
          actor_role: context.role,
          actor_id: context.actorId,
          request_id: context.requestId,
        }))
          await tx`select set_config(${`app.${key}`},${value},true)`;
      return work(new PostgresRepositories(tx));
    }) as Promise<T>;
  }
  async reserveAdvisoryLock(
    key: string,
    wait = false,
  ): Promise<(() => Promise<void>) | null> {
    for (;;) {
      if (this.ending) throw new Error("RolePool is closed");
      if (!this.lockUrl) throw new Error("Advisory locks require a dedicated connection URL");
      // Lifetime locks must not occupy the transaction pool, even when all sockets are live.
      let disconnected = false;
      const session = postgres(this.lockUrl, { max: 1, onclose: () => { disconnected = true; } });
      this.lockSessions.add(session);
      let connection: Awaited<ReturnType<Sql["reserve"]>> | undefined;
      const close = async () => {
        try {
          if (connection) {
            try { if (!disconnected && !this.ending) await connection.unsafe("reset role"); }
            finally { connection.release(); }
          }
        } finally {
          try { await session.end({ timeout: 0 }); }
          finally { this.lockSessions.delete(session); }
        }
      };
      let acquired: boolean | undefined;
      try {
        connection = await session.reserve();
        await connection.unsafe(`set role ${this.role}`);
        acquired = (
          await connection<{ acquired: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${key},0)) acquired`
        )[0]?.acquired;
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
      if (acquired) {
        let released: Promise<void> | undefined;
        return () => released ??= (async () => {
          try {
            if (disconnected || this.ending) throw new Error("Advisory lock connection closed");
            await connection!`select pg_advisory_unlock(hashtextextended(${key},0))`;
          } finally { await close(); }
        })();
      }
      await close();
      if (!wait) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  end() {
    this.ending = true;
    return this.shutdown ??= Promise.all([
      this.sql.end(),
      ...[...this.lockSessions].map((session) => session.end({ timeout: 0 }).finally(() => this.lockSessions.delete(session))),
    ]).then(() => undefined);
  }
}

export function createRuntimePools(
  input:
    | string
    | { api: string; admin: string; manager: string; worker: string },
) {
  const url = (key: "api" | "admin" | "manager" | "worker") =>
    typeof input === "string" ? input : input[key];
  const pools = {
    api: new RolePool(postgres(url("api")), "agendia_runtime", url("api")),
    admin: new RolePool(postgres(url("admin")), "agendia_admin_runtime", url("admin")),
    manager: new RolePool(postgres(url("manager")), "agendia_whatsapp_runtime", url("manager")),
    worker: new RolePool(postgres(url("worker")), "agendia_worker_runtime", url("worker")),
  };
  return {
    ...pools,
    end: () =>
      Promise.all(Object.values(pools).map((pool) => pool.end())).then(
        () => undefined,
      ),
  };
}
