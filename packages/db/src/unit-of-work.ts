import type { TenantContext } from "./tenant-context.ts";
import { type PostgresRepositories, type RolePool } from "./repositories.ts";

export interface UnitOfWorkEvents {
  audit: { eventType: string; outcome: "success" | "failure" | "denied"; eventHash: string };
  outbox: { topic: string; stableKey: string; payload: object };
}

export class TenantUnitOfWork {
  constructor(private readonly pool: RolePool) {}
  execute<T>(context: TenantContext, events: UnitOfWorkEvents, mutation: (repositories: PostgresRepositories) => Promise<T>): Promise<T> {
    return this.pool.run(context, async (repositories) => {
      const result = await mutation(repositories);
      await repositories.appendAudit(context.businessId, events.audit);
      await repositories.enqueueOutbox(context.businessId, events.outbox.topic, events.outbox.stableKey, events.outbox.payload);
      return result;
    });
  }
}
