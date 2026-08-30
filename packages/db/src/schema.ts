import { pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastTechnicalActivityAt: timestamp("last_technical_activity_at", { withTimezone: true }),
});

export const tenantRecords = pgTable("tenant_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  value: text("value").notNull(),
}, (table) => [unique().on(table.businessId, table.id)]);
