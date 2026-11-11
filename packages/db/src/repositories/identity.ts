import { and, eq, isNull, sql } from "drizzle-orm";
import { authIdentities, webSessions } from "../schema.ts";
import { execute, result, type Db } from "./shared.ts";

export function saveIdentity(db: Db, row: {
  email: string;
  passwordPhc: string;
  businessId: string;
}) {
  return result(db.insert(authIdentities).values({ normalizedEmail: row.email,
    passwordPhc: row.passwordPhc, role: "business_user", businessId: row.businessId }));
}
export async function findIdentity(db: Db, email: string) {
  const [row] = await result(db.select({ business_id: sql<string>`${authIdentities.businessId}` }).from(authIdentities)
    .where(eq(authIdentities.normalizedEmail, email)));
  return row ?? null;
}
export async function admitLogin(db: Db, accountHash: string): Promise<boolean> {
  return (await execute<{ admitted: boolean }>(db, sql`select admit_login(${accountHash}) admitted`))[0]?.admitted === true;
}
export async function authIdentity(db: Db, email: string) {
  return (
    (await execute<{
      id: string;
      password_phc: string;
      role: "platform_admin" | "business_user";
      business_id: string | null;
      active: boolean;
      business_status: string | null;
    }>(db, sql`select i.id,i.password_phc,i.role,i.business_id,i.active,b.status business_status from auth_identities i left join businesses b on b.id=i.business_id where normalized_email=${email}`))[0] ?? null
  );
}
export function createSession(db: Db, row: {
  identityId: string;
  tokenHash: string;
  csrfHash: string;
  absolute: Date;
  idle: Date;
  idleTtl: number;
}) {
  return result(db.insert(webSessions).values({ identityId: row.identityId, tokenSha256: row.tokenHash,
    csrfSha256: row.csrfHash, absoluteExpiresAt: row.absolute, idleExpiresAt: row.idle, idleTtlMs: sql`${row.idleTtl}` }));
}
export async function session(db: Db, tokenHash: string) {
  return (
    (await execute<{
      session_id: string;
      identity_id: string;
      role: "platform_admin" | "business_user";
      business_id: string | null;
      csrf_sha256: string;
    }>(db, sql`select s.id session_id,i.id identity_id,i.role,i.business_id,s.csrf_sha256 from web_sessions s join auth_identities i on i.id=s.identity_id left join businesses b on b.id=i.business_id where s.token_sha256=${tokenHash} and s.revoked_at is null and s.absolute_expires_at>now() and s.idle_expires_at>now() and i.active and (i.role='platform_admin' or b.status='active')`))[0] ?? null
  );
}
export async function touchSession(db: Db, id: string, legacyIdleTtl: number): Promise<boolean> {
  const rows = await execute(db, sql`update web_sessions s set last_seen_at=clock_timestamp(), idle_expires_at=least(s.absolute_expires_at, clock_timestamp() + coalesce(s.idle_ttl_ms, ${legacyIdleTtl}) * interval '1 millisecond')
    from auth_identities i left join businesses b on b.id=i.business_id
    where s.id=${id} and i.id=s.identity_id and s.revoked_at is null and s.absolute_expires_at>clock_timestamp() and s.idle_expires_at>clock_timestamp()
      and i.active and (i.role='platform_admin' or b.status='active') returning s.id`);
  return rows.length > 0;
}
export function revokeSession(db: Db, tokenHash: string) {
  return result(db.update(webSessions).set({ revokedAt: sql`now()` })
    .where(and(eq(webSessions.tokenSha256, tokenHash), isNull(webSessions.revokedAt))));
}
