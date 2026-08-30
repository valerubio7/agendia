import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);
export const BusinessProfileSchema = z.object({
  displayName: text(160).min(1), description: text(4_000), address: text(500), contact: text(500),
  businessHours: text(2_000), offerings: text(8_000), faq: text(8_000), policies: text(8_000), additionalInfo: text(8_000),
});
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;
export class InMemoryProfileRepository { readonly rows = new Map<string, BusinessProfile>(); }
export class ProfileService {
  constructor(private readonly repository: InMemoryProfileRepository) {}
  save(authenticatedBusinessId: string, input: unknown): BusinessProfile { const profile = BusinessProfileSchema.parse(input); this.repository.rows.set(authenticatedBusinessId, profile); return profile; }
  get(authenticatedBusinessId: string): BusinessProfile | null { return this.repository.rows.get(authenticatedBusinessId) ?? null; }
}
export function serializeProfileForAi(profile: BusinessProfile): string {
  return Object.entries(profile).map(([field, value]) => `${field}: ${value}`).join("\n");
}
