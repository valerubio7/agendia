import type { PostgresRepositories } from "../repositories.ts";
import type { Db } from "./shared.ts";

export function saveBusiness(db: Db, row: { id: string; name: string }) {
  return db`insert into businesses (id,name) values (${row.id},${row.name}) on conflict (id) do update set name=excluded.name`;
}
export async function createBusinessUser(db: Db, repo: PostgresRepositories, row: {
  id: string;
  name: string;
  email: string;
  passwordPhc: string;
}) {
  await repo.saveBusiness(row);
  await repo.saveIdentity({
    email: row.email,
    passwordPhc: row.passwordPhc,
    businessId: row.id,
  });
}
export async function setBusinessStatus(db: Db, id: string, status: string) {
  const changed = await db`update businesses set status=${status} where id=${id} returning id`;
  if (!changed.length) return false;
  await db`update auth_identities set active=${status === "active"} where business_id=${id}`;
  if (status === "suspended")
    await db`update web_sessions set revoked_at=now() where identity_id in(select id from auth_identities where business_id=${id}) and revoked_at is null`;
  return true;
}
export function listBusinesses(db: Db) {
  return db`select id,name,status,created_at "createdAt",last_technical_activity_at "lastTechnicalActivityAt",agent_status "agentStatus",whatsapp_status "whatsappStatus" from admin_business_status order by created_at`;
}
export async function business(db: Db, id: string) {
  return (
    (
      await db`select id,name,status,created_at "createdAt",last_technical_activity_at "lastTechnicalActivityAt" from businesses where id=${id}`
    )[0] ?? null
  );
}
export function saveProfile(db: Db, businessId: string, displayName: string) {
  return db`insert into business_profiles (business_id,display_name) values (${businessId},${displayName}) on conflict (business_id) do update set display_name=excluded.display_name,updated_at=now()`;
}
export async function profile(db: Db) {
  return (
    (
      await db`select display_name "displayName",description,address from business_profiles limit 1`
    )[0] ?? null
  );
}
export function saveFullProfile(db: Db, businessId: string, p: Record<string, string>) {
  return db`insert into business_profiles(business_id,display_name,description,address) values(${businessId},${p.displayName!},${p.description!},${p.address!}) on conflict(business_id) do update set display_name=excluded.display_name,description=excluded.description,address=excluded.address,updated_at=now()`;
}
