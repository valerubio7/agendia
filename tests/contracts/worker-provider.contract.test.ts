import { describe, expect, test } from "bun:test";
import type {
  AiProvider,
  AiGenerateRequest,
  ToolConversationProvider,
  ToolConversationRequest,
  ConversationSummarizer,
} from "@agendia/domain";
import { hasToolConversationProvider } from "@agendia/domain";
import {
  AiProviderError,
  DeepSeekAdapter,
  DeepSeekSummarizer,
} from "@agendia/ai-deepseek";
import { createMessagingRuntime } from "../../apps/whatsapp-manager/src/index.ts";
import { startMessageWorker } from "../../apps/message-worker/src/index.ts";
import { PostgresAiJobProcessor } from "../../apps/message-worker/src/jobs/ai-job.ts";
import { deepSeekFetchDouble } from "../support/index.ts";

const request: AiGenerateRequest = {
  business: { name: "A" },
  assistant: { tone: "amable" },
  context: { summary: "s", recent: [] },
  message: "hola",
  maxOutputCharacters: 100,
  correlationId: "c1",
};

describe("worker/provider production contracts", () => {
  test("keeps DeepSeek behind AiProvider with a deterministic fetch boundary", async () => {
    const double = deepSeekFetchDouble({ text: "respuesta" }),
      provider: AiProvider = new DeepSeekAdapter({
        apiKey: "secret",
        fetcher: double.fetcher,
      });
    expect(await provider.generate(request)).toMatchObject({
      text: "respuesta",
      providerId: "deterministic",
    });
    expect(double.calls).toHaveLength(1);
  });
  test("keeps native conversation capability separate from text-only worker providers", async () => {
    const textOnly: AiProvider = { generate: async () => ({ text: "unchanged", providerId: "text", usageTokens: 0 }) };
    expect(await textOnly.generate(request)).toMatchObject({ text: "unchanged" });
    expect(hasToolConversationProvider(textOnly)).toBe(false);
    expect(hasToolConversationProvider({ ...textOnly, converse: null } as AiProvider)).toBe(false);
    const provider: AiProvider & ToolConversationProvider = new DeepSeekAdapter({
      apiKey: "secret", fetcher: async () => new Response(JSON.stringify({
        id: "native", usage: { total_tokens: 3 },
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "¿Qué servicio buscás?" } }],
      })),
    });
    expect(hasToolConversationProvider(provider)).toBe(true);
    const nativeRequest: ToolConversationRequest = {
      messages: [{ role: "user", content: "Servicios?" }], tools: [],
      maxOutputCharacters: 100, correlationId: "native-1",
    };
    expect(await provider.converse(nativeRequest)).toEqual({
      message: { role: "assistant", content: "¿Qué servicio buscás?", toolCalls: [] },
      providerId: "native", usageTokens: 3,
    });
  });
  test("requires callable converse before accessing the database", () => {
    let databaseTouches = 0;
    const pools = new Proxy({} as ConstructorParameters<typeof PostgresAiJobProcessor>[0], {
      get() { databaseTouches++; throw new Error("Unexpected database access"); },
    });
    const textOnly: AiProvider = {
      generate: async () => ({ text: "unused", providerId: "text", usageTokens: 0 }),
    };
    for (const provider of [textOnly, { ...textOnly, converse: null }]) {
      expect(() => new PostgresAiJobProcessor(pools, provider)).toThrow(/converse/i);
    }
    const native: AiProvider & ToolConversationProvider = {
      ...textOnly,
      converse: async () => ({
        message: { role: "assistant", content: "unused", toolCalls: [] },
        providerId: "native", usageTokens: 0,
      }),
    };
    expect(() => new PostgresAiJobProcessor(pools, native)).not.toThrow();
    expect(databaseTouches).toBe(0);
  });
  test("summary transport rejects malformed JSON and covers hung body", async () => {
    for (const [fetcher, code] of [
      [async () => new Response("{"), "invalid_response"],
      [async () => new Response(new ReadableStream()), "timeout"],
      [async () => { throw new Error("secret network"); }, "provider_unavailable"],
    ] as const) {
      const summarizer = new DeepSeekSummarizer({ apiKey: "secret", fetcher, totalTimeoutMs: 10 });
      await expect(summarizer.summarize({ prior: null, messages: [], correlationId: "s1" })).rejects.toMatchObject({ code });
    }
  });
  test("classifies transport failure without retry or credential exposure", async () => {
    const double = deepSeekFetchDouble({
        error: new Error("timeout never-log"),
      }),
      provider: AiProvider = new DeepSeekAdapter({
        apiKey: "never-log",
        fetcher: double.fetcher,
      });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      AiProviderError,
    );
    expect(double.calls).toHaveLength(1);
    try {
      await provider.generate(request);
    } catch (error) {
      expect(String(error)).not.toContain("never-log");
    }
  });
  test("keeps structured conversation summarization behind a replaceable boundary", async () => {
    const content = {
        facts: ["prefiere mañana"],
        requests: [],
        commitments: [],
        preferences: ["mañana"],
        openItems: [],
      },
      double = deepSeekFetchDouble({ text: JSON.stringify(content) });
    const summarizer: ConversationSummarizer = new DeepSeekSummarizer({
      apiKey: "secret",
      fetcher: double.fetcher,
    });
    expect(
      await summarizer.summarize({
        prior: null,
        messages: [{ sequence: 1, role: "customer", text: "Prefiero mañana" }],
        correlationId: "summary:1",
      }),
    ).toEqual(content);
    expect(double.calls[0]).toContain("Prefiero mañana");
    expect(double.calls[0]).not.toContain("secret");
  });
  test("exports executable manager messaging and pg-boss worker bootstraps", () => {
    expect(typeof createMessagingRuntime).toBe("function");
    expect(typeof startMessageWorker).toBe("function");
  });
});
