import {
  ToolAgentMessageSchema, ToolConversationRequestSchema, TOOL_CONVERSATION_LIMITS,
  type ToolConversationMessage, type ToolConversationProvider,
} from "@agendia/domain";
import { AiProviderError } from "@agendia/ai-deepseek";
import { REQUEST_BUDGET_BYTES, requestBytes } from "./limits.ts";
import { agentToolDefinitions, type AgentToolSession } from "./tools.ts";
/** No repository is exposed to the provider. Cancellation closes authority before
 * racing continuations can resume; in-flight SQL drains before T2 rolls back. */
export async function converseAgent(provider: ToolConversationProvider, session: AgentToolSession,
  initial: ToolConversationMessage[], correlationId: string, options: { durationMs?: number; signal?: AbortSignal; repairFinalJson?: boolean } = {}): Promise<string> {
  const controller = new AbortController();
  const messages = structuredClone(initial);
  const usedIds = new Set<string>();
  let callCount = 0;
  let repairingFinal = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const stop = (error: Error) => {
    session.close(); controller.abort(); rejectDeadline(error);
  };
  const expire = () => stop(new AiProviderError("timeout"));
  // Caller cancellation is not a provider timeout. Use the standard AbortError
  // rather than inventing an AI error code or classifying arbitrary error prose.
  const cancel = () => stop(new DOMException("Agent caller cancelled", "AbortError"));
  const assertOpen = () => { if (controller.signal.aborted) throw new Error("Agent cancelled"); };
  const loop = async () => {
    for (let round = 0; round < 6; round++) {
      assertOpen();
      const request = ToolConversationRequestSchema.parse({ messages, tools: agentToolDefinitions,
        maxOutputCharacters: 4000, correlationId });
      // Leave space for wire-specific fields; adapter also validates its exact body.
      if (requestBytes(messages) > REQUEST_BUDGET_BYTES) throw new Error("Agent request limit");
      const result = await provider.converse(request, controller.signal);
      assertOpen();
      const message = ToolAgentMessageSchema.parse(result.message);
      if ((message.content?.length ?? 0) > 4000) throw new Error("Agent output limit");
      const batchIds = new Set<string>();
      for (const call of message.toolCalls) {
        if (usedIds.has(call.id) || batchIds.has(call.id) || !agentToolDefinitions.some(tool => tool.name === call.name))
          throw new Error("Invalid agent tool batch");
        batchIds.add(call.id);
      }
      callCount += message.toolCalls.length;
      if (callCount > 16 || messages.length + 1 + message.toolCalls.length > TOOL_CONVERSATION_LIMITS.messages)
        throw new Error("Agent call limit");
      if (repairingFinal && message.toolCalls.length) throw new Error("Tools not permitted during final format repair");
      if (!message.toolCalls.length) {
        const content = message.content!.trim();
        if (!options.repairFinalJson) return content;
        try { session.renderResponse(content); return content; }
        catch (error) {
          if (repairingFinal || !(error instanceof SyntaxError)) throw error;
          repairingFinal = true;
          messages.push(message, { role: "user", content: "Tu salida anterior no cumple el formato obligatorio. Volvé a emitir únicamente el objeto JSON válido con text y, si corresponde, presentedQuoteReference. No hagas llamadas a herramientas." });
          continue;
        }
      }
      messages.push(message);
      for (const call of message.toolCalls) {
        assertOpen();
        const output = await session.execute(call.name, call.arguments);
        assertOpen();
        usedIds.add(call.id);
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(output) });
      }
    }
    throw new Error("Agent round limit");
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
