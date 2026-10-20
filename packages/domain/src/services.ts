import { z } from "zod";

export const ServiceInputSchema = z.object({
  name: z.string().trim().min(1).refine(text => !text.includes("\u0000")),
  description: z.string().refine(text => !text.includes("\u0000")).optional(),
  durationMinutes: z.number().int().positive().multipleOf(15),
  priceArs: z.number().finite().nonnegative(),
});

export type ServiceInput = z.infer<typeof ServiceInputSchema>;

export interface ServiceNameEntry {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
}

export function normalizeServiceName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Advisory check for a validated name within an application-provided business scope.
 * The scope is not authorization; persistence must enforce uniqueness atomically.
 * Supply the edited service ID to exclude that record, not other matching records.
 */
export function isServiceNameAvailable(
  businessId: string,
  name: string,
  services: readonly ServiceNameEntry[],
  editedServiceId?: string,
): boolean {
  const normalizedName = normalizeServiceName(name);
  return !services.some((service) =>
    service.businessId === businessId
    && service.id !== editedServiceId
    && normalizeServiceName(service.name) === normalizedName,
  );
}
