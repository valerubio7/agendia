import { validSenderEvidence, emptyAgendaDialogue, type SenderEvidence, type AgendaDialogue } from "../../../domain/src/whatsapp/agenda.ts";
import type { PostgresRepositories } from "../repositories.ts";
import { AppointmentError } from "./appointments.ts";
import { sql } from "drizzle-orm";
import { whatsappAgendaDialogues, whatsappAgendaReceipts } from "../schema.ts";
import { asDbJson, execute, result, type Db } from "./shared.ts";

/** Serialize collisions across PN and LID within this specific business connection. */
export async function bindReceivedSender(db: Db, businessId: string, connectionId: string, remoteJid: string, evidence: SenderEvidence): Promise<string | null> {
  if (!validSenderEvidence(remoteJid, evidence)) return null;
  await execute(db, sql`select pg_advisory_xact_lock(hashtextextended(${`sender:${businessId}:${connectionId}`},0))`);
  const rows = await execute<{ phone: string; pn_jid: string; lid_jid: string | null }>(db, sql`
      select phone,pn_jid,lid_jid from whatsapp_sender_bindings
      where business_id=${businessId} and connection_id=${connectionId}
        and (phone=${evidence.phone} or pn_jid=${evidence.pnJid} or lid_jid=${evidence.lidJid})`);
  if (rows.some(row => row.phone !== evidence.phone || row.pn_jid !== evidence.pnJid
    || (evidence.lidJid !== null && row.lid_jid !== null && row.lid_jid !== evidence.lidJid))) return null;
  await execute(db, sql`insert into whatsapp_sender_bindings(business_id,connection_id,phone,pn_jid,lid_jid)
      values(${businessId},${connectionId},${evidence.phone},${evidence.pnJid},${evidence.lidJid})
      on conflict(business_id,connection_id,phone) do update
      set lid_jid=coalesce(whatsapp_sender_bindings.lid_jid,excluded.lid_jid)`);
  return evidence.phone;
}
export async function agendaSender(db: Db, messageId: string): Promise<string | null> {
  const [row] = await execute<{ phone: string }>(db, sql`select s.phone from whatsapp_received_senders s
      join messages m on (m.business_id,m.id,m.connection_id)=(s.business_id,s.message_id,s.connection_id)
      join whatsapp_sender_bindings b on (b.business_id,b.connection_id,b.phone)=(s.business_id,s.connection_id,s.phone)
      where s.message_id=${messageId} and m.direction='inbound'`);
  return row?.phone ?? null;
}
export async function latestAgendaActionSequence(db: Db, businessId: string, connectionId: string,
  conversationId: string, phone: string): Promise<string> {
  const [row] = await execute<{ sequence: string | null }>(db, sql`select max(m.sequence)::text as sequence
      from whatsapp_agenda_receipts r
      join messages m on (m.business_id,m.id)=(r.business_id,r.message_id)
      join whatsapp_received_senders s on (s.business_id,s.message_id)=(m.business_id,m.id)
      where m.business_id=${businessId} and m.connection_id=${connectionId} and m.conversation_id=${conversationId}
        and s.phone=${phone} and r.operation in ('confirm_quote','confirm_quote_naturally','finish_accepted_booking','collect_booking_names','cancel','notes','preference','clear_pending')`);
  return row?.sequence ?? "0";
}
export async function lockAgendaDialogue(db: Db, businessId: string, connectionId: string, phone: string): Promise<AgendaDialogue> {
  await execute(db, sql`select pg_advisory_xact_lock(hashtextextended(${`agenda:${businessId}:${connectionId}:${phone}`},0))`);
  const [row] = await execute<{ dialogue: AgendaDialogue }>(db, sql`select dialogue from whatsapp_agenda_dialogues
      where business_id=${businessId} and connection_id=${connectionId} and phone=${phone}`);
  return row?.dialogue ?? emptyAgendaDialogue();
}
export async function saveAgendaDialogue(db: Db, businessId: string, connectionId: string, phone: string, dialogue: AgendaDialogue) {
  const normalized = asDbJson(dialogue);
  await result(db.insert(whatsappAgendaDialogues).values({ businessId, connectionId, phone, dialogue: normalized })
    .onConflictDoUpdate({ target: [whatsappAgendaDialogues.businessId, whatsappAgendaDialogues.connectionId, whatsappAgendaDialogues.phone],
      set: { dialogue: normalized, updatedAt: sql`now()` } }));
}
export async function lockAgendaSource(db: Db, repo: PostgresRepositories, messageId: string) {
  await execute(db, sql`select c.id from conversations c join messages m on m.conversation_id=c.id
      where m.id=${messageId} for update of c`);
  return repo.loadAiMessage(messageId, true);
}
export async function agendaQuoteDelivered(db: Db, outboundId: string | null, connectionId: string, phone: string): Promise<boolean> {
  if (!outboundId) return false;
  const [row] = await execute(db, sql`select o.outbound_id from outbound_commands o
      join whatsapp_received_senders s on s.message_id=o.source_message_id and s.business_id=o.business_id
      where o.outbound_id=${outboundId} and o.connection_id=${connectionId} and s.phone=${phone} and o.state='sent'`);
  return !!row;
}
export async function recordAgendaReceipt(db: Db, businessId: string, messageId: string, outboundId: string | null, operation: string) {
  await result(db.insert(whatsappAgendaReceipts).values({ businessId, messageId, outboundId, operation }));
}
/** Metadata-only expression does not need an active catalog or reserve capacity. */
export async function setAgendaPreference(db: Db, repo: PostgresRepositories, businessId: string, id: string, resourceId: string | null, now: string) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const current = await repo.getAppointment(businessId, id);
  if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
  if (current.state !== "confirmed") throw new AppointmentError("STATE_LOCKED");
  if (Date.parse(now) >= current.startMs) throw new AppointmentError("STARTED_STRUCTURE_LOCKED");
  if (resourceId !== null && !(await repo.getResource(businessId, resourceId))) throw new AppointmentError("UNKNOWN_OWNED_ID");
  await execute(db, sql`update appointments set customer_resource_preference_id=${resourceId},updated_at=now()
      where business_id=${businessId} and id=${id} and state='confirmed'`);
  return { ...current, customerResourcePreference: resourceId };
}
