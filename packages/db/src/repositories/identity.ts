import type { Db } from "./shared.ts";

export function saveIdentity(db: Db, row: {
  email: string;
  passwordPhc: string;
  businessId: string;
}) {
  return db`insert into auth_identities (normalized_email,password_phc,role,business_id) values (${row.email},${row.passwordPhc},'business_user',${row.businessId})`;
}
export async function findIdentity(db: Db, email: string) {
  return (
    (
      await db<
        { business_id: string }[]
      >`select business_id from auth_identities where normalized_email=${email}`
    )[0] ?? null
  );
}
export async function admitLogin(db: Db, accountHash: string): Promise<boolean> {
  return (await db<{ admitted: boolean }[]>`select admit_login(${accountHash}) admitted`)[0]?.admitted === true;
}
export async function authIdentity(db: Db, email: string) {
  return (
    (
      await db<
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
export function createSession(db: Db, row: {
  identityId: string;
  tokenHash: string;
  csrfHash: string;
  absolute: Date;
  idle: Date;
}) {
  return db`insert into web_sessions(identity_id,token_sha256,csrf_sha256,absolute_expires_at,idle_expires_at) values(${row.identityId},${row.tokenHash},${row.csrfHash},${row.absolute},${row.idle})`;
}
export async function session(db: Db, tokenHash: string) {
  return (
    (
      await db<
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
export function touchSession(db: Db, id: string, idle: Date) {
  return db`update web_sessions set last_seen_at=now(),idle_expires_at=least(absolute_expires_at,${idle}) where id=${id}`;
}
export function revokeSession(db: Db, tokenHash: string) {
  return db`update web_sessions set revoked_at=now() where token_sha256=${tokenHash} and revoked_at is null`;
}
