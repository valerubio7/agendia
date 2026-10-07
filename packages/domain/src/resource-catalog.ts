import { z } from "zod";
import { WeeklyScheduleSchema } from "./agenda-availability.ts";
import {
  ServiceInputSchema,
  isServiceNameAvailable,
  normalizeServiceName,
  type ServiceNameEntry,
} from "./service-catalog.ts";

export const ResourceInputSchema = z.object({
  name: ServiceInputSchema.shape.name,
  description: ServiceInputSchema.shape.description,
  // PostgreSQL UUIDs are case-insensitive; keep first-seen order for the logical set.
  serviceIds: z.array(z.uuid().transform((id) => id.toLowerCase()))
    .transform((ids) => [...new Set(ids)]),
  weeklySchedule: WeeklyScheduleSchema,
});

export type ResourceInput = z.infer<typeof ResourceInputSchema>;
export type ResourceNameEntry = ServiceNameEntry;
export const normalizeResourceName = normalizeServiceName;
export const isResourceNameAvailable = isServiceNameAvailable;

/** Minimal catalog facts; callers supply validated canonical IDs and establish ownership separately. */
export function isResourceEligibleForService(
  resource: { readonly status: "active" | "suspended"; readonly serviceIds: readonly string[] },
  service: { readonly id: string; readonly status: "active" | "suspended" },
): boolean {
  return resource.status === "active"
    && service.status === "active"
    && resource.serviceIds.includes(service.id);
}
