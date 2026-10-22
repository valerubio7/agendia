import type { PostgresRepositories, SealedLinkCode } from "../repositories.ts";
import type { Db } from "./shared.ts";

export async function whatsapp(db: Db) {
  return (
    (
      await db`select id,lower(state) status,linked_number "linkedNumber",linked_at "linkedAt",last_connected_at "lastConnectedAt" from whatsapp_connections limit 1`
    )[0] ?? null
  );
}
export function saveConnection(db: Db, id: string, businessId: string) {
  return db`insert into whatsapp_connections (id,business_id) values (${id},${businessId}) on conflict(business_id) do nothing`;
}
export async function connection(db: Db) {
  return (
    (
      await db<
        { id: string; sessionPublicId: string; linkCommandId: string | null; linkPending: boolean }[]
      >`select id,session_public_id "sessionPublicId",link_command_id "linkCommandId",link_pending "linkPending" from whatsapp_connections limit 1`
    )[0] ?? null
  );
}
export function replaceLinkCode(db: Db, id: string, value: SealedLinkCode, expiresAt: Date) {
  return db`insert into whatsapp_link_codes(connection_id,business_id,token,ciphertext,nonce,auth_tag,expires_at) values(${id},${value.businessId},${value.token},${value.ciphertext},${value.nonce},${value.tag},${expiresAt}) on conflict(connection_id) do update set token=excluded.token,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,expires_at=excluded.expires_at,created_at=now()`;
}
export async function currentLinkCode(db: Db, now: Date) {
  await db`delete from whatsapp_link_codes where expires_at<=${now}`;
  return (
    (
      await db<
        {
          businessId: string;
          connectionId: string;
          token: string;
          ciphertext: Buffer;
          nonce: Buffer;
          tag: Buffer;
        }[]
      >`select business_id "businessId",connection_id "connectionId",token,ciphertext,nonce,auth_tag tag from whatsapp_link_codes where expires_at>${now} limit 1`
    )[0] ?? null
  );
}
export function invalidateLinkCode(db: Db, id: string, token: string) {
  return db`delete from whatsapp_link_codes where connection_id=${id} and token=${token}`;
}
export function clearLinkCode(db: Db, id: string) {
  return db`delete from whatsapp_link_codes where connection_id=${id}`;
}
export async function clearWhatsAppAuth(db: Db, id: string) {
  await db`delete from whatsapp_auth_records where connection_id=${id}`;
  await db`update whatsapp_connections set wrapped_dek=null,wrapped_dek_nonce=null,wrapped_dek_tag=null,kek_version=null where id=${id}`;
}
export async function lockAuthConnection(db: Db, businessId: string, id: string) {
  const rows = await db`select id from whatsapp_connections where id=${id} and business_id=${businessId} for update`;
  if (!rows.length) throw new Error("authentication connection unavailable");
}
export async function authEnvelope(db: Db, id: string) {
  return (
    await db<
      {
        businessId: string;
        ciphertext: Buffer;
        iv: Buffer;
        tag: Buffer;
        kekVersion: string;
      }[]
    >`select business_id "businessId",wrapped_dek ciphertext,wrapped_dek_nonce iv,wrapped_dek_tag tag,kek_version "kekVersion" from whatsapp_connections where id=${id} and wrapped_dek is not null`
  )[0];
}
export async function saveAuthEnvelope(
  db: Db,
  id: string,
  value: { ciphertext: Buffer; iv: Buffer; tag: Buffer; kekVersion: string },
) {
  const rows = await db`update whatsapp_connections set wrapped_dek=${value.ciphertext},wrapped_dek_nonce=${value.iv},wrapped_dek_tag=${value.tag},kek_version=${value.kekVersion} where id=${id} and wrapped_dek is null returning id`;
  if (!rows.length) throw new Error("authentication envelope already initialized or unavailable");
}
export async function authRecord(db: Db, id: string, name: string) {
  return (
    await db<
      {
        businessId: string;
        connectionId: string;
        name: string;
        version: number;
        ciphertext: Buffer;
        iv: Buffer;
        tag: Buffer;
      }[]
    >`select business_id "businessId",connection_id "connectionId",record_name name,version,ciphertext,nonce iv,auth_tag tag from whatsapp_auth_records where connection_id=${id} and record_name=${name}`
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
  const rows = await db`insert into whatsapp_auth_records(business_id,connection_id,record_name,version,ciphertext,nonce,auth_tag) values(${value.businessId},${value.connectionId},${value.name},${value.version},${value.ciphertext},${value.iv},${value.tag}) on conflict(business_id,connection_id,record_name) do update set version=excluded.version,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag where whatsapp_auth_records.version=excluded.version-1 returning version`;
  if (!rows.length) throw new Error("authentication record version conflict");
}
export async function claimWhatsAppLink(db: Db, token: string) {
  return (
    (
      await db<
        { command_id: string; business_id: string }[]
      >`select * from claim_whatsapp_link_command(${token})`
    )[0] ?? null
  );
}
export function restorableWhatsApp(db: Db) {
  return db<
    { id: string; business_id: string }[]
  >`select * from restorable_whatsapp_connections()`;
}
export async function admitWhatsAppLink(db: Db, repo: PostgresRepositories, id: string, commandId: string, claim: string): Promise<boolean> {
  const [connection] = await db`select id from whatsapp_connections where id=${id} for update`;
  if (!connection) return false;
  const [command] = await db`select o.id,o.link_admitted_at from outbox_events o
      join whatsapp_connections w on w.business_id=o.business_id
      where w.id=${id} and o.id=${commandId} and o.topic='whatsapp.link_requested'
        and o.published_at is null and o.claim_token=${claim}
        and o.claimed_at>now()-interval '30 seconds' for update of o`;
  if (!command) return false;
  if (!command.link_admitted_at) {
    await repo.clearLinkCode(id);
    await repo.clearWhatsAppAuth(id);
    await db`update whatsapp_connections set link_command_id=${commandId},link_pending=true,state='LINKING',version=version+1 where id=${id}`;
    await db`update outbox_events set link_admitted_at=now() where id=${commandId}`;
  }
  return true;
}
export async function completeWhatsAppLink(db: Db, commandId: string, claim: string, ownership: string) {
  return (await db<{ completed: boolean }[]>`select complete_whatsapp_link_command(${commandId},${claim},${ownership}) completed`)[0]!.completed;
}
export async function takeOverWhatsApp(db: Db, repo: PostgresRepositories, id: string, owner: string, token: string, now: Date) {
  // Match claim/finish lock ordering, then fence the old socket before reconciliation.
  await db`select id from conversations where connection_id=${id} order by created_at,id for update`;
  await db`update whatsapp_connections set owner_id=${owner},ownership_token=${token},heartbeat_at=${now},version=version+1 where id=${id}`;
  const abandoned = await db<{ outbound_id: string; business_id: string }[]>`
      update outbound_commands set state='delivery_unknown',failure_code='delivery_unknown',updated_at=now()
      where connection_id=${id} and state='sending' returning outbound_id,business_id`;
  for (const row of abandoned) await repo.recordRuntimeEvent(row.business_id, {
    code: 'whatsapp.delivery_unknown', outcome: 'failure', source: 'whatsapp-manager',
    requestId: `outbound:${row.outbound_id}`, severity: 'error',
  });
}
export async function lockWhatsAppOwnership(db: Db, id: string, token: string): Promise<boolean> {
  const rows = await db`select id from whatsapp_connections where id=${id} and ownership_token=${token} for update`;
  return rows.length > 0;
}
export function heartbeatWhatsApp(db: Db, id: string, owner: string, now: Date, token?: string) {
  return db`update whatsapp_connections set owner_id=${owner},heartbeat_at=${now},version=version+1 where id=${id} and (${token ?? null}::uuid is null or ownership_token=${token ?? null})`;
}
export function releaseWhatsApp(db: Db, id: string, owner: string, token: string) {
  return db`update whatsapp_connections set owner_id=null,ownership_token=null,heartbeat_at=null,version=version+1 where id=${id} and owner_id=${owner} and ownership_token=${token}`;
}
export function setWhatsAppState(db: Db, id: string, state: string, now: Date, number?: string) {
  return db`update whatsapp_connections set state=${state},link_pending=case when ${state} in ('CONNECTED','LINK_REQUIRED') then false else link_pending end,linked_number=coalesce(${number ?? null},linked_number),linked_at=case when ${state}='CONNECTED' then coalesce(linked_at,${now}) else linked_at end,last_connected_at=case when ${state}='CONNECTED' then ${now} else last_connected_at end,version=version+1 where id=${id}`;
}
