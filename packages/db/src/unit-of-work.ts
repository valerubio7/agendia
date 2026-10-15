import type { TenantContext } from "./tenant-context.ts";
import { type AppointmentOperationRow, type PostgresRepositories, type RolePool } from "./repositories.ts";

export class AppointmentOperationError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super("Appointment operation did not complete"); }
}
export type AppointmentOperation = {
  key: string; kind: AppointmentOperationRow["kind"]; target: string | null; fingerprint: string; status: number;
  failure: (cause: unknown) => { status: number; body: unknown } | null;
};

export interface UnitOfWorkEvents {
  audit: { eventType: string; outcome: "success" | "failure" | "denied"; eventHash: string };
  outbox: { topic: string; stableKey: string; payload: object };
}

export class TenantUnitOfWork {
  constructor(private readonly pool: RolePool) {}
  async execute<T>(context: TenantContext, events: UnitOfWorkEvents, mutation: (repositories: PostgresRepositories) => Promise<T>, operation?: AppointmentOperation): Promise<T> {
    const execute = async (repo: PostgresRepositories) => {
      const result = await mutation(repo);
      await repo.appendAudit(context.businessId, events.audit);
      await repo.enqueueOutbox(context.businessId, events.outbox.topic, events.outbox.stableKey, events.outbox.payload);
      return result;
    };
    if (!operation) return this.pool.run(context, execute);
    const receipt = await this.pool.run(context, async repo => {
      // No separately committed reservation can survive a crash. The transaction owns admission,
      // domain effects and the receipt; a fence takes this same lock even before an execution arrives.
      await repo.lockAppointmentOperation(context, operation.key);
      const previous = await repo.appointmentOperation(context, operation.key);
      if (previous) {
        if (previous.kind !== operation.kind || previous.target !== operation.target
          || (previous.state !== "cancelled" && previous.fingerprint !== operation.fingerprint))
          throw new AppointmentOperationError(409, { code: "CONFLICT", message: "Operation key payload differs" });
        return previous;
      }
      let row: AppointmentOperationRow;
      try {
        const body = await repo.appointmentOperationSavepoint(execute);
        row = { kind: operation.kind, target: operation.target, fingerprint: operation.fingerprint,
          state: "completed", result: { status: operation.status, body } };
      } catch (cause) {
        const failure = operation.failure(cause);
        if (!failure) throw cause; // Infrastructure/unknown errors roll back everything, including admission.
        row = { kind: operation.kind, target: operation.target, fingerprint: operation.fingerprint, state: "failed", result: failure };
      }
      await repo.recordAppointmentOperation(context, operation.key, row);
      return row;
    });
    // Throw only AFTER commit, never while committing a deterministic failed receipt.
    if (receipt.state === "cancelled") throw new AppointmentOperationError(409, { code: "CONFLICT", message: "Operation request was cancelled" });
    if (receipt.state === "failed") throw new AppointmentOperationError(receipt.result!.status, receipt.result!.body);
    return receipt.result!.body as T;
  }
}
