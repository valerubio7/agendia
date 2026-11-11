import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Db, Transaction } from "../../packages/db/src/repositories/shared.ts";
import type { TenantContext } from "../../packages/db/src/tenant-context.ts";

// Own a separate client: drizzle() changes driver codecs; physical admin probes must keep theirs.
export const createDrizzleRuntime = (url: string) => drizzle(postgres(url));

export function withDrizzleContext<T>(db: Db, context: TenantContext, work: (tx: Transaction) => Promise<T>) {
  return db.transaction(async tx => {
    await tx.execute(sql`set local role agendia_runtime`);
    await tx.execute(sql`select set_config('app.tenant_id',${context.businessId},true),
      set_config('app.actor_role',${context.role},true), set_config('app.actor_id',${context.actorId},true),
      set_config('app.request_id',${context.requestId},true)`);
    return work(tx);
  });
}
