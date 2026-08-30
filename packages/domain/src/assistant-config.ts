import { z } from "zod";
const bounded = z.string().trim().max(8_000);
export const AssistantConfigInputSchema = z.object({ personality: bounded, tone: bounded, instructions: bounded, knowledge: bounded, rules: bounded, restrictions: bounded, active: z.boolean(), expectedRevision: z.number().int().min(0) });
export type AssistantConfig = Omit<z.infer<typeof AssistantConfigInputSchema>, "expectedRevision"> & { revision: number };
export class InMemoryAssistantRepository { readonly rows = new Map<string, AssistantConfig>(); }
export class AssistantConfigService {
  constructor(private readonly repository: InMemoryAssistantRepository) {}
  save(businessId: string, input: unknown): AssistantConfig {
    const parsed = AssistantConfigInputSchema.parse(input); const current = this.repository.rows.get(businessId);
    if ((current?.revision ?? 0) !== parsed.expectedRevision) throw new Error("Revision conflict");
    const { expectedRevision: _, ...fields } = parsed; const saved = { ...fields, revision: parsed.expectedRevision + 1 }; this.repository.rows.set(businessId, saved); return saved;
  }
  get(businessId: string) { return this.repository.rows.get(businessId) ?? null; }
}
export function isAutomationEligible(input: { businessStatus: "active" | "suspended"; assistantActive: boolean; whatsappStatus: "connected" | "disconnected" | "link_required" | "error"; withinBusinessHours: boolean }): boolean {
  return input.businessStatus === "active" && input.assistantActive && input.whatsappStatus === "connected";
}
