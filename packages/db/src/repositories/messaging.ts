import type { SenderEvidence } from "../../../domain/src/whatsapp/agenda.ts";
import type { PostgresRepositories } from "../repositories.ts";
import { replyDeadline } from "../reply-pacing.ts";
import { asDbJson, type Db } from "./shared.ts";

export async function routeSession(db: Db, session: string) {
  return (
    (
      await db<
        {
          business_id: string;
          connection_id: string;
          business_status: "active" | "suspended";
          agent_active: boolean;
        }[]
      >`select * from route_whatsapp_session(${session}::uuid)`
    )[0] ?? null
  );
}
export async function ingestInbound(db: Db, repo: PostgresRepositories, input: {
  businessId: string;
  connectionId: string;
  providerId: string;
  remoteJid: string;
  text: string | null;
  receivedAt: Date;
  classification: string;
  senderEvidence?: SenderEvidence;
}) {
  const seen = await db`insert into inbox_events(business_id,source,stable_key) values(${input.businessId},'baileys',${input.providerId}) on conflict do nothing returning id`;
  if (!seen.length) return null;
  const senderPhone = input.classification === "accepted" && input.senderEvidence
    ? await repo.bindReceivedSender(input.businessId, input.connectionId, input.remoteJid, input.senderEvidence) : null;
  const businessText = input.classification === "accepted_business";
  if (input.classification !== "accepted" && !businessText) {
    await db`insert into technical_events(business_id,component,code,severity) values(${input.businessId},'whatsapp-manager',${input.classification},'info')`;
    return { duplicate: false };
  }
  const conversation = (
    await db<
      { id: string; reply_due_at: Date | null; last_reply_at: Date | null; last_exchange_at: Date | null; accepted_at: Date }[]
    >`insert into conversations(business_id,connection_id,remote_jid) values(${input.businessId},${input.connectionId},${input.remoteJid}) on conflict(business_id,connection_id,remote_jid) do update set remote_jid=excluded.remote_jid returning id,reply_due_at,last_reply_at,last_exchange_at,clock_timestamp() accepted_at`
  )[0]!;
  // The upsert holds the conversation lock, shared with generation save,
  // outbound claim and confirmation. Recheck echo identity after that lock.
  // Identity outlives delivery state: even a late echo after a terminal
  // failure must not masquerade as manual input and cancel fresh work.
  if (businessText) {
    const echo = await db`select outbound_id from outbound_commands where business_id=${input.businessId} and connection_id=${input.connectionId} and conversation_id=${conversation.id} and (outbound_id::text=${input.providerId} or provider_message_id=${input.providerId})`;
    const persisted = await db`select id from messages where business_id=${input.businessId} and connection_id=${input.connectionId} and provider_message_id=${input.providerId} and direction='outbound'`;
    if (echo.length || persisted.length) return { duplicate: false, generatedEcho: true };
  }
  const sequence = Number(
    (
      await db<
        { sequence: string }[]
      >`update conversations set next_sequence=next_sequence+1 where id=${conversation.id} returning next_sequence-1 sequence`
    )[0]!.sequence,
  );
  if (businessText) {
    await db`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at,processing_state) values(${input.businessId},${conversation.id},${input.connectionId},${input.providerId},${sequence},'outbound',${input.text!},${input.receivedAt},'sent')`;
    await db`update conversations set latest_inbound_id=null,reply_due_at=null,last_reply_at=${conversation.accepted_at},last_exchange_at=${conversation.accepted_at} where id=${conversation.id}`;
    await db`update messages set processing_state='superseded' where conversation_id=${conversation.id} and direction='inbound' and processing_state in ('pending','generated') and not exists(select 1 from outbound_commands o where o.source_message_id=messages.id and o.state in ('sending','sent','delivery_unknown'))`;
    await db`update outbound_commands set state='failed',failure_code='manual_reply',updated_at=now() where conversation_id=${conversation.id} and state='generated'`;
    await db`update outbox_events set published_at=now() where topic='ai.generate' and published_at is null and payload->>'messageId' in (select id::text from messages where conversation_id=${conversation.id} and processing_state='superseded')`;
    return { duplicate: false, sequence };
  }
  const message = (
    await db<
      { id: string }[]
    >`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at) values(${input.businessId},${conversation.id},${input.connectionId},${input.providerId},${sequence},'inbound',${input.text!},${input.receivedAt}) returning id`
  )[0]!;
  if (senderPhone) await db`insert into whatsapp_received_senders(business_id,message_id,connection_id,phone)
      values(${input.businessId},${message.id},${input.connectionId},${senderPhone})`;
  const policy = await repo.globalReplyPacing();
  const due = replyDeadline(conversation.accepted_at, conversation.last_reply_at, conversation.last_exchange_at, conversation.reply_due_at, policy);
  await db`update conversations set latest_inbound_id=${message.id},reply_due_at=${due},last_exchange_at=${conversation.accepted_at} where id=${conversation.id}`;
  await db`update messages set processing_state='superseded' where conversation_id=${conversation.id} and direction='inbound' and id<>${message.id} and processing_state in ('pending','generated')`;
  await db`update outbound_commands set state='failed',failure_code='superseded',updated_at=now() where conversation_id=${conversation.id} and state='generated'`;
  await db`update outbox_events set published_at=now() where topic='ai.generate' and published_at is null and payload->>'messageId' in (select id::text from messages where conversation_id=${conversation.id} and processing_state='superseded')`;
  await db`insert into outbox_events(business_id,topic,stable_key,payload,next_attempt_at) values(${input.businessId},'ai.generate',${`ai:${input.providerId}`},${db.json({ businessId: input.businessId, messageId: message.id })},${due}) on conflict do nothing`;
  return { duplicate: false, messageId: message.id, sequence };
}
export async function loadAiMessage(db: Db, messageId: string, requireDue = false) {
  const message = (
    await db<
      {
        id: string;
        business_id: string;
        sequence: string;
        conversation_id: string;
        connection_id: string;
        raw_text: string;
      }[]
    >`select m.id,m.business_id,m.sequence,m.conversation_id,m.connection_id,m.raw_text from messages m join conversations c on c.id=m.conversation_id and c.business_id=m.business_id join businesses b on b.id=m.business_id join agent_configs a on a.business_id=b.id join whatsapp_connections w on w.id=m.connection_id where m.id=${messageId} and m.direction='inbound' and m.processing_state='pending' and c.latest_inbound_id=m.id and (not ${requireDue} or c.reply_due_at<=now()) and b.status='active' and a.active and w.state='CONNECTED'`
  )[0];
  if (!message) return null;
  const profile =
    (
      await db<
        Record<string, string>[]
      >`select display_name,description,address from business_profiles limit 1`
    )[0] ?? {};
  const agent =
    (
      await db<
        Record<string, string>[]
      >`select style,business_instructions from agent_configs limit 1`
    )[0] ?? {};
  const turns = await db<
    {
      id: string;
      sequence: string;
      direction: "inbound" | "outbound";
      raw_text: string;
      processing_state: string;
      closes_group: boolean;
    }[]
  >`select m.id,m.sequence,m.direction,m.raw_text,m.processing_state,
      case when m.direction='inbound' then m.processing_state='ai_failed' or exists(
        select 1 from outbound_commands o where o.business_id=m.business_id
        and o.connection_id=m.connection_id and o.conversation_id=m.conversation_id
        and o.source_message_id=m.id and o.send_started_at is not null)
      else m.processing_state='sent' and not exists(
        select 1 from outbound_commands o where o.business_id=m.business_id
        and o.connection_id=m.connection_id and o.conversation_id=m.conversation_id
        and (o.provider_message_id=m.provider_message_id or o.outbound_id::text=m.provider_message_id
          or (o.source_message_id is null and o.send_started_at is not null and o.provider_message_id is null)))
      end closes_group
      from messages m where m.business_id=${message.business_id}
      and m.connection_id=${message.connection_id} and m.conversation_id=${message.conversation_id} order by m.sequence`;
  // Claimed output closes at its inbound source, never its delayed sent row.
  // Unknown-source legacy output cannot prove a boundary; unknown delivery
  // identity also prevents guessing that a sent row was a manual reply.
  const closedThrough = turns.reduce((closed, turn) => turn.closes_group && Number(turn.sequence) < Number(message.sequence)
    ? Math.max(closed, Number(turn.sequence)) : closed, 0);
  const currentGroup = turns.filter((turn) => turn.direction === 'inbound'
    && Number(turn.sequence) > closedThrough && Number(turn.sequence) <= Number(message.sequence));
  const summaries = await db<
    { version: number; covered_through: string; structured_summary: any }[]
  >`select version,covered_through,structured_summary from conversation_summaries where conversation_id=${message.conversation_id} and covered_through<=(select coalesce(max(sequence),0) from messages where conversation_id=${message.conversation_id}) order by covered_through desc,version desc`;
  return { ...message, profile, agent, turns, summaries, currentGroup };
}
export async function loadSummarySource(db: Db, conversationId: string, coveredThrough: number) {
  const exists = (
    await db<
      { id: string }[]
    >`select id from conversations where id=${conversationId}`
  )[0];
  if (!exists) return null;
  const turns = await db<
    {
      sequence: string;
      direction: "inbound" | "outbound";
      raw_text: string;
      processing_state: string;
    }[]
  >`select sequence,direction,raw_text,processing_state from messages where conversation_id=${conversationId} and sequence<=${coveredThrough} order by sequence`;
  const summaries = await db<
    { version: number; covered_through: string; structured_summary: any }[]
  >`select version,covered_through,structured_summary from conversation_summaries where conversation_id=${conversationId} and covered_through<=${coveredThrough} order by covered_through desc,version desc`;
  return { turns, summaries };
}
export async function saveConversationSummary(
  db: Db,
  conversationId: string,
  expectedVersion: number,
  coveredThrough: number,
  summary: unknown,
) {
  await db`select pg_advisory_xact_lock(hashtextextended(${"summary:" + conversationId},0))`;
  return Boolean(
    (
      await db`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) select current_setting('app.tenant_id')::uuid,${conversationId},${expectedVersion + 1},${coveredThrough},${db.json(asDbJson(summary))} where ${coveredThrough}>(select coalesce(max(covered_through),0) from conversation_summaries where conversation_id=${conversationId}) and ${expectedVersion}=(select coalesce(max(version),0) from conversation_summaries where conversation_id=${conversationId}) and ${coveredThrough}<=(select coalesce(max(sequence),0) from messages where conversation_id=${conversationId}) on conflict do nothing returning id`
    ).length,
  );
}
export function recordSummaryFailure(db: Db, businessId: string) {
  return db`insert into technical_events(business_id,component,code,severity) values(${businessId},'message-worker','ai.summary_failed','error')`;
}
export async function failAi(db: Db, repo: PostgresRepositories, messageId: string, businessId: string, code: string) {
  await db`select c.id from conversations c join messages m on m.conversation_id=c.id where m.id=${messageId} for update of c`;
  const changed = await db`update messages set processing_state='ai_failed' where id=${messageId} and processing_state='pending'`;
  if (!changed.count) return;
  await db`update conversations set reply_due_at=null where latest_inbound_id=${messageId}`;
  await db`insert into technical_events(business_id,component,code,severity) values(${businessId},'message-worker',${code},'error')`;
  await repo.appendAudit(businessId, {
    eventType: "ai.failed",
    outcome: "failure",
    eventHash: "f".repeat(64),
  });
}
export async function saveGenerated(db: Db, messageId: string, businessId: string, text: string) {
  await db`select c.id from conversations c join messages m on m.conversation_id=c.id where m.id=${messageId} for update of c`;
  const source = (
    await db<
      { conversation_id: string; connection_id: string }[]
    >`update messages set processing_state='generated' where id=${messageId} and processing_state='pending' and exists(select 1 from conversations c where c.id=messages.conversation_id and c.latest_inbound_id=messages.id and c.reply_due_at<=now()) returning conversation_id,connection_id`
  )[0];
  if (!source) return null;
  return (
    (
      await db<
        { outbound_id: string }[]
      >`insert into outbound_commands(business_id,conversation_id,connection_id,source_message_id,text,state) values(${businessId},${source.conversation_id},${source.connection_id},${messageId},${text},'generated') on conflict(source_message_id) where source_message_id is not null do nothing returning outbound_id`
    )[0] ?? null
  );
}
export async function claimOwnedOutbound(db: Db, owner: string, ownership: string[]) {
  return (
    (
      await db<
        {
          outbound_id: string;
          business_id: string;
          conversation_id: string;
          connection_id: string;
          remote_jid: string;
          text: string;
          ownership_token: string;
        }[]
      >`select * from claim_owned_outbound(${owner},${ownership})`
    )[0] ?? null
  );
}
export async function finishOutbound(
  db: Db,
  repo: PostgresRepositories,
  id: string,
  state: "sent" | "failed" | "delivery_unknown",
  providerId: string | undefined,
  ownership: string,
) {
  await db`select c.id from conversations c join outbound_commands o on o.conversation_id=c.id where o.outbound_id=${id} for update of c`;
  const [connection] = await db`select w.id from whatsapp_connections w join outbound_commands o
      on o.connection_id=w.id and o.business_id=w.business_id where o.outbound_id=${id} for update of w`;
  if (!connection || !await repo.lockWhatsAppOwnership(connection.id, ownership)) return false;
  const row = (
    await db<
      {
        business_id: string;
        conversation_id: string;
        connection_id: string;
        text: string;
      }[]
    >`update outbound_commands set state=${state},provider_message_id=${providerId ?? null},acknowledged_at=case when ${state}='sent' then now() end,failure_code=case when ${state}='sent' then null else ${state} end,updated_at=now() where outbound_id=${id} and state='sending' and ownership_token=${ownership} returning business_id,conversation_id,connection_id,text`
  )[0];
  if (!row) return false;
  const code =
    state === "sent"
      ? "whatsapp.outbound.acknowledged"
      : state === "failed"
        ? "whatsapp.send_failed"
        : "whatsapp.delivery_unknown";
  if (state === "sent")
    await db`insert into technical_events(business_id,component,code,severity,safe_details) values(${row.business_id},'whatsapp-manager',${code},'info','{}')`;
  else
    await repo.recordRuntimeEvent(row.business_id, {
      code,
      outcome: "failure",
      source: "whatsapp-manager",
      requestId: `outbound:${id}`,
      severity: "error",
    });
  if (state === "sent") {
    const seq = (
      await db<
        { sequence: string }[]
      >`update conversations set next_sequence=next_sequence+1,last_reply_at=date_trunc('milliseconds',clock_timestamp()),last_exchange_at=date_trunc('milliseconds',clock_timestamp()) where id=${row.conversation_id} returning next_sequence-1 sequence`
    )[0]!.sequence;
    await db`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at,processing_state) values(${row.business_id},${row.conversation_id},${row.connection_id},${providerId!},${seq},'outbound',${row.text},now(),'sent') on conflict do nothing`;
  }
  return true;
}
