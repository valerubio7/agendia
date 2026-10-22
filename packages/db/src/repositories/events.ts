import type { PostgresRepositories, SafeRuntimeEvent } from "../repositories.ts";
import { asDbJson, type Db } from "./shared.ts";

export function appendRuntimeAudit(db: Db, businessId: string | null, event: SafeRuntimeEvent) {
  return db`select append_runtime_audit(${businessId},${event.code},${event.outcome},${event.source},${event.actorId ?? null},${event.requestId})`;
}
export async function recordRuntimeEvent(db: Db, repo: PostgresRepositories, businessId: string, event: SafeRuntimeEvent) {
  if (event.severity)
    await db`insert into technical_events(business_id,component,code,severity,safe_details) values(${businessId},${event.source},${event.code},${event.severity},'{}')`;
  await repo.appendRuntimeAudit(businessId, event);
}
export function recordInbox(db: Db, businessId: string, source: string, stableKey: string) {
  return db`insert into inbox_events (business_id,source,stable_key) values (${businessId},${source},${stableKey}) on conflict do nothing`;
}
export function enqueueOutbox(
  db: Db,
  businessId: string,
  topic: string,
  stableKey: string,
  payload: unknown,
) {
  return db`insert into outbox_events (business_id,topic,stable_key,payload) values (${businessId},${topic},${stableKey},${db.json(asDbJson(payload))}) on conflict do nothing`;
}
export async function claimOutbox(db: Db) {
  return (
    (
      await db<
        { id: string; topic: string; stable_key: string }[]
      >`select id,topic,stable_key from outbox_events where published_at is null order by created_at for update skip locked limit 1`
    )[0] ?? null
  );
}
export async function markOutboxPublished(db: Db, id: string) {
  return (
    await db`update outbox_events set published_at=now() where id=${id} and published_at is null returning id`
  ).length;
}
export function claimAiOutbox(db: Db, token: string, limit: number, staleMs: number) {
  return db<
    {
      id: string;
      business_id: string;
      stable_key: string;
      payload: object;
      publish_attempts: number;
    }[]
  >`select * from claim_ai_outbox(${token},${limit},${staleMs})`;
}
export async function completeAiOutbox(db: Db, id: string, token: string) {
  return (
    await db<
      { complete_ai_outbox: boolean }[]
    >`select complete_ai_outbox(${id},${token})`
  )[0]?.complete_ai_outbox
    ? 1
    : 0;
}
export async function releaseAiOutbox(db: Db, id: string, token: string, delayMs: number) {
  return Boolean(
    (
      await db<
        { release_ai_outbox: boolean }[]
      >`select release_ai_outbox(${id},${token},${delayMs})`
    )[0]?.release_ai_outbox,
  );
}
export async function appendAudit(
  db: Db,
  businessId: string,
  event: { eventType: string; outcome: string; eventHash: string },
) {
  await db`select pg_advisory_xact_lock(hashtext(${"audit:" + businessId}))`;
  const previous = (
    await db<
      { stream_sequence: string; event_hash: string }[]
    >`select stream_sequence,event_hash from audit_events where business_id=${businessId} order by stream_sequence desc limit 1`
  )[0];
  return db`insert into audit_events (business_id,actor_id,event_type,outcome,request_id,stream_sequence,previous_hash,event_hash,hmac_key_version) values (${businessId},current_setting('app.actor_id',true),${event.eventType},${event.outcome},current_setting('app.request_id',true),${Number(previous?.stream_sequence ?? 0) + 1},${previous?.event_hash ?? "GENESIS"},${event.eventHash},'runtime-v1')`;
}
export async function auditCount(db: Db) {
  return Number(
    (
      await db<
        { count: string }[]
      >`select count(*) count from audit_events`
    )[0]?.count ?? 0,
  );
}
