import { and, eq, sql } from "drizzle-orm";
import { clients } from "../schema.ts";
import type { PostgresRepositories } from "../repositories.ts";
import { execute, result, type Db } from "./shared.ts";

export type ClientRegistryInput = {
  firstName: string;
  lastName: string;
  phone: string;
};
export type RegistryClient = ClientRegistryInput & { id: string };
const projection = { id: clients.id, firstName: clients.firstName, lastName: clients.lastName, phone: clients.phone };

// LIKE metacharacters are data, never a caller-controlled search pattern.
const literalSearch = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;

export function listClients(db: Db, q = "") {
  const pattern = literalSearch(q);
  return execute<RegistryClient>(db, sql`
      select id,first_name "firstName",last_name "lastName",phone from clients
      where first_name collate service_name_case ilike ${pattern}
         or last_name collate service_name_case ilike ${pattern}
         or phone ilike ${pattern}
      order by lower(first_name collate service_name_case) collate "C",
        lower(last_name collate service_name_case) collate "C",phone,id`);
}
export async function getClientById(db: Db, id: string) {
  const [row] = await result(db.select(projection).from(clients).where(eq(clients.id, id)));
  return row ?? null;
}
// Exact stored identity only: no manual-country/type inference or aliases.
export async function findClientByCanonicalPhone(db: Db, phone: string) {
  const [row] = await result(db.select(projection).from(clients).where(eq(clients.phone, phone)));
  return row ?? null;
}
export async function createClient(db: Db, repo: PostgresRepositories, businessId: string, input: ClientRegistryInput) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const [row] = await result(db.insert(clients).values({ businessId, ...input }).returning(projection));
  return row!;
}
export async function updateClient(db: Db, repo: PostgresRepositories, businessId: string, id: string, input: ClientRegistryInput) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const [row] = await result(db.update(clients).set(input)
    .where(and(eq(clients.businessId, businessId), eq(clients.id, id))).returning(projection));
  return row ?? null;
}
