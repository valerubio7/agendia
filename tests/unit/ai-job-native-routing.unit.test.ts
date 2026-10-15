import { describe, expect, test } from "bun:test";
import * as domain from "@agendia/domain";
import { DeepSeekAdapter } from "@agendia/ai-deepseek";
import { PostgresAiJobProcessor } from "../../apps/message-worker/src/ai-job.ts";
import * as agenda from "../../apps/message-worker/src/whatsapp-agenda.ts";

const generate = async () => ({ text: "hola", providerId: "fixture", usageTokens: 0 });
describe("native-only production worker boundary", () => {
  test("missing native capability fails closed at construction", () => {
    expect(() => new PostgresAiJobProcessor({} as any, { generate })).toThrow("converse");
    expect(() => new PostgresAiJobProcessor({} as any, { generate, converse: null } as any)).toThrow("converse");
  });
  test("valid native capability constructs without generation or proposal shims", () => {
    const provider = { generate, converse: async () => ({ message: { role: "assistant" as const, content: "Hola", toolCalls: [] }, providerId: "fixture", usageTokens: 0 }) };
    expect(() => new PostgresAiJobProcessor({} as any, provider)).not.toThrow();
    expect(typeof new DeepSeekAdapter({ apiKey: "fixture" }).generate).toBe("function");
    expect(typeof new DeepSeekAdapter({ apiKey: "fixture" }).converse).toBe("function");
  });
  test("legacy proposal and interpreter surfaces are absent at runtime", () => {
    for (const name of ["AgendaProposalSchema", "AgendaProposalRequestSchema", "hasAgendaProposalProvider"])
      expect(Reflect.has(domain, name)).toBe(false);
    expect(Reflect.has(DeepSeekAdapter.prototype, "proposeAgenda")).toBe(false);
    expect(Reflect.has(agenda.PostgresWhatsAppAgenda.prototype, "process")).toBe(false);
    for (const name of ["isAgendaMessage", "factualQuestion", "renderFactualReply"])
      expect(Reflect.has(agenda, name)).toBe(false);
  });
});
