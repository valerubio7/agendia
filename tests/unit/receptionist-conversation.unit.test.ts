import { describe, expect, test } from "bun:test";
import { converseReceptionist, buildReceptionistMessages } from "../../apps/message-worker/src/receptionist.ts";
import { ReceptionistToolSession } from "../../apps/message-worker/src/receptionist-tools.ts";
import type { ToolConversationProvider, ToolConversationRequest, ToolAssistantMessage } from "@agendia/domain";

const final = (content = "¿Qué día te sirve?"): ToolAssistantMessage => ({ role: "assistant", content, toolCalls: [] });
const calls = (...names: string[]): ToolAssistantMessage => ({ role: "assistant", content: null,
  toolCalls: names.map((name, i) => ({ id: `${name}_${i}`, name, arguments: {} })), providerState: { reasoningContent: "private" } });
const source = {
  raw_text: "y queda cerca?", profile: { display_name: "Local", description: "Cortes", address: "Calle 1" },
  assistant: { style: "amable", business_instructions: "No inventar" }, sequence: "5",
  currentGroup: [{ id: "4", raw_text: "ola kiero algo", sequence: "4" }, { id: "5", raw_text: "y queda cerca?", sequence: "5" }],
  turns: [
    { id: "5", sequence: "5", direction: "inbound", processing_state: "pending", raw_text: "y queda cerca?" },
    { id: "3", sequence: "3", direction: "outbound", processing_state: "sent", raw_text: "¿Qué buscás?" },
    { id: "4", sequence: "4", direction: "inbound", processing_state: "pending", raw_text: "ola kiero algo" },
    { id: "2", sequence: "2", direction: "inbound", processing_state: "generated", raw_text: "antes" },
  ], summaries: [{ covered_through: "2", structured_summary: { facts: ["cliente habitual"], requests: [], commitments: [], preferences: [], openItems: [] } }],
};
const messages = () => buildReceptionistMessages(source, "config", "2035-04-01T12:00:00Z");
function scripted(outputs: ToolAssistantMessage[]) {
  const requests: ToolConversationRequest[] = [];
  const provider: ToolConversationProvider = { converse: async request => {
    requests.push(structuredClone(request));
    const message = outputs.shift(); if (!message) throw new Error("script exhausted");
    return { message, providerId: "script", usageTokens: 0 };
  } };
  return { provider, requests };
}
describe("bounded model-led receptionist", () => {
  test("ordered summary, sent history and grouped current input appear once as data", () => {
    const context = messages();
    expect(context.slice(2)).toEqual([
      { role: "assistant", content: "¿Qué buscás?", toolCalls: [] },
      { role: "user", content: "ola kiero algo\ny queda cerca?" },
    ]);
    expect(context[1]!.content).toContain("cliente habitual");
    expect(context[1]!.content).toContain("Calle 1");
    expect(context[1]!.content).toContain("2035-04-01");
    expect(context[0]!.content).toContain("use backend presentation.label verbatim");
    expect(context[0]!.content).toContain("Never independently calculate weekdays or timezone conversions");
    expect(context[0]!.content).toContain("If no canonical label is supplied, do not invent a weekday");
    expect(JSON.stringify(context)).not.toContain('"antes"');
  });
  test("packs large legitimate settings losslessly and removes oldest optional history first", () => {
    const assistant = { style: "s".repeat(32022), business_instructions: "i".repeat(64058) };
    const binding = { evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64) };
    const current = "dale resrvame ese 😀";
    const input = { ...source, assistant, raw_text: current, sequence: "30",
      currentGroup: [{ id: "30", sequence: "30", raw_text: current }],
      turns: Array.from({ length: 20 }, (_, i) => ({ id: String(i + 3), sequence: String(i + 3),
        direction: "inbound", processing_state: "generated", raw_text: "😀".repeat(1000) })) };
    const packed = buildReceptionistMessages(input, "Global atención 😀", "2035-04-01T12:00:00Z",
      { currentEvidence: current, naturalConfirmation: binding });
    expect(packed.every(m => m.content!.length <= 16384)).toBe(true);
    const serialized = JSON.stringify({ messages: packed, tools: [], maxOutputCharacters: 4000, correlationId: "test" });
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(122880);
    const settingsParts = packed.filter(m => m.role === "user" && m.content!.startsWith('{"dataOnly":true,"section":"settings"'))
      .map(m => JSON.parse(m.content!).text).join("");
    expect(JSON.parse(settingsParts)).toEqual({ assistantSettings: assistant, administratorSettings: "Global atención 😀" });
    expect(JSON.parse(packed[1]!.content!).runtime).toEqual({ currentEvidence: current, naturalConfirmation: binding });
    expect(packed.at(-1)!.content).toBe(current);
    expect(packed.filter(m => m.content === "😀".repeat(1000)).length).toBeLessThan(20);
    expect(packed[0]!.content).toContain("Tools are the only source");
  });
  test("preserves unicode current groups across message boundaries without slicing evidence", () => {
    const current = "😀".repeat(9000) + "\nexact suffix";
    const packed = buildReceptionistMessages({ ...source, raw_text: current,
      currentGroup: [{ id: "5", sequence: "5", raw_text: current }] }, "", "now");
    const chunks = packed.filter(m => m.content?.startsWith('{"dataOnly":true,"section":"currentInput"'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(chunks.map(m => JSON.parse(m.content!).text).join(""))).toEqual({ text: current });
    expect(packed.every(m => m.content!.length <= 16384)).toBe(true);
  });
  test("fails clearly when required settings alone cannot fit native limits", () => {
    expect(() => buildReceptionistMessages({ ...source, assistant: { style: "😀".repeat(40000) } }, "", "now"))
      .toThrow("required context exceeds native limits");
  });
  for (const text of ["ola kiero algo", "dale resrvame ese", "me vendría bien arreglarme", "no, mejor mañana"]) {
    test(`unconditionally leads with native provider: ${text}`, async () => {
      const script = scripted([final()]);
      const session = new ReceptionistToolSession(async () => { throw new Error("unexpected tool"); });
      expect(await converseReceptionist(script.provider, session, [{ role: "user", content: text }], "test")).toBe("¿Qué día te sirve?");
      expect(script.requests[0]!.messages.at(-1)!.content).toBe(text);
    });
  }
  test("complete serialized batches, rejected calls and private state return only to provider", async () => {
    const executed: string[] = [];
    const session = new ReceptionistToolSession(async command => { executed.push(command.name); return { status: "unavailable_data", code: "NOT_REGISTERED" }; });
    const script = scripted([calls("read_business", "read_calendar", "cancel"), final("No tengo ese dato; ¿qué día te sirve?")]);
    expect(await converseReceptionist(script.provider, session, messages(), "test")).toBe("No tengo ese dato; ¿qué día te sirve?");
    expect(executed).toEqual(["read_business", "read_calendar"]);
    const batch = script.requests[1]!.messages.slice(-4);
    expect(batch[0]!.role).toBe("assistant");
    expect(batch.slice(1).map(m => m.role)).toEqual(["tool", "tool", "tool"]);
    expect(batch[3]!.content).toContain("INVALID_TOOL");
    expect(JSON.stringify(batch)).toContain("private");
  });
  test("exact natural confirmation evidence comes from runtime context", async () => {
    const binding = { evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64) };
    const session = new ReceptionistToolSession(async command => {
      expect(command.arguments).toEqual({ ...binding, evidence: "dale reservame ese" });
      return { status: "staged_action", operation: command.name, appointment: { id: "real" } };
    }, { message: "dale reservame ese", recent: [], pending: null, naturalConfirmation: binding });
    const first = calls("confirm_quote_naturally");
    first.toolCalls[0]!.arguments = { ...binding, evidence: session.context.message };
    const script = scripted([first, final("Listo.")]);
    expect(await converseReceptionist(script.provider, session, messages(), "test")).toBe("Listo.");
    expect(script.requests[1]!.messages.at(-1)!.content).toContain("staged_action");
  });
  test("rejects duplicate/unknown calls and malformed output before execution", async () => {
    for (const output of [calls("read_business", "read_business"), calls("unknown"), { ...final(), content: "" }]) {
      if (output.toolCalls.length === 2) output.toolCalls[1]!.id = output.toolCalls[0]!.id;
      let executions = 0;
      const session = new ReceptionistToolSession(async () => { executions++; return { status: "data", data: {} }; });
      await expect(converseReceptionist(scripted([output]).provider, session, messages(), "test")).rejects.toThrow();
      expect(executions).toBe(0);
    }
  });
  test("deadline aborts provider and closes retained capability", async () => {
    let signal: AbortSignal | undefined;
    const provider: ToolConversationProvider = { converse: async (_, received) => { signal = received; return new Promise(() => {}); } };
    let executions = 0;
    const session = new ReceptionistToolSession(async () => { executions++; return { status: "data", data: {} }; });
    await expect(converseReceptionist(provider, session, messages(), "test", { durationMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect((await session.execute("read_business", {})).status).toBe("rejected");
    expect(executions).toBe(0);
  });
  test("total calls, oversized context and external cancellation are bounded", async () => {
    let executions = 0;
    const makeSession = () => new ReceptionistToolSession(async () => { executions++; return { status: "data", data: {} }; });
    const outputs = Array.from({ length: 3 }, (_, round) => ({ role: "assistant" as const, content: null,
      toolCalls: Array.from({ length: 8 }, (_, i) => ({ id: `r${round}_${i}`, name: "read_business", arguments: {} })) }));
    await expect(converseReceptionist(scripted(outputs).provider, makeSession(), messages(), "test")).rejects.toThrow("call limit");
    expect(executions).toBe(16);
    const script = scripted([final()]);
    await expect(converseReceptionist(script.provider, makeSession(), [{ role: "user", content: "x".repeat(17000) }], "test")).rejects.toThrow();
    expect(script.requests).toHaveLength(0);
    const controller = new AbortController(); controller.abort();
    await expect(converseReceptionist(script.provider, makeSession(), messages(), "test", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(script.requests).toHaveLength(0);
  });
  test("cancellation drains an active tool and refuses late continuation authority", async () => {
    let complete: () => void = () => {};
    let executions = 0;
    const session = new ReceptionistToolSession(async () => {
      executions++;
      await new Promise<void>(resolve => { complete = resolve; });
      return { status: "staged_action", operation: "test", appointment: {} };
    });
    const controller = new AbortController();
    const run = converseReceptionist(scripted([calls("read_business"), final("Must not return")]).provider,
      session, messages(), "test", { signal: controller.signal });
    while (!executions) await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort();
    expect((await session.execute("read_business", {})).status).toBe("rejected");
    complete();
    await expect(run).rejects.toThrow();
    expect(executions).toBe(1);
  });
  test("provider errors and round exhaustion never produce fallback text", async () => {
    const session = () => new ReceptionistToolSession(async () => ({ status: "data", data: {} }));
    await expect(converseReceptionist({ converse: async () => { throw new Error("offline"); } }, session(), messages(), "test")).rejects.toThrow("offline");
    const outputs = Array.from({ length: 6 }, (_, i) => { const m = calls("read_business"); m.toolCalls[0]!.id = `round_${i}`; return m; });
    await expect(converseReceptionist(scripted(outputs).provider, session(), messages(), "test")).rejects.toThrow("round");
  });
});
