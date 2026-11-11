import { and, eq, isNull, sql } from "drizzle-orm";
import { businesses, businessProfiles, authIdentities } from "../schema.ts";
import type { PostgresRepositories } from "../repositories.ts";
import { execute, result, type Db } from "./shared.ts";

export function saveBusiness(db: Db, row: { id: string; name: string }) {
  return result(db.insert(businesses).values(row).onConflictDoUpdate({ target: businesses.id, set: { name: row.name } }));
}
export async function createBusinessUser(db: Db, repo: PostgresRepositories, row: {
  id: string;
  name: string;
  email: string;
  passwordPhc: string;
}) {
  await repo.saveBusiness(row);
  await repo.saveIdentity({ email: row.email, passwordPhc: row.passwordPhc, businessId: row.id });
}
export async function setBusinessStatus(db: Db, id: string, status: string) {
  const changed = await result(db.update(businesses).set({ status }).where(eq(businesses.id, id)).returning({ id: businesses.id }));
  if (!changed.length) return false;
  await result(db.update(authIdentities).set({ active: status === "active" }).where(eq(authIdentities.businessId, id)));
  if (status === "suspended")
    await execute(db, sql`update web_sessions set revoked_at=now() where identity_id in(select id from auth_identities where business_id=${id}) and revoked_at is null`);
  return true;
}
export function listBusinesses(db: Db) {
  return execute(db, sql`select id,name,status,created_at "createdAt",last_technical_activity_at "lastTechnicalActivityAt",agent_status "agentStatus",whatsapp_status "whatsappStatus" from admin_business_status order by created_at`);
}
export async function business(db: Db, id: string) {
  const [row] = await result(db.select({ id: businesses.id, name: businesses.name, status: businesses.status,
    createdAt: businesses.createdAt, lastTechnicalActivityAt: businesses.lastTechnicalActivityAt }).from(businesses)
    .where(and(eq(businesses.id, id), isNull(businesses.deletedAt))));
  return row ?? null;
}
export function saveProfile(db: Db, businessId: string, displayName: string) {
  return result(db.insert(businessProfiles).values({ businessId, displayName }).onConflictDoUpdate({
    target: businessProfiles.businessId, set: { displayName, updatedAt: sql`now()` },
  }));
}
export async function profile(db: Db) {
  const [row] = await result(db.select({ displayName: businessProfiles.displayName,
    description: businessProfiles.description, address: businessProfiles.address }).from(businessProfiles).limit(1));
  return row ?? null;
}
export function saveFullProfile(db: Db, businessId: string, p: Record<string, string>) {
  const values = { displayName: p.displayName!, description: p.description!, address: p.address! };
  return result(db.insert(businessProfiles).values({ businessId, ...values }).onConflictDoUpdate({
    target: businessProfiles.businessId, set: { ...values, updatedAt: sql`now()` },
  }));
}
