import { asc, sql } from "drizzle-orm";
import { pendingRegistrations } from "../schema.ts";
import { execute, result, type Db } from "./shared.ts";

export async function admitRegistration(db: Db) {
  return (await execute<{ admitted: boolean }>(db, sql`select admit_registration() admitted`))[0]?.admitted === true;
}
export async function submitRegistration(db: Db, name: string, email: string, phc: string) {
  return (await execute<{ created: boolean }>(db, sql`select submit_registration(${name},${email},${phc}) created`))[0]?.created === true;
}
export function listRegistrations(db: Db) {
  return result(db.select({ id: pendingRegistrations.id, name: pendingRegistrations.name,
    email: pendingRegistrations.email, createdAt: pendingRegistrations.createdAt }).from(pendingRegistrations)
    .orderBy(asc(pendingRegistrations.createdAt), asc(pendingRegistrations.id)));
}
export async function decideRegistration(db: Db, id: string, approve: boolean) {
  return (await execute<{ decided: boolean }>(db, sql`select decide_registration(${id},${approve}) decided`))[0]?.decided === true;
}
