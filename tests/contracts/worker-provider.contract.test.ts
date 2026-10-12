import { describe, expect, test } from "bun:test";
import type {
  AiProvider,
  AiGenerateRequest,
  AgendaProposalProvider,
  AgendaProposal,
  ConversationSummarizer,
} from "@agendia/domain";
import {
  AiProviderError,
  DeepSeekAdapter,
  DeepSeekSummarizer,
} from "@agendia/ai-deepseek";
import { createMessagingRuntime } from "../../apps/whatsapp-manager/src/index.ts";
import { startMessageWorker } from "../../apps/message-worker/src/index.ts";
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
  test("keeps proposal capability separate from text-only worker providers", async () => {
    const textOnly: AiProvider = { generate: async () => ({ text: "unchanged", providerId: "text", usageTokens: 0 }) };
    expect(await textOnly.generate(request)).toMatchObject({ text: "unchanged" });
    const proposal = { operation: "read_catalog", arguments: {} } satisfies AgendaProposal;
    const provider: AgendaProposalProvider = new DeepSeekAdapter({
      apiKey: "secret", fetcher: async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(proposal) } }],
      })),
    });
    expect(await provider.proposeAgenda({
      message: "Servicios?", context: { summary: "", recent: [] },
      catalog: { services: [], resources: [] }, correlationId: "p1",
    })).toEqual(proposal);
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
