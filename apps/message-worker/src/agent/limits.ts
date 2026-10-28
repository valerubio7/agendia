import { TOOL_CONVERSATION_LIMITS, type ToolConversationMessage } from "@agendia/domain";
import { agentToolDefinitions } from "./tools.ts";

// Reserve wire overhead beyond the shared request shape; the adapter additionally
// checks its exact serialized body. Complete later tool batches may still hit limits.
export const REQUEST_BUDGET_BYTES = TOOL_CONVERSATION_LIMITS.requestBytes - 8192;
export const requestBytes = (messages: ToolConversationMessage[]) => new TextEncoder().encode(JSON.stringify({
  messages, tools: agentToolDefinitions, maxOutputCharacters: 4000, correlationId: "x".repeat(200),
})).byteLength;
