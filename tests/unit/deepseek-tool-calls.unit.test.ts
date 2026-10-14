import { describe, expect, test } from "bun:test";
import { DeepSeekAdapter } from "../../packages/ai-deepseek/src/deepseek-adapter.ts";
import type { ToolConversationRequest } from "../../packages/domain/src/ai-provider.ts";

const request: ToolConversationRequest = {
  messages: [{ role: "system", content: "Usa datos reales." }, { role: "user", content: "¿Qué ofrecen?" }],
  tools: [{ name: "read_catalog", description: "Read actual services", parameters: { type: "object", properties: {} } }],
  maxOutputCharacters: 1000,
  correlationId: "tools-1",
};
const call = (id = "call_1", name = "read_catalog", args = "{}") => ({
  id, type: "function", function: { name, arguments: args },
});
const envelope = (message: unknown, finish_reason = "stop") => JSON.stringify({
  id: "completion-1", choices: [{ finish_reason, message }], usage: { total_tokens: 12 },
});
const provider = (body: string) => new DeepSeekAdapter({ apiKey: "test-only", fetcher: async () => new Response(body) });

describe("native tool conversations", () => {
  test("native cancellation aborts transport, including pre-aborted requests", async () => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    let fetches = 0;
    const adapter = new DeepSeekAdapter({ apiKey: "test-only", fetcher: async (_, init) => {
      fetches++; received = init?.signal;
      return new Promise(() => {});
    } });
    const pending = adapter.converse(request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(received?.aborted).toBe(true);
    await expect(adapter.converse(request, controller.signal)).rejects.toMatchObject({ code: "timeout" });
    expect(fetches).toBe(1);
  });

  test("returns natural final text without exposing reasoning", async () => {
    const result = await provider(envelope({ role: "assistant", content: " Tenemos cortes y color. ", reasoning_content: "private reasoning" })).converse(request);
    expect(result.message.content).toBe("Tenemos cortes y color.");
    expect(result.message.toolCalls).toEqual([]);
    expect(result.message.providerState?.reasoningContent).toBe("private reasoning");
    expect(result.providerId).toBe("completion-1");
    expect(result.usageTokens).toBe(12);
  });

  test("accepts tool-only and multiple calls with object arguments", async () => {
    for (const content of [null, "", "Voy a consultar."]) {
      const result = await provider(envelope({ role: "assistant", content, tool_calls: [call(), call("call_2", "read_catalog", '{"search":"corte"}')] }, "tool_calls")).converse(request);
      expect(result.message.content).toBe(content);
      expect(result.message.toolCalls).toEqual([
        { id: "call_1", name: "read_catalog", arguments: {} },
        { id: "call_2", name: "read_catalog", arguments: { search: "corte" } },
      ]);
    }
  });

  test("accepts optional numeric index metadata without exposing it in domain calls", async () => {
    for (const calls of [
      [{ ...call("synthetic_call"), index: 0 }],
      [{ ...call(), index: 0 }, { ...call("call_2"), index: 1 }],
      [call(), { ...call("call_2"), index: 1 }],
      [{ ...call(), index: Number.MAX_SAFE_INTEGER }],
    ]) {
      const result = await provider(envelope({ role: "assistant", content: "Synthetic preamble", tool_calls: calls }, "tool_calls")).converse(request);
      expect(result.message.content).toBe("Synthetic preamble");
      expect(result.message.toolCalls).toEqual(calls.map(wire => ({ id: wire.id, name: "read_catalog", arguments: {} })));
    }
  });

  test("rejects invalid index metadata and unknown wire keys", async () => {
    for (const wire of [
      ...["0", null, true, {}, [], -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(index => ({ ...call(), index })),
      { ...call(), index: 0, extra: "unexpected" },
      { ...call(), extra: "unexpected" },
      { ...call(), index: 0, function: { ...call().function, extra: "unexpected" } },
    ]) await expect(provider(envelope({ role: "assistant", content: null, tool_calls: [wire] }, "tool_calls")).converse(request)).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("index metadata cannot authorize tools or replace ID validation and correlation", async () => {
    for (const calls of [
      [{ ...call("call_1", "unknown"), index: 0 }],
      [{ ...call("bad id"), index: 0 }],
      [{ ...call("call_1", "read_catalog", "[]"), index: 0 }],
      [{ ...call(), index: 0 }, { ...call(), index: 1 }],
    ]) await expect(provider(envelope({ role: "assistant", content: null, tool_calls: calls }, "tool_calls")).converse(request)).rejects.toMatchObject({ code: "invalid_response" });
    // Repeated metadata is benign; distinct IDs still determine correlation.
    const result = await provider(envelope({ role: "assistant", content: null, tool_calls: [{ ...call(), index: 0 }, { ...call("call_2"), index: 0 }] }, "tool_calls")).converse(request);
    expect(result.message.toolCalls.map(tool => tool.id)).toEqual(["call_1", "call_2"]);
  });

  test("serializes native functions, assistant calls, correlated results and reasoning round-trip", async () => {
    let body: any;
    const adapter = new DeepSeekAdapter({ apiKey: "test-only", model: "configured-model", fetcher: async (_, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(envelope({ role: "assistant", content: "Ofrecemos cortes." }));
    } });
    const first = await provider(envelope({ role: "assistant", content: null, reasoning_content: "keep verbatim\n", tool_calls: [call(), call("call_2")] }, "tool_calls")).converse(request);
    await adapter.converse({ ...request, messages: [...request.messages, first.message,
      { role: "tool", toolCallId: "call_2", content: '{"services":[]}' },
      { role: "tool", toolCallId: "call_1", content: '{"services":["corte"]}' },
    ] });
    expect(body.model).toBe("configured-model");
    expect(body.tools).toEqual([{ type: "function", function: request.tools[0] }]);
    expect(body.messages[2]).toEqual({ role: "assistant", content: null, reasoning_content: "keep verbatim\n", tool_calls: [call(), call("call_2")] });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "call_2", content: '{"services":[]}' });
    expect(body.messages[4].tool_call_id).toBe("call_1");
    expect(body.response_format).toBeUndefined();
  });

  test("preserves default model and allows an empty tool allowlist for final text", async () => {
    let body: any;
    const adapter = new DeepSeekAdapter({ apiKey: "test-only", fetcher: async (_, init) => {
      body = JSON.parse(String(init?.body)); return new Response(envelope({ role: "assistant", content: "Hola." }));
    } });
    await adapter.converse({ ...request, tools: [] });
    expect(body.model).toBe("deepseek-chat");
    expect(body.tools).toBeUndefined();
  });

  test("rejects malformed, unknown, duplicate and oversized tool calls", async () => {
    for (const calls of [
      [call("", "read_catalog")], [call("bad id")], [call("x".repeat(129))],
      [call("call_1", "unknown")], [call(), call()],
      [call("call_1", "read_catalog", "{")], [call("call_1", "read_catalog", "[]")],
      [call("call_1", "read_catalog", "null")], [call("call_1", "read_catalog", "42")],
      [call("call_1", "read_catalog", JSON.stringify({ x: "😀".repeat(4096) }))],
      [{ ...call(), type: "other" }], [{ id: "call_1", type: "function", function: { name: "read_catalog", arguments: {} } }],
      Array.from({ length: 9 }, (_, i) => call(`call_${i}`)),
    ]) await expect(provider(envelope({ role: "assistant", content: null, tool_calls: calls }, "tool_calls")).converse(request)).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("rejects ambiguous, empty or incomplete responses", async () => {
    for (const body of [
      envelope({ role: "assistant", content: "" }), envelope({ role: "assistant", content: null }),
      envelope({ role: "assistant", content: " " }), envelope({ role: "user", content: "Hi" }),
      envelope({ role: "assistant", content: "x".repeat(1001) }),
      envelope({ role: "assistant", content: 42 }),
      envelope({ role: "assistant", content: null, tool_calls: [call()] }, "stop"),
      envelope({ role: "assistant", content: "Hi", tool_calls: [] }, "tool_calls"),
      envelope({ role: "assistant", content: "Hi", tool_calls: {} }),
      envelope({ role: "assistant", content: "Hi", reasoning_content: 42 }),
      envelope({ role: "assistant", content: "Hi", reasoning_content: "x".repeat(32769) }),
      envelope({ role: "assistant", content: "Hi", function_call: { name: "read_catalog", arguments: "{}" } }),
      envelope({ role: "assistant", content: "Hi", refusal: "refused" }),
      ...["length", "content_filter", null, "unknown"].map(reason => envelope({ role: "assistant", content: "Hi" }, reason as any)),
      JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Hi" } }, { finish_reason: "stop", message: { role: "assistant", content: "Other" } }] }),
      "null", "{",
    ]) await expect(provider(body).converse(request)).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("validates definitions, bounds and history correlations before fetching", async () => {
    let fetches = 0;
    const adapter = new DeepSeekAdapter({ apiKey: "test-only", fetcher: async () => { fetches++; return new Response("{}"); } });
    const assistant = { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "read_catalog", arguments: {} }] } as const;
    const result = { role: "tool", toolCallId: "call_1", content: "{}" } as const;
    const invalid: unknown[] = [
      { ...request, tools: [request.tools[0], request.tools[0]] },
      { ...request, tools: [{ ...request.tools[0], name: "bad name" }] },
      { ...request, tools: [{ ...request.tools[0], name: "x".repeat(65) }] },
      { ...request, tools: [{ ...request.tools[0], description: "x".repeat(2001) }] },
      { ...request, tools: [{ ...request.tools[0], parameters: [] }] },
      { ...request, tools: [{ ...request.tools[0], parameters: { type: "array" } }] },
      { ...request, tools: Array(33).fill(request.tools[0]) },
      { ...request, messages: Array(101).fill(request.messages[0]) },
      { ...request, maxOutputCharacters: 0 }, { ...request, maxOutputCharacters: 8193 },
      { ...request, messages: [{ role: "user", content: "x".repeat(16385) }] },
      { ...request, messages: [{ role: "user", content: null }] },
      { ...request, messages: [...request.messages, { ...assistant, providerState: { reasoningContent: "x".repeat(32769) } }, result] },
      { ...request, messages: [...request.messages, { ...assistant, toolCalls: [{ id: "call_1", name: "read_catalog", arguments: { x: "😀".repeat(4096) } }] }, result] },
      { ...request, messages: [result] },
      { ...request, messages: [...request.messages, assistant] },
      { ...request, messages: [...request.messages, assistant, { ...result, toolCallId: "unknown" }] },
      { ...request, messages: [...request.messages, assistant, result, result] },
      { ...request, messages: [...request.messages, assistant, request.messages[1], result] },
      { ...request, messages: [...request.messages, assistant, result, assistant, result] },
      { ...request, messages: [...request.messages, { ...assistant, toolCalls: [{ id: "call_1", name: "unknown", arguments: {} }] }, result] },
      { ...request, messages: [...request.messages, { ...assistant, toolCalls: [{ id: "call_1", name: "read_catalog", arguments: { x: Infinity } }] }, result] },
      { ...request, messages: Array(20).fill({ role: "user", content: "😀".repeat(4000) }) },
    ];
    for (const value of invalid) await expect(adapter.converse(value as ToolConversationRequest)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetches).toBe(0);
  });

  test("rejects a returned ID already used in history", async () => {
    await expect(provider(envelope({ role: "assistant", content: null, tool_calls: [call()] }, "tool_calls")).converse({ ...request,
      messages: [...request.messages,
        { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "read_catalog", arguments: {} }] },
        { role: "tool", toolCallId: "call_1", content: "{}" },
      ],
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("accepts exact argument, text and call count limits and rejects calls without definitions", async () => {
    // {"x":"..."} consumes eight bytes in addition to its string payload.
    const args = JSON.stringify({ x: "a".repeat(16376) });
    expect(new TextEncoder().encode(args).byteLength).toBe(16384);
    const large = await provider(envelope({ role: "assistant", content: null, tool_calls: [call("call_1", "read_catalog", args)] }, "tool_calls")).converse(request);
    expect(large.message.toolCalls[0]?.arguments.x).toBe("a".repeat(16376));
    const calls = Array.from({ length: 8 }, (_, i) => call(`call_${i}`));
    expect((await provider(envelope({ role: "assistant", content: null, tool_calls: calls }, "tool_calls")).converse(request)).message.toolCalls).toHaveLength(8);
    const text = "x".repeat(1000);
    expect((await provider(envelope({ role: "assistant", content: text })).converse(request)).message.content).toBe(text);
    await expect(provider(envelope({ role: "assistant", content: null, tool_calls: [call()] }, "tool_calls")).converse({ ...request, tools: [] })).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("uses bounded transport for oversize and timeout errors", async () => {
    await expect(provider(" ".repeat(65537)).converse(request)).rejects.toMatchObject({ code: "invalid_response" });
    const adapter = new DeepSeekAdapter({ apiKey: "test-only", totalTimeoutMs: 10, connectTimeoutMs: 5,
      fetcher: async () => new Promise<Response>(() => {}),
    });
    await expect(adapter.converse(request)).rejects.toMatchObject({ code: "timeout" });
  });
});
