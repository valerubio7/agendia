import { describe, expect, test } from "bun:test";
import {
  ConversationContextBuilder,
  InMemoryConversationHistory,
} from "../../packages/domain/src/messaging/conversation-context-builder.ts";

function history() {
  const repository = new InMemoryConversationHistory();
  repository.append("tenant-a", "chat-a", [
    { sequence: 1, role: "customer", text: "Necesito información" },
    { sequence: 2, role: "assistant", text: "El envío demora dos días", delivery: "sent" },
    { sequence: 3, role: "customer", text: "Perfecto, recordar mi dirección" },
    { sequence: 4, role: "assistant", text: "¿Cuál es tu zona?", delivery: "sent" },
    { sequence: 5, role: "customer", text: "¿Cuándo llega el envío?" },
  ]);
  repository.saveSummary("tenant-a", "chat-a", {
    version: 1, coveredThrough: 3, facts: ["Cliente consulta envío"], requests: ["Recordar dirección"],
    commitments: ["Entrega estimada en dos días"], preferences: [], openItems: ["Confirmar zona"],
  });
  return repository;
}

describe("complete-history conversation context representation", () => {
  test("takes the visible latest50 before excluding current group, without refill or clipping", () => {
    const repository = new InMemoryConversationHistory();
    repository.append("tenant-a", "chat-a", Array.from({ length: 60 }, (_, index) => ({
      id: `m${index + 1}`, sequence: index + 1, role: "customer" as const,
      text: index === 10 ? " \t" + "😀".repeat(9000) + "\n " : `turn-${index + 1}`,
    })));
    repository.append("tenant-a", "chat-a", [{ sequence: 61, role: "assistant", text: "ambiguous", delivery: "delivery_unknown" }]);
    const result = new ConversationContextBuilder(repository).build({
      businessId: "tenant-a", conversationId: "chat-a",
      currentGroupIds: ["m59", "m60"],
    });
    if (result.status !== "ready") throw new Error("expected ready context");
    expect(result.context.recent.map(turn => turn.sequence)).toEqual(Array.from({ length: 48 }, (_, index) => index + 11));
    expect(result.context.recent[0]?.text).toBe(" \t" + "😀".repeat(9000) + "\n ");
    expect(repository.listRaw("tenant-a", "chat-a")).toHaveLength(61);
  });
  test("keeps covered history alongside the unchanged previous summary without retrieval", () => {
    const repository = history();
    const result = new ConversationContextBuilder(repository).build({
      businessId: "tenant-a", conversationId: "chat-a",
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready context");
    expect(result.context.summary).toMatchObject({ version: 1, coveredThrough: 3 });
    expect(result.context).not.toHaveProperty("retrieved");
    expect(result.context.recent.map((turn) => turn.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(result.context.representsThrough).toBe(5);
    expect(repository.listRaw("tenant-a", "chat-a")).toHaveLength(5);
  });

  test("falls back to the recent window while a missing summary is generated", () => {
    const repository = history();
    repository.removeSummary("tenant-a", "chat-a");
    const result=new ConversationContextBuilder(repository).build({ businessId: "tenant-a", conversationId: "chat-a" });
    expect(result.status).toBe("ready");if(result.status!=="ready")throw new Error("expected fallback context");
    expect(result.context.summary).toBeNull();expect(result.context.recent.map(turn=>turn.sequence)).toEqual([1,2,3,4,5]);expect(repository.listRaw("tenant-a","chat-a")).toHaveLength(5);
  });

  test("requires tenant and conversation scope and never retrieves another chat", () => {
    const repository = history();
    repository.append("tenant-b", "chat-b", [{ sequence: 1, role: "customer", text: "SECRETO OTRO TENANT" }]);
    const builder = new ConversationContextBuilder(repository);
    expect(() => builder.build({ businessId: "", conversationId: "chat-a" })).toThrow("tenant and conversation are required");
    const result = builder.build({ businessId: "tenant-a", conversationId: "chat-a" });
    expect(JSON.stringify(result)).not.toContain("SECRETO OTRO TENANT");
  });

  test("uses only confirmed assistant turns without a representation budget", () => {
    const repository = history();
    repository.append("tenant-a", "chat-a", [{ sequence: 6, role: "assistant", text: "No entregado", delivery: "failed" }]);
    const result = new ConversationContextBuilder(repository).build({ businessId: "tenant-a", conversationId: "chat-a" });
    expect(result.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("No entregado");
    expect(result.status === "ready" && result.context.recent).toHaveLength(5);
  });
});
