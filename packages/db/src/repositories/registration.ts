import type { Db } from "./shared.ts";

export async function admitRegistration(db: Db) {
  return (await db<{ admitted: boolean }[]>`select admit_registration() admitted`)[0]?.admitted === true;
}
export async function submitRegistration(db: Db, name: string, email: string, phc: string) {
  return (await db<{ created: boolean }[]>`select submit_registration(${name},${email},${phc}) created`)[0]?.created === true;
}
export function listRegistrations(db: Db) {
  return db`select id,name,email,created_at "createdAt" from pending_registrations order by created_at,id`;
}
export async function decideRegistration(db: Db, id: string, approve: boolean) {
  return (await db<{ decided: boolean }[]>`select decide_registration(${id},${approve}) decided`)[0]?.decided === true;
}
