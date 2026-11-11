import { ResourceInputSchema, isResourceScheduleWithinBusiness, normalizeWeeklySchedule, isStructurallyAvailable,
  parseInstantMs, type EpochInterval, type ResourceInput } from "@agendia/domain";
import type { PostgresRepositories } from "../repositories.ts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { services, resources, resourceServices, serviceCategories } from "../schema.ts";
import { appointmentId, asDbJson, execute, result, type Db } from "./shared.ts";

export type CatalogResource = Omit<ResourceInput, "description"> & {
  id: string; description: string | null; status: "active" | "suspended";
};
/** B2 maps these domain conflicts to safe HTTP errors; no persistence details escape. */
export class ResourceCatalogError extends Error {
  constructor(readonly code: "UNKNOWN_SERVICE" | "HOURS_CONFLICT" | "FUTURE_APPOINTMENT_CONFLICT") { super(code); }
}

export type SavedAppointmentInterval = { startRaw: string; startMs: string; endMs: string; durationMinutes: number };
export function appointmentInterval(row: SavedAppointmentInterval): EpochInterval {
  const startMs = Number(row.startMs), endMs = Number(row.endMs);
  if (parseInstantMs(row.startRaw) !== startMs || !Number.isSafeInteger(endMs) || endMs <= startMs
    || endMs > 253402387139999 || !Number.isSafeInteger(row.durationMinutes) || row.durationMinutes <= 0
    || row.durationMinutes % 5 !== 0 || endMs !== startMs + row.durationMinutes * 60000)
    throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
  return { startMs, endMs };
}

export type ServiceCatalogInput = {
  name: string;
  description?: string | undefined;
  durationMinutes: number;
  priceArs: number;
  categoryId?: string | null | undefined;
};
export type CatalogService = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceArs: number;
  status: "active" | "suspended";
  categoryId: string | null;
};

