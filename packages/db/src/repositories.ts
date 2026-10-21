import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { TransactionSql } from "postgres";
import { asDbJson, type Db } from "./repositories/shared.ts";
import * as identity from "./repositories/identity.ts";
import * as business from "./repositories/business.ts";
import * as clients from "./repositories/clients.ts";
import * as catalog from "./repositories/catalog.ts";
import * as businessCalendar from "./repositories/business-calendar.ts";
import * as appointments from "./repositories/appointments.ts";
import * as agentSettings from "./repositories/agent-settings.ts";
import { AppointmentError, type StoredAppointment, type AppointmentCreationContext, type AppointmentChangeContext,
  type AppointmentAvailabilityContext, type AppointmentAvailabilityOption } from "./repositories/appointments.ts";
export { AppointmentError } from "./repositories/appointments.ts";
export type { CreateAppointmentInput, AppointmentChangeContext, AppointmentCreationContext, ChangeAppointmentInput,
  AppointmentNotesInput, AppointmentAvailabilityContext, AppointmentAvailabilityOption, AppointmentHistoryFilter,
  StoredAppointment } from "./repositories/appointments.ts";
import type { BusinessCalendar } from "./repositories/business-calendar.ts";
export type { BusinessCalendar } from "./repositories/business-calendar.ts";
import type { ClientRegistryInput } from "./repositories/clients.ts";
import type { CatalogResource, ServiceCatalogInput, CatalogService } from "./repositories/catalog.ts";
export type { ClientRegistryInput, RegistryClient } from "./repositories/clients.ts";
export { ResourceCatalogError } from "./repositories/catalog.ts";
export type { CatalogResource, ServiceCatalogInput, CatalogService } from "./repositories/catalog.ts";
import type { TenantContext } from "./tenant-context.ts";
import { replyDeadline } from "./reply-pacing.ts";
import type { ReplyPacing } from "@agendia/domain";
import { validSenderEvidence, emptyAgendaDialogue, type SenderEvidence, type AgendaDialogue } from "../../domain/src/whatsapp/agenda.ts";
import type { AppointmentActionContext, ResourceInput,
  BusinessClosure, BusinessClosureInput, WeeklySchedule } from "@agendia/domain";

/** Acquire inside the tenant UoW BEFORE reads/guards/mutations (also when no row exists).
 * C/T05/T09 must use this same namespace. Hash collisions only serialize businesses;
 * tenant identity remains enforced by context and RLS, never by the hash.
 */
export async function acquireBusinessCalendarLock(tx: TransactionSql, context: Pick<TenantContext, "businessId">) {
  if ("begin" in tx) throw new Error("Calendar lock requires a transaction");
  const businessId = context.businessId.toLowerCase();
  const [scope] = await tx`select current_setting('app.tenant_id',true) tenant`;
  if (scope?.tenant?.toLowerCase() !== businessId) throw new Error("Calendar lock requires matching tenant context");
  await tx`select pg_advisory_xact_lock(hashtextextended(${"business-calendar:" + businessId},0))`;
}

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

export type { RuntimeRole } from "./runtime-pools.ts";
export type SafeRuntimeEvent = {
  code: string;
  outcome: "success" | "failure" | "denied";
  source: "api" | "whatsapp-manager";
  actorId?: string;
  requestId: string;
  severity?: "info" | "warning" | "error" | "critical";
};

