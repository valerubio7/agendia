import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { TenantContext } from "./tenant-context.ts";

export type SealedLinkCode = {
  businessId: string;
  connectionId: string;
  token: string;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
};
const linkAad = (businessId: string, connectionId: string, token: string) =>
  Buffer.from(`agendia-link:${businessId}:${connectionId}:${token}`);
export function linkCodeKeyFromEnv(env: Record<string, string | undefined>) {
  const encoded = env.WHATSAPP_LINK_CODE_KEY,
    key = encoded && Buffer.from(encoded, "base64");
  if (!key || key.length !== 32)
    throw new Error("WHATSAPP_LINK_CODE_KEY must contain 32 bytes");
  return key;
}
export function sealLinkCode(
  key: Buffer,
  businessId: string,
  connectionId: string,
  token: string,
  value: string,
): SealedLinkCode {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(linkAad(businessId, connectionId, token));
  return {
    businessId,
    connectionId,
    token,
    nonce,
    ciphertext: Buffer.concat([cipher.update(value, "utf8"), cipher.final()]),
    tag: cipher.getAuthTag(),
  };
}
export function openLinkCode(key: Buffer, value: SealedLinkCode) {
  const decipher = createDecipheriv("aes-256-gcm", key, value.nonce);
  decipher.setAAD(linkAad(value.businessId, value.connectionId, value.token));
  decipher.setAuthTag(value.tag);
  return Buffer.concat([
    decipher.update(value.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

type Db = Sql | TransactionSql;
type DbJson = Parameters<Sql["json"]>[0];
function asDbJson(value: unknown): DbJson {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON serializable");
    return JSON.parse(encoded) as DbJson;
  } catch {
    throw new Error("Value must be JSON serializable");
  }
}
export type RuntimeRole =
  | "agendia_runtime"
  | "agendia_admin_runtime"
  | "agendia_whatsapp_runtime"
  | "agendia_worker_runtime";
export type SafeRuntimeEvent = {
  code: string;
  outcome: "success" | "failure" | "denied";
  source: "api" | "whatsapp-manager";
  actorId?: string;
  requestId: string;
  severity?: "info" | "warning" | "error" | "critical";
};

export class PostgresRepositories {
  constructor(private readonly db: Db) {}
  saveBusiness(row: { id: string; name: string }) {
    return this
      .db`insert into businesses (id,name) values (${row.id},${row.name}) on conflict (id) do update set name=excluded.name`;
  }
  saveIdentity(row: {
    email: string;
    passwordPhc: string;
    businessId: string;
  }) {
    return this
      .db`insert into auth_identities (normalized_email,password_phc,role,business_id) values (${row.email},${row.passwordPhc},'business_user',${row.businessId})`;
  }
  async findIdentity(email: string) {
    return (
      (
        await this.db<
          { business_id: string }[]
        >`select business_id from auth_identities where normalized_email=${email}`
      )[0] ?? null
    );
  }
  async authIdentity(email: string) {
    return (
      (
        await this.db<
          {
            id: string;
            password_phc: string;
            role: "platform_admin" | "business_user";
            business_id: string | null;
            active: boolean;
            business_status: string | null;
          }[]
        >`select i.id,i.password_phc,i.role,i.business_id,i.active,b.status business_status from auth_identities i left join businesses b on b.id=i.business_id where normalized_email=${email}`
      )[0] ?? null
    );
  }
  createSession(row: {
    identityId: string;
    tokenHash: string;
    csrfHash: string;
    absolute: Date;
    idle: Date;
  }) {
    return this
      .db`insert into web_sessions(identity_id,token_sha256,csrf_sha256,absolute_expires_at,idle_expires_at) values(${row.identityId},${row.tokenHash},${row.csrfHash},${row.absolute},${row.idle})`;
  }
  async session(tokenHash: string) {
    return (
      (
        await this.db<
          {
            session_id: string;
            identity_id: string;
            role: "platform_admin" | "business_user";
            business_id: string | null;
            csrf_sha256: string;
          }[]
        >`select s.id session_id,i.id identity_id,i.role,i.business_id,s.csrf_sha256 from web_sessions s join auth_identities i on i.id=s.identity_id left join businesses b on b.id=i.business_id where s.token_sha256=${tokenHash} and s.revoked_at is null and s.absolute_expires_at>now() and s.idle_expires_at>now() and i.active and (i.role='platform_admin' or b.status='active')`
      )[0] ?? null
    );
  }
  touchSession(id: string, idle: Date) {
    return this
      .db`update web_sessions set last_seen_at=now(),idle_expires_at=least(absolute_expires_at,${idle}) where id=${id}`;
  }
  revokeSession(tokenHash: string) {
    return this
      .db`update web_sessions set revoked_at=now() where token_sha256=${tokenHash} and revoked_at is null`;
  }
  appendRuntimeAudit(businessId: string | null, event: SafeRuntimeEvent) {
    return this
      .db`select append_runtime_audit(${businessId},${event.code},${event.outcome},${event.source},${event.actorId ?? null},${event.requestId})`;
  }
  async recordRuntimeEvent(businessId: string, event: SafeRuntimeEvent) {
    if (event.severity)
      await this
        .db`insert into technical_events(business_id,component,code,severity,safe_details) values(${businessId},${event.source},${event.code},${event.severity},'{}')`;
    await this.appendRuntimeAudit(businessId, event);
  }
  async createBusinessUser(row: {
    id: string;
    name: string;
    email: string;
    passwordPhc: string;
  }) {
    await this.saveBusiness(row);
    await this.saveIdentity({
      email: row.email,
      passwordPhc: row.passwordPhc,
      businessId: row.id,
    });
  }
  renameBusiness(id: string, name: string) {
    return this
      .db`update businesses set name=${name} where id=${id} returning id`;
  }
  async setBusinessStatus(id: string, status: string) {
    const changed = await this
      .db`update businesses set status=${status} where id=${id} returning id`;
    if (!changed.length) return false;
    await this
      .db`update auth_identities set active=${status === "active"} where business_id=${id}`;
    if (status === "suspended")
      await this
        .db`update web_sessions set revoked_at=now() where identity_id in(select id from auth_identities where business_id=${id}) and revoked_at is null`;
    return true;
  }
  async replaceBusinessPassword(id: string, passwordPhc: string) {
    const rows = await this.db<
      { id: string }[]
    >`update auth_identities set password_phc=${passwordPhc} where business_id=${id} and role='business_user' returning id`;
    if (rows[0])
      await this
        .db`update web_sessions set revoked_at=now() where identity_id=${rows[0].id} and revoked_at is null`;
    return Boolean(rows[0]);
  }
  listBusinesses() {
    return this
      .db`select id,name,status,created_at "createdAt",last_technical_activity_at "lastTechnicalActivityAt",assistant_status "assistantStatus",whatsapp_status "whatsappStatus" from admin_business_status order by created_at`;
  }
  async business(id: string) {
    return (
      (
        await this
          .db`select id,name,status,created_at "createdAt",last_technical_activity_at "lastTechnicalActivityAt" from businesses where id=${id}`
      )[0] ?? null
    );
  }
  saveProfile(businessId: string, displayName: string) {
    return this
      .db`insert into business_profiles (business_id,display_name) values (${businessId},${displayName}) on conflict (business_id) do update set display_name=excluded.display_name,updated_at=now()`;
  }
  async profile() {
    return (
      (
        await this
          .db`select display_name "displayName",description,address,contact,business_hours "businessHours",offerings,faq,policies,additional_info "additionalInfo" from business_profiles limit 1`
      )[0] ?? null
    );
  }
  saveFullProfile(businessId: string, p: Record<string, string>) {
    return this
      .db`insert into business_profiles(business_id,display_name,description,address,contact,business_hours,offerings,faq,policies,additional_info) values(${businessId},${p.displayName!},${p.description!},${p.address!},${p.contact!},${p.businessHours!},${p.offerings!},${p.faq!},${p.policies!},${p.additionalInfo!}) on conflict(business_id) do update set display_name=excluded.display_name,description=excluded.description,address=excluded.address,contact=excluded.contact,business_hours=excluded.business_hours,offerings=excluded.offerings,faq=excluded.faq,policies=excluded.policies,additional_info=excluded.additional_info,updated_at=now()`;
  }
  saveAssistant(businessId: string, active: boolean) {
    return this
      .db`insert into assistant_configs (business_id,active) values (${businessId},${active}) on conflict (business_id) do update set active=excluded.active,revision=assistant_configs.revision+1,updated_at=now()`;
  }
  async assistant() {
    return (
      (
        await this
          .db`select personality,tone,instructions,knowledge,rules,restrictions,active,revision from assistant_configs limit 1`
      )[0] ?? null
    );
  }
  async saveFullAssistant(
    businessId: string,
    p: Record<string, unknown>,
    expected: number,
  ) {
    return (
      (
        await this
          .db`insert into assistant_configs(business_id,personality,tone,instructions,knowledge,rules,restrictions,active,revision) values(${businessId},${p.personality as string},${p.tone as string},${p.instructions as string},${p.knowledge as string},${p.rules as string},${p.restrictions as string},${p.active as boolean},1) on conflict(business_id) do update set personality=excluded.personality,tone=excluded.tone,instructions=excluded.instructions,knowledge=excluded.knowledge,rules=excluded.rules,restrictions=excluded.restrictions,active=excluded.active,revision=assistant_configs.revision+1,updated_at=now() where assistant_configs.revision=${expected} returning personality,tone,instructions,knowledge,rules,restrictions,active,revision`
      )[0] ?? null
    );
  }
  async whatsapp() {
    return (
      (
        await this
          .db`select id,lower(state) status,linked_number "linkedNumber",linked_at "linkedAt",last_connected_at "lastConnectedAt" from whatsapp_connections limit 1`
      )[0] ?? null
    );
  }
  saveConnection(id: string, businessId: string) {
    return this
      .db`insert into whatsapp_connections (id,business_id) values (${id},${businessId}) on conflict(business_id) do nothing`;
  }
  async connection() {
    return (
      (
        await this.db<
          { id: string; sessionPublicId: string }[]
        >`select id,session_public_id "sessionPublicId" from whatsapp_connections limit 1`
      )[0] ?? null
    );
  }
  replaceLinkCode(id: string, value: SealedLinkCode, expiresAt: Date) {
    return this
      .db`insert into whatsapp_link_codes(connection_id,business_id,token,ciphertext,nonce,auth_tag,expires_at) values(${id},${value.businessId},${value.token},${value.ciphertext},${value.nonce},${value.tag},${expiresAt}) on conflict(connection_id) do update set token=excluded.token,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,expires_at=excluded.expires_at,created_at=now()`;
  }
  async currentLinkCode(now: Date) {
    await this.db`delete from whatsapp_link_codes where expires_at<=${now}`;
    return (
      (
        await this.db<
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
  invalidateLinkCode(id: string, token: string) {
    return this
      .db`delete from whatsapp_link_codes where connection_id=${id} and token=${token}`;
  }
  clearLinkCode(id: string) {
    return this.db`delete from whatsapp_link_codes where connection_id=${id}`;
  }
  async clearWhatsAppAuth(id: string) {
    await this.db`delete from whatsapp_auth_records where connection_id=${id}`;
    await this
      .db`update whatsapp_connections set wrapped_dek=null,wrapped_dek_nonce=null,wrapped_dek_tag=null,kek_version=null where id=${id}`;
  }
  async authEnvelope(id: string) {
    return (
      await this.db<
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
  saveAuthEnvelope(
    id: string,
    value: { ciphertext: Buffer; iv: Buffer; tag: Buffer; kekVersion: string },
  ) {
    return this
      .db`update whatsapp_connections set wrapped_dek=${value.ciphertext},wrapped_dek_nonce=${value.iv},wrapped_dek_tag=${value.tag},kek_version=${value.kekVersion} where id=${id}`;
  }
  async authRecord(id: string, name: string) {
    return (
      await this.db<
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
  async saveAuthRecord(value: {
    businessId: string;
    connectionId: string;
    name: string;
    version: number;
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  }) {
    const rows = await this
      .db`insert into whatsapp_auth_records(business_id,connection_id,record_name,version,ciphertext,nonce,auth_tag) values(${value.businessId},${value.connectionId},${value.name},${value.version},${value.ciphertext},${value.iv},${value.tag}) on conflict(business_id,connection_id,record_name) do update set version=excluded.version,ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag where whatsapp_auth_records.version=excluded.version-1 returning version`;
    if (!rows.length) throw new Error("authentication record version conflict");
  }
  async claimWhatsAppLink() {
    return (
      (
        await this.db<
          { command_id: string; business_id: string }[]
        >`select * from claim_whatsapp_link_command()`
      )[0] ?? null
    );
  }
  restorableWhatsApp() {
    return this.db<
      { id: string; business_id: string }[]
    >`select * from restorable_whatsapp_connections()`;
  }
  heartbeatWhatsApp(id: string, owner: string, now: Date) {
    return this
      .db`update whatsapp_connections set owner_id=${owner},heartbeat_at=${now},version=version+1 where id=${id}`;
  }
  releaseWhatsApp(id: string, owner: string) {
    return this
      .db`update whatsapp_connections set owner_id=null,heartbeat_at=null,version=version+1 where id=${id} and owner_id=${owner}`;
  }
  setWhatsAppState(id: string, state: string, now: Date, number?: string) {
    return this
      .db`update whatsapp_connections set state=${state},linked_number=coalesce(${number ?? null},linked_number),linked_at=case when ${state}='CONNECTED' then coalesce(linked_at,${now}) else linked_at end,last_connected_at=case when ${state}='CONNECTED' then ${now} else last_connected_at end,version=version+1 where id=${id}`;
  }
  async routeSession(session: string) {
    return (
      (
        await this.db<
          {
            business_id: string;
            connection_id: string;
            business_status: "active" | "suspended";
            assistant_active: boolean;
          }[]
        >`select * from route_whatsapp_session(${session}::uuid)`
      )[0] ?? null
    );
  }
  async ingestInbound(input: {
    businessId: string;
    connectionId: string;
    providerId: string;
    remoteJid: string;
    text: string | null;
    receivedAt: Date;
    classification: string;
  }) {
    const seen = await this
      .db`insert into inbox_events(business_id,source,stable_key) values(${input.businessId},'baileys',${input.providerId}) on conflict do nothing returning id`;
    if (!seen.length) return null;
    if (input.classification !== "accepted") {
      await this
        .db`insert into technical_events(business_id,component,code,severity) values(${input.businessId},'whatsapp-manager',${input.classification},'info')`;
      return { duplicate: false };
    }
    const conversation = (
      await this.db<
        { id: string }[]
      >`insert into conversations(business_id,connection_id,remote_jid) values(${input.businessId},${input.connectionId},${input.remoteJid}) on conflict(business_id,connection_id,remote_jid) do update set remote_jid=excluded.remote_jid returning id`
    )[0]!;
    const sequence = Number(
      (
        await this.db<
          { sequence: string }[]
        >`update conversations set next_sequence=next_sequence+1 where id=${conversation.id} returning next_sequence-1 sequence`
      )[0]!.sequence,
    );
    const message = (
      await this.db<
        { id: string }[]
      >`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at) values(${input.businessId},${conversation.id},${input.connectionId},${input.providerId},${sequence},'inbound',${input.text!},${input.receivedAt}) returning id`
    )[0]!;
    await this.enqueueOutbox(
      input.businessId,
      "ai.generate",
      `ai:${input.providerId}`,
      { businessId: input.businessId, messageId: message.id },
    );
    return { duplicate: false, messageId: message.id, sequence };
  }
  async loadAiMessage(messageId: string) {
    const message = (
      await this.db<
        {
          id: string;
          conversation_id: string;
          connection_id: string;
          raw_text: string;
        }[]
      >`select m.id,m.conversation_id,m.connection_id,m.raw_text from messages m join businesses b on b.id=m.business_id join assistant_configs a on a.business_id=b.id join whatsapp_connections w on w.id=m.connection_id where m.id=${messageId} and m.direction='inbound' and m.processing_state='pending' and b.status='active' and a.active and w.state='CONNECTED'`
    )[0];
    if (!message) return null;
    const profile =
      (
        await this.db<
          Record<string, string>[]
        >`select display_name,description,address,contact,business_hours,offerings,faq,policies,additional_info from business_profiles limit 1`
      )[0] ?? {};
    const assistant =
      (
        await this.db<
          Record<string, string>[]
        >`select personality,tone,instructions,knowledge,rules,restrictions from assistant_configs limit 1`
      )[0] ?? {};
    const turns = await this.db<
      {
        sequence: string;
        direction: "inbound" | "outbound";
        raw_text: string;
        processing_state: string;
      }[]
    >`select sequence,direction,raw_text,processing_state from messages where conversation_id=${message.conversation_id} order by sequence`;
    const summaries = await this.db<
      { version: number; covered_through: string; structured_summary: any }[]
    >`select version,covered_through,structured_summary from conversation_summaries where conversation_id=${message.conversation_id} and covered_through<=(select coalesce(max(sequence),0) from messages where conversation_id=${message.conversation_id}) order by covered_through desc,version desc`;
    return { ...message, profile, assistant, turns, summaries };
  }
  async loadSummarySource(conversationId: string, coveredThrough: number) {
    const exists = (
      await this.db<
        { id: string }[]
      >`select id from conversations where id=${conversationId}`
    )[0];
    if (!exists) return null;
    const turns = await this.db<
      {
        sequence: string;
        direction: "inbound" | "outbound";
        raw_text: string;
        processing_state: string;
      }[]
    >`select sequence,direction,raw_text,processing_state from messages where conversation_id=${conversationId} and sequence<=${coveredThrough} order by sequence`;
    const summaries = await this.db<
      { version: number; covered_through: string; structured_summary: any }[]
    >`select version,covered_through,structured_summary from conversation_summaries where conversation_id=${conversationId} and covered_through<=${coveredThrough} order by covered_through desc,version desc`;
    return { turns, summaries };
  }
  async saveConversationSummary(
    conversationId: string,
    expectedVersion: number,
    coveredThrough: number,
    summary: unknown,
  ) {
    await this
      .db`select pg_advisory_xact_lock(hashtextextended(${"summary:" + conversationId},0))`;
    return Boolean(
      (
        await this
          .db`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) select current_setting('app.tenant_id')::uuid,${conversationId},${expectedVersion + 1},${coveredThrough},${this.db.json(asDbJson(summary))} where ${coveredThrough}>(select coalesce(max(covered_through),0) from conversation_summaries where conversation_id=${conversationId}) and ${expectedVersion}=(select coalesce(max(version),0) from conversation_summaries where conversation_id=${conversationId}) and ${coveredThrough}<=(select coalesce(max(sequence),0) from messages where conversation_id=${conversationId}) on conflict do nothing returning id`
      ).length,
    );
  }
  recordSummaryFailure(businessId: string) {
    return this
      .db`insert into technical_events(business_id,component,code,severity) values(${businessId},'message-worker','ai.summary_failed','error')`;
  }
  async failAi(messageId: string, businessId: string, code: string) {
    await this
      .db`update messages set processing_state='ai_failed' where id=${messageId}`;
    await this
      .db`insert into technical_events(business_id,component,code,severity) values(${businessId},'message-worker',${code},'error')`;
    await this.appendAudit(businessId, {
      eventType: "ai.failed",
      outcome: "failure",
      eventHash: "f".repeat(64),
    });
  }
  async saveGenerated(messageId: string, businessId: string, text: string) {
    const source = (
      await this.db<
        { conversation_id: string; connection_id: string }[]
      >`update messages set processing_state='generated' where id=${messageId} and processing_state='pending' returning conversation_id,connection_id`
    )[0];
    if (!source) return null;
    return (
      (
        await this.db<
          { outbound_id: string }[]
        >`insert into outbound_commands(business_id,conversation_id,connection_id,source_message_id,text,state) values(${businessId},${source.conversation_id},${source.connection_id},${messageId},${text},'generated') on conflict(source_message_id) where source_message_id is not null do nothing returning outbound_id`
      )[0] ?? null
    );
  }
  async claimOwnedOutbound(owner: string) {
    return (
      (
        await this.db<
          {
            outbound_id: string;
            business_id: string;
            conversation_id: string;
            connection_id: string;
            remote_jid: string;
            text: string;
          }[]
        >`select * from claim_owned_outbound(${owner})`
      )[0] ?? null
    );
  }
  async finishOutbound(
    id: string,
    state: "sent" | "failed" | "delivery_unknown",
    providerId?: string,
  ) {
    const row = (
      await this.db<
        {
          business_id: string;
          conversation_id: string;
          connection_id: string;
          text: string;
        }[]
      >`update outbound_commands set state=${state},provider_message_id=${providerId ?? null},acknowledged_at=case when ${state}='sent' then now() end,failure_code=case when ${state}='sent' then null else ${state} end,updated_at=now() where outbound_id=${id} and state='sending' returning business_id,conversation_id,connection_id,text`
    )[0];
    if (!row) return false;
    const code =
      state === "sent"
        ? "whatsapp.outbound.acknowledged"
        : state === "failed"
          ? "whatsapp.send_failed"
          : "whatsapp.delivery_unknown";
    if (state === "sent")
      await this
        .db`insert into technical_events(business_id,component,code,severity,safe_details) values(${row.business_id},'whatsapp-manager',${code},'info','{}')`;
    else
      await this.recordRuntimeEvent(row.business_id, {
        code,
        outcome: "failure",
        source: "whatsapp-manager",
        requestId: `outbound:${id}`,
        severity: "error",
      });
    if (state === "sent") {
      const seq = (
        await this.db<
          { sequence: string }[]
        >`update conversations set next_sequence=next_sequence+1 where id=${row.conversation_id} returning next_sequence-1 sequence`
      )[0]!.sequence;
      await this
        .db`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at,processing_state) values(${row.business_id},${row.conversation_id},${row.connection_id},${providerId!},${seq},'outbound',${row.text},now(),'sent') on conflict do nothing`;
    }
    return true;
  }
  recordInbox(businessId: string, source: string, stableKey: string) {
    return this
      .db`insert into inbox_events (business_id,source,stable_key) values (${businessId},${source},${stableKey}) on conflict do nothing`;
  }
  enqueueOutbox(
    businessId: string,
    topic: string,
    stableKey: string,
    payload: unknown,
  ) {
    return this
      .db`insert into outbox_events (business_id,topic,stable_key,payload) values (${businessId},${topic},${stableKey},${this.db.json(asDbJson(payload))}) on conflict do nothing`;
  }
  async claimOutbox() {
    return (
      (
        await this.db<
          { id: string; topic: string; stable_key: string }[]
        >`select id,topic,stable_key from outbox_events where published_at is null order by created_at for update skip locked limit 1`
      )[0] ?? null
    );
  }
  async markOutboxPublished(id: string) {
    return (
      await this
        .db`update outbox_events set published_at=now() where id=${id} and published_at is null returning id`
    ).length;
  }
  claimAiOutbox(token: string, limit: number, staleMs: number) {
    return this.db<
      {
        id: string;
        business_id: string;
        stable_key: string;
        payload: object;
        publish_attempts: number;
      }[]
    >`select * from claim_ai_outbox(${token},${limit},${staleMs})`;
  }
  async completeAiOutbox(id: string, token: string) {
    return (
      await this.db<
        { complete_ai_outbox: boolean }[]
      >`select complete_ai_outbox(${id},${token})`
    )[0]?.complete_ai_outbox
      ? 1
      : 0;
  }
  async releaseAiOutbox(id: string, token: string, delayMs: number) {
    return Boolean(
      (
        await this.db<
          { release_ai_outbox: boolean }[]
        >`select release_ai_outbox(${id},${token},${delayMs})`
      )[0]?.release_ai_outbox,
    );
  }
  async appendAudit(
    businessId: string,
    event: { eventType: string; outcome: string; eventHash: string },
  ) {
    await this
      .db`select pg_advisory_xact_lock(hashtext(${"audit:" + businessId}))`;
    const previous = (
      await this.db<
        { stream_sequence: string; event_hash: string }[]
      >`select stream_sequence,event_hash from audit_events where business_id=${businessId} order by stream_sequence desc limit 1`
    )[0];
    return this
      .db`insert into audit_events (business_id,actor_id,event_type,outcome,request_id,stream_sequence,previous_hash,event_hash,hmac_key_version) values (${businessId},current_setting('app.actor_id',true),${event.eventType},${event.outcome},current_setting('app.request_id',true),${Number(previous?.stream_sequence ?? 0) + 1},${previous?.event_hash ?? "GENESIS"},${event.eventHash},'runtime-v1')`;
  }
  async auditCount() {
    return Number(
      (
        await this.db<
          { count: string }[]
        >`select count(*) count from audit_events`
      )[0]?.count ?? 0,
    );
  }
  async tenantSnapshot() {
    const profile = (
      await this.db<
        { display_name: string }[]
      >`select display_name from business_profiles limit 1`
    )[0];
    const assistant = (
      await this.db<
        { active: boolean }[]
      >`select active from assistant_configs limit 1`
    )[0];
    const inbox = Number(
      (
        await this.db<
          { count: string }[]
        >`select count(*) count from inbox_events`
      )[0]?.count ?? 0,
    );
    const outbox = Number(
      (
        await this.db<
          { count: string }[]
        >`select count(*) count from outbox_events`
      )[0]?.count ?? 0,
    );
    return {
      profile: profile?.display_name ?? null,
      assistantActive: assistant?.active ?? null,
      inbox,
      outbox,
    };
  }
  conversationTexts() {
    return this.db`select raw_text from messages`;
  }
  authRecordNames() {
    return this.db`select record_name from whatsapp_auth_records`;
  }
}

export class RolePool {
  constructor(
    private readonly sql: Sql,
    readonly role: RuntimeRole,
  ) {}
  run<T>(
    context: TenantContext | undefined,
    work: (repositories: PostgresRepositories) => Promise<T>,
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${this.role}`);
      if (context)
        for (const [key, value] of Object.entries({
          tenant_id: context.businessId,
          actor_role: context.role,
          actor_id: context.actorId,
          request_id: context.requestId,
        }))
          await tx`select set_config(${`app.${key}`},${value},true)`;
      return work(new PostgresRepositories(tx));
    }) as Promise<T>;
  }
  async reserveAdvisoryLock(
    key: string,
  ): Promise<(() => Promise<void>) | null> {
    const connection = await this.sql.reserve();
    await connection.unsafe(`set role ${this.role}`);
    const acquired = (
      await connection<
        { acquired: boolean }[]
      >`select pg_try_advisory_lock(hashtextextended(${key},0)) acquired`
    )[0]?.acquired;
    if (!acquired) {
      await connection.unsafe("reset role");
      connection.release();
      return null;
    }
    return async () => {
      await connection`select pg_advisory_unlock(hashtextextended(${key},0))`;
      await connection.unsafe("reset role");
      connection.release();
    };
  }
  end() {
    return this.sql.end();
  }
}

export function createRuntimePools(
  input:
    | string
    | { api: string; admin: string; manager: string; worker: string },
) {
  const url = (key: "api" | "admin" | "manager" | "worker") =>
    typeof input === "string" ? input : input[key];
  const pools = {
    api: new RolePool(postgres(url("api")), "agendia_runtime"),
    admin: new RolePool(postgres(url("admin")), "agendia_admin_runtime"),
    manager: new RolePool(postgres(url("manager")), "agendia_whatsapp_runtime"),
    worker: new RolePool(postgres(url("worker")), "agendia_worker_runtime"),
  };
  return {
    ...pools,
    end: () =>
      Promise.all(Object.values(pools).map((pool) => pool.end())).then(
        () => undefined,
      ),
  };
}
