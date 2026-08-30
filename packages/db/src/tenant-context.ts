import type { Sql, TransactionSql } from "postgres";

export type TenantActorRole = "business_user" | "platform_admin" | "internal_worker";
export interface TenantContext {
  readonly businessId: string;
  readonly actorId: string;
  readonly role: TenantActorRole;
  readonly requestId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Construct only from an authenticated identity or internal session-routing record. */
export function tenantContext(input: TenantContext): TenantContext {
  if (!UUID.test(input.businessId)) throw new Error("Invalid server-derived business identity");
  if (!input.actorId || !input.requestId) throw new Error("Tenant context requires actor and request identifiers");
  return Object.freeze({ ...input });
}

export async function withTenantTransaction<T>(sql: Sql, context: TenantContext, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("set local role agendia_runtime");
    await tx`select set_config('app.tenant_id', ${context.businessId}, true)`;
    await tx`select set_config('app.actor_role', ${context.role}, true)`;
    await tx`select set_config('app.actor_id', ${context.actorId}, true)`;
    await tx`select set_config('app.request_id', ${context.requestId}, true)`;
    return work(tx);
  }) as Promise<T>;
}
