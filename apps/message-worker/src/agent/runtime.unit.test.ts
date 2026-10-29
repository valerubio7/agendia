import { describe, expect, test } from "bun:test";
import { converseAgent } from "./runtime.ts";
import { buildAgentMessages } from "./context.ts";
import { AgentToolSession, agentToolDefinitions } from "./tools.ts";
import { AGENT_SYSTEM_PROMPT, TOOL_CONVERSATION_LIMITS, type ToolConversationProvider, type ToolConversationRequest, type ToolAgentMessage } from "@agendia/domain";

const final = (content = "¿Qué día te sirve?"): ToolAgentMessage => ({ role: "assistant", content, toolCalls: [] });
const calls = (...names: string[]): ToolAgentMessage => ({ role: "assistant", content: null,
  toolCalls: names.map((name, i) => ({ id: `${name}_${i}`, name, arguments: {} })), providerState: { reasoningContent: "private" } });
const source = {
  raw_text: "y queda cerca?", profile: { display_name: "Local", description: "Cortes", address: "Calle 1" },
  agent: { style: "amable", business_instructions: "No inventar" }, sequence: "5",
  currentGroup: [{ id: "4", raw_text: "ola kiero algo", sequence: "4" }, { id: "5", raw_text: "y queda cerca?", sequence: "5" }],
  turns: [
    { id: "5", sequence: "5", direction: "inbound", processing_state: "pending", raw_text: "y queda cerca?" },
    { id: "3", sequence: "3", direction: "outbound", processing_state: "sent", raw_text: "¿Qué buscás?" },
    { id: "4", sequence: "4", direction: "inbound", processing_state: "pending", raw_text: "ola kiero algo" },
    { id: "2", sequence: "2", direction: "inbound", processing_state: "generated", raw_text: "antes" },
  ], summaries: [{ covered_through: "2", structured_summary: { facts: ["cliente habitual"], requests: [], commitments: [], preferences: [], openItems: [] } }],
};
const messages = () => buildAgentMessages(source, "2035-04-01T12:00:00Z");
function scripted(outputs: ToolAgentMessage[]) {
  const requests: ToolConversationRequest[] = [];
  const provider: ToolConversationProvider = { converse: async request => {
    requests.push(structuredClone(request));
    const message = outputs.shift(); if (!message) throw new Error("script exhausted");
    return { message, providerId: "script", usageTokens: 0 };
  } };
  return { provider, requests };
}
describe("bounded model-led agent", () => {
  test("ordered summary, sent history and grouped current input appear once as data", () => {
    const context = messages();
    expect(context.slice(2)).toEqual([
      { role: "assistant", content: "¿Qué buscás?", toolCalls: [] },
      { role: "user", content: "ola kiero algo\ny queda cerca?" },
    ]);
    expect(context[1]!.content).toContain("cliente habitual");
    expect(context[1]!.content).toContain("Calle 1");
    expect(context[1]!.content).toContain("2035-04-01");
    expect(context.filter(message => message.role === "system")).toEqual([
      { role: "system", content: AGENT_SYSTEM_PROMPT },
    ]);
    expect(context[0]!.content).toContain("usá presentation.label del backend como fuente");
    expect(context[0]!.content).toContain("podés expresarla con palabras naturales, sin cambiar la fecha, hora ni zona horaria");
    expect(context[0]!.content).toContain("Nunca calcules por tu cuenta días de la semana ni conversiones de zona horaria");
    expect(context[0]!.content).toContain("Si no hay una etiqueta canónica, no inventes un día de la semana");
    expect(JSON.stringify(context)).not.toContain('"antes"');
  });
  test("packs large legitimate settings losslessly and removes oldest optional history first", () => {
    const envelope = { tools: agentToolDefinitions, maxOutputCharacters: 4000, correlationId: "x".repeat(200) };
    const protocolBytes = new TextEncoder().encode(JSON.stringify({ ...envelope,
      messages: [{ role: "system", content: AGENT_SYSTEM_PROMPT }] })).byteLength;
    const requestBudget = TOOL_CONVERSATION_LIMITS.requestBytes - 8192; // Existing builder wire reserve.
    // Leave one message's headroom for context/chunk framing; optional history must compete for the remainder.
    const payload = requestBudget - protocolBytes - TOOL_CONVERSATION_LIMITS.messageCharacters;
    const styleSize = Math.floor(payload / 3);
    const agent = { style: "s".repeat(styleSize), business_instructions: "i".repeat(payload - styleSize) };
    expect(agent.style.length).toBeGreaterThan(TOOL_CONVERSATION_LIMITS.messageCharacters);
    expect(agent.business_instructions.length).toBeGreaterThan(TOOL_CONVERSATION_LIMITS.messageCharacters);
    const binding = { evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64) };
    const current = "dale resrvame ese 😀";
    const namesRuntime = { namesReference: "c".repeat(64), nameSources: [{ messageId: "29", text: "María Pérez 😀" }] };
    const input = { ...source, agent, raw_text: current, sequence: "30",
      currentGroup: [{ id: "30", sequence: "30", raw_text: current }],
      turns: Array.from({ length: 20 }, (_, i) => ({ id: String(i + 3), sequence: String(i + 3),
        direction: "inbound", processing_state: "generated", raw_text: "😀".repeat(1000) })) };
    const packed = buildAgentMessages(input, "2035-04-01T12:00:00Z",
      { currentEvidence: current, naturalConfirmation: binding, ...namesRuntime });
    expect(packed.every(m => m.content!.length <= 16384)).toBe(true);
    const serialized = JSON.stringify({ messages: packed, ...envelope });
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(requestBudget);
    const settingsParts = packed.filter(m => m.role === "user" && m.content!.startsWith('{"dataOnly":true,"section":"settings"'))
      .map(m => JSON.parse(m.content!).text).join("");
    expect(packed.filter(m => m.content?.startsWith('{"dataOnly":true,"section":"settings"')).length).toBeGreaterThan(1);
    expect(JSON.parse(settingsParts)).toEqual({ agentSettings: agent });
    expect(JSON.parse(packed[1]!.content!).runtime).toEqual({ currentEvidence: current, naturalConfirmation: binding, ...namesRuntime });
    expect(packed.at(-1)!.content).toBe(current);
    expect(packed.filter(m => m.content === "😀".repeat(1000)).length).toBeLessThan(20);
    expect(packed.filter(m => m.content === "😀".repeat(1000)).length).toBeGreaterThan(0);
    expect(packed[0]!.content).toContain("Las herramientas son la única fuente");
    expect(packed.filter(message => message.role === "system")).toEqual([
      { role: "system", content: AGENT_SYSTEM_PROMPT },
    ]);
  });
  test("runtime context excludes administrator settings and preserves business settings and server time", () => {
    const context = buildAgentMessages(source, "2035-04-01T12:00:00Z");
    expect(context.filter(message => message.role === "system")).toEqual([
      { role: "system", content: AGENT_SYSTEM_PROMPT },
    ]);
    expect(context[1]!.role).toBe("user");
    expect(JSON.parse(context[1]!.content!)).toMatchObject({ agentSettings: source.agent, serverTime: "2035-04-01T12:00:00Z" });
    expect(JSON.parse(context[1]!.content!)).not.toHaveProperty("administratorSettings");
  });
  test("preserves unicode current groups across message boundaries without slicing evidence", () => {
    const current = "😀".repeat(9000) + "\nexact suffix";
    const packed = buildAgentMessages({ ...source, raw_text: current,
      currentGroup: [{ id: "5", sequence: "5", raw_text: current }] }, "now");
    const chunks = packed.filter(m => m.content?.startsWith('{"dataOnly":true,"section":"currentInput"'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(chunks.map(m => JSON.parse(m.content!).text).join(""))).toEqual({ text: current });
    expect(packed.every(m => m.content!.length <= 16384)).toBe(true);
  });
  test("fails clearly when required settings alone cannot fit native limits", () => {
    expect(() => buildAgentMessages({ ...source, agent: { style: "😀".repeat(40000) } }, "now"))
      .toThrow("required context exceeds native limits");
  });
  for (const text of ["ola kiero algo", "dale resrvame ese", "me vendría bien arreglarme", "no, mejor mañana"]) {
    test(`unconditionally leads with native provider: ${text}`, async () => {
      const script = scripted([final()]);
      const session = new AgentToolSession(async () => { throw new Error("unexpected tool"); });
      expect(await converseAgent(script.provider, session, [{ role: "user", content: text }], "test")).toBe("¿Qué día te sirve?");
      expect(script.requests[0]!.messages.at(-1)!.content).toBe(text);
    });
  }
  test("complete serialized batches, rejected calls and private state return only to provider", async () => {
    const executed: string[] = [];
    const session = new AgentToolSession(async command => { executed.push(command.name); return { status: "unavailable_data", code: "NOT_REGISTERED" }; });
    const script = scripted([calls("read_business", "read_calendar", "cancel"), final("No tengo ese dato; ¿qué día te sirve?")]);
    expect(await converseAgent(script.provider, session, messages(), "test")).toBe("No tengo ese dato; ¿qué día te sirve?");
    expect(executed).toEqual(["read_business", "read_calendar"]);
    const batch = script.requests[1]!.messages.slice(-4);
    expect(batch[0]!.role).toBe("assistant");
    expect(batch.slice(1).map(m => m.role)).toEqual(["tool", "tool", "tool"]);
    expect(batch[3]!.content).toContain("INVALID_TOOL");
    expect(JSON.stringify(batch)).toContain("private");
  });
  test("fresh evidence policy preserves stale failure history and passes actual current results", async () => {
    const input = { ...source, turns: [{ id: "3", sequence: "3", direction: "outbound", processing_state: "sent",
      raw_text: "consulta rechazada" }] };
    const initial = buildAgentMessages(input, "2035-04-01T12:00:00Z");
    expect(initial[0]!.content).toContain("Los fallos relatados por agentes anteriores no son evidencia actual");
    expect(initial[0]!.content).toContain("availability");
    expect(initial[0]!.content).toContain("read_catalog");
    expect(initial[0]!.content).toContain("antes de ofrecer opciones o afirmar que la consulta actual fue rechazada o falló");
    expect(initial[0]!.content).toContain("no pidas UUIDs ni reconfirmes datos conocidos");
    expect(initial).toContainEqual({ role: "assistant", content: "consulta rechazada", toolCalls: [] });
    const first = calls("availability");
    first.toolCalls[0]!.arguments = { serviceId: "123e4567-e89b-42d3-a456-426614174000", date: "2035-04-02" };
    let executions = 0;
    const output = { status: "data" as const, data: { items: [], message: "current backend evidence" } };
    const session = new AgentToolSession(async () => { executions++; return output; });
    const script = scripted([first, final("No hay horarios.")]);
    await converseAgent(script.provider, session, initial, "test");
    expect(executions).toBe(1);
    expect(script.requests[1]!.messages.at(-1)).toEqual({ role: "tool", toolCallId: "availability_0", content: JSON.stringify(output) });
    expect(script.requests[1]!.messages).toContainEqual({ role: "assistant", content: "consulta rechazada", toolCalls: [] });
  });
  test("scripted prose after catalog and availability keeps only the chosen customer wording", async () => {
    const label = "lunes 2035-04-02 a las 10:00";
    const wording = `El corte cuesta ARS 1500 y tenés ${label}. ¿Te sirve?`;
    const session = new AgentToolSession(async command => command.name === "read_catalog"
      ? { status: "data", data: { items: [
        { name: "Corte", durationMinutes: 30, priceArs: 1500 },
        { name: "Color", durationMinutes: 90, priceArs: 9000 },
      ] } }
      : { status: "data", data: { message: "Volcado completo: 10:00, 11:00, 12:00", items: [{ presentation: { label } }] } });
    const read = calls("availability");
    read.toolCalls[0]!.arguments = { serviceId: "123e4567-e89b-42d3-a456-426614174000", date: "2035-04-02" };
    const script = scripted([calls("read_catalog"), read, final(JSON.stringify({ text: wording }))]);
    const raw = await converseAgent(script.provider, session, messages(), "test");
    expect(session.renderResponse(raw).text).toBe(wording);
    expect(script.requests).toHaveLength(3);
    expect(script.requests[2]!.messages.at(-1)!.content).toContain(label);
  });
  test("informational prose still obeys the 4000-character serialized output ceiling", async () => {
    const empty = JSON.stringify({ text: "" });
    for (const length of [4000, 4001]) {
      const raw = JSON.stringify({ text: "a".repeat(length - empty.length) });
      expect(raw.length).toBe(length);
      const session = new AgentToolSession(async () => { throw new Error("unexpected tool"); });
      const script = scripted([final(raw)]);
      if (length === 4000) {
        const result = await converseAgent(script.provider, session, messages(), "test");
        expect(session.renderResponse(result).text).toBe("a".repeat(length - empty.length));
      } else {
        await expect(converseAgent(script.provider, session, messages(), "test")).rejects.toThrow("Agent output limit");
      }
      expect(script.requests[0]!.maxOutputCharacters).toBe(4000);
    }
  });
  test("completed turns include zero-call summaries and drained call counts only", async () => {
    for (const useTools of [false, true]) {
      const events: unknown[] = [];
      let executions = 0;
      const session = new AgentToolSession(async () => { executions++; return { status: "data", data: {} }; }, undefined,
        event => events.push(event));
      const script = scripted(useTools ? [calls("read_catalog", "availability"), final()] : [final()]);
      await converseAgent(script.provider, session, messages(), "test");
      session.reportCompletedTurn();
      session.reportCompletedTurn();
      expect(executions).toBe(useTools ? 1 : 0);
      expect(events.at(-1)).toEqual({ code: "agent.turn_completed", toolCalls: useTools ? 2 : 0,
        completedCalls: useTools ? 2 : 0, failedCalls: 0 });
      expect(events.filter((e: any) => e.code === "agent.turn_completed")).toHaveLength(1);
    }
  });
  test("infrastructure failure drains without emitting a successful turn summary", async () => {
    const events: unknown[] = [];
    const session = new AgentToolSession(async () => { throw new Error("private fault"); }, undefined, event => events.push(event));
    await expect(converseAgent(scripted([calls("read_catalog")]).provider, session, messages(), "test")).rejects.toThrow("private fault");
    expect(events).toEqual([{ code: "agent.tool_completed", toolName: "read_catalog", status: "infrastructure_failure" }]);
  });
  test("exact natural confirmation evidence comes from runtime context", async () => {
    const binding = { evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64) };
    const session = new AgentToolSession(async command => {
      expect(command.arguments).toEqual({ ...binding, evidence: "dale reservame ese" });
      return { status: "staged_action", operation: command.name, appointment: { id: "real" } };
    }, { message: "dale reservame ese", recent: [], pending: null, naturalConfirmation: binding });
    const first = calls("confirm_quote_naturally");
    first.toolCalls[0]!.arguments = { ...binding, evidence: session.context.message };
    const script = scripted([first, final("Listo.")]);
    expect(await converseAgent(script.provider, session, messages(), "test")).toBe("Listo.");
    expect(script.requests[1]!.messages.at(-1)!.content).toContain("staged_action");
  });
  test("native conversation carries fresh target references into cancel (scripted interpretation only)", async () => {
    const appointmentId = "123e4567-e89b-42d3-a456-426614174000", reference = "a".repeat(64);
    const evidence = "quería cancelar mi turno";
    const executed: string[] = [];
    const session = new AgentToolSession(async command => {
      executed.push(command.name);
      if (command.name === "owned_appointment") return { status: "data", data: { id: appointmentId, cancellationReference: reference } };
      expect(command.arguments).toEqual({ appointmentId, binding: { evidence, evidenceReference: reference } });
      return { status: "staged_action", operation: "cancel", appointment: { id: appointmentId } };
    });
    const provider: ToolConversationProvider = { converse: async request => {
      const last = request.messages.at(-1)!;
      let message = final('{"text":"Listo."}');
      if (last.role === "user") {
        message = calls("owned_appointment"); message.toolCalls[0]!.arguments = { appointmentId };
      } else if (last.role === "tool" && last.toolCallId === "owned_appointment_0") {
        const read = JSON.parse(last.content!);
        message = calls("cancel"); message.toolCalls[0]!.arguments = {
          appointmentId: read.data.id, binding: { evidence, evidenceReference: read.data.cancellationReference },
        };
      }
      return { message, providerId: "script", usageTokens: 0 };
    } };
    expect(await converseAgent(provider, session, [{ role: "user", content: evidence }], "test")).toBe('{"text":"Listo."}');
    expect(executed).toEqual(["owned_appointment", "cancel"]);
  });
  test("rejects duplicate/unknown calls and malformed output before execution", async () => {
    for (const output of [calls("read_business", "read_business"), calls("unknown"), { ...final(), content: "" }]) {
      if (output.toolCalls.length === 2) output.toolCalls[1]!.id = output.toolCalls[0]!.id;
      let executions = 0;
      const session = new AgentToolSession(async () => { executions++; return { status: "data", data: {} }; });
      await expect(converseAgent(scripted([output]).provider, session, messages(), "test")).rejects.toThrow();
      expect(executions).toBe(0);
    }
  });
  test("deadline aborts provider and closes retained capability", async () => {
    let signal: AbortSignal | undefined;
    const provider: ToolConversationProvider = { converse: async (_, received) => { signal = received; return new Promise(() => {}); } };
    let executions = 0;
    const session = new AgentToolSession(async () => { executions++; return { status: "data", data: {} }; });
    await expect(converseAgent(provider, session, messages(), "test", { durationMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect((await session.execute("read_business", {})).status).toBe("rejected");
    expect(executions).toBe(0);
  });
  test("total calls, oversized context and external cancellation are bounded", async () => {
    let executions = 0;
    const makeSession = () => new AgentToolSession(async () => { executions++; return { status: "data", data: {} }; });
    const outputs = Array.from({ length: 3 }, (_, round) => ({ role: "assistant" as const, content: null,
      toolCalls: Array.from({ length: 8 }, (_, i) => ({ id: `r${round}_${i}`, name: "read_business", arguments: {} })) }));
    await expect(converseAgent(scripted(outputs).provider, makeSession(), messages(), "test")).rejects.toThrow("call limit");
    expect(executions).toBe(16);
    const script = scripted([final()]);
    await expect(converseAgent(script.provider, makeSession(), [{ role: "user", content: "x".repeat(17000) }], "test")).rejects.toThrow();
    expect(script.requests).toHaveLength(0);
    const controller = new AbortController(); controller.abort();
    await expect(converseAgent(script.provider, makeSession(), messages(), "test", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(script.requests).toHaveLength(0);
  });
  test("cancellation drains an active tool and refuses late continuation authority", async () => {
    let complete: () => void = () => {};
    let executions = 0;
    const session = new AgentToolSession(async () => {
      executions++;
      await new Promise<void>(resolve => { complete = resolve; });
      return { status: "staged_action", operation: "test", appointment: {} };
    });
    const controller = new AbortController();
    const run = converseAgent(scripted([calls("read_business"), final("Must not return")]).provider,
      session, messages(), "test", { signal: controller.signal });
    while (!executions) await new Promise(resolve => setTimeout(resolve, 1));
    controller.abort();
    expect((await session.execute("read_business", {})).status).toBe("rejected");
    complete();
    await expect(run).rejects.toThrow();
    expect(executions).toBe(1);
  });
  test("provider errors and round exhaustion never produce fallback text", async () => {
    const session = () => new AgentToolSession(async () => ({ status: "data", data: {} }));
    await expect(converseAgent({ converse: async () => { throw new Error("offline"); } }, session(), messages(), "test")).rejects.toThrow("offline");
    const outputs = Array.from({ length: 6 }, (_, i) => { const m = calls("read_business"); m.toolCalls[0]!.id = `round_${i}`; return m; });
    await expect(converseAgent(scripted(outputs).provider, session(), messages(), "test")).rejects.toThrow("round");
  });
});
