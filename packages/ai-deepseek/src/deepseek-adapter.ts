import { AI_SYSTEM_INSTRUCTIONS, ToolConversationRequestSchema, ToolAgentMessageSchema, TOOL_CONVERSATION_LIMITS } from "@agendia/domain";
import type { ConversationToolCall, ToolConversationProvider, ToolConversationRequest, ToolConversationResult } from "@agendia/domain";
import type { AiGenerateRequest, AiGenerateResult, AiProvider, ConversationSummarizer, ConversationSummaryContent, ConversationSummaryRequest } from "@agendia/domain";

export const DEEPSEEK_CONNECT_TIMEOUT_MS = 5_000;
export const DEEPSEEK_TOTAL_TIMEOUT_MS = 30_000;

export type AiProviderErrorCode = "timeout" | "rate_limited" | "provider_unavailable" | "invalid_response" | "invalid_request";
export class AiProviderError extends Error {
  constructor(public readonly code: AiProviderErrorCode) { super(`AI provider failed: ${code}`); }
}

interface DeepSeekRequestBody {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  max_tokens: number;
  tools?: never;
}

function delimited(label: string, value: unknown): string {
  return `--- ${label} ---\n${JSON.stringify(value)}\n--- FIN ${label} ---`;
}

export function buildDeepSeekRequest(request: AiGenerateRequest, model = "deepseek-chat"): DeepSeekRequestBody {
  return {
    model,
    messages: [
      { role: "system", content: request.additionalInstructions
        ? AI_SYSTEM_INSTRUCTIONS + "\n\n" + request.additionalInstructions
        : AI_SYSTEM_INSTRUCTIONS },
      { role: "user", content: [
        delimited("INSTRUCCIONES DEL AGENTE", request.agent),
        delimited("INFORMACIÓN DEL NEGOCIO", request.business),
        delimited("HISTORIAL DE CONVERSACIÓN", request.context),
        delimited("MENSAJE ACTUAL DEL CLIENTE", request.message),
      ].join("\n") },
    ],
    max_tokens: Math.max(1, Math.ceil(request.maxOutputCharacters / 4)),
  };
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
interface AdapterOptions { apiKey: string; model?: string; endpoint?: string; fetcher?: Fetcher; totalTimeoutMs?: number; connectTimeoutMs?: number }

const MAX_RESPONSE_BYTES = 65_536;

/** Header deadline is not a TCP measurement; total deadline includes streaming body.
 * Race explicitly so deterministic injected transports cannot ignore our deadline.
 */
async function completion(options: AdapterOptions, fetcher: Fetcher, body: unknown, signal?: AbortSignal): Promise<any> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let complete = false;
  let cancel: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    const expire = () => {
      timedOut = true;
      controller.abort();
      reject(new AiProviderError("timeout"));
    };
    cancel = expire;
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) expire();
    totalTimer = setTimeout(expire, options.totalTimeoutMs ?? DEEPSEEK_TOTAL_TIMEOUT_MS);
    headerTimer = setTimeout(expire, options.connectTimeoutMs ?? DEEPSEEK_CONNECT_TIMEOUT_MS);
  });
  const run = async () => {
    const response = await fetcher(options.endpoint ?? "https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    clearTimeout(headerTimer);
    // A late header response after our race ended must not retain its body.
    if (timedOut) { void response.body?.cancel().catch(() => {}); throw new AiProviderError("timeout"); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new AiProviderError(response.status === 429 ? "rate_limited" : response.status >= 500 ? "provider_unavailable" : "invalid_response");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new AiProviderError("invalid_response");
    }
    if (!response.body) throw new AiProviderError("invalid_response");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new AiProviderError("invalid_response");
      chunks.push(part.value);
    }
    complete = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new AiProviderError("invalid_response"); }
  };
  try { return await Promise.race([deadline, ...(signal?.aborted ? [] : [run()])]); }
  catch (error) {
    if (timedOut) throw new AiProviderError("timeout");
    if (error instanceof AiProviderError) throw error;
    throw new AiProviderError("provider_unavailable");
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(headerTimer);
    signal?.removeEventListener("abort", cancel);
    if (reader) {
      if (!complete) void reader.cancel().catch(() => {});
      else reader.releaseLock();
    }
  }
}

type ValidToolRequest = ReturnType<typeof ToolConversationRequestSchema.parse>;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const objectValue = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Complete tool batches are required before any subsequent conversational turn. */
function validateToolHistory(request: ValidToolRequest): Set<string> {
  const names = new Set(request.tools.map(tool => tool.name));
  if (names.size !== request.tools.length) throw new AiProviderError("invalid_request");
  const usedIds = new Set<string>();
  const pending = new Set<string>();
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId)) throw new AiProviderError("invalid_request");
      continue;
    }
    if (pending.size) throw new AiProviderError("invalid_request");
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls) {
      if (!names.has(call.name) || usedIds.has(call.id)) throw new AiProviderError("invalid_request");
      usedIds.add(call.id);
      pending.add(call.id);
    }
  }
  if (pending.size) throw new AiProviderError("invalid_request");
  return usedIds;
}

function toolRequestBody(request: ValidToolRequest, model: string) {
  return {
    model,
    messages: request.messages.map(message => {
      if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
      if (message.role !== "assistant") return { role: message.role, content: message.content };
      return {
        role: "assistant", content: message.content,
        ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => ({
          id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })) } : {}),
        ...(message.providerState ? { reasoning_content: message.providerState.reasoningContent } : {}),
      };
    }),
    ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: "function", function: tool })) } : {}),
    // Reasoning and arguments also consume completion tokens, unlike customer text.
    max_tokens: 8192,
  };
}

