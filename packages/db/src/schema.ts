import { sql } from "drizzle-orm";
import {
  bigint, boolean, char, check, customType, date, foreignKey, index, integer, jsonb,
  numeric, pgPolicy, pgTable, pgView, primaryKey, text, timestamp, unique, uniqueIndex,
  uuid, varchar, type PgPolicyConfig,
} from "drizzle-orm/pg-core";

// Effective application metadata after SQL migrations 0000–0008 (Drizzle 0.45.2).
// SQL remains authoritative for FORCE RLS, exclusion constraints, collations,
// roles/ACLs, functions, triggers, extensions, schemas and seed rows.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const tenantScope = sql`business_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
const purgeScope = sql`business_id = nullif(current_setting('app.purge_business', true), '')::uuid`;

// Policies are fresh objects: Drizzle attaches each policy to its owning table.
function tenantPolicy(name: string, to: NonNullable<PgPolicyConfig["to"]>, command: NonNullable<PgPolicyConfig["for"]> = "all") {
  const config: PgPolicyConfig = { for: command, to };
  if (command !== "insert") config.using = tenantScope;
  if (["all", "insert", "update"].includes(command)) config.withCheck = tenantScope;
  return pgPolicy(name, config);
}
function purgePolicy() {
  return pgPolicy("business_purge_scope", { for: "all", to: "agendia_business_purge", using: purgeScope, withCheck: purgeScope });
}
function catalogPolicies(name: string) {
  return [tenantPolicy(`${name}_tenant`, "agendia_runtime"), tenantPolicy("agenda_worker_read", "agendia_worker_runtime", "select"), purgePolicy()];
}
function messagingPolicies() {
  return [tenantPolicy("tenant_manager", "agendia_whatsapp_runtime"), tenantPolicy("tenant_worker", "agendia_worker_runtime"), purgePolicy()];
}
const trimWhitespace = sql.raw(String.raw`U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'`);
const normalizedName = sql`lower(btrim(name, ${trimWhitespace}) COLLATE service_name_case)`;

// Identity and tenant ownership.
export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastTechnicalActivityAt: timestamp("last_technical_activity_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, () => [
  check("businesses_name_check", sql`length(trim(name)) > 0`),
  check("businesses_status_check", sql`status IN ('active', 'suspended')`),
]);

