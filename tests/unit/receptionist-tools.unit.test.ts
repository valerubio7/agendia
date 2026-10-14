import { describe, expect, test } from "bun:test";
import { ReceptionistToolSession, receptionistToolDefinitions, parseReceptionistTool } from "../../apps/message-worker/src/receptionist-tools.ts";

import { canonicalReceptionistDate as canonicalDate } from "../../apps/message-worker/src/receptionist-tools.ts";
const id = "123e4567-e89b-42d3-a456-426614174000";
describe("canonical receptionist date presentation", () => {
  const zone = "America/Argentina/Buenos_Aires";
  test("2035-04-02 is canonically Monday, not Wednesday", () => {
    expect(canonicalDate("2035-04-02T10:00:00-03:00", zone)).toEqual({
      timeZone: zone, localDate: "2035-04-02", localTime: "10:00", weekday: "lunes",
      label: "lunes 2035-04-02 a las 10:00 (America/Argentina/Buenos_Aires)",
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
describe("receptionist tool boundary", () => {
  test("native definitions are a closed strict allowlist", () => {
    expect(receptionistToolDefinitions.length).toBeGreaterThan(8);
    for (const definition of receptionistToolDefinitions) {
      expect(definition.parameters.type).toBe("object");
      expect(definition.parameters.additionalProperties).toBe(false);
      expect(parseReceptionistTool("arbitrary_sql", {})).toBeNull();
    }
  });
  test("rejects tenant, sender and ownership claims even on otherwise valid tools", () => {
    for (const field of ["businessId", "tenantId", "phone", "clientId", "confirmed", "owner"]) {
      expect(parseReceptionistTool("read_business", { [field]: id })).toBeNull();
      expect(parseReceptionistTool("prepare_booking", { serviceId: id, startsAt: "2035-04-02T10:00:00-03:00", [field]: id })).toBeNull();
    }
    expect(parseReceptionistTool("confirm_quote", { confirmed: true })).toBeNull();
    expect(parseReceptionistTool("prepare_booking", { serviceId: id, startsAt: "2035-04-02T10:00:00-03:00",
      presentation: canonicalDate("2035-04-02T10:00:00-03:00", "America/Argentina/Buenos_Aires") })).toBeNull();
  });
  test("validates IDs, real dates, instants and text limits", () => {
    expect(parseReceptionistTool("availability", { serviceId: id, date: "2035-02-30" })).toBeNull();
    expect(parseReceptionistTool("availability", { serviceId: "bad", date: "2035-04-02" })).toBeNull();
    expect(parseReceptionistTool("prepare_booking", { serviceId: id, startsAt: "tomorrow" })).toBeNull();
    expect(parseReceptionistTool("notes", { appointmentId: id, notes: "x".repeat(2001) })).toBeNull();
    expect(parseReceptionistTool("prepare_change", { appointmentId: id })).toBeNull();
    expect(parseReceptionistTool("availability", { serviceId: id, date: "2035-04-02" })?.name).toBe("availability");
  });
  test("natural confirmation requires bounded exact evidence and opaque bindings, not a boolean", () => {
    const valid = { evidence: "dale reservame ese", evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64) };
    expect(parseReceptionistTool("confirm_quote_naturally", valid)?.name).toBe("confirm_quote_naturally");
    for (const field of ["evidence", "evidenceReference", "quoteFingerprint"]) {
      const missing: Record<string, string> = { ...valid };
      delete missing[field];
      expect(parseReceptionistTool("confirm_quote_naturally", missing)).toBeNull();
    }
    for (const field of ["confirmed", "businessId", "phone", "appointmentId"]) {
      expect(parseReceptionistTool("confirm_quote_naturally", { ...valid, [field]: true })).toBeNull();
    }
    expect(parseReceptionistTool("confirm_quote_naturally", { ...valid, quoteFingerprint: "old" })).toBeNull();
    expect(parseReceptionistTool("confirm_quote_naturally", { ...valid, evidence: "x".repeat(12001) })).toBeNull();
  });
  test("invalid calls never reach trusted handlers", async () => {
    let calls = 0;
    const session = new ReceptionistToolSession(async () => { calls++; return { status: "data", data: {} }; });
    expect((await session.execute("unknown", {})).status).toBe("rejected");
    expect((await session.execute("read_business", { phone: "+123456789" })).status).toBe("rejected");
    expect(calls).toBe(0);
    expect((await session.execute("read_business", {})).status).toBe("data");
    expect(calls).toBe(1);
  });
  test("bounds calls and closes the capability at transaction end", async () => {
    let calls = 0;
    const session = new ReceptionistToolSession(async () => { calls++; return { status: "data", data: {} }; });
    for (let index = 0; index < 16; index++) await session.execute("read_business", {});
    expect((await session.execute("read_business", {})).status).toBe("rejected");
    expect(calls).toBe(16);
    session.close();
    expect((await session.execute("read_business", {})).status).toBe("rejected");
  });
  test("does not turn infrastructure errors into unavailable facts", async () => {
    const session = new ReceptionistToolSession(async () => { throw new Error("private database detail"); });
    await expect(session.execute("read_business", {})).rejects.toThrow("private database detail");
  });
  test("oversized result aborts rather than silently hiding facts", async () => {
    const session = new ReceptionistToolSession(async () => ({ status: "data", data: "x".repeat(20000) }));
    await expect(session.execute("read_business", {})).rejects.toThrow("Tool result limit");
  });
});
