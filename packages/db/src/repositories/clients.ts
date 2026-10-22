import type { PostgresRepositories } from "../repositories.ts";
import type { Db } from "./shared.ts";

export type ClientRegistryInput = {
  firstName: string;
  lastName: string;
  phone: string;
};
export type RegistryClient = ClientRegistryInput & { id: string };

// LIKE metacharacters are data, never a caller-controlled search pattern.
const literalSearch = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;

export function listClients(db: Db, q = "") {
  const pattern = literalSearch(q);
  return db<RegistryClient[]>`
      select id,first_name "firstName",last_name "lastName",phone from clients
      where first_name collate service_name_case ilike ${pattern}
         or last_name collate service_name_case ilike ${pattern}
         or phone ilike ${pattern}
      order by lower(first_name collate service_name_case) collate "C",
        lower(last_name collate service_name_case) collate "C",phone,id`;
}
export async function getClientById(db: Db, id: string) {
  const [row] = await db<RegistryClient[]>`
      select id,first_name "firstName",last_name "lastName",phone from clients where id=${id}`;
  return row ?? null;
}
// Exact stored identity only: no manual-country/type inference or aliases.
export async function findClientByCanonicalPhone(db: Db, phone: string) {
  const [row] = await db<RegistryClient[]>`
      select id,first_name "firstName",last_name "lastName",phone from clients where phone=${phone}`;
  return row ?? null;
}
export async function createClient(db: Db, repo: PostgresRepositories, businessId: string, input: ClientRegistryInput) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const [row] = await db<RegistryClient[]>`
      insert into clients(business_id,first_name,last_name,phone)
      values(${businessId},${input.firstName},${input.lastName},${input.phone})
      returning id,first_name "firstName",last_name "lastName",phone`;
  return row!;
}
export async function updateClient(db: Db, repo: PostgresRepositories, businessId: string, id: string, input: ClientRegistryInput) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const [row] = await db<RegistryClient[]>`
      update clients set first_name=${input.firstName},last_name=${input.lastName},phone=${input.phone}
      where business_id=${businessId} and id=${id} returning id,first_name "firstName",last_name "lastName",phone`;
  return row ?? null;
}
