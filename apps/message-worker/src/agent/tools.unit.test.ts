import { describe, expect, test } from "bun:test";
import { AgentToolSession, agentToolDefinitions, parseAgentTool } from "./tools.ts";

import { canonicalAgentDate as canonicalDate } from "./tools.ts";
const id = "123e4567-e89b-42d3-a456-426614174000";
describe("canonical agent date presentation", () => {
  const zone = "America/Argentina/Buenos_Aires";
  test("2035-04-02 is canonically Monday, not Wednesday", () => {
    expect(canonicalDate("2035-04-02T10:00:00-03:00", zone)).toEqual({
      timeZone: zone, localDate: "2035-04-02", localTime: "10:00", weekday: "lunes",
      label: "lunes 2 de abril de 2035 a las 10:00",
    });
  });
  test("UTC midnight converts to the real local previous date and weekday", () => {
    expect(canonicalDate("2035-04-02T01:30:00Z", zone)).toMatchObject({
      localDate: "2035-04-01", localTime: "22:30", weekday: "domingo",
    });
  });
  test("missing, invalid or ambiguous times/zones produce no invented labels", () => {
    for (const instant of [null, undefined, "", "2035-04-02", "tomorrow", "2035-02-30T10:00:00Z"])
      expect(canonicalDate(instant, zone)).toBeNull();
    for (const invalidZone of [null, undefined, "", "Mars/Local"])
      expect(canonicalDate("2035-04-02T10:00:00-03:00", invalidZone)).toBeNull();
  });
});
describe("agent tool boundary", () => {
  test("native definitions are a closed strict allowlist", () => {
    expect(agentToolDefinitions.length).toBeGreaterThan(8);
    for (const definition of agentToolDefinitions) {
      expect(definition.parameters.type).toBe("object");
      expect(definition.parameters.additionalProperties).toBe(false);
      expect(parseAgentTool("arbitrary_sql", {})).toBeNull();
    }
  });
  test("rejects tenant, sender and ownership claims even on otherwise valid tools", () => {
    for (const field of ["businessId", "tenantId", "phone", "clientId", "confirmed", "owner"]) {
      expect(parseAgentTool("read_business", { [field]: id })).toBeNull();
      expect(parseAgentTool("prepare_booking", { serviceId: id, startsAt: "2035-04-02T10:00:00-03:00", [field]: id })).toBeNull();
    }
    expect(parseAgentTool("confirm_quote", { confirmed: true })).toBeNull();
    expect(parseAgentTool("prepare_booking", { serviceId: id, startsAt: "2035-04-02T10:00:00-03:00",
      presentation: canonicalDate("2035-04-02T10:00:00-03:00", "America/Argentina/Buenos_Aires") })).toBeNull();
  });
  test("validates IDs, real dates, instants and text limits", () => {
    expect(parseAgentTool("availability", { serviceId: id, date: "2035-02-30" })).toBeNull();
    expect(parseAgentTool("availability", { serviceId: "bad", date: "2035-04-02" })).toBeNull();
    expect(parseAgentTool("prepare_booking", { serviceId: id, startsAt: "tomorrow" })).toBeNull();
    expect(parseAgentTool("notes", { appointmentId: id, notes: "x".repeat(2001) })).toBeNull();
    expect(parseAgentTool("prepare_change", { appointmentId: id })).toBeNull();
    expect(parseAgentTool("availability", { serviceId: id, date: "2035-04-02" })?.name).toBe("availability");
  });
  test("natural confirmation requires bounded exact evidence and opaque bindings, not a boolean", () => {
    const valid = { evidence: "dale reservame ese", evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64) };
    expect(parseAgentTool("confirm_quote_naturally", valid)?.name).toBe("confirm_quote_naturally");
    for (const field of ["evidence", "evidenceReference", "quoteFingerprint"]) {
      const missing: Record<string, string> = { ...valid };
      delete missing[field];
      expect(parseAgentTool("confirm_quote_naturally", missing)).toBeNull();
    }
    for (const field of ["confirmed", "businessId", "phone", "appointmentId"]) {
      expect(parseAgentTool("confirm_quote_naturally", { ...valid, [field]: true })).toBeNull();
    }
    expect(parseAgentTool("confirm_quote_naturally", { ...valid, quoteFingerprint: "old" })).toBeNull();
    expect(parseAgentTool("confirm_quote_naturally", { ...valid, evidence: "x".repeat(12001) })).toBeNull();
  });
  test("native cancellation extends the strict legacy contract with a complete binding, never consent flags", () => {
    const binding = { evidence: "quería cancelar mi turno", evidenceReference: "a".repeat(64) };
    expect(parseAgentTool("cancel", { appointmentId: id, binding })?.name).toBe("cancel");
    expect(parseAgentTool("cancel", { appointmentId: id })?.name).toBe("cancel");
    for (const invalid of [{}, { evidence: binding.evidence }, { evidenceReference: binding.evidenceReference },
      { ...binding, evidence: "" }, { ...binding, evidenceReference: "forged" }, { ...binding, confirmed: true }])
      expect(parseAgentTool("cancel", { appointmentId: id, binding: invalid })).toBeNull();
    expect(parseAgentTool("cancel", { appointmentId: id, binding, confirmed: true })).toBeNull();
  });
  test("booking name patches require a draft reference and strict literal field provenance", () => {
    const field = { value: "María", messageId: id, start: 0 };
    const args = { namesReference: "a".repeat(64), firstName: field };
    expect(parseAgentTool("collect_booking_names", args)?.name).toBe("collect_booking_names");
    for (const invalid of [{}, { firstName: field }, { namesReference: args.namesReference },
      { ...args, namesReference: "forged" }, { ...args, confirmed: true },
      ...[{}, { ...field, start: -1 }, { ...field, start: 0.5 }, { ...field, value: " " },
        { ...field, value: "x".repeat(101) }, { ...field, proof: true }].map(firstName => ({ ...args, firstName }))])
      expect(parseAgentTool("collect_booking_names", invalid)).toBeNull();
    expect(agentToolDefinitions).toHaveLength(16);
  });
  test("native metadata bindings require complete member evidence and operation-specific selection fields", () => {
    const binding = { evidenceReference: "a".repeat(64), messageId: id, evidence: "Anotá: café ☕" };
    const notes = { appointmentId: id, notes: "café ☕", binding: { ...binding, start: 7 } };
    const preference = { appointmentId: id, resourceId: id, binding: { ...binding, resourceReference: "b".repeat(64) } };
    for (const [name, args] of [["notes", notes], ["preference", preference]] as const) {
      expect(parseAgentTool(name, args)?.name).toBe(name);
      for (const invalid of [{}, { ...args.binding, messageId: "forged" }, { ...args.binding, evidence: "" },
        { ...args.binding, evidenceReference: "old" }, { ...args.binding, confirmed: true }])
        expect(parseAgentTool(name, { ...args, binding: invalid })).toBeNull();
    }
    expect(parseAgentTool("notes", { ...notes, binding })).toBeNull();
    for (const start of [-1, 0.5]) expect(parseAgentTool("notes", { ...notes, binding: { ...binding, start } })).toBeNull();
    expect(parseAgentTool("notes", { ...notes, notes: "x".repeat(2001) })).toBeNull();
    expect(parseAgentTool("notes", { ...notes, binding: null })).toBeNull();
    expect(parseAgentTool("preference", { ...preference, binding: null })).toBeNull();
    expect(parseAgentTool("notes", { ...notes, notes: null, binding })?.name).toBe("notes");
    expect(parseAgentTool("notes", { ...notes, notes: null })).toBeNull(); // Clear cannot carry a span.
    expect(parseAgentTool("preference", { ...preference, binding })).toBeNull();
    expect(parseAgentTool("preference", { ...preference, resourceId: null, binding })?.name).toBe("preference");
    expect(parseAgentTool("preference", { ...preference, resourceId: null })).toBeNull();
    expect(parseAgentTool("notes", { appointmentId: id, notes: null })?.name).toBe("notes");
    expect(parseAgentTool("preference", { appointmentId: id, resourceId: null })?.name).toBe("preference");
  });
  test("invalid calls never reach trusted handlers", async () => {
    let calls = 0;
    const session = new AgentToolSession(async () => { calls++; return { status: "data", data: {} }; });
    expect((await session.execute("unknown", {})).status).toBe("rejected");
    expect((await session.execute("read_business", { phone: "+123456789" })).status).toBe("rejected");
    expect(calls).toBe(0);
    expect((await session.execute("read_business", {})).status).toBe("data");
    expect(calls).toBe(1);
  });
  test("invalid tool diagnostics expose only controlled names, codes and schema categories", async () => {
    const events: unknown[] = [];
    const session = new AgentToolSession(async () => ({ status: "data", data: {} }), undefined,
      event => events.push(event));
    const secret = "private-name-phone-provider-text";
    for (const [name, args, toolName, schemaIssueCategory] of [
      [secret, { secret }, "unknown", "unknown_tool"],
      ["read_business", { [secret]: id }, "read_business", "unexpected_fields"],
      ["availability", { serviceId: id }, "availability", "invalid_type"],
      ["availability", { serviceId: secret, date: "2026-10-15" }, "availability", "invalid_value"],
      ["availability", { serviceId: id, date: "2026-02-30" }, "availability", "invalid_value"],
    ] as const) {
      expect(await session.execute(name, args)).toEqual({ status: "rejected", code: "INVALID_TOOL" });
      expect(events.filter((e: any) => e.code === "agent.tool_rejected").at(-1)).toEqual({ code: "agent.tool_rejected", toolName,
        errorCode: "INVALID_TOOL", schemaIssueCategory });
    }
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(id);
    await session.execute("read_business", {});
    expect(events.filter((e: any) => e.code === "agent.tool_rejected")).toHaveLength(5);
  });
  test("completion evidence covers all controlled outcomes without private payloads", async () => {
    const events: unknown[] = [];
    const secret = "private-name-phone-provider-text";
    const outputs = [
      { status: "data", data: secret }, { status: "unavailable_data", code: secret },
      { status: "clarification", code: secret, reason: secret }, { status: "rejected", code: secret },
      { status: "prepared_quote", quote: secret },
      { status: "staged_action", operation: secret, appointment: secret },
    ] as const;
    let executions = 0;
    const session = new AgentToolSession(async () => outputs[executions++]!, undefined, event => events.push(event));
    for (const output of outputs) {
      await session.execute("read_business", {});
      expect(events.at(-1)).toEqual({ code: "agent.tool_completed", toolName: "read_business", status: output.status });
    }
    await session.execute(secret, { [secret]: secret });
    expect(events.at(-1)).toEqual({ code: "agent.tool_completed", toolName: "unknown", status: "rejected" });
    expect(executions).toBe(6);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(id);
  });
  test("throwing diagnostics cannot fail or repeat a successful mutation or schema rejection", async () => {
    for (const diagnose of [() => { throw new Error("private logger failure"); }, async () => { throw new Error("private logger failure"); }]) {
      let executions = 0;
      const session = new AgentToolSession(async () => { executions++; return { status: "staged_action", operation: "cancel", appointment: {} }; },
        undefined, diagnose);
      expect((await session.execute("cancel", { appointmentId: id })).status).toBe("staged_action");
      expect((await session.execute("availability", {})).status).toBe("rejected");
      session.close();
      await session.drain();
      session.reportCompletedTurn();
      expect(executions).toBe(1);
    }
  });
  test("bounds calls and closes the capability at transaction end", async () => {
    let calls = 0;
    const session = new AgentToolSession(async () => { calls++; return { status: "data", data: {} }; });
    for (let index = 0; index < 16; index++) await session.execute("read_business", {});
    expect((await session.execute("read_business", {})).status).toBe("rejected");
    expect(calls).toBe(16);
    session.close();
    expect((await session.execute("read_business", {})).status).toBe("rejected");
  });
  for (const toolName of ["prepare_booking", "prepare_change"] as const)
    for (const rejection of ["schema", "limit", "handler"] as const) test(`preparation rejection observation is serialized: ${toolName}/${rejection}`, async () => {
    const order: string[] = [];
    const session = new AgentToolSession(async command => {
      await Promise.resolve();
      order.push(command.name);
      return command.name === "prepare_change" ? { status: "rejected", code: "AGENDA_REJECTED" }
        : { status: "data", data: {} };
    }, undefined, undefined, () => { order.push("revoked"); });
    if (rejection === "limit") for (let i = 0; i < 15; i++) await session.execute("read_business", {});
    order.length = 0;
    const first = session.execute("prepare_booking", { serviceId: id, startsAt: "2035-04-02T10:00:00-03:00" });
    const second = session.execute(rejection === "handler" ? "prepare_change" : toolName,
      rejection === "handler" ? { appointmentId: id, startsAt: "2035-04-02T11:00:00-03:00" } : {});
    await Promise.all([first, second]);
    expect(order).toEqual(rejection === "handler" ? ["prepare_booking", "prepare_change", "revoked"] : ["prepare_booking", "revoked"]);
    const completedOrder = [...order];
    await session.execute("misspelled_preparation", {});
    expect(order).toEqual(completedOrder);
    session.close();
    await session.execute(toolName, {});
    expect(order).toEqual(completedOrder); // Closed capabilities cannot revoke persisted state.
  });
  test("does not turn infrastructure errors into unavailable facts", async () => {
    const events: unknown[] = [];
    const session = new AgentToolSession(async () => { throw new Error("private database detail"); }, undefined,
      event => events.push(event));
    await expect(session.execute("read_business", {})).rejects.toThrow("private database detail");
    await expect(session.drain()).rejects.toThrow("private database detail");
    expect(events).toEqual([{ code: "agent.tool_completed", toolName: "read_business", status: "infrastructure_failure" }]);
  });
  test("queued malformed preparation cannot swallow an earlier infrastructure failure", async () => {
    let revoked = false;
    const session = new AgentToolSession(async () => { throw new Error("infrastructure failure"); },
      undefined, undefined, () => { revoked = true; });
    const first = session.execute("read_catalog", {});
    const malformed = session.execute("prepare_change", {});
    const results = await Promise.allSettled([first, malformed]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
    await expect(session.drain()).rejects.toThrow("infrastructure failure");
    expect(revoked).toBe(false);
  });
  test("oversized result aborts rather than silently hiding facts", async () => {
    const session = new AgentToolSession(async () => ({ status: "data", data: "x".repeat(20000) }));
    await expect(session.execute("read_business", {})).rejects.toThrow("Tool result limit");
  });
});
