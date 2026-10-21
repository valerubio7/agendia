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
import * as whatsapp from "./repositories/whatsapp.ts";
import * as whatsappAgenda from "./repositories/whatsapp-agenda.ts";
import * as messaging from "./repositories/messaging.ts";
import type { StoredAppointment, AppointmentCreationContext, AppointmentChangeContext,
  AppointmentAvailabilityContext, AppointmentAvailabilityOption } from "./repositories/appointments.ts";
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
import type { ReplyPacing } from "@agendia/domain";
import type { SenderEvidence, AgendaDialogue } from "../../domain/src/whatsapp/agenda.ts";
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
    return whatsapp.whatsapp(this.db);
  }
  saveConnection(id: string, businessId: string) {
    return whatsapp.saveConnection(this.db, id, businessId);
  }
  async connection() {
    return whatsapp.connection(this.db);
  }
  replaceLinkCode(id: string, value: SealedLinkCode, expiresAt: Date) {
    return whatsapp.replaceLinkCode(this.db, id, value, expiresAt);
  }
  async currentLinkCode(now: Date) {
    return whatsapp.currentLinkCode(this.db, now);
  }
  invalidateLinkCode(id: string, token: string) {
    return whatsapp.invalidateLinkCode(this.db, id, token);
  }
  clearLinkCode(id: string) {
    return whatsapp.clearLinkCode(this.db, id);
  }
  async clearWhatsAppAuth(id: string) {
    return whatsapp.clearWhatsAppAuth(this.db, id);
  }
  async lockAuthConnection(businessId: string, id: string) {
    return whatsapp.lockAuthConnection(this.db, businessId, id);
  }
  async authEnvelope(id: string) {
    return whatsapp.authEnvelope(this.db, id);
  }
  async saveAuthEnvelope(
    id: string,
    value: { ciphertext: Buffer; iv: Buffer; tag: Buffer; kekVersion: string },
  ) {
    return whatsapp.saveAuthEnvelope(this.db, id, value);
  }
  async authRecord(id: string, name: string) {
    return whatsapp.authRecord(this.db, id, name);
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
    return whatsapp.saveAuthRecord(this.db, value);
  }
  async claimWhatsAppLink(token: string) {
    return whatsapp.claimWhatsAppLink(this.db, token);
  }
  restorableWhatsApp() {
    return whatsapp.restorableWhatsApp(this.db);
  }
  async admitWhatsAppLink(id: string, commandId: string, claim: string): Promise<boolean> {
    return whatsapp.admitWhatsAppLink(this.db, this, id, commandId, claim);
  }
  async completeWhatsAppLink(commandId: string, claim: string, ownership: string) {
    return whatsapp.completeWhatsAppLink(this.db, commandId, claim, ownership);
  }
  async takeOverWhatsApp(id: string, owner: string, token: string, now: Date) {
    return whatsapp.takeOverWhatsApp(this.db, this, id, owner, token, now);
  }
  async lockWhatsAppOwnership(id: string, token: string): Promise<boolean> {
    return whatsapp.lockWhatsAppOwnership(this.db, id, token);
  }
  heartbeatWhatsApp(id: string, owner: string, now: Date, token?: string) {
    return whatsapp.heartbeatWhatsApp(this.db, id, owner, now, token);
  }
  releaseWhatsApp(id: string, owner: string, token: string) {
    return whatsapp.releaseWhatsApp(this.db, id, owner, token);
  }
  setWhatsAppState(id: string, state: string, now: Date, number?: string) {
    return whatsapp.setWhatsAppState(this.db, id, state, now, number);
  }
  /** Serialize collisions across PN and LID within this specific business connection. */
  async bindReceivedSender(businessId: string, connectionId: string, remoteJid: string, evidence: SenderEvidence): Promise<string | null> {
    return whatsappAgenda.bindReceivedSender(this.db, businessId, connectionId, remoteJid, evidence);
  }
  async agendaSender(messageId: string): Promise<string | null> {
    return whatsappAgenda.agendaSender(this.db, messageId);
  }
  async lockAgendaDialogue(businessId: string, connectionId: string, phone: string): Promise<AgendaDialogue> {
    return whatsappAgenda.lockAgendaDialogue(this.db, businessId, connectionId, phone);
  }
  async saveAgendaDialogue(businessId: string, connectionId: string, phone: string, dialogue: AgendaDialogue) {
    return whatsappAgenda.saveAgendaDialogue(this.db, businessId, connectionId, phone, dialogue);
  }
  async lockAgendaSource(messageId: string) {
    return whatsappAgenda.lockAgendaSource(this.db, this, messageId);
  }
  async agendaQuoteDelivered(outboundId: string | null, connectionId: string, phone: string): Promise<boolean> {
    return whatsappAgenda.agendaQuoteDelivered(this.db, outboundId, connectionId, phone);
  }
  async recordAgendaReceipt(businessId: string, messageId: string, outboundId: string, operation: string) {
    return whatsappAgenda.recordAgendaReceipt(this.db, businessId, messageId, outboundId, operation);
  }
  /** Metadata-only expression does not need an active catalog or reserve capacity. */
  async setAgendaPreference(businessId: string, id: string, resourceId: string | null, now: string) {
    return whatsappAgenda.setAgendaPreference(this.db, this, businessId, id, resourceId, now);
  }
  async routeSession(session: string) {
    return messaging.routeSession(this.db, session);
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
    return messaging.ingestInbound(this.db, this, input);
  }
  async loadAiMessage(messageId: string, requireDue = false) {
    return messaging.loadAiMessage(this.db, messageId, requireDue);
  }
  async loadSummarySource(conversationId: string, coveredThrough: number) {
    return messaging.loadSummarySource(this.db, conversationId, coveredThrough);
  }
  async saveConversationSummary(
    conversationId: string,
    expectedVersion: number,
    coveredThrough: number,
    summary: unknown,
  ) {
    return messaging.saveConversationSummary(this.db, conversationId, expectedVersion, coveredThrough, summary);
  }
  recordSummaryFailure(businessId: string) {
    return messaging.recordSummaryFailure(this.db, businessId);
  }
  async failAi(messageId: string, businessId: string, code: string) {
    return messaging.failAi(this.db, this, messageId, businessId, code);
  }
  async saveGenerated(messageId: string, businessId: string, text: string) {
    return messaging.saveGenerated(this.db, messageId, businessId, text);
  }
  async claimOwnedOutbound(owner: string, ownership: string[]) {
    return messaging.claimOwnedOutbound(this.db, owner, ownership);
  }
  async finishOutbound(
    id: string,
    state: "sent" | "failed" | "delivery_unknown",
    providerId: string | undefined,
    ownership: string,
  ) {
    return messaging.finishOutbound(this.db, this, id, state, providerId, ownership);
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
