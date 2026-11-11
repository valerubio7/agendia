import { BusinessClosureInputSchema, parseInstantMs, WeeklyScheduleSchema, isResourceScheduleWithinBusiness,
  isEpochIntervalWithinWeeklySchedule, isEpochIntervalOpenForClosures, type EpochInterval,
  type BusinessClosure, type BusinessClosureInput, type WeeklySchedule } from "@agendia/domain";
import type { PostgresRepositories } from "../repositories.ts";
import { ResourceCatalogError, appointmentInterval, type SavedAppointmentInterval } from "./catalog.ts";
import { and, eq, sql } from "drizzle-orm";
import { businessCalendars, businessCalendarClosures } from "../schema.ts";
import { asDbJson, execute, result, type Db } from "./shared.ts";

export type BusinessCalendar = { weeklySchedule: WeeklySchedule };

type ClosureRow = { id: string; kind: string; date: string | null; start: string | null; end: string | null };
const closureDto = (row: ClosureRow): BusinessClosure => ({ id: row.id,
  ...BusinessClosureInputSchema.parse(row.kind === "date"
    ? { kind: row.kind, date: row.date } : { kind: row.kind, start: row.start, end: row.end }),
});
function closureValues(input: BusinessClosureInput) {
  const valid = BusinessClosureInputSchema.parse(input);
  return valid.kind === "date"
    ? { kind: valid.kind, date: valid.date, start: null, end: null, startMs: null, endMs: null }
    : { kind: valid.kind, date: null, start: valid.start, end: valid.end,
      startMs: parseInstantMs(valid.start)!, endMs: parseInstantMs(valid.end)! };
}

export async function getBusinessCalendar(db: Db, businessId: string): Promise<{ weeklySchedule: WeeklySchedule | null }> {
  const [row] = await result(db.select({ weeklySchedule: businessCalendars.weeklySchedule })
    .from(businessCalendars).where(eq(businessCalendars.businessId, businessId)));
  return { weeklySchedule: row ? WeeklyScheduleSchema.parse(row.weeklySchedule) : null };
}
/** Called only after the shared early lock; B2 protects Confirmed only, unlike B1 resources. */
async function futureConfirmedIntervals(db: Db, businessId: string, nowMs: number): Promise<EpochInterval[]> {
  if (!Number.isSafeInteger(nowMs)) throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
  const rows = await execute<SavedAppointmentInterval>(db, sql`select start_raw "startRaw",start_ms "startMs",end_ms "endMs",duration_minutes "durationMinutes"
      from appointments where business_id=${businessId} and state='confirmed' and start_ms>${nowMs}`);
  return rows.map(appointmentInterval);
}
async function guardClosureAppointments(db: Db, businessId: string, input: BusinessClosureInput, nowMs: number) {
  if ((await futureConfirmedIntervals(db, businessId, nowMs)).some(interval => !isEpochIntervalOpenForClosures(interval, [input])))
    throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
}
/** Transaction required; uses the same early lock as public calendar/closure callers. */
export async function saveBusinessCalendar(db: Db, repo: PostgresRepositories, businessId: string, weeklySchedule: WeeklySchedule): Promise<BusinessCalendar> {
  await repo.acquireBusinessCalendarLock({ businessId });
  const nowMs = Date.now();
  const valid = WeeklyScheduleSchema.parse(weeklySchedule);
  const resources = await repo.listResources(businessId);
  if (resources.some(resource => !isResourceScheduleWithinBusiness(resource.weeklySchedule, valid)))
    throw new ResourceCatalogError("HOURS_CONFLICT");
  if ((await futureConfirmedIntervals(db, businessId, nowMs)).some(interval => !isEpochIntervalWithinWeeklySchedule(interval, valid)))
    throw new ResourceCatalogError("FUTURE_APPOINTMENT_CONFLICT");
  const normalized = asDbJson(valid);
  const [row] = await result(db.insert(businessCalendars).values({ businessId, weeklySchedule: normalized })
    .onConflictDoUpdate({ target: businessCalendars.businessId, set: { weeklySchedule: normalized } })
    .returning({ weeklySchedule: sql<WeeklySchedule>`${businessCalendars.weeklySchedule}` }));
  return row!;
}
export async function listBusinessClosures(db: Db, businessId: string): Promise<BusinessClosure[]> {
  const rows = await execute<ClosureRow>(db, sql`select id,kind,closed_date::text date,start_raw start,end_raw "end"
      from business_calendar_closures where business_id=${businessId} order by id`);
  return rows.map(closureDto);
}
/** All closure mutations require the shared early calendar lock in the caller's UoW. */
export async function createBusinessClosure(db: Db, repo: PostgresRepositories, businessId: string, input: BusinessClosureInput): Promise<BusinessClosure> {
  await repo.acquireBusinessCalendarLock({ businessId });
  const nowMs = Date.now();
  const v = closureValues(input);
  await guardClosureAppointments(db, businessId, input, nowMs);
  const [row] = await execute<ClosureRow>(db, sql`insert into business_calendar_closures
      (business_id,kind,closed_date,start_raw,end_raw,start_ms,end_ms)
      values(${businessId},${v.kind},${v.date},${v.start},${v.end},${v.startMs},${v.endMs})
      returning id,kind,closed_date::text date,start_raw start,end_raw "end"`);
  return closureDto(row!);
}
export async function updateBusinessClosure(db: Db, repo: PostgresRepositories, businessId: string, id: string, input: BusinessClosureInput): Promise<BusinessClosure | null> {
  await repo.acquireBusinessCalendarLock({ businessId });
  const nowMs = Date.now();
  const [owned] = await result(db.select({ id: businessCalendarClosures.id }).from(businessCalendarClosures)
    .where(and(eq(businessCalendarClosures.businessId, businessId), eq(businessCalendarClosures.id, id))));
  if (!owned) return null;
  const v = closureValues(input);
  await guardClosureAppointments(db, businessId, input, nowMs);
  const [row] = await execute<ClosureRow>(db, sql`update business_calendar_closures set kind=${v.kind},closed_date=${v.date},
      start_raw=${v.start},end_raw=${v.end},start_ms=${v.startMs},end_ms=${v.endMs}
      where business_id=${businessId} and id=${id}
      returning id,kind,closed_date::text date,start_raw start,end_raw "end"`);
  return row ? closureDto(row) : null;
}
export async function deleteBusinessClosure(db: Db, repo: PostgresRepositories, businessId: string, id: string): Promise<boolean> {
  await repo.acquireBusinessCalendarLock({ businessId });
  const rows = await result(db.delete(businessCalendarClosures)
    .where(and(eq(businessCalendarClosures.businessId, businessId), eq(businessCalendarClosures.id, id)))
    .returning({ id: businessCalendarClosures.id }));
  return rows.length > 0;
}