function parseToolResponse(payload: unknown, request: ValidToolRequest, usedIds: Set<string>): ToolConversationResult {
  const invalid = () => { throw new AiProviderError("invalid_response"); };
  if (!objectValue(payload) || !Array.isArray(payload.choices) || payload.choices.length !== 1) return invalid();
  const choice = payload.choices[0];
  if (!objectValue(choice) || !objectValue(choice.message)) return invalid();
  const message = choice.message;
  if (message.role !== "assistant" || message.function_call !== undefined || (message.refusal != null)) return invalid();
  const wireCalls = message.tool_calls === undefined ? [] : message.tool_calls;
  if (!Array.isArray(wireCalls) || wireCalls.length > TOOL_CONVERSATION_LIMITS.calls) return invalid();
  if (choice.finish_reason !== (wireCalls.length ? "tool_calls" : "stop")) return invalid();
  if (message.content !== null && typeof message.content !== "string") return invalid();
  if (typeof message.content === "string" && message.content.length > request.maxOutputCharacters) return invalid();
  const calls: ConversationToolCall[] = [];
  const names = new Set(request.tools.map(tool => tool.name));
  for (const wire of wireCalls) {
    if (!objectValue(wire) || wire.type !== "function" || !objectValue(wire.function)) return invalid();
    if (Object.keys(wire).some(key => !["id", "type", "function", "index"].includes(key)) ||
        Object.keys(wire.function).some(key => !["name", "arguments"].includes(key))) return invalid();
    // Optional provider index is benign metadata, not authorization or correlation.
    // Validate it when present, then omit it from domain calls; IDs remain authoritative.
    if ("index" in wire && (typeof wire.index !== "number" || !Number.isSafeInteger(wire.index) || wire.index < 0)) return invalid();
    const args = wire.function.arguments;
    if (typeof args !== "string" || byteLength(args) > TOOL_CONVERSATION_LIMITS.argumentBytes) return invalid();
    // JSON parsing and the shared schema reject arrays, scalars and non-JSON values.
    calls.push({ id: wire.id as string, name: wire.function.name as string, arguments: JSON.parse(args) });
  }
  const parsed = ToolAgentMessageSchema.safeParse({
    role: "assistant", content: typeof message.content === "string" ? message.content.trim() : null,
    toolCalls: calls,
    ...(message.reasoning_content !== undefined ? { providerState: { reasoningContent: message.reasoning_content } } : {}),
  });
  if (!parsed.success) return invalid();
  for (const call of parsed.data.toolCalls) {
    if (!names.has(call.name) || usedIds.has(call.id)) return invalid();
    usedIds.add(call.id);
  }
  const usage = objectValue(payload.usage) ? payload.usage.total_tokens : undefined;
  return {
    message: parsed.data,
    providerId: typeof payload.id === "string" ? payload.id : "deepseek-unknown",
    usageTokens: typeof usage === "number" && Number.isSafeInteger(usage) && usage >= 0 ? usage : 0,
  };
}

export class DeepSeekAdapter implements AiProvider, ToolConversationProvider {
  private readonly fetcher: Fetcher;
  constructor(private readonly options: AdapterOptions) { this.fetcher = options.fetcher ?? fetch; }

  async converse(request: ToolConversationRequest, signal?: AbortSignal): Promise<ToolConversationResult> {
    let input: ValidToolRequest;
    let usedIds: Set<string>;
    let body: ReturnType<typeof toolRequestBody>;
    try {
      input = ToolConversationRequestSchema.parse(request);
      usedIds = validateToolHistory(input);
      body = toolRequestBody(input, this.options.model ?? "deepseek-chat");
      if (byteLength(JSON.stringify(body)) > TOOL_CONVERSATION_LIMITS.requestBytes) throw new AiProviderError("invalid_request");
    } catch { throw new AiProviderError("invalid_request"); }
    const payload: unknown = await completion(this.options, this.fetcher, body, signal);
    try { return parseToolResponse(payload, input, usedIds); }
    catch { throw new AiProviderError("invalid_response"); }
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    try {
      const payload = await completion(this.options, this.fetcher, buildDeepSeekRequest(request, this.options.model));
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim().length === 0 || text.length > request.maxOutputCharacters) throw new AiProviderError("invalid_response");
      return {
        text: text.trim(),
        providerId: typeof payload.id === "string" ? payload.id : "deepseek-unknown",
        usageTokens: typeof payload.usage?.total_tokens === "number" ? payload.usage.total_tokens : 0,
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError("invalid_response");
    }
  }

}

const summaryKeys=(value:unknown):value is ConversationSummaryContent=>{
  if(!value||typeof value!=="object")return false;
  return ["facts","requests","commitments","preferences","openItems"].every(key=>Array.isArray((value as Record<string,unknown>)[key])&&((value as Record<string,unknown>)[key] as unknown[]).every(item=>typeof item==="string"));
};
export class DeepSeekSummarizer implements ConversationSummarizer {
  private readonly fetcher:Fetcher;
  constructor(private readonly options:AdapterOptions){this.fetcher=options.fetcher??fetch;}
  async summarize(request:ConversationSummaryRequest):Promise<ConversationSummaryContent>{
    try{
      const payload=await completion(this.options,this.fetcher,{model:this.options.model??"deepseek-chat",messages:[{role:"system",content:"Resumen estructurado de conversación. Devuelve solo JSON con facts, requests, commitments, preferences y openItems como arrays de strings."},{role:"user",content:JSON.stringify(request)}],max_tokens:1_000});
      const text=payload?.choices?.[0]?.message?.content;if(typeof text!=="string")throw new AiProviderError("invalid_response");
      const content=JSON.parse(text) as unknown;if(!summaryKeys(content))throw new AiProviderError("invalid_response");return content;
    }catch(error){if(error instanceof AiProviderError)throw error;throw new AiProviderError("invalid_response");}
  }
}
