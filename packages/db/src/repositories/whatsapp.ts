import type { PostgresRepositories, SealedLinkCode } from "../repositories.ts";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { whatsappConnections, whatsappLinkCodes, whatsappAuthRecords } from "../schema.ts";
import { execute, result, type Db } from "./shared.ts";

export async function whatsapp(db: Db) {
  return (
    (
      await execute<{ id: string; status: string; linkedNumber: string | null; linkedAt: Date | null; lastConnectedAt: Date | null }>(db,
        sql`select id,lower(state) status,linked_number "linkedNumber",linked_at "linkedAt",last_connected_at "lastConnectedAt" from whatsapp_connections limit 1`)
    )[0] ?? null
  );
}
export function saveConnection(db: Db, id: string, businessId: string) {
  return result(db.insert(whatsappConnections).values({ id, businessId })
    .onConflictDoNothing({ target: whatsappConnections.businessId }));
}
export async function connection(db: Db) {
  return (
    (
      await result(db.select({ id: whatsappConnections.id, sessionPublicId: whatsappConnections.sessionPublicId,
        linkCommandId: whatsappConnections.linkCommandId, linkPending: whatsappConnections.linkPending }).from(whatsappConnections).limit(1))
    )[0] ?? null
  );
}
export function replaceLinkCode(db: Db, id: string, value: SealedLinkCode, expiresAt: Date) {
  const values = { token: value.token, ciphertext: value.ciphertext, nonce: value.nonce, authTag: value.tag, expiresAt };
  return result(db.insert(whatsappLinkCodes).values({ connectionId: id, businessId: value.businessId, ...values })
    .onConflictDoUpdate({ target: whatsappLinkCodes.connectionId, set: { ...values, createdAt: sql`now()` } }));
}
export async function currentLinkCode(db: Db, now: Date) {
  await result(db.delete(whatsappLinkCodes).where(lte(whatsappLinkCodes.expiresAt, now)));
  return (
    (
      await result(db.select({ businessId: whatsappLinkCodes.businessId, connectionId: whatsappLinkCodes.connectionId,
        token: whatsappLinkCodes.token, ciphertext: whatsappLinkCodes.ciphertext, nonce: whatsappLinkCodes.nonce, tag: whatsappLinkCodes.authTag })
        .from(whatsappLinkCodes).where(gt(whatsappLinkCodes.expiresAt, now)).limit(1))
    )[0] ?? null
  );
}
export function invalidateLinkCode(db: Db, id: string, token: string) {
  return result(db.delete(whatsappLinkCodes).where(and(eq(whatsappLinkCodes.connectionId, id), eq(whatsappLinkCodes.token, token))));
}
export function clearLinkCode(db: Db, id: string) {
  return result(db.delete(whatsappLinkCodes).where(eq(whatsappLinkCodes.connectionId, id)));
}
export async function clearWhatsAppAuth(db: Db, id: string) {
  await result(db.delete(whatsappAuthRecords).where(eq(whatsappAuthRecords.connectionId, id)));
  await result(db.update(whatsappConnections).set({ wrappedDek: null, wrappedDekNonce: null, wrappedDekTag: null, kekVersion: null })
    .where(eq(whatsappConnections.id, id)));
}
export async function lockAuthConnection(db: Db, businessId: string, id: string) {
  const rows = await result(db.select({ id: whatsappConnections.id }).from(whatsappConnections)
    .where(and(eq(whatsappConnections.id, id), eq(whatsappConnections.businessId, businessId))).for("update"));
  if (!rows.length) throw new Error("authentication connection unavailable");
}
export async function authEnvelope(db: Db, id: string) {
  return (
    await execute<{
      businessId: string;
      ciphertext: Buffer;
      iv: Buffer;
      tag: Buffer;
      kekVersion: string;
    }>(db, sql`select business_id "businessId",wrapped_dek ciphertext,wrapped_dek_nonce iv,wrapped_dek_tag tag,kek_version "kekVersion" from whatsapp_connections where id=${id} and wrapped_dek is not null`)
  )[0];
}
export async function saveAuthEnvelope(
  db: Db,
  id: string,
  value: { ciphertext: Buffer; iv: Buffer; tag: Buffer; kekVersion: string },
) {
  const rows = await result(db.update(whatsappConnections).set({ wrappedDek: value.ciphertext,
    wrappedDekNonce: value.iv, wrappedDekTag: value.tag, kekVersion: value.kekVersion })
    .where(and(eq(whatsappConnections.id, id), isNull(whatsappConnections.wrappedDek)))
    .returning({ id: whatsappConnections.id }));
  if (!rows.length) throw new Error("authentication envelope already initialized or unavailable");
}
export async function authRecord(db: Db, id: string, name: string) {
  return (
    await result(db.select({ businessId: whatsappAuthRecords.businessId, connectionId: whatsappAuthRecords.connectionId,
      name: whatsappAuthRecords.recordName, version: whatsappAuthRecords.version, ciphertext: whatsappAuthRecords.ciphertext,
      iv: whatsappAuthRecords.nonce, tag: whatsappAuthRecords.authTag }).from(whatsappAuthRecords)
      .where(and(eq(whatsappAuthRecords.connectionId, id), eq(whatsappAuthRecords.recordName, name))))
  )[0];
}
export async function saveAuthRecord(db: Db, value: {
  businessId: string;
  connectionId: string;
  name: string;
  version: number;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}) {
  const rows = await result(db.insert(whatsappAuthRecords).values({ businessId: value.businessId, connectionId: value.connectionId,
    recordName: value.name, version: value.version, ciphertext: value.ciphertext, nonce: value.iv, authTag: value.tag })
    .onConflictDoUpdate({ target: [whatsappAuthRecords.businessId, whatsappAuthRecords.connectionId, whatsappAuthRecords.recordName],
      set: { version: value.version, ciphertext: value.ciphertext, nonce: value.iv, authTag: value.tag },
      setWhere: sql`${whatsappAuthRecords.version}=${value.version}-1`,
    }).returning({ version: whatsappAuthRecords.version }));
  if (!rows.length) throw new Error("authentication record version conflict");
}
export async function claimWhatsAppLink(db: Db, token: string) {
  return (
    (
      await execute<{ command_id: string; business_id: string }>(db, sql`select * from claim_whatsapp_link_command(${token})`)
    )[0] ?? null
  );
}
export function restorableWhatsApp(db: Db) {
  return execute<{ id: string; business_id: string }>(db, sql`select * from restorable_whatsapp_connections()`);
}
export async function admitWhatsAppLink(db: Db, repo: PostgresRepositories, id: string, commandId: string, claim: string): Promise<boolean> {
  const [connection] = await result(db.select({ id: whatsappConnections.id }).from(whatsappConnections)
    .where(eq(whatsappConnections.id, id)).for("update"));
  if (!connection) return false;
  const [command] = await execute(db, sql`select o.id,o.link_admitted_at from outbox_events o
      join whatsapp_connections w on w.business_id=o.business_id
      where w.id=${id} and o.id=${commandId} and o.topic='whatsapp.link_requested'
        and o.published_at is null and o.claim_token=${claim}
        and o.claimed_at>now()-interval '30 seconds' for update of o`);
  if (!command) return false;
  if (!command.link_admitted_at) {
    await repo.clearLinkCode(id);
    await repo.clearWhatsAppAuth(id);
    await execute(db, sql`update whatsapp_connections set link_command_id=${commandId},link_pending=true,state='LINKING',version=version+1 where id=${id}`);
    await execute(db, sql`update outbox_events set link_admitted_at=now() where id=${commandId}`);
  }
  return true;
}
export async function completeWhatsAppLink(db: Db, commandId: string, claim: string, ownership: string) {
  return (await execute<{ completed: boolean }>(db, sql`select complete_whatsapp_link_command(${commandId},${claim},${ownership}) completed`))[0]!.completed;
}
export async function takeOverWhatsApp(db: Db, repo: PostgresRepositories, id: string, owner: string, token: string, now: Date) {
  // Match claim/finish lock ordering, then fence the old socket before reconciliation.
  await execute(db, sql`select id from conversations where connection_id=${id} order by created_at,id for update`);
  await result(db.update(whatsappConnections).set({ ownerId: owner, ownershipToken: token, heartbeatAt: now,
    version: sql`${whatsappConnections.version}+1` }).where(eq(whatsappConnections.id, id)));
  const abandoned = await execute<{ outbound_id: string; business_id: string }>(db, sql`
      update outbound_commands set state='delivery_unknown',failure_code='delivery_unknown',updated_at=now()
      where connection_id=${id} and state='sending' returning outbound_id,business_id`);
  for (const row of abandoned) await repo.recordRuntimeEvent(row.business_id, {
    code: 'whatsapp.delivery_unknown', outcome: 'failure', source: 'whatsapp-manager',
    requestId: `outbound:${row.outbound_id}`, severity: 'error',
  });
}
export async function lockWhatsAppOwnership(db: Db, id: string, token: string): Promise<boolean> {
  const rows = await result(db.select({ id: whatsappConnections.id }).from(whatsappConnections)
    .where(and(eq(whatsappConnections.id, id), eq(whatsappConnections.ownershipToken, token))).for("update"));
  return rows.length > 0;
}
export function heartbeatWhatsApp(db: Db, id: string, owner: string, now: Date, token?: string) {
  return execute(db, sql`update whatsapp_connections set owner_id=${owner},heartbeat_at=${now.toISOString()},version=version+1 where id=${id} and (${token ?? null}::uuid is null or ownership_token=${token ?? null})`);
}
export function releaseWhatsApp(db: Db, id: string, owner: string, token: string) {
  return result(db.update(whatsappConnections).set({ ownerId: null, ownershipToken: null, heartbeatAt: null,
    version: sql`${whatsappConnections.version}+1` }).where(and(eq(whatsappConnections.id, id),
      eq(whatsappConnections.ownerId, owner), eq(whatsappConnections.ownershipToken, token))));
}
export function setWhatsAppState(db: Db, id: string, state: string, now: Date, number?: string) {
  return execute(db, sql`update whatsapp_connections set state=${state},link_pending=case when ${state} in ('CONNECTED','LINK_REQUIRED') then false else link_pending end,linked_number=coalesce(${number ?? null},linked_number),linked_at=case when ${state}='CONNECTED' then coalesce(linked_at,${now.toISOString()}) else linked_at end,last_connected_at=case when ${state}='CONNECTED' then ${now.toISOString()} else last_connected_at end,version=version+1 where id=${id}`);
}
