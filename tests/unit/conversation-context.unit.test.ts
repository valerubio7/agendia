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
  test("combines an exact prefix summary, relevant literal retrieval and recent contiguous window", () => {
    const repository = history();
    const result = new ConversationContextBuilder(repository).build({
      businessId: "tenant-a", conversationId: "chat-a", query: "envío", maxCharacters: 1_000,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready context");
    expect(result.context.summary).toMatchObject({ version: 1, coveredThrough: 3 });
    expect(result.context.retrieved.map((turn) => turn.sequence)).toEqual([2]);
    expect(result.context.recent.map((turn) => turn.sequence)).toEqual([4, 5]);
    expect(result.context.representsThrough).toBe(5);
    expect(repository.listRaw("tenant-a", "chat-a")).toHaveLength(5);
  });

  test("falls back to the recent window while a missing summary is generated", () => {
    const repository = history();
    repository.removeSummary("tenant-a", "chat-a");
    const result=new ConversationContextBuilder(repository).build({ businessId: "tenant-a", conversationId: "chat-a", query: "envío", maxCharacters: 100 });
    expect(result.status).toBe("ready");if(result.status!=="ready")throw new Error("expected fallback context");
    expect(result.context.summary).toBeNull();expect(result.context.recent.map(turn=>turn.sequence)).toEqual([4,5]);expect(repository.listRaw("tenant-a","chat-a")).toHaveLength(5);
  });

  test("requires tenant and conversation scope and never retrieves another chat", () => {
    const repository = history();
    repository.append("tenant-b", "chat-b", [{ sequence: 1, role: "customer", text: "SECRETO OTRO TENANT" }]);
    const builder = new ConversationContextBuilder(repository);
    expect(() => builder.build({ businessId: "", conversationId: "chat-a", query: "envío", maxCharacters: 1_000 })).toThrow("tenant and conversation are required");
    const result = builder.build({ businessId: "tenant-a", conversationId: "chat-a", query: "SECRETO", maxCharacters: 1_000 });
    expect(JSON.stringify(result)).not.toContain("SECRETO OTRO TENANT");
  });

  test("uses only confirmed assistant turns and enforces the representation budget", () => {
    const repository = history();
    repository.append("tenant-a", "chat-a", [{ sequence: 6, role: "assistant", text: "No entregado", delivery: "failed" }]);
    const result = new ConversationContextBuilder(repository).build({ businessId: "tenant-a", conversationId: "chat-a", query: "entregado", maxCharacters: 260 });
    expect(result.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("No entregado");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(420);
  });
});
