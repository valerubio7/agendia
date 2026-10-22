import {
  ToolAssistantMessageSchema, ToolConversationRequestSchema, TOOL_CONVERSATION_LIMITS,
  type ToolConversationMessage, type ToolConversationProvider,
} from "@agendia/domain";
import { AiProviderError } from "@agendia/ai-deepseek";
import { REQUEST_BUDGET_BYTES, requestBytes } from "./limits.ts";
import { receptionistToolDefinitions, type ReceptionistToolSession } from "./tools.ts";
/** No repository is exposed to the provider. Cancellation closes authority before
 * racing continuations can resume; in-flight SQL drains before T2 rolls back. */
export async function converseReceptionist(provider: ToolConversationProvider, session: ReceptionistToolSession,
  initial: ToolConversationMessage[], correlationId: string, options: { durationMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  const controller = new AbortController();
  const messages = structuredClone(initial);
  const usedIds = new Set<string>();
  let callCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const stop = (error: Error) => {
    session.close(); controller.abort(); rejectDeadline(error);
  };
  const expire = () => stop(new AiProviderError("timeout"));
  // Caller cancellation is not a provider timeout. Use the standard AbortError
  // rather than inventing an AI error code or classifying arbitrary error prose.
  const cancel = () => stop(new DOMException("Receptionist caller cancelled", "AbortError"));
  const assertOpen = () => { if (controller.signal.aborted) throw new Error("Receptionist cancelled"); };
  const loop = async () => {
    for (let round = 0; round < 6; round++) {
      assertOpen();
      const request = ToolConversationRequestSchema.parse({ messages, tools: receptionistToolDefinitions,
        maxOutputCharacters: 4000, correlationId });
      // Leave space for wire-specific fields; adapter also validates its exact body.
      if (requestBytes(messages) > REQUEST_BUDGET_BYTES) throw new Error("Receptionist request limit");
      const result = await provider.converse(request, controller.signal);
      assertOpen();
      const message = ToolAssistantMessageSchema.parse(result.message);
      if ((message.content?.length ?? 0) > 4000) throw new Error("Receptionist output limit");
      const batchIds = new Set<string>();
      for (const call of message.toolCalls) {
        if (usedIds.has(call.id) || batchIds.has(call.id) || !receptionistToolDefinitions.some(tool => tool.name === call.name))
          throw new Error("Invalid receptionist tool batch");
        batchIds.add(call.id);
      }
      callCount += message.toolCalls.length;
      if (callCount > 16 || messages.length + 1 + message.toolCalls.length > TOOL_CONVERSATION_LIMITS.messages)
        throw new Error("Receptionist call limit");
      if (!message.toolCalls.length) return message.content!.trim();
      messages.push(message);
      for (const call of message.toolCalls) {
        assertOpen();
        const output = await session.execute(call.name, call.arguments);
        assertOpen();
        usedIds.add(call.id);
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(output) });
      }
    }
    throw new Error("Receptionist round limit");
  };
  timer = setTimeout(expire, options.durationMs ?? 20_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try { return await Promise.race([deadline, loop()]); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    session.close(); controller.abort();
    await session.drain();
  }
}
