import { z } from "zod";
// Legacy VARCHAR limits count code points; JS and textarea limits count UTF-16 units.
// Keep "Label:\ntext" sections and their two-newline separators, without trimming.
export const AGENT_STYLE_LIMIT = 32_000 + "Personalidad:\n".length + "Tono:\n".length + 2;
export const AGENT_BUSINESS_INSTRUCTIONS_LIMIT = 64_000 + ["Instrucciones", "Conocimiento", "Reglas", "Restricciones"].reduce((n, label) => n + label.length + 2, 0) + 6;
export const AgentConfigInputSchema = z.object({
  style: z.string().max(AGENT_STYLE_LIMIT),
  businessInstructions: z.string().max(AGENT_BUSINESS_INSTRUCTIONS_LIMIT),
  active: z.boolean(),
  expectedRevision: z.number().int().min(0),
});
export type AgentConfig = Omit<z.infer<typeof AgentConfigInputSchema>, "expectedRevision"> & { revision: number };
export class InMemoryAgentRepository { readonly rows = new Map<string, AgentConfig>(); }
export class AgentConfigService {
  constructor(private readonly repository: InMemoryAgentRepository) {}
  save(businessId: string, input: unknown): AgentConfig {
    const parsed = AgentConfigInputSchema.parse(input); const current = this.repository.rows.get(businessId);
    if ((current?.revision ?? 0) !== parsed.expectedRevision) throw new Error("Revision conflict");
    const { expectedRevision: _, ...fields } = parsed; const saved = { ...fields, revision: parsed.expectedRevision + 1 }; this.repository.rows.set(businessId, saved); return saved;
  }
  get(businessId: string) { return this.repository.rows.get(businessId) ?? null; }
}
export function isAutomationEligible(input: { businessStatus: "active" | "suspended"; agentActive: boolean; whatsappStatus: "connected" | "disconnected" | "link_required" | "error"; withinBusinessHours: boolean }): boolean {
  return input.businessStatus === "active" && input.agentActive && input.whatsappStatus === "connected";
}