export function listResources(db: Db, businessId: string) {
  return execute<CatalogResource>(db, sql`select r.id,r.name,r.description,r.status,r.weekly_schedule "weeklySchedule",
      array(select rs.service_id::text from resource_services rs join services s on (s.business_id,s.id)=(rs.business_id,rs.service_id)
        where rs.business_id=r.business_id and rs.resource_id=r.id and s.deleted_at is null order by rs.service_id) "serviceIds"
      from resources r where r.business_id=${businessId} and r.deleted_at is null order by r.normalized_name,r.id`);
}
export async function getResource(db: Db, businessId: string, id: string) {
  const [row] = await execute<CatalogResource>(db, sql`select r.id,r.name,r.description,r.status,r.weekly_schedule "weeklySchedule",
      array(select rs.service_id::text from resource_services rs join services s on (s.business_id,s.id)=(rs.business_id,rs.service_id)
        where rs.business_id=r.business_id and rs.resource_id=r.id and s.deleted_at is null order by rs.service_id) "serviceIds"
      from resources r where r.business_id=${businessId} and r.id=${id} and r.deleted_at is null`);
  return row ?? null;
}
async function validateResource(db: Db, repo: PostgresRepositories, businessId: string, input: ResourceInput) {
  const valid = ResourceInputSchema.parse(input);
  const calendar = await repo.getBusinessCalendar(businessId);
  if (!isResourceScheduleWithinBusiness(valid.weeklySchedule, calendar.weeklySchedule ?? {}))
    throw new ResourceCatalogError("HOURS_CONFLICT");
  if (valid.serviceIds.length) {
    const owned = await result(db.select({ id: services.id }).from(services)
      .where(and(eq(services.businessId, businessId), isNull(services.deletedAt), inArray(services.id, valid.serviceIds))));
    if (owned.length !== valid.serviceIds.length) throw new ResourceCatalogError("UNKNOWN_SERVICE");
  }
  return valid;
}
async function replaceResourceServices(db: Db, businessId: string, id: string, serviceIds: string[]) {
  await result(db.delete(resourceServices).where(and(eq(resourceServices.businessId, businessId), eq(resourceServices.resourceId, id))));
  if (serviceIds.length) await result(db.insert(resourceServices).values(serviceIds.map(serviceId => ({
    businessId, resourceId: id, serviceId,
  }))));
}
/** All mutations require a tenant transaction; assignments and caller audit/outbox share its rollback. */
export async function createResource(db: Db, repo: PostgresRepositories, businessId: string, input: ResourceInput): Promise<CatalogResource> {
  await repo.acquireBusinessCalendarLock({ businessId });
  const valid = await validateResource(db, repo, businessId, input);
  const [row] = await result(db.insert(resources).values({ businessId, name: valid.name,
    description: valid.description ?? null, weeklySchedule: asDbJson(valid.weeklySchedule) }).returning({ id: resources.id }));
  await replaceResourceServices(db, businessId, row!.id, valid.serviceIds);
  return (await repo.getResource(businessId, row!.id))!;
}
/** Protect all strictly future states, using agreed appointment duration rather than current catalog terms. */
async function guardResourceAppointments(db: Db, businessId: string, current: CatalogResource, proposed: ResourceInput, nowMs: number) {
  const hoursChanged = JSON.stringify(normalizeWeeklySchedule(current.weeklySchedule))
    !== JSON.stringify(normalizeWeeklySchedule(proposed.weeklySchedule));
  const removedAssignment = current.serviceIds.some(serviceId => !proposed.serviceIds.includes(serviceId));
  if (!hoursChanged && !removedAssignment) return;
  if (!Number.isSafeInteger(nowMs)) throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
  const appointments = await execute<SavedAppointmentInterval & { serviceId: string }>(db, sql`
      select service_id "serviceId",start_raw "startRaw",start_ms "startMs",end_ms "endMs",duration_minutes "durationMinutes"
      from appointments where business_id=${businessId} and resource_id=${current.id} and start_ms>${nowMs}`);
  for (const appointment of appointments) {
    appointmentInterval(appointment); // Hostile raw SQL must not cause a false pass.
    if (!proposed.serviceIds.includes(appointment.serviceId)
      || !isStructurallyAvailable({ start: appointment.startRaw, durationMinutes: appointment.durationMinutes,
        businessHours: proposed.weeklySchedule, resourceHours: proposed.weeklySchedule }))
      throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
  }
}
export async function updateResource(db: Db, repo: PostgresRepositories, businessId: string, id: string, input: ResourceInput): Promise<CatalogResource | null> {
  await repo.acquireBusinessCalendarLock({ businessId });
  const nowMs = Date.now(); // One server clock, after locking; never a request/model field.
  const current = await repo.getResource(businessId, id);
  if (!current) return null;
  const valid = await validateResource(db, repo, businessId, input);
  await guardResourceAppointments(db, businessId, current, valid, nowMs);
  await result(db.update(resources).set({ name: valid.name, description: valid.description ?? null,
    weeklySchedule: asDbJson(valid.weeklySchedule) }).where(and(eq(resources.businessId, businessId), eq(resources.id, id), isNull(resources.deletedAt))));
  await replaceResourceServices(db, businessId, id, valid.serviceIds);
  return repo.getResource(businessId, id);
}
export async function setResourceStatus(db: Db, repo: PostgresRepositories, businessId: string, id: string, status: CatalogResource["status"]): Promise<CatalogResource | null> {
  await repo.acquireBusinessCalendarLock({ businessId });
  await result(db.update(resources).set({ status }).where(and(eq(resources.businessId, businessId), eq(resources.id, id), isNull(resources.deletedAt))));
  return repo.getResource(businessId, id);
}
export function listServiceCategories(db: Db) {
  return result(db.select({ id: serviceCategories.id, name: serviceCategories.name }).from(serviceCategories)
    .orderBy(asc(serviceCategories.name), asc(serviceCategories.id)));
}
export async function createServiceCategory(db: Db, businessId: string, name: string) {
  const [row] = await result(db.insert(serviceCategories).values({ businessId, name })
    .returning({ id: serviceCategories.id, name: serviceCategories.name }));
  return row!;
}
export async function deleteServiceCategory(db: Db, repo: PostgresRepositories, businessId: string, id: string) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const [category] = await result(db.select({ id: serviceCategories.id }).from(serviceCategories)
    .where(and(eq(serviceCategories.businessId, businessId), eq(serviceCategories.id, id))));
  if (!category) return false;
  await result(db.update(services).set({ categoryId: null }).where(and(eq(services.businessId, businessId), eq(services.categoryId, id))));
  await result(db.delete(serviceCategories).where(and(eq(serviceCategories.businessId, businessId), eq(serviceCategories.id, id))));
  return true;
}
const serviceProjection = {
  id: services.id,
  name: services.name,
  description: services.description,
  durationMinutes: services.durationMinutes,
  priceArs: sql<number>`${services.priceArs}::float8`,
  status: sql<CatalogService["status"]>`${services.status}`,
  categoryId: services.categoryId,
};
export function listServices(db: Db) {
  return result(db.select(serviceProjection).from(services).where(isNull(services.deletedAt))
    .orderBy(asc(services.normalizedName), asc(services.id)));
}
export async function createService(db: Db, repo: PostgresRepositories, businessId: string, input: ServiceCatalogInput) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const [row] = await result(db.insert(services).values({ businessId, name: input.name,
    description: input.description ?? null, durationMinutes: input.durationMinutes,
    priceArs: sql`${input.priceArs}`, categoryId: input.categoryId ?? null }).returning(serviceProjection));
  return row!;
}
export async function updateService(db: Db, repo: PostgresRepositories, businessId: string, id: string, input: ServiceCatalogInput) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const [row] = await result(db.update(services).set({ name: input.name, description: input.description ?? null,
    durationMinutes: input.durationMinutes, priceArs: sql`${input.priceArs}`,
    categoryId: sql`case when ${input.categoryId !== undefined} then ${input.categoryId ?? null}::uuid else ${services.categoryId} end`,
  }).where(and(eq(services.businessId, businessId), eq(services.id, id), isNull(services.deletedAt)))
    .returning(serviceProjection));
  return row ?? null;
}
export async function setServiceStatus(db: Db, repo: PostgresRepositories, businessId: string, id: string, status: CatalogService["status"]) {
  await repo.acquireBusinessCalendarLock({ businessId });
  const [row] = await result(db.update(services).set({ status })
    .where(and(eq(services.businessId, businessId), eq(services.id, id), isNull(services.deletedAt))).returning(serviceProjection));
  return row ?? null;
}
/** Internal retirement only: caller UoW owns tombstone + links + audit/outbox rollback. */
export async function retireCatalogItem(db: Db, repo: PostgresRepositories, businessId: string, id: string, table: "services" | "resources") {
  await repo.acquireBusinessCalendarLock({ businessId });
  const nowMs = Date.now();
  const ownedId = appointmentId.safeParse(id);
  if (!ownedId.success) return false;
  id = ownedId.data;
  const [owned] = await execute(db, sql`select id from ${sql.identifier(table)} where business_id=${businessId} and id=${id} and deleted_at is null`);
  if (!owned) return false;
  if (!Number.isSafeInteger(nowMs)) throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
  const column = table === "services" ? "service_id" : "resource_id";
  // ALL states, actual assignment only. A historical preference FK does not reserve this resource.
  const future = await execute(db, sql`select id from appointments where business_id=${businessId}
      and ${sql.identifier(column)}=${id} and start_ms>${nowMs} limit 1`);
  if (future.length) throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
  const updated = await execute(db, sql`update ${sql.identifier(table)} set deleted_at=${new Date(nowMs).toISOString()}
      where business_id=${businessId} and id=${id} and deleted_at is null returning id`);
  if (!updated.length) return false;
  await execute(db, sql`delete from resource_services where business_id=${businessId} and ${sql.identifier(column)}=${id}`);
  return true;
}
