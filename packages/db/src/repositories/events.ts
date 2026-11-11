import { and, eq, isNull, sql } from "drizzle-orm";
import { inboxEvents, outboxEvents, technicalEvents } from "../schema.ts";
import type { PostgresRepositories, SafeRuntimeEvent } from "../repositories.ts";
import { asDbJson, execute, result, type Db } from "./shared.ts";

export function appendRuntimeAudit(db: Db, businessId: string | null, event: SafeRuntimeEvent) {
  return execute(db, sql`select append_runtime_audit(${businessId},${event.code},${event.outcome},${event.source},${event.actorId ?? null},${event.requestId})`);
}
export async function recordRuntimeEvent(db: Db, repo: PostgresRepositories, businessId: string, event: SafeRuntimeEvent) {
  if (event.severity)
    await result(db.insert(technicalEvents).values({ businessId, component: event.source, code: event.code,
      severity: event.severity, safeDetails: {} }));
  await repo.appendRuntimeAudit(businessId, event);
}
export function recordInbox(db: Db, businessId: string, source: string, stableKey: string) {
  return result(db.insert(inboxEvents).values({ businessId, source, stableKey }).onConflictDoNothing());
}
export function enqueueOutbox(db: Db, businessId: string, topic: string, stableKey: string, payload: unknown) {
  return result(db.insert(outboxEvents).values({ businessId, topic, stableKey, payload: asDbJson(payload) }).onConflictDoNothing());
}
export async function claimOutbox(db: Db) {
  const [row] = await result(db.select({ id: outboxEvents.id, topic: outboxEvents.topic, stable_key: outboxEvents.stableKey })
    .from(outboxEvents).where(isNull(outboxEvents.publishedAt)).orderBy(outboxEvents.createdAt).for("update", { skipLocked: true }).limit(1));
  return row ?? null;
}
export async function markOutboxPublished(db: Db, id: string) {
  return (await result(db.update(outboxEvents).set({ publishedAt: sql`now()` })
    .where(and(eq(outboxEvents.id, id), isNull(outboxEvents.publishedAt))).returning({ id: outboxEvents.id }))).length;
}
export function claimAiOutbox(db: Db, token: string, limit: number, staleMs: number) {
  return execute<{
    id: string;
    business_id: string;
    stable_key: string;
    payload: object;
    publish_attempts: number;
  }>(db, sql`select * from claim_ai_outbox(${token},${limit},${staleMs})`);
}
export async function completeAiOutbox(db: Db, id: string, token: string) {
  return (await execute<{ complete_ai_outbox: boolean }>(db, sql`select complete_ai_outbox(${id},${token})`))[0]?.complete_ai_outbox ? 1 : 0;
}
export async function releaseAiOutbox(db: Db, id: string, token: string, delayMs: number) {
  return Boolean((await execute<{ release_ai_outbox: boolean }>(db, sql`select release_ai_outbox(${id},${token},${delayMs})`))[0]?.release_ai_outbox);
}
export async function appendAudit(db: Db, businessId: string, event: { eventType: string; outcome: string; eventHash: string }) {
  await execute(db, sql`select pg_advisory_xact_lock(hashtext(${"audit:" + businessId}))`);
  const previous = (await execute<{ stream_sequence: string; event_hash: string }>(db,
    sql`select stream_sequence,event_hash from audit_events where business_id=${businessId} order by stream_sequence desc limit 1`))[0];
  return execute(db, sql`insert into audit_events (business_id,actor_id,event_type,outcome,request_id,stream_sequence,previous_hash,event_hash,hmac_key_version) values (${businessId},current_setting('app.actor_id',true),${event.eventType},${event.outcome},current_setting('app.request_id',true),${Number(previous?.stream_sequence ?? 0) + 1},${previous?.event_hash ?? "GENESIS"},${event.eventHash},'runtime-v1')`);
}
export async function auditCount(db: Db) {
  return Number((await execute<{ count: string }>(db, sql`select count(*) count from audit_events`))[0]?.count ?? 0);
}
