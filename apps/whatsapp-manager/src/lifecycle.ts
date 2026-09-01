import { randomUUID } from "node:crypto";
import {
  sealLinkCode,
  tenantContext,
  type createRuntimePools,
} from "@agendia/db";
import type { InboundWhatsAppEvent } from "./inbound-handler.ts";

export type BaileysLifecycleEvent =
  | { type: "qr"; value: string }
  | { type: "open"; linkedNumber: string }
  | { type: "transient-close" }
  | { type: "logout" }
  | { type: "corrupt" };

export interface WhatsAppGateway {
  connect(
    connectionId: string,
    onEvent: (event: BaileysLifecycleEvent) => unknown,
    onInbound?: (event: InboundWhatsAppEvent) => unknown,
    sessionPublicId?: string,
  ): unknown | Promise<unknown>;
}

type Pools = ReturnType<typeof createRuntimePools>;
type Lease = { closed: Promise<void>; close(): void };
export class PostgresWhatsAppManager {
  private readonly active = new Map<
    string,
    {
      lease: Lease;
      heartbeat: ReturnType<typeof setInterval>;
      done: Promise<void>;
    }
  >();
  constructor(
    private readonly pools: Pools,
    private readonly ownerId: string,
    private readonly gatewayFor: (businessId: string) => WhatsAppGateway,
    private readonly heartbeatMs = 15_000,
    private readonly onInbound: (event: InboundWhatsAppEvent) => unknown = () =>
      undefined,
    private readonly linkCodeKey: Buffer = Buffer.alloc(32),
  ) {}
  private context(businessId: string) {
    return tenantContext({
      businessId,
      actorId: this.ownerId,
      role: "internal_worker",
      requestId: `whatsapp-manager:${this.ownerId}`,
    });
  }
  private async start(
    businessId: string,
    id: string | undefined,
    now: number,
    relink = false,
  ): Promise<boolean> {
    const context = this.context(businessId);
    if (!id)
      await this.pools.manager.run(context, (repo) =>
        repo.saveConnection(randomUUID(), businessId),
      );
    const connection = await this.pools.manager.run(context, (repo) =>
      repo.connection(),
    );
    id = connection?.id;
    if (!id || !connection || this.active.has(id)) return false;
    const release = await this.pools.manager.reserveAdvisoryLock(id);
    if (!release) return false;
    if (relink)
      await this.pools.manager.run(context, async (repo) => {
        await repo.clearLinkCode(id!);
        await repo.clearWhatsAppAuth(id!);
      });
    const link: { token?: string } = {};
    await this.pools.manager.run(context, async (repo) => {
      await repo.heartbeatWhatsApp(id!, this.ownerId, new Date(now));
      await repo.recordRuntimeEvent(businessId, {
        code: "whatsapp.manager.started",
        outcome: "success",
        source: "whatsapp-manager",
        actorId: this.ownerId,
        requestId: context.requestId,
        severity: "info",
      });
      const current = relink ? null : await repo.currentLinkCode(new Date(now));
      if (current) link.token = current.token;
    });
    const pending: Promise<unknown>[] = [];
    let connected: unknown;
    try {
      connected = await this.gatewayFor(businessId).connect(
        id,
        (event) => {
          const work = this.apply(context, businessId, id!, event, now, link);
          pending.push(work);
          return work;
        },
        this.onInbound,
        connection.sessionPublicId,
      );
    } catch {
      await this.pools.manager.run(context, async (repo) => {
        await repo.setWhatsAppState(id!, "ERROR", new Date(now));
        if (link.token) await repo.invalidateLinkCode(id!, link.token);
        await repo.recordRuntimeEvent(businessId, {
          code: "whatsapp.connection_failed",
          outcome: "failure",
          source: "whatsapp-manager",
          actorId: this.ownerId,
          requestId: context.requestId,
          severity: "error",
        });
      });
      await release();
      return false;
    }
    await Promise.all(pending);
    if (connected && typeof connected === "object" && "closed" in connected) {
      const lease = connected as Lease;
      let heartbeatWork = Promise.resolve<unknown>(undefined);
      const heartbeat = setInterval(() => {
        heartbeatWork = heartbeatWork
          .then(() =>
            this.pools.manager.run(context, (repo) =>
              repo.heartbeatWhatsApp(id!, this.ownerId, new Date()),
            ),
          )
          .catch(() => undefined);
      }, this.heartbeatMs);
      const done = lease.closed.finally(async () => {
        clearInterval(heartbeat);
        this.active.delete(id!);
        try {
          await heartbeatWork;
          await this.pools.manager.run(context, (repo) =>
            repo.releaseWhatsApp(id!, this.ownerId),
          );
        } finally {
          await release();
        }
      });
      this.active.set(id, { lease, heartbeat, done });
    } else await release();
    return true;
  }
  private apply(
    context: ReturnType<PostgresWhatsAppManager["context"]>,
    businessId: string,
    id: string,
    event: BaileysLifecycleEvent,
    now: number,
    link: { token?: string },
  ) {
    return this.pools.manager.run(context, async (repo) => {
      if (event.type === "qr") {
        const token = randomUUID();
        link.token = token;
        await repo.replaceLinkCode(
          id,
          sealLinkCode(this.linkCodeKey, businessId, id, token, event.value),
          new Date(now + 5 * 60_000),
        );
        return repo.recordRuntimeEvent(businessId, {
          code: "whatsapp.link_qr_available",
          outcome: "success",
          source: "whatsapp-manager",
          actorId: this.ownerId,
          requestId: context.requestId,
          severity: "info",
        });
      }
      const mapped =
        event.type === "open"
          ? {
              state: "CONNECTED",
              code: "whatsapp.connected",
              outcome: "success",
              severity: "info",
            }
          : event.type === "transient-close"
            ? {
                state: "RECONNECTING",
                code: "whatsapp.disconnected",
                outcome: "failure",
                severity: "warning",
              }
            : event.type === "logout"
              ? {
                  state: "LINK_REQUIRED",
                  code: "whatsapp.link_required",
                  outcome: "success",
                  severity: "warning",
                }
              : {
                  state: "ERROR",
                  code: "whatsapp.connection_failed",
                  outcome: "failure",
                  severity: "error",
                };
      await repo.setWhatsAppState(
        id,
        mapped.state,
        new Date(now),
        event.type === "open" ? event.linkedNumber : undefined,
      );
      if (link.token && ["open", "logout", "corrupt"].includes(event.type))
        await repo.invalidateLinkCode(id, link.token);
      await repo.recordRuntimeEvent(businessId, {
        code: mapped.code,
        outcome: mapped.outcome as "success" | "failure",
        source: "whatsapp-manager",
        actorId: this.ownerId,
        requestId: context.requestId,
        severity: mapped.severity as "info" | "warning" | "error",
      });
    });
  }
  async processNext(now = Date.now()): Promise<boolean> {
    const command = await this.pools.manager.run(undefined, (repo) =>
      repo.claimWhatsAppLink(),
    );
    return command
      ? this.start(command.business_id, undefined, now, true)
      : false;
  }
  async restart(now = Date.now()): Promise<string[]> {
    const rows = await this.pools.manager.run(undefined, (repo) =>
        repo.restorableWhatsApp(),
      ),
      started: string[] = [];
    for (const row of rows)
      if (await this.start(row.business_id, row.id, now)) started.push(row.id);
    return started;
  }
  async stop(): Promise<void> {
    const active = [...this.active.values()];
    for (const item of active) item.lease.close();
    await Promise.all(active.map((item) => item.done));
  }
}
