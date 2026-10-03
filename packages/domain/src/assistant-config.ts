import { z } from "zod";
// Legacy VARCHAR limits count code points; JS and textarea limits count UTF-16 units.
// Keep "Label:\ntext" sections and their two-newline separators, without trimming.
export const ASSISTANT_STYLE_LIMIT = 32_000 + "Personalidad:\n".length + "Tono:\n".length + 2;
export const ASSISTANT_BUSINESS_INSTRUCTIONS_LIMIT = 64_000 + ["Instrucciones", "Conocimiento", "Reglas", "Restricciones"].reduce((n, label) => n + label.length + 2, 0) + 6;
export const AssistantConfigInputSchema = z.object({
  style: z.string().max(ASSISTANT_STYLE_LIMIT),
  businessInstructions: z.string().max(ASSISTANT_BUSINESS_INSTRUCTIONS_LIMIT),
  active: z.boolean(),
  expectedRevision: z.number().int().min(0),
});
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
