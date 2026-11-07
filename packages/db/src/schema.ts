import { sql } from "drizzle-orm";
import { check, foreignKey, pgPolicy, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastTechnicalActivityAt: timestamp("last_technical_activity_at", { withTimezone: true }),
});

export const whatsappAgendaReceipts = pgTable("whatsapp_agenda_receipts", {
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  messageId: uuid("message_id").primaryKey(),
  outboundId: uuid("outbound_id"),
  operation: text("operation").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [check("whatsapp_agenda_receipts_silent_output_check",
  sql`(${table.operation} = 'silent' AND ${table.outboundId} IS NULL) OR (${table.operation} <> 'silent' AND ${table.outboundId} IS NOT NULL)`)]);

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