export type AppointmentOperationRow = {
  kind: "create" | "change" | "notes" | "state"; target: string | null;
  fingerprint: string | null; state: "completed" | "failed" | "cancelled";
  result: { status: number; body: unknown } | null;
};
export class PostgresRepositories {
  constructor(private readonly db: Db) {}
  async lockAppointmentOperation(context: TenantContext, key: string, wait = true): Promise<boolean> {
    if ("begin" in this.db) throw new Error("Operation lock requires a transaction");
    const lock = `appointment-operation:${context.businessId}:${context.actorId}:${key}`;
    if (wait) { await this.db`select pg_advisory_xact_lock(hashtextextended(${lock},0))`; return true; }
    const [row] = await this.db`select pg_try_advisory_xact_lock(hashtextextended(${lock},0)) acquired`;
    return row!.acquired;
  }
  async appointmentOperation(context: TenantContext, key: string): Promise<AppointmentOperationRow | null> {
    const [row] = await this.db<AppointmentOperationRow[]>`select kind,target_id target,fingerprint,state,result
      from appointment_operation_receipts where business_id=${context.businessId} and actor_id=${context.actorId} and operation_key=${key}`;
    return row ?? null;
  }
  async recordAppointmentOperation(context: TenantContext, key: string, row: AppointmentOperationRow) {
    await this.db`insert into appointment_operation_receipts(business_id,actor_id,operation_key,kind,target_id,fingerprint,state,result)
      values(${context.businessId},${context.actorId},${key},${row.kind},${row.target},${row.fingerprint},${row.state},
        ${row.result === null ? null : this.db.json(asDbJson(row.result))})`;
  }
  appointmentOperationSavepoint<T>(work: (repo: PostgresRepositories) => Promise<T>): Promise<T> {
    if ("begin" in this.db) throw new Error("Operation savepoint requires a transaction");
    return (this.db as TransactionSql).savepoint(tx => work(new PostgresRepositories(tx))) as Promise<T>;
  }
  acquireBusinessCalendarLock(context: Pick<TenantContext, "businessId">) {
    if ("begin" in this.db) throw new Error("Calendar lock requires a transaction");
    return acquireBusinessCalendarLock(this.db as TransactionSql, context);
  }
  /** Read-only owned projection: current client identity, frozen catalog terms. */
  async getAppointment(businessId: string, id: string): Promise<StoredAppointment | null> {
    return appointments.getAppointment(this.db, businessId, id);
  }
  /** All states, exact half-open START bounds. Caller materializes local dates for UI. */
  async listAppointments(businessId: string, input: unknown = {}): Promise<StoredAppointment[]> {
    return appointments.listAppointments(this.db, businessId, input);
  }
  /** Caller establishes action facts; only notes change, including on started Confirmed bookings. */
  async setAppointmentNotes(businessId: string, id: string, input: unknown, trusted: AppointmentActionContext): Promise<StoredAppointment> {
    return appointments.setAppointmentNotes(this.db, this, businessId, id, input, trusted);
  }
  /** No automatic states/reopening. Creation origin does not establish this action's channel. */
  async transitionAppointment(businessId: string, id: string, target: unknown, trusted: AppointmentActionContext): Promise<StoredAppointment> {
    return appointments.transitionAppointment(this.db, this, businessId, id, target, trusted);
  }
  /** Caller UoW owns client + appointment + audit/outbox rollback; no messaging effects here.
   * Shared business lock precedes every lookup. SQL GiST remains the raw-writer backstop.
   * Only trusted explicit customer expression sets preference; absence defaults to null.
   */
  async createAppointment(businessId: string, input: unknown, trusted: AppointmentCreationContext): Promise<StoredAppointment> {
    return appointments.createAppointment(this.db, this, businessId, input, trusted);
  }
  /** Business-scoped advisory read, in one tenant transaction under the shared calendar lock.
   * Caller must bind the real sender/customer before supplying reschedule context (T14/T15).
   * No reservation or effects: create/change must revalidate after this transaction releases.
   */
  async listAppointmentAvailability(businessId: string, input: unknown,
    trusted: AppointmentAvailabilityContext = {}): Promise<AppointmentAvailabilityOption[]> {
    return appointments.listAppointmentAvailability(this.db, this, businessId, input, trusted);
  }
  /** Otherwise-authorized structural changes or explicit upcoming customer-preference metadata.
   * Preference-only changes do not require active catalogs/hours or promise availability;
   * they never change schedule, agreed terms, assigned resource, client, notes, state or origin.
   * Caller establishes explicit customer expression and any transport confirmation.
   * The existing T07 planner owns identity/epoch no-op, agreed-term and time policy.
   */
  async changeAppointment(businessId: string, id: string, input: unknown, trusted: AppointmentChangeContext): Promise<StoredAppointment> {
    return appointments.changeAppointment(this.db, this, businessId, id, input, trusted);
  }
  async getBusinessCalendar(businessId: string): Promise<{ weeklySchedule: WeeklySchedule | null }> {
    return businessCalendar.getBusinessCalendar(this.db, businessId);
  }
  /** Transaction required; uses the same early lock as public calendar/closure callers. */
  async saveBusinessCalendar(businessId: string, weeklySchedule: WeeklySchedule): Promise<BusinessCalendar> {
    return businessCalendar.saveBusinessCalendar(this.db, this, businessId, weeklySchedule);
  }
  async listBusinessClosures(businessId: string): Promise<BusinessClosure[]> {
    return businessCalendar.listBusinessClosures(this.db, businessId);
  }
  /** All closure mutations require the shared early calendar lock in the caller's UoW. */
  async createBusinessClosure(businessId: string, input: BusinessClosureInput): Promise<BusinessClosure> {
    return businessCalendar.createBusinessClosure(this.db, this, businessId, input);
  }
  async updateBusinessClosure(businessId: string, id: string, input: BusinessClosureInput): Promise<BusinessClosure | null> {
    return businessCalendar.updateBusinessClosure(this.db, this, businessId, id, input);
  }
  async deleteBusinessClosure(businessId: string, id: string): Promise<boolean> {
    return businessCalendar.deleteBusinessClosure(this.db, this, businessId, id);
  }
  listResources(businessId: string) {
    return catalog.listResources(this.db, businessId);
  }
  async getResource(businessId: string, id: string) {
    return catalog.getResource(this.db, businessId, id);
  }
  /** All mutations require a tenant transaction; assignments and caller audit/outbox share its rollback. */
  async createResource(businessId: string, input: ResourceInput): Promise<CatalogResource> {
    return catalog.createResource(this.db, this, businessId, input);
  }
  async updateResource(businessId: string, id: string, input: ResourceInput): Promise<CatalogResource | null> {
    return catalog.updateResource(this.db, this, businessId, id, input);
  }
  async setResourceStatus(businessId: string, id: string, status: CatalogResource["status"]): Promise<CatalogResource | null> {
    return catalog.setResourceStatus(this.db, this, businessId, id, status);
  }
  listClients(q = "") {
    return clients.listClients(this.db, q);
  }
  async getClientById(id: string) {
    return clients.getClientById(this.db, id);
  }
  // Exact stored identity only: no manual-country/type inference or aliases.
  async findClientByCanonicalPhone(phone: string) {
    return clients.findClientByCanonicalPhone(this.db, phone);
  }
  async createClient(businessId: string, input: ClientRegistryInput) {
    return clients.createClient(this.db, this, businessId, input);
  }
  async updateClient(businessId: string, id: string, input: ClientRegistryInput) {
    return clients.updateClient(this.db, this, businessId, id, input);
  }
  listServices() {
    return catalog.listServices(this.db);
  }
  async createService(businessId: string, input: ServiceCatalogInput) {
    return catalog.createService(this.db, this, businessId, input);
  }
  async updateService(businessId: string, id: string, input: ServiceCatalogInput) {
    return catalog.updateService(this.db, this, businessId, id, input);
  }
  async setServiceStatus(businessId: string, id: string, status: CatalogService["status"]) {
    return catalog.setServiceStatus(this.db, this, businessId, id, status);
  }
  /** Internal retirement only: caller UoW owns tombstone + links + audit/outbox rollback. */
  private async retireCatalogItem(businessId: string, id: string, table: "services" | "resources") {
    return catalog.retireCatalogItem(this.db, this, businessId, id, table);
  }
  deleteService(businessId: string, id: string): Promise<boolean> {
    return this.retireCatalogItem(businessId, id, "services");
  }
  deleteResource(businessId: string, id: string): Promise<boolean> {
    return this.retireCatalogItem(businessId, id, "resources");
  }
  async platformAiInstructions() {
    return agentSettings.platformAiInstructions(this.db);
  }
  async updatePlatformAiInstructions(additionalInstructions: string, replyPacing?: ReplyPacing) {
    return agentSettings.updatePlatformAiInstructions(this.db, additionalInstructions, replyPacing);
  }
  async globalReplyPacing(): Promise<ReplyPacing> {
    return agentSettings.globalReplyPacing(this.db);
  }
  saveBusiness(row: { id: string; name: string }) {
    return business.saveBusiness(this.db, row);
  }
  saveIdentity(row: {
    email: string;
    passwordPhc: string;
    businessId: string;
  }) {
    return identity.saveIdentity(this.db, row);
  }
  async findIdentity(email: string) {
    return identity.findIdentity(this.db, email);
  }
  async admitLogin(accountHash: string): Promise<boolean> {
    return identity.admitLogin(this.db, accountHash);
  }
  async authIdentity(email: string) {
    return identity.authIdentity(this.db, email);
  }
  createSession(row: {
    identityId: string;
    tokenHash: string;
    csrfHash: string;
    absolute: Date;
    idle: Date;
  }) {
    return identity.createSession(this.db, row);
  }
  async session(tokenHash: string) {
    return identity.session(this.db, tokenHash);
  }
  touchSession(id: string, idle: Date) {
    return identity.touchSession(this.db, id, idle);
  }
  revokeSession(tokenHash: string) {
    return identity.revokeSession(this.db, tokenHash);
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
    return business.createBusinessUser(this.db, this, row);
  }
  renameBusiness(id: string, name: string) {
    return business.renameBusiness(this.db, id, name);
  }
  async setBusinessStatus(id: string, status: string) {
    return business.setBusinessStatus(this.db, id, status);
  }
  async replaceBusinessPassword(id: string, passwordPhc: string) {
    return business.replaceBusinessPassword(this.db, id, passwordPhc);
  }
  listBusinesses() {
    return business.listBusinesses(this.db);
  }
  async business(id: string) {
    return business.business(this.db, id);
  }
  saveProfile(businessId: string, displayName: string) {
    return business.saveProfile(this.db, businessId, displayName);
  }
  async profile() {
    return business.profile(this.db);
  }
  saveFullProfile(businessId: string, p: Record<string, string>) {
    return business.saveFullProfile(this.db, businessId, p);
  }
  saveAssistant(businessId: string, active: boolean) {
    return agentSettings.saveAssistant(this.db, businessId, active);
  }
  async assistant() {
    return agentSettings.assistant(this.db);
  }
  async saveFullAssistant(
    businessId: string,
    p: Record<string, unknown>,
    expected: number,
  ) {
    return agentSettings.saveFullAssistant(this.db, businessId, p, expected);
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
          { id: string; sessionPublicId: string; linkCommandId: string | null; linkPending: boolean }[]
        >`select id,session_public_id "sessionPublicId",link_command_id "linkCommandId",link_pending "linkPending" from whatsapp_connections limit 1`
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
  async lockAuthConnection(businessId: string, id: string) {
    const rows = await this.db`select id from whatsapp_connections where id=${id} and business_id=${businessId} for update`;
    if (!rows.length) throw new Error("authentication connection unavailable");
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
  async saveAuthEnvelope(
    id: string,
    value: { ciphertext: Buffer; iv: Buffer; tag: Buffer; kekVersion: string },
  ) {
    const rows = await this
      .db`update whatsapp_connections set wrapped_dek=${value.ciphertext},wrapped_dek_nonce=${value.iv},wrapped_dek_tag=${value.tag},kek_version=${value.kekVersion} where id=${id} and wrapped_dek is null returning id`;
    if (!rows.length) throw new Error("authentication envelope already initialized or unavailable");
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
  async claimWhatsAppLink(token: string) {
    return (
      (
        await this.db<
          { command_id: string; business_id: string }[]
        >`select * from claim_whatsapp_link_command(${token})`
      )[0] ?? null
    );
  }
  restorableWhatsApp() {
    return this.db<
      { id: string; business_id: string }[]
    >`select * from restorable_whatsapp_connections()`;
  }
  async admitWhatsAppLink(id: string, commandId: string, claim: string): Promise<boolean> {
    const [connection] = await this.db`select id from whatsapp_connections where id=${id} for update`;
    if (!connection) return false;
    const [command] = await this.db`select o.id,o.link_admitted_at from outbox_events o
      join whatsapp_connections w on w.business_id=o.business_id
      where w.id=${id} and o.id=${commandId} and o.topic='whatsapp.link_requested'
        and o.published_at is null and o.claim_token=${claim}
        and o.claimed_at>now()-interval '30 seconds' for update of o`;
    if (!command) return false;
    if (!command.link_admitted_at) {
      await this.clearLinkCode(id);
      await this.clearWhatsAppAuth(id);
      await this.db`update whatsapp_connections set link_command_id=${commandId},link_pending=true,state='LINKING',version=version+1 where id=${id}`;
      await this.db`update outbox_events set link_admitted_at=now() where id=${commandId}`;
    }
    return true;
  }
  async completeWhatsAppLink(commandId: string, claim: string, ownership: string) {
    return (await this.db<{ completed: boolean }[]>`select complete_whatsapp_link_command(${commandId},${claim},${ownership}) completed`)[0]!.completed;
  }
  async takeOverWhatsApp(id: string, owner: string, token: string, now: Date) {
    // Match claim/finish lock ordering, then fence the old socket before reconciliation.
    await this.db`select id from conversations where connection_id=${id} order by created_at,id for update`;
    await this.db`update whatsapp_connections set owner_id=${owner},ownership_token=${token},heartbeat_at=${now},version=version+1 where id=${id}`;
    const abandoned = await this.db<{ outbound_id: string; business_id: string }[]>`
      update outbound_commands set state='delivery_unknown',failure_code='delivery_unknown',updated_at=now()
      where connection_id=${id} and state='sending' returning outbound_id,business_id`;
    for (const row of abandoned) await this.recordRuntimeEvent(row.business_id, {
      code: 'whatsapp.delivery_unknown', outcome: 'failure', source: 'whatsapp-manager',
      requestId: `outbound:${row.outbound_id}`, severity: 'error',
    });
  }
  async lockWhatsAppOwnership(id: string, token: string): Promise<boolean> {
    const rows = await this.db`select id from whatsapp_connections where id=${id} and ownership_token=${token} for update`;
    return rows.length > 0;
  }
  heartbeatWhatsApp(id: string, owner: string, now: Date, token?: string) {
    return this
      .db`update whatsapp_connections set owner_id=${owner},heartbeat_at=${now},version=version+1 where id=${id} and (${token ?? null}::uuid is null or ownership_token=${token ?? null})`;
  }
  releaseWhatsApp(id: string, owner: string, token: string) {
    return this
      .db`update whatsapp_connections set owner_id=null,ownership_token=null,heartbeat_at=null,version=version+1 where id=${id} and owner_id=${owner} and ownership_token=${token}`;
  }
  setWhatsAppState(id: string, state: string, now: Date, number?: string) {
    return this
      .db`update whatsapp_connections set state=${state},link_pending=case when ${state} in ('CONNECTED','LINK_REQUIRED') then false else link_pending end,linked_number=coalesce(${number ?? null},linked_number),linked_at=case when ${state}='CONNECTED' then coalesce(linked_at,${now}) else linked_at end,last_connected_at=case when ${state}='CONNECTED' then ${now} else last_connected_at end,version=version+1 where id=${id}`;
  }
  /** Serialize collisions across PN and LID within this specific business connection. */
  async bindReceivedSender(businessId: string, connectionId: string, remoteJid: string, evidence: SenderEvidence): Promise<string | null> {
    if (!validSenderEvidence(remoteJid, evidence)) return null;
    await this.db`select pg_advisory_xact_lock(hashtextextended(${`sender:${businessId}:${connectionId}`},0))`;
    const rows = await this.db<{ phone: string; pn_jid: string; lid_jid: string | null }[]>`
      select phone,pn_jid,lid_jid from whatsapp_sender_bindings
      where business_id=${businessId} and connection_id=${connectionId}
        and (phone=${evidence.phone} or pn_jid=${evidence.pnJid} or lid_jid=${evidence.lidJid})`;
    if (rows.some(row => row.phone !== evidence.phone || row.pn_jid !== evidence.pnJid
      || (evidence.lidJid !== null && row.lid_jid !== null && row.lid_jid !== evidence.lidJid))) return null;
    await this.db`insert into whatsapp_sender_bindings(business_id,connection_id,phone,pn_jid,lid_jid)
      values(${businessId},${connectionId},${evidence.phone},${evidence.pnJid},${evidence.lidJid})
      on conflict(business_id,connection_id,phone) do update
      set lid_jid=coalesce(whatsapp_sender_bindings.lid_jid,excluded.lid_jid)`;
    return evidence.phone;
  }
  async agendaSender(messageId: string): Promise<string | null> {
    const [row] = await this.db<{ phone: string }[]>`select s.phone from whatsapp_received_senders s
      join messages m on (m.business_id,m.id,m.connection_id)=(s.business_id,s.message_id,s.connection_id)
      join whatsapp_sender_bindings b on (b.business_id,b.connection_id,b.phone)=(s.business_id,s.connection_id,s.phone)
      where s.message_id=${messageId} and m.direction='inbound'`;
    return row?.phone ?? null;
  }
  async lockAgendaDialogue(businessId: string, connectionId: string, phone: string): Promise<AgendaDialogue> {
    await this.db`select pg_advisory_xact_lock(hashtextextended(${`agenda:${businessId}:${connectionId}:${phone}`},0))`;
    const [row] = await this.db<{ dialogue: AgendaDialogue }[]>`select dialogue from whatsapp_agenda_dialogues
      where business_id=${businessId} and connection_id=${connectionId} and phone=${phone}`;
    return row?.dialogue ?? emptyAgendaDialogue();
  }
  async saveAgendaDialogue(businessId: string, connectionId: string, phone: string, dialogue: AgendaDialogue) {
    await this.db`insert into whatsapp_agenda_dialogues(business_id,connection_id,phone,dialogue)
      values(${businessId},${connectionId},${phone},${this.db.json(asDbJson(dialogue))})
      on conflict(business_id,connection_id,phone) do update set dialogue=excluded.dialogue,updated_at=now()`;
  }
  async lockAgendaSource(messageId: string) {
    await this.db`select c.id from conversations c join messages m on m.conversation_id=c.id
      where m.id=${messageId} for update of c`;
    return this.loadAiMessage(messageId, true);
  }
  async agendaQuoteDelivered(outboundId: string | null, connectionId: string, phone: string): Promise<boolean> {
    if (!outboundId) return false;
    const [row] = await this.db`select o.outbound_id from outbound_commands o
      join whatsapp_received_senders s on s.message_id=o.source_message_id and s.business_id=o.business_id
      where o.outbound_id=${outboundId} and o.connection_id=${connectionId} and s.phone=${phone} and o.state='sent'`;
    return !!row;
  }
  async recordAgendaReceipt(businessId: string, messageId: string, outboundId: string, operation: string) {
    await this.db`insert into whatsapp_agenda_receipts(business_id,message_id,outbound_id,operation)
      values(${businessId},${messageId},${outboundId},${operation})`;
  }
  /** Metadata-only expression does not need an active catalog or reserve capacity. */
  async setAgendaPreference(businessId: string, id: string, resourceId: string | null, now: string) {
    await this.acquireBusinessCalendarLock({ businessId });
    const current = await this.getAppointment(businessId, id);
    if (!current) throw new AppointmentError("UNKNOWN_OWNED_ID");
    if (current.state !== "confirmed") throw new AppointmentError("STATE_LOCKED");
    if (Date.parse(now) >= current.startMs) throw new AppointmentError("STARTED_STRUCTURE_LOCKED");
    if (resourceId !== null && !(await this.getResource(businessId, resourceId))) throw new AppointmentError("UNKNOWN_OWNED_ID");
    await this.db`update appointments set customer_resource_preference_id=${resourceId},updated_at=now()
      where business_id=${businessId} and id=${id} and state='confirmed'`;
    return { ...current, customerResourcePreference: resourceId };
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
    senderEvidence?: SenderEvidence;
  }) {
    const seen = await this
      .db`insert into inbox_events(business_id,source,stable_key) values(${input.businessId},'baileys',${input.providerId}) on conflict do nothing returning id`;
    if (!seen.length) return null;
    const senderPhone = input.classification === "accepted" && input.senderEvidence
      ? await this.bindReceivedSender(input.businessId, input.connectionId, input.remoteJid, input.senderEvidence) : null;
    const businessText = input.classification === "accepted_business";
    if (input.classification !== "accepted" && !businessText) {
      await this
        .db`insert into technical_events(business_id,component,code,severity) values(${input.businessId},'whatsapp-manager',${input.classification},'info')`;
      return { duplicate: false };
    }
    const conversation = (
      await this.db<
        { id: string; reply_due_at: Date | null; last_reply_at: Date | null; last_exchange_at: Date | null; accepted_at: Date }[]
      >`insert into conversations(business_id,connection_id,remote_jid) values(${input.businessId},${input.connectionId},${input.remoteJid}) on conflict(business_id,connection_id,remote_jid) do update set remote_jid=excluded.remote_jid returning id,reply_due_at,last_reply_at,last_exchange_at,clock_timestamp() accepted_at`
    )[0]!;
    // The upsert holds the conversation lock, shared with generation save,
    // outbound claim and confirmation. Recheck echo identity after that lock.
    // Identity outlives delivery state: even a late echo after a terminal
    // failure must not masquerade as manual input and cancel fresh work.
    if (businessText) {
      const echo = await this.db`select outbound_id from outbound_commands where business_id=${input.businessId} and connection_id=${input.connectionId} and conversation_id=${conversation.id} and (outbound_id::text=${input.providerId} or provider_message_id=${input.providerId})`;
      const persisted = await this.db`select id from messages where business_id=${input.businessId} and connection_id=${input.connectionId} and provider_message_id=${input.providerId} and direction='outbound'`;
      if (echo.length || persisted.length) return { duplicate: false, generatedEcho: true };
    }
    const sequence = Number(
      (
        await this.db<
          { sequence: string }[]
        >`update conversations set next_sequence=next_sequence+1 where id=${conversation.id} returning next_sequence-1 sequence`
      )[0]!.sequence,
    );
    if (businessText) {
      await this.db`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at,processing_state) values(${input.businessId},${conversation.id},${input.connectionId},${input.providerId},${sequence},'outbound',${input.text!},${input.receivedAt},'sent')`;
      await this.db`update conversations set latest_inbound_id=null,reply_due_at=null,last_reply_at=${conversation.accepted_at},last_exchange_at=${conversation.accepted_at} where id=${conversation.id}`;
      await this.db`update messages set processing_state='superseded' where conversation_id=${conversation.id} and direction='inbound' and processing_state in ('pending','generated') and not exists(select 1 from outbound_commands o where o.source_message_id=messages.id and o.state in ('sending','sent','delivery_unknown'))`;
      await this.db`update outbound_commands set state='failed',failure_code='manual_reply',updated_at=now() where conversation_id=${conversation.id} and state='generated'`;
      await this.db`update outbox_events set published_at=now() where topic='ai.generate' and published_at is null and payload->>'messageId' in (select id::text from messages where conversation_id=${conversation.id} and processing_state='superseded')`;
      return { duplicate: false, sequence };
    }
    const message = (
      await this.db<
        { id: string }[]
      >`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at) values(${input.businessId},${conversation.id},${input.connectionId},${input.providerId},${sequence},'inbound',${input.text!},${input.receivedAt}) returning id`
    )[0]!;
    if (senderPhone) await this.db`insert into whatsapp_received_senders(business_id,message_id,connection_id,phone)
      values(${input.businessId},${message.id},${input.connectionId},${senderPhone})`;
    const policy = await this.globalReplyPacing();
    const due = replyDeadline(conversation.accepted_at, conversation.last_reply_at, conversation.last_exchange_at, conversation.reply_due_at, policy);
    await this.db`update conversations set latest_inbound_id=${message.id},reply_due_at=${due},last_exchange_at=${conversation.accepted_at} where id=${conversation.id}`;
    await this.db`update messages set processing_state='superseded' where conversation_id=${conversation.id} and direction='inbound' and id<>${message.id} and processing_state in ('pending','generated')`;
    await this.db`update outbound_commands set state='failed',failure_code='superseded',updated_at=now() where conversation_id=${conversation.id} and state='generated'`;
    await this.db`update outbox_events set published_at=now() where topic='ai.generate' and published_at is null and payload->>'messageId' in (select id::text from messages where conversation_id=${conversation.id} and processing_state='superseded')`;
    await this.db`insert into outbox_events(business_id,topic,stable_key,payload,next_attempt_at) values(${input.businessId},'ai.generate',${`ai:${input.providerId}`},${this.db.json({ businessId: input.businessId, messageId: message.id })},${due}) on conflict do nothing`;
    return { duplicate: false, messageId: message.id, sequence };
  }
  async loadAiMessage(messageId: string, requireDue = false) {
    const message = (
      await this.db<
        {
          id: string;
          business_id: string;
          sequence: string;
          conversation_id: string;
          connection_id: string;
          raw_text: string;
        }[]
      >`select m.id,m.business_id,m.sequence,m.conversation_id,m.connection_id,m.raw_text from messages m join conversations c on c.id=m.conversation_id and c.business_id=m.business_id join businesses b on b.id=m.business_id join assistant_configs a on a.business_id=b.id join whatsapp_connections w on w.id=m.connection_id where m.id=${messageId} and m.direction='inbound' and m.processing_state='pending' and c.latest_inbound_id=m.id and (not ${requireDue} or c.reply_due_at<=now()) and b.status='active' and a.active and w.state='CONNECTED'`
    )[0];
    if (!message) return null;
    const profile =
      (
        await this.db<
          Record<string, string>[]
        >`select display_name,description,address from business_profiles limit 1`
      )[0] ?? {};
    const assistant =
      (
        await this.db<
          Record<string, string>[]
        >`select style,business_instructions from assistant_configs limit 1`
      )[0] ?? {};
    const turns = await this.db<
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
    const summaries = await this.db<
      { version: number; covered_through: string; structured_summary: any }[]
    >`select version,covered_through,structured_summary from conversation_summaries where conversation_id=${message.conversation_id} and covered_through<=(select coalesce(max(sequence),0) from messages where conversation_id=${message.conversation_id}) order by covered_through desc,version desc`;
    return { ...message, profile, assistant, turns, summaries, currentGroup };
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
    await this.db`select c.id from conversations c join messages m on m.conversation_id=c.id where m.id=${messageId} for update of c`;
    const changed = await this
      .db`update messages set processing_state='ai_failed' where id=${messageId} and processing_state='pending'`;
    if (!changed.count) return;
    await this.db`update conversations set reply_due_at=null where latest_inbound_id=${messageId}`;
    await this
      .db`insert into technical_events(business_id,component,code,severity) values(${businessId},'message-worker',${code},'error')`;
    await this.appendAudit(businessId, {
      eventType: "ai.failed",
      outcome: "failure",
      eventHash: "f".repeat(64),
    });
  }
  async saveGenerated(messageId: string, businessId: string, text: string) {
    await this.db`select c.id from conversations c join messages m on m.conversation_id=c.id where m.id=${messageId} for update of c`;
    const source = (
      await this.db<
        { conversation_id: string; connection_id: string }[]
      >`update messages set processing_state='generated' where id=${messageId} and processing_state='pending' and exists(select 1 from conversations c where c.id=messages.conversation_id and c.latest_inbound_id=messages.id and c.reply_due_at<=now()) returning conversation_id,connection_id`
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
  async claimOwnedOutbound(owner: string, ownership: string[]) {
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
            ownership_token: string;
          }[]
        >`select * from claim_owned_outbound(${owner},${ownership})`
      )[0] ?? null
    );
  }
  async finishOutbound(
    id: string,
    state: "sent" | "failed" | "delivery_unknown",
    providerId: string | undefined,
    ownership: string,
  ) {
    await this.db`select c.id from conversations c join outbound_commands o on o.conversation_id=c.id where o.outbound_id=${id} for update of c`;
    const [connection] = await this.db`select w.id from whatsapp_connections w join outbound_commands o
      on o.connection_id=w.id and o.business_id=w.business_id where o.outbound_id=${id} for update of w`;
    if (!connection || !await this.lockWhatsAppOwnership(connection.id, ownership)) return false;
    const row = (
      await this.db<
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
        >`update conversations set next_sequence=next_sequence+1,last_reply_at=date_trunc('milliseconds',clock_timestamp()),last_exchange_at=date_trunc('milliseconds',clock_timestamp()) where id=${row.conversation_id} returning next_sequence-1 sequence`
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

export { RolePool, createRuntimePools } from "./runtime-pools.ts";
