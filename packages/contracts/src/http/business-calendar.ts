import type { BusinessClosure, BusinessClosureInput } from "@agendia/domain/business-calendar";
import type { WeeklySchedule } from "@agendia/domain/agenda-availability";

export type BusinessClosureDto = BusinessClosure;
export type BusinessClosureRequest = BusinessClosureInput;

/** Null means unconfigured; an empty map is explicitly all off. */
export type BusinessCalendarDto = { weeklySchedule: WeeklySchedule | null };
export type BusinessCalendarInput = { weeklySchedule: WeeklySchedule };
