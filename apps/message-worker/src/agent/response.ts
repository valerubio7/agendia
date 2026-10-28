import { z } from "zod";

const response = z.object({
  text: z.string().min(1).max(4000).refine(value => Boolean(value.trim())),
  presentedQuoteReference: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
export type AgentResponse = z.infer<typeof response>;

/** Validates shape, not prose truth or disclosure of proposal terms. Never rewrites text. */
export function renderAgentResponse(raw: string): AgentResponse {
  if (typeof raw !== "string" || raw.length > 4000) throw new Error("Agent final output limit");
  return response.parse(JSON.parse(raw));
}