// FORCE RLS, grants, and the business write trigger remain in the SQL migrations.
export const businessProfiles = pgTable("business_profiles", {
  businessId: uuid("business_id").primaryKey(),
  displayName: varchar("display_name", { length: 160 }).notNull(),
  description: varchar("description", { length: 4000 }).notNull().default(""),
  address: varchar("address", { length: 500 }).notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => {
  const tenantScope = sql`business_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  const purgeScope = sql`business_id = nullif(current_setting('app.purge_business', true), '')::uuid`;
  return [
    foreignKey({ name: "business_profiles_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
    pgPolicy("business_profiles_tenant", { for: "all", to: "agendia_runtime", using: tenantScope, withCheck: tenantScope }),
    pgPolicy("business_profiles_worker", { for: "select", to: "agendia_worker_runtime", using: tenantScope }),
    pgPolicy("business_purge_scope", { for: "all", to: "agendia_business_purge", using: purgeScope, withCheck: purgeScope }),
  ];
}).enableRLS();

// FORCE RLS, grants, and the business write trigger remain in the SQL migrations.
export const tenantRecords = pgTable("tenant_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  value: text("value").notNull(),
}, (table) => {
  const tenantScope = sql`current_setting('app.actor_role', true) = 'business_user'
    AND business_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  const purgeScope = sql`business_id = nullif(current_setting('app.purge_business', true), '')::uuid`;
  return [
    foreignKey({ name: "tenant_records_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
    unique("tenant_records_business_id_id_key").on(table.businessId, table.id),
    pgPolicy("tenant_records_business_user", { for: "all", to: "agendia_runtime", using: tenantScope, withCheck: tenantScope }),
    pgPolicy("tenant_records_admin_deny", { for: "select", to: "agendia_admin_runtime", using: sql`false` }),
    pgPolicy("business_purge_scope", { for: "all", to: "agendia_business_purge", using: purgeScope, withCheck: purgeScope }),
  ];
}).enableRLS();

export const authIdentities = pgTable("auth_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  normalizedEmail: text("normalized_email").notNull().unique("auth_identities_normalized_email_key"),
  passwordPhc: text("password_phc").notNull(),
  role: text("role").notNull(),
  businessId: uuid("business_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ name: "auth_identities_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  check("auth_identities_role_check", sql`role IN ('platform_admin', 'business_user')`),
  check("auth_identities_check", sql`(role = 'platform_admin' AND business_id IS NULL) OR (role = 'business_user' AND business_id IS NOT NULL)`),
  uniqueIndex("auth_one_business_user").on(table.businessId).where(sql`role = 'business_user'`),
]);

export const webSessions = pgTable("web_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  identityId: uuid("identity_id").notNull(),
  tokenSha256: char("token_sha256", { length: 64 }).notNull().unique("web_sessions_token_sha256_key"),
  csrfSha256: char("csrf_sha256", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  idleTtlMs: bigint("idle_ttl_ms", { mode: "bigint" }),
}, table => [foreignKey({ name: "web_sessions_identity_id_fkey", columns: [table.identityId], foreignColumns: [authIdentities.id] })]);

export const agentConfigs = pgTable("agent_configs", {
  businessId: uuid("business_id").primaryKey(),
  active: boolean("active").notNull().default(false),
  revision: integer("revision").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  style: text("style").notNull().default(""),
  businessInstructions: text("business_instructions").notNull().default(""),
}, table => [
  foreignKey({ name: "agent_configs_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  check("agent_configs_revision_check", sql`revision >= 0`),
  tenantPolicy("agent_configs_tenant", "agendia_runtime"),
  tenantPolicy("agent_configs_worker", "agendia_worker_runtime", "select"),
  purgePolicy(),
]).enableRLS();

// Durable event streams and dispatch envelopes.
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id"),
  actorId: text("actor_id"),
  eventType: text("event_type").notNull(),
  outcome: text("outcome").notNull(),
  requestId: text("request_id").notNull(),
  metadata: jsonb("metadata").notNull().default(sql`'{}'`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  streamSequence: bigint("stream_sequence", { mode: "bigint" }).notNull(),
  previousHash: varchar("previous_hash", { length: 64 }).notNull(),
  eventHash: char("event_hash", { length: 64 }).notNull(),
  hmacKeyVersion: text("hmac_key_version").notNull(),
  source: text("source").notNull().default("runtime"),
}, table => [
  foreignKey({ name: "audit_events_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  unique("audit_events_business_id_id_key").on(table.businessId, table.id),
  check("audit_events_outcome_check", sql`outcome IN ('success', 'failure', 'denied')`),
  check("audit_events_stream_sequence_check", sql`stream_sequence > 0`),
  check("audit_events_previous_hash_check", sql`previous_hash ~ '^[0-9a-f]{64}$' OR previous_hash = 'GENESIS'`),
  check("audit_events_event_hash_check", sql`event_hash ~ '^[0-9a-f]{64}$'`),
  check("audit_events_hmac_key_version_check", sql`length(hmac_key_version) > 0`),
  uniqueIndex("audit_events_stream_sequence_idx").on(sql`coalesce(business_id::text, 'platform')`, table.streamSequence),
  index("audit_events_verify_idx").on(table.businessId, table.streamSequence, table.previousHash, table.eventHash),
  tenantPolicy("audit_events_tenant", "agendia_runtime"),
  tenantPolicy("audit_events_manager_runtime", "agendia_whatsapp_runtime"),
  tenantPolicy("audit_events_admin_http", "agendia_admin_runtime", "select"),
  tenantPolicy("audit_events_admin_http_insert", "agendia_admin_runtime", "insert"),
  tenantPolicy("audit_events_worker_select", "agendia_worker_runtime", "select"),
  tenantPolicy("audit_events_worker_insert", "agendia_worker_runtime", "insert"),
  pgPolicy("business_purge_audit", { for: "all", to: "agendia_business_purge", using: purgeScope, withCheck: purgeScope }),
]).enableRLS();

export const technicalEvents = pgTable("technical_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  component: text("component").notNull(),
  code: text("code").notNull(),
  severity: text("severity").notNull(),
  safeDetails: jsonb("safe_details").notNull().default(sql`'{}'`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ name: "technical_events_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  unique("technical_events_business_id_id_key").on(table.businessId, table.id),
  check("technical_events_severity_check", sql`severity IN ('info', 'warning', 'error', 'critical')`),
  tenantPolicy("technical_events_tenant", "agendia_runtime"),
  tenantPolicy("technical_events_manager_runtime", "agendia_whatsapp_runtime"),
  tenantPolicy("technical_events_worker", "agendia_worker_runtime", "insert"),
  purgePolicy(),
]).enableRLS();

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  topic: text("topic").notNull(),
  stableKey: text("stable_key").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  claimToken: uuid("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  publishAttempts: integer("publish_attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  linkAdmittedAt: timestamp("link_admitted_at", { withTimezone: true }),
}, table => [
  foreignKey({ name: "outbox_events_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  unique("outbox_events_business_id_stable_key_key").on(table.businessId, table.stableKey),
  unique("outbox_events_business_id_id_key").on(table.businessId, table.id),
  index("outbox_events_ai_dispatch_idx").on(table.nextAttemptAt, table.createdAt).where(sql`topic='ai.generate' AND published_at IS NULL`),
  tenantPolicy("outbox_events_tenant", "agendia_runtime"),
  tenantPolicy("outbox_events_manager_runtime", "agendia_whatsapp_runtime"),
  tenantPolicy("outbox_events_worker_runtime", "agendia_worker_runtime", "select"),
  tenantPolicy("outbox_events_worker_publish", "agendia_worker_runtime", "update"),
  tenantPolicy("outbox_events_admin_http", "agendia_admin_runtime", "insert"),
  tenantPolicy("agenda_worker_outbox", "agendia_worker_runtime", "insert"),
  purgePolicy(),
]).enableRLS();

export const inboxEvents = pgTable("inbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  source: text("source").notNull(),
  stableKey: text("stable_key").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ name: "inbox_events_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  unique("inbox_events_business_id_source_stable_key_key").on(table.businessId, table.source, table.stableKey),
  unique("inbox_events_business_id_id_key").on(table.businessId, table.id),
  tenantPolicy("inbox_events_tenant", "agendia_runtime"),
  tenantPolicy("inbox_events_manager_runtime", "agendia_whatsapp_runtime"),
  purgePolicy(),
]).enableRLS();

export const operationalControls = pgTable("operational_controls", {
  singleton: boolean("singleton").primaryKey().default(true),
  automationDisabled: boolean("automation_disabled").notNull().default(false),
  incidentReference: text("incident_reference"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  initialDelaySeconds: integer("initial_delay_seconds").notNull().default(600),
  activeDelaySeconds: integer("active_delay_seconds").notNull().default(90),
  inactivityResetSeconds: integer("inactivity_reset_seconds").notNull().default(3600),
}, () => [
  check("operational_controls_singleton_check", sql`singleton`),
  check("operational_controls_initial_delay_seconds_check", sql`initial_delay_seconds BETWEEN 0 AND 86400`),
  check("operational_controls_active_delay_seconds_check", sql`active_delay_seconds BETWEEN 0 AND 86400`),
  check("operational_controls_inactivity_reset_seconds_check", sql`inactivity_reset_seconds BETWEEN 1 AND 604800`),
  check("operational_controls_check", sql`NOT automation_disabled OR length(trim(incident_reference)) > 0`),
]);

// WhatsApp connection material and tenant-scoped message history.
export const whatsappConnections = pgTable("whatsapp_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().unique("whatsapp_connections_business_id_key"),
  sessionPublicId: uuid("session_public_id").notNull().unique("whatsapp_connections_session_public_id_key").defaultRandom(),
  state: varchar("state", { length: 24 }).notNull().default("LINK_REQUIRED"),
  linkedNumber: varchar("linked_number", { length: 40 }),
  linkedAt: timestamp("linked_at", { withTimezone: true }),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  ownerId: text("owner_id"),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  version: integer("version").notNull().default(0),
  wrappedDek: bytea("wrapped_dek"),
  wrappedDekNonce: bytea("wrapped_dek_nonce"),
  wrappedDekTag: bytea("wrapped_dek_tag"),
  kekVersion: text("kek_version"),
  ownershipToken: uuid("ownership_token"),
  linkCommandId: uuid("link_command_id"),
  linkPending: boolean("link_pending").notNull().default(false),
}, table => [
  foreignKey({ name: "whatsapp_connections_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  unique("whatsapp_connections_business_id_id_key").on(table.businessId, table.id),
  check("whatsapp_connections_state_check", sql`state IN ('LINK_REQUIRED','LINKING','CONNECTED','RECONNECTING','DISCONNECTED','ERROR')`),
  check("whatsapp_connections_version_check", sql`version >= 0`),
  tenantPolicy("whatsapp_connections_tenant", "agendia_runtime", "select"),
  tenantPolicy("whatsapp_connections_manager", "agendia_whatsapp_runtime"),
  tenantPolicy("whatsapp_connections_worker", "agendia_worker_runtime", "select"),
  purgePolicy(),
]).enableRLS();

export const whatsappAuthRecords = pgTable("whatsapp_auth_records", {
  businessId: uuid("business_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  recordName: text("record_name").notNull(),
  version: integer("version").notNull(),
  nonce: bytea("nonce").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  authTag: bytea("auth_tag").notNull(),
}, table => [
  primaryKey({ name: "whatsapp_auth_records_pkey", columns: [table.businessId, table.connectionId, table.recordName] }),
  foreignKey({ name: "whatsapp_auth_records_business_id_connection_id_fkey", columns: [table.businessId, table.connectionId], foreignColumns: [whatsappConnections.businessId, whatsappConnections.id] }),
  check("whatsapp_auth_records_version_check", sql`version > 0`),
  tenantPolicy("whatsapp_auth_manager_only", "agendia_whatsapp_runtime"),
  purgePolicy(),
]).enableRLS();

export const whatsappLinkCodes = pgTable("whatsapp_link_codes", {
  connectionId: uuid("connection_id").primaryKey(),
  businessId: uuid("business_id").notNull(),
  token: uuid("token").notNull().unique("whatsapp_link_codes_token_key"),
  ciphertext: bytea("ciphertext").notNull(),
  nonce: bytea("nonce").notNull(),
  authTag: bytea("auth_tag").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ name: "whatsapp_link_codes_business_id_connection_id_fkey", columns: [table.businessId, table.connectionId], foreignColumns: [whatsappConnections.businessId, whatsappConnections.id] }).onDelete("cascade"),
  check("whatsapp_link_codes_nonce_check", sql`octet_length(nonce)=12`),
  check("whatsapp_link_codes_auth_tag_check", sql`octet_length(auth_tag)=16`),
  index("whatsapp_link_codes_expiry").on(table.expiresAt),
  tenantPolicy("whatsapp_link_codes_tenant", "agendia_runtime", "select"),
  tenantPolicy("whatsapp_link_codes_tenant_expiry", "agendia_runtime", "delete"),
  tenantPolicy("whatsapp_link_codes_manager", "agendia_whatsapp_runtime"),
  purgePolicy(),
]).enableRLS();

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  remoteJid: text("remote_jid").notNull(),
  nextSequence: bigint("next_sequence", { mode: "bigint" }).notNull().default(sql`1`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  replyDueAt: timestamp("reply_due_at", { withTimezone: true }),
  latestInboundId: uuid("latest_inbound_id"),
  lastExchangeAt: timestamp("last_exchange_at", { withTimezone: true }),
  lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
}, table => [
  unique("conversations_business_id_connection_id_remote_jid_key").on(table.businessId, table.connectionId, table.remoteJid),
  unique("conversations_business_id_id_key").on(table.businessId, table.id),
  foreignKey({ name: "conversations_business_id_connection_id_fkey", columns: [table.businessId, table.connectionId], foreignColumns: [whatsappConnections.businessId, whatsappConnections.id] }),
  tenantPolicy("conversations_internal", ["agendia_whatsapp_runtime", "agendia_worker_runtime"]),
  purgePolicy(),
]).enableRLS();

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  sequence: bigint("sequence", { mode: "bigint" }).notNull(),
  direction: varchar("direction", { length: 16 }).notNull(),
  rawText: text("raw_text").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  processingState: varchar("processing_state", { length: 24 }).notNull().default("pending"),
}, table => [
  unique("messages_business_id_connection_id_provider_message_id_key").on(table.businessId, table.connectionId, table.providerMessageId),
  unique("messages_business_id_conversation_id_sequence_key").on(table.businessId, table.conversationId, table.sequence),
  unique("messages_business_id_id_key").on(table.businessId, table.id),
  foreignKey({ name: "messages_business_id_conversation_id_fkey", columns: [table.businessId, table.conversationId], foreignColumns: [conversations.businessId, conversations.id] }),
  foreignKey({ name: "messages_business_id_connection_id_fkey", columns: [table.businessId, table.connectionId], foreignColumns: [whatsappConnections.businessId, whatsappConnections.id] }),
  check("messages_direction_check", sql`direction IN ('inbound','outbound')`),
  index("messages_conversation_order_idx").on(table.businessId, table.conversationId, table.sequence),
  index("messages_context_order_idx").on(table.businessId, table.conversationId, table.sequence.desc().nullsFirst()),
  index("messages_context_search_idx").using("gin", sql`to_tsvector('simple', raw_text)`),
  tenantPolicy("messages_internal", ["agendia_whatsapp_runtime", "agendia_worker_runtime"]),
  purgePolicy(),
]).enableRLS();

export const conversationSummaries = pgTable("conversation_summaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  version: integer("version").notNull(),
  coveredThrough: bigint("covered_through", { mode: "bigint" }).notNull(),
  structuredSummary: jsonb("structured_summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique("conversation_summaries_business_id_conversation_id_version_key").on(table.businessId, table.conversationId, table.version),
  unique("conversation_summaries_business_id_id_key").on(table.businessId, table.id),
  foreignKey({ name: "conversation_summaries_business_id_conversation_id_fkey", columns: [table.businessId, table.conversationId], foreignColumns: [conversations.businessId, conversations.id] }),
  check("conversation_summaries_version_check", sql`version > 0`),
  check("conversation_summaries_covered_through_check", sql`covered_through >= 0`),
  tenantPolicy("conversation_summaries_worker", "agendia_worker_runtime"),
  purgePolicy(),
]).enableRLS();

export const outboundCommands = pgTable("outbound_commands", {
  outboundId: uuid("outbound_id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  text: text("text").notNull(),
  state: varchar("state", { length: 24 }).notNull().default("pending"),
  claimedBy: text("claimed_by"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  sendStartedAt: timestamp("send_started_at", { withTimezone: true }),
  providerMessageId: text("provider_message_id"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  failureCode: text("failure_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  sourceMessageId: uuid("source_message_id"),
  ownershipToken: uuid("ownership_token"),
}, table => [
  unique("outbound_commands_business_id_outbound_id_key").on(table.businessId, table.outboundId),
  foreignKey({ name: "outbound_commands_business_id_conversation_id_fkey", columns: [table.businessId, table.conversationId], foreignColumns: [conversations.businessId, conversations.id] }),
  foreignKey({ name: "outbound_commands_business_id_connection_id_fkey", columns: [table.businessId, table.connectionId], foreignColumns: [whatsappConnections.businessId, whatsappConnections.id] }),
  check("outbound_commands_text_check", sql`length(text) > 0`),
  check("outbound_commands_state_check", sql`state IN ('pending','processing','generated','sending','sent','failed','delivery_unknown')`),
  index("outbound_commands_claim_idx").on(table.connectionId, table.state, table.createdAt).where(sql`state = 'generated'`),
  uniqueIndex("outbound_commands_provider_message_idx").on(table.businessId, table.connectionId, table.providerMessageId).where(sql`provider_message_id IS NOT NULL`),
  uniqueIndex("outbound_commands_source_message_idx").on(table.sourceMessageId).where(sql`source_message_id IS NOT NULL`),
  tenantPolicy("outbound_commands_worker", "agendia_worker_runtime"),
  tenantPolicy("outbound_commands_manager", "agendia_whatsapp_runtime"),
  purgePolicy(),
]).enableRLS();

// Catalog and calendars. Explicit COLLATE "C" on normalized_name remains SQL-only.
export const serviceCategories = pgTable("service_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  name: text("name").notNull(),
}, table => [
  foreignKey({ name: "service_categories_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  unique("service_categories_business_id_id_key").on(table.businessId, table.id),
  check("service_categories_name_check", sql`btrim(name, ${trimWhitespace}) <> ''`),
  tenantPolicy("service_categories_tenant", "agendia_runtime"),
  purgePolicy(),
]).enableRLS();

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  normalizedName: text("normalized_name").generatedAlwaysAs(normalizedName),
  durationMinutes: integer("duration_minutes").notNull(),
  priceArs: numeric("price_ars").notNull(),
  status: text("status").notNull().default("active"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  categoryId: uuid("category_id"),
}, table => [
  foreignKey({ name: "services_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  foreignKey({ name: "services_category_business_fk", columns: [table.businessId, table.categoryId], foreignColumns: [serviceCategories.businessId, serviceCategories.id] }),
  unique("services_business_id_id_key").on(table.businessId, table.id),
  check("services_duration_minutes_check", sql`duration_minutes > 0 AND duration_minutes % 5 = 0`),
  check("services_price_ars_check", sql`price_ars >= 0 AND price_ars < 'Infinity'::numeric`),
  check("services_status_check", sql`status IN ('active', 'suspended')`),
  check("services_normalized_name_check", sql`normalized_name <> ''`),
  uniqueIndex("services_business_name_key").on(table.businessId, sql`service_name_sha256(normalized_name)`).where(sql`deleted_at IS NULL`),
  ...catalogPolicies("services"),
]).enableRLS();

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone").notNull(),
}, table => [
  foreignKey({ name: "clients_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  unique("clients_business_phone_key").on(table.businessId, table.phone),
  unique("clients_business_id_key").on(table.businessId, table.id),
  check("clients_phone_check", sql.raw(String.raw`phone ~ '^\+[1-9][0-9]{1,14}$'`)),
  check("clients_first_name_check", sql`btrim(first_name, ${trimWhitespace}) <> ''`),
  check("clients_last_name_check", sql`btrim(last_name, ${trimWhitespace}) <> ''`),
  ...catalogPolicies("clients"),
  tenantPolicy("agenda_worker_client_create", "agendia_worker_runtime", "insert"),
]).enableRLS();

export const businessCalendars = pgTable("business_calendars", {
  businessId: uuid("business_id").primaryKey(),
  weeklySchedule: jsonb("weekly_schedule").notNull(),
}, table => [
  foreignKey({ name: "business_calendars_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  check("business_calendars_weekly_schedule_check", sql`valid_business_weekly_schedule(weekly_schedule)`),
  ...catalogPolicies("business_calendars"),
]).enableRLS();

export const businessCalendarClosures = pgTable("business_calendar_closures", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  kind: text("kind").notNull(),
  closedDate: date("closed_date", { mode: "string" }),
  startRaw: text("start_raw"),
  endRaw: text("end_raw"),
  startMs: bigint("start_ms", { mode: "bigint" }),
  endMs: bigint("end_ms", { mode: "bigint" }),
}, table => [
  foreignKey({ name: "business_calendar_closures_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  check("business_calendar_closures_kind_check", sql`kind IN ('date', 'interval')`),
  check("business_calendar_closures_check", sql`
    (kind = 'date' AND closed_date IS NOT NULL
      AND closed_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
      AND start_raw IS NULL AND end_raw IS NULL AND start_ms IS NULL AND end_ms IS NULL)
    OR (kind = 'interval' AND closed_date IS NULL
      AND start_raw IS NOT NULL AND end_raw IS NOT NULL
      AND start_ms IS NOT NULL AND end_ms IS NOT NULL AND end_ms > start_ms
      AND start_ms BETWEEN -62135683140000 AND 253402387139999
      AND end_ms BETWEEN -62135683140000 AND 253402387139999)`),
  index("business_calendar_closures_business_id").on(table.businessId, table.id),
  ...catalogPolicies("business_calendar_closures"),
]).enableRLS();

export const resources = pgTable("resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  normalizedName: text("normalized_name").generatedAlwaysAs(normalizedName),
  status: text("status").notNull().default("active"),
  weeklySchedule: jsonb("weekly_schedule").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, table => [
  foreignKey({ name: "resources_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  unique("resources_business_id_id_key").on(table.businessId, table.id),
  check("resources_status_check", sql`status IN ('active', 'suspended')`),
  check("resources_weekly_schedule_check", sql`valid_business_weekly_schedule(weekly_schedule)`),
  check("resources_normalized_name_check", sql`normalized_name <> ''`),
  uniqueIndex("resources_business_name_key").on(table.businessId, sql`service_name_sha256(normalized_name)`).where(sql`deleted_at IS NULL`),
  ...catalogPolicies("resources"),
]).enableRLS();

export const resourceServices = pgTable("resource_services", {
  businessId: uuid("business_id").notNull(),
  resourceId: uuid("resource_id").notNull(),
  serviceId: uuid("service_id").notNull(),
}, table => [
  primaryKey({ name: "resource_services_pkey", columns: [table.businessId, table.resourceId, table.serviceId] }),
  foreignKey({ name: "resource_services_business_id_resource_id_fkey", columns: [table.businessId, table.resourceId], foreignColumns: [resources.businessId, resources.id] }),
  foreignKey({ name: "resource_services_business_id_service_id_fkey", columns: [table.businessId, table.serviceId], foreignColumns: [services.businessId, services.id] }),
  ...catalogPolicies("resource_services"),
]).enableRLS();

// Frozen appointment terms. appointments_confirmed_capacity is a SQL exclusion
// constraint (GiST), deliberately NOT represented as a weaker ordinary index.
export const appointments = pgTable("appointments", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull(),
  clientId: uuid("client_id").notNull(),
  serviceId: uuid("service_id").notNull(),
  resourceId: uuid("resource_id").notNull(),
  customerResourcePreferenceId: uuid("customer_resource_preference_id"),
  serviceLabel: text("service_label").notNull(),
  resourceLabel: text("resource_label").notNull(),
  priceArs: numeric("price_ars").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  startRaw: text("start_raw").notNull(),
  startMs: bigint("start_ms", { mode: "bigint" }).notNull(),
  endMs: bigint("end_ms", { mode: "bigint" }).notNull(),
  state: text("state").notNull(),
  origin: text("origin").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ name: "appointments_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  foreignKey({ name: "appointments_business_id_client_id_fkey", columns: [table.businessId, table.clientId], foreignColumns: [clients.businessId, clients.id] }),
  foreignKey({ name: "appointments_business_id_service_id_fkey", columns: [table.businessId, table.serviceId], foreignColumns: [services.businessId, services.id] }),
  foreignKey({ name: "appointments_business_id_resource_id_fkey", columns: [table.businessId, table.resourceId], foreignColumns: [resources.businessId, resources.id] }),
  foreignKey({ name: "appointments_business_id_customer_resource_preference_id_fkey", columns: [table.businessId, table.customerResourcePreferenceId], foreignColumns: [resources.businessId, resources.id] }),
  unique("appointments_business_id_id_key").on(table.businessId, table.id),
  check("appointments_service_label_check", sql`btrim(service_label, ${trimWhitespace}) <> ''`),
  check("appointments_resource_label_check", sql`btrim(resource_label, ${trimWhitespace}) <> ''`),
  check("appointments_price_ars_check", sql`price_ars >= 0 AND price_ars < 'Infinity'::numeric`),
  check("appointments_duration_minutes_check", sql`duration_minutes > 0 AND duration_minutes % 5 = 0`),
  check("appointments_start_ms_check", sql`start_ms BETWEEN -62135683140000 AND 253402387139999`),
  check("appointments_end_ms_check", sql`end_ms BETWEEN -62135683140000 AND 253402387139999`),
  check("appointments_check", sql`end_ms > start_ms AND end_ms::numeric = start_ms::numeric + duration_minutes::numeric * 60000`),
  check("appointments_state_check", sql`state IN ('confirmed', 'done', 'cancelled', 'no_show')`),
  check("appointments_origin_check", sql`origin IN ('manual', 'ai')`),
  ...catalogPolicies("appointments"),
  tenantPolicy("agenda_worker_appointment_create", "agendia_worker_runtime", "insert"),
  tenantPolicy("agenda_worker_appointment_change", "agendia_worker_runtime", "update"),
]).enableRLS();

export const appointmentOperationReceipts = pgTable("appointment_operation_receipts", {
  businessId: uuid("business_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  operationKey: uuid("operation_key").notNull(),
  kind: text("kind").notNull(),
  targetId: uuid("target_id"),
  fingerprint: text("fingerprint"),
  state: text("state").notNull(),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => {
  const ownerScope = sql`business_id = nullif(current_setting('app.tenant_id',true),'')::uuid
    AND actor_id = nullif(current_setting('app.actor_id',true),'')::uuid
    AND current_setting('app.actor_role',true) = 'business_user'`;
  return [
    primaryKey({ name: "appointment_operation_receipts_pkey", columns: [table.businessId, table.actorId, table.operationKey] }),
    foreignKey({ name: "appointment_operation_receipts_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
    foreignKey({ name: "appointment_operation_receipts_actor_id_fkey", columns: [table.actorId], foreignColumns: [authIdentities.id] }),
    check("appointment_operation_receipts_kind_check", sql`kind IN ('create','change','notes','state')`),
    check("appointment_operation_receipts_state_check", sql`state IN ('completed','failed','cancelled')`),
    check("appointment_operation_receipts_check", sql`(kind = 'create') = (target_id IS NULL)`),
    check("appointment_operation_receipts_check1", sql`(state = 'cancelled' AND fingerprint IS NULL AND result IS NULL)
      OR (state IN ('completed','failed') AND fingerprint IS NOT NULL AND result IS NOT NULL)`),
    pgPolicy("appointment_operation_owner", { for: "all", to: "agendia_runtime", using: ownerScope, withCheck: ownerScope }),
    purgePolicy(),
    pgPolicy("business_purge_receipt_reference", { for: "select", to: "agendia_business_purge", using: sql`true` }),
  ];
}).enableRLS();

// WhatsApp sender identity and agenda idempotency.
export const whatsappSenderBindings = pgTable("whatsapp_sender_bindings", {
  businessId: uuid("business_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  phone: text("phone").notNull(),
  pnJid: text("pn_jid").notNull(),
  lidJid: text("lid_jid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ name: "whatsapp_sender_bindings_pkey", columns: [table.businessId, table.connectionId, table.phone] }),
  foreignKey({ name: "whatsapp_sender_bindings_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  foreignKey({ name: "whatsapp_sender_bindings_business_id_connection_id_fkey", columns: [table.businessId, table.connectionId], foreignColumns: [whatsappConnections.businessId, whatsappConnections.id] }),
  unique("whatsapp_sender_bindings_business_id_connection_id_pn_jid_key").on(table.businessId, table.connectionId, table.pnJid),
  unique("whatsapp_sender_bindings_business_id_connection_id_lid_jid_key").on(table.businessId, table.connectionId, table.lidJid),
  check("whatsapp_sender_bindings_phone_check", sql.raw(String.raw`phone ~ '^\+[1-9][0-9]{6,14}$'`)),
  ...messagingPolicies(),
]).enableRLS();

export const whatsappReceivedSenders = pgTable("whatsapp_received_senders", {
  businessId: uuid("business_id").notNull(),
  messageId: uuid("message_id").primaryKey(),
  connectionId: uuid("connection_id").notNull(),
  phone: text("phone").notNull(),
}, table => [
  foreignKey({ name: "whatsapp_received_senders_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  foreignKey({ name: "whatsapp_received_senders_business_id_message_id_fkey", columns: [table.businessId, table.messageId], foreignColumns: [messages.businessId, messages.id] }),
  foreignKey({ name: "whatsapp_received_senders_business_id_connection_id_fkey", columns: [table.businessId, table.connectionId], foreignColumns: [whatsappConnections.businessId, whatsappConnections.id] }),
  foreignKey({ name: "whatsapp_received_senders_business_id_connection_id_phone_fkey", columns: [table.businessId, table.connectionId, table.phone], foreignColumns: [whatsappSenderBindings.businessId, whatsappSenderBindings.connectionId, whatsappSenderBindings.phone] }),
  ...messagingPolicies(),
]).enableRLS();

export const whatsappAgendaDialogues = pgTable("whatsapp_agenda_dialogues", {
  businessId: uuid("business_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  phone: text("phone").notNull(),
  dialogue: jsonb("dialogue").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ name: "whatsapp_agenda_dialogues_pkey", columns: [table.businessId, table.connectionId, table.phone] }),
  foreignKey({ name: "whatsapp_agenda_dialogues_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  foreignKey({ name: "whatsapp_agenda_dialogues_business_id_connection_id_fkey", columns: [table.businessId, table.connectionId], foreignColumns: [whatsappConnections.businessId, whatsappConnections.id] }),
  foreignKey({ name: "whatsapp_agenda_dialogues_business_id_connection_id_phone_fkey", columns: [table.businessId, table.connectionId, table.phone], foreignColumns: [whatsappSenderBindings.businessId, whatsappSenderBindings.connectionId, whatsappSenderBindings.phone] }),
  ...messagingPolicies(),
]).enableRLS();

export const whatsappAgendaReceipts = pgTable("whatsapp_agenda_receipts", {
  businessId: uuid("business_id").notNull(),
  messageId: uuid("message_id").primaryKey(),
  outboundId: uuid("outbound_id"),
  operation: text("operation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  foreignKey({ name: "whatsapp_agenda_receipts_business_id_fkey", columns: [table.businessId], foreignColumns: [businesses.id] }),
  foreignKey({ name: "whatsapp_agenda_receipts_business_id_message_id_fkey", columns: [table.businessId, table.messageId], foreignColumns: [messages.businessId, messages.id] }),
  foreignKey({ name: "whatsapp_agenda_receipts_business_id_outbound_id_fkey", columns: [table.businessId, table.outboundId], foreignColumns: [outboundCommands.businessId, outboundCommands.outboundId] }),
  check("whatsapp_agenda_receipts_silent_output_check", sql`(operation = 'silent' AND outbound_id IS NULL) OR (operation <> 'silent' AND outbound_id IS NOT NULL)`),
  ...messagingPolicies(),
]).enableRLS();

// Owner-only authentication budgets and registration storage (no RLS).
export const loginThrottleGlobal = pgTable("login_throttle_global", {
  singleton: boolean("singleton").primaryKey().default(true),
  attempts: integer("attempts").notNull(),
  resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
}, () => [
  check("login_throttle_global_singleton_check", sql`singleton`),
  check("login_throttle_global_attempts_check", sql`attempts BETWEEN 0 AND 120`),
]);

export const loginThrottleAccounts = pgTable("login_throttle_accounts", {
  accountHash: text("account_hash").primaryKey(),
  attempts: integer("attempts").notNull(),
  resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
}, table => [
  check("login_throttle_accounts_account_hash_check", sql`account_hash ~ '^[a-f0-9]{64}$'`),
  check("login_throttle_accounts_attempts_check", sql`attempts BETWEEN 1 AND 20`),
  index("login_throttle_accounts_expiry").on(table.resetsAt),
]);

export const registrationThrottle = pgTable("registration_throttle", {
  singleton: boolean("singleton").primaryKey().default(true),
  attempts: integer("attempts").notNull(),
  resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
}, () => [check("registration_throttle_singleton_check", sql`singleton`)]);

export const pendingRegistrations = pgTable("pending_registrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  email: text("email").notNull().unique("pending_registrations_email_key"),
  passwordPhc: text("password_phc").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, () => [
  check("pending_registrations_name_check", sql`length(trim(name)) > 0`),
  check("pending_registrations_email_check", sql`length(email) <= 254 AND email = lower(trim(email))`),
]);

export const adminBusinessStatus = pgView("admin_business_status", {
  id: uuid("id"),
  name: varchar("name", { length: 160 }),
  status: varchar("status", { length: 16 }),
  createdAt: timestamp("created_at", { withTimezone: true }),
  lastTechnicalActivityAt: timestamp("last_technical_activity_at", { withTimezone: true }),
  agentStatus: text("agent_status"),
  whatsappStatus: text("whatsapp_status"),
}).as(sql`SELECT b.id,b.name,b.status,b.created_at,b.last_technical_activity_at,
  CASE WHEN a.active THEN 'active' ELSE 'inactive' END agent_status,
  coalesce(lower(w.state),'link_required') whatsapp_status
  FROM businesses b LEFT JOIN agent_configs a ON a.business_id=b.id
  LEFT JOIN whatsapp_connections w ON w.business_id=b.id WHERE b.deleted_at IS NULL`);
