import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRuntimePools } from "@agendia/db";
import type { AiProvider, ToolConversationProvider, ToolConversationRequest, ToolAgentMessage } from "@agendia/domain";
import { PostgresAiJobProcessor } from "../../apps/message-worker/src/jobs/ai-job.ts";
import { PostgresInboundHandler } from "../../apps/whatsapp-manager/src/inbound.ts";
import { normalizeBaileysMessage } from "../../packages/whatsapp-baileys/src/baileys-gateway.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

import { scriptedAgentReply } from "../e2e/support/providers.ts";

let db: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(db.container.getConnectionUri());
}, 120_000);
afterAll(async () => { await pools?.end(); await db?.stop(); });
const finish = (content: string): ToolAgentMessage => ({ role: "assistant", content, toolCalls: [] });
const modelReply = (request: ToolConversationRequest) => finish(scriptedAgentReply(
  request.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content!)),
));
const batch = (id: string, name: string, args = {}): ToolAgentMessage => ({ role: "assistant", content: null,
  toolCalls: [{ id, name, arguments: args }], providerState: { reasoningContent: "never public" } });
async function fixture() {
  const business = randomUUID(), connection = randomUUID(), session = randomUUID(), service = randomUUID(), resource = randomUUID();
  const schedule = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [day, [{ startMinute: 540, endMinute: 1080 }]]));
  await db.sql`insert into businesses(id,name) values(${business},'Conversation')`;
  await db.sql`insert into agent_configs(business_id,active,style,business_instructions) values(${business},true,'amable','Solo datos reales')`;
  await db.sql`insert into business_profiles(business_id,display_name,description,address) values(${business},'Salón','Cortes','Calle real 1')`;
  await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state) values(${connection},${business},${session},'CONNECTED')`;
  await db.sql`insert into business_calendars(business_id,weekly_schedule) values(${business},${db.sql.json(schedule)})`;
  await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${service},${business},'Corte',30,1500)`;
  await db.sql`insert into resources(id,business_id,name,weekly_schedule) values(${resource},${business},'Ana',${db.sql.json(schedule)})`;
  await db.sql`insert into resource_services(business_id,resource_id,service_id) values(${business},${resource},${service})`;
  await db.sql`insert into clients(business_id,first_name,last_name,phone) values(${business},'María','Pérez','+5491123456789')`;
  async function receive(text: string, trusted = true) {
    const providerId = randomUUID();
    const event = normalizeBaileysMessage(session, { key: { id: providerId, remoteJid: "5491123456789@s.whatsapp.net" }, message: { conversation: text } }, trusted)!;
    await new PostgresInboundHandler(pools).handle(event);
    const [row] = await db.sql`select id,conversation_id from messages where business_id=${business} and provider_message_id=${providerId}`;
    await db.sql`update conversations set reply_due_at=now()-interval '1 second' where id=${row!.conversation_id}`;
    return { businessId: business, messageId: row!.id as string, correlationId: `conversation:${providerId}` };
  }
  function worker(script: (request: ToolConversationRequest) => Promise<ToolAgentMessage>) {
    const requests: ToolConversationRequest[] = [];
    const provider: AiProvider & ToolConversationProvider = {
      generate: async () => { throw new Error("Legacy generation forbidden"); },
      converse: async request => { requests.push(structuredClone(request)); return { message: await script(request), providerId: "script", usageTokens: 0 }; },
    };
    return { processor: new PostgresAiJobProcessor(pools, provider), requests };
  }
  const outputs = () => db.sql`select * from outbound_commands where business_id=${business} order by created_at`;
  const appointments = () => db.sql`select * from appointments where business_id=${business}`;
  return { business, service, resource, receive, worker, outputs, appointments };
}
describe("production inbound native conversation with transactional tools", () => {
  test("informal grouped input reaches model with grounded facts, then complete factual/availability batch", async () => {
    const h = await fixture();
    const older = await h.receive("ola kiero arreglarme");
    const current = await h.receive("queda cerca y hay algo el 2035-04-03?");
    let round = 0;
    const w = h.worker(async request => {
      expect(await h.outputs()).toHaveLength(0);
      if (!round++) {
        expect(request.messages.at(-1)!.content).toBe("ola kiero arreglarme\nqueda cerca y hay algo el 2035-04-03?");
        expect(request.messages[1]!.content).toContain("Calle real 1");
        return { ...batch("facts", "read_business"), toolCalls: [
          { id: "facts", name: "read_business", arguments: {} },
          { id: "slots", name: "availability", arguments: { serviceId: h.service, date: "2035-04-03" } },
        ] };
      }
      expect(request.messages.slice(-2).map(m => m.role)).toEqual(["tool", "tool"]);
      expect(request.messages.at(-1)!.content).toContain("2035-04-03");
      const slots = JSON.parse(request.messages.at(-1)!.content!);
      expect(slots.data.items[0].presentation.weekday).toBe("martes");
      expect(slots.data.items[0].presentation.timeZone).toBe("America/Argentina/Buenos_Aires");
      return finish(JSON.stringify({ text: 'Dirección registrada: "Calle real 1". Horarios disponibles: 2035-04-03: 09:00. ¿Qué horario elegís?' }));
    });
    await w.processor.process(older);
    expect(w.requests).toHaveLength(0);
    await w.processor.process(current);
    await w.processor.process(current);
    expect(w.requests).toHaveLength(2);
    const out = await h.outputs();
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe("generated");
    expect(out[0]!.text).toContain('Dirección registrada: "Calle real 1".');
    expect(out[0]!.text).toContain("Horarios disponibles: 2035-04-03:");
    expect(out[0]!.text).toContain("¿Qué horario elegís?");
    expect(out[0]!.text).not.toContain("never public");
    expect(await h.appointments()).toHaveLength(0);
  });
  test("fresh quote, changed mind, delivered natural acceptance and idempotent atomic booking", async () => {
    const h = await fixture();
    let round = 0;
    const quoteWorker = h.worker(async request => {
      if (!round++) return batch("prepare", "prepare_booking", { serviceId: h.service, startsAt: "2035-04-02T10:00:00-03:00" });
      expect(JSON.parse(request.messages.at(-1)!.content!).presentation.weekday).toBe("lunes");
      return modelReply(request);
    });
    await quoteWorker.processor.process(await h.receive("ese me sirve"));
    expect(await h.appointments()).toHaveLength(0);
    let out = await h.outputs();
    expect(out[0]!.text).toContain("ARS 1500");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${out[0]!.outbound_id}`;
    round = 0;
    const changeWorker = h.worker(async request => !round++ ? batch("clear", "clear_pending") : finish('{"text":"¿Qué servicio y día querés consultar?"}'));
    await changeWorker.processor.process(await h.receive("no mejor otro"));
    expect(await h.appointments()).toHaveLength(0);
    round = 0;
    await quoteWorker.processor.process(await h.receive("mejor el primero"));
    out = await h.outputs();
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${out.at(-1)!.outbound_id}`;
    round = 0;
    const acceptWorker = h.worker(async request => {
      expect(await h.outputs()).toHaveLength(3);
      if (!round++) {
        const context = JSON.parse(request.messages[1]!.content!);
        expect(context.runtime.currentEvidence).toBe("dale resrvame ese");
        expect(context.runtime.naturalConfirmation).not.toBeNull();
        expect(context.runtime.pendingPresentation.weekday).toBe("lunes");
        expect(context.runtime.pendingPresentation.localTime).toBe("10:00");
        return batch("accept", "confirm_quote_naturally", { ...context.runtime.naturalConfirmation, evidence: context.runtime.currentEvidence });
      }
      expect(request.messages.at(-1)!.content).toContain("staged_action");
      return modelReply(request);
    });
    const job = await h.receive("dale resrvame ese");
    await acceptWorker.processor.process(job);
    await acceptWorker.processor.process(job);
    expect(await h.appointments()).toHaveLength(1);
    expect(await h.outputs()).toHaveLength(4);
    const receipts = await db.sql`select * from whatsapp_agenda_receipts where business_id=${h.business} and message_id=${job.messageId}`;
    expect(receipts).toHaveLength(1);
  });
  test("a successful format repair commits a staged booking once across job replay", async () => {
    const h = await fixture();
    let round = 0;
    const prepare = h.worker(async request => !round++ ? batch("prepare", "prepare_booking", { serviceId: h.service, startsAt: "2035-04-02T10:00:00-03:00" }) : modelReply(request));
    await prepare.processor.process(await h.receive("primero ese"));
    expect(await h.appointments()).toHaveLength(0);
    const out = await h.outputs();
    expect(out).toHaveLength(1);
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${out[0]!.outbound_id}`;
    round = 0;
    const worker = h.worker(async request => {
      if (round++ === 0) {
        const runtime = JSON.parse(request.messages[1]!.content!).runtime;
        return batch("accept", "confirm_quote_naturally", { ...runtime.naturalConfirmation, evidence: runtime.currentEvidence });
      }
      if (round === 2) {
        expect(JSON.parse(request.messages.at(-1)!.content!).status).toBe("staged_action");
        return finish("Guardado");
      }
      expect(round).toBe(3);
      expect(request.messages.at(-2)!.content).toBe("Guardado");
      expect(request.messages.at(-1)!.content).toContain("objeto JSON");
      expect(request.messages.filter(message => message.role === "tool")).toHaveLength(1);
      return finish('{"text":"Guardado"}');
    });
    const job = await h.receive("dale reservame ese");
    await worker.processor.process(job);
    const appointments = await h.appointments(), outputs = await h.outputs();
    const receipts = await db.sql`select * from whatsapp_agenda_receipts where business_id=${h.business} and message_id=${job.messageId}`;
    expect(worker.requests).toHaveLength(3);
    expect(appointments).toHaveLength(1);
    expect(outputs).toHaveLength(2);
    expect(outputs.filter(output => output.source_message_id === job.messageId)).toMatchObject([
      { text: "Guardado", state: "generated" },
    ]);
    expect(receipts).toHaveLength(1);
    await worker.processor.process(job);
    expect(worker.requests).toHaveLength(3);
    expect(await h.appointments()).toEqual(appointments);
    expect(await h.outputs()).toEqual(outputs);
    expect(await db.sql`select * from whatsapp_agenda_receipts where business_id=${h.business} and message_id=${job.messageId}`).toEqual(receipts);
  });
  test("a format repair cannot execute tools or commit a staged booking", async () => {
    const h = await fixture();
    let round = 0;
    const prepare = h.worker(async request => !round++ ? batch("prepare", "prepare_booking", { serviceId: h.service, startsAt: "2035-04-02T10:00:00-03:00" }) : modelReply(request));
    await prepare.processor.process(await h.receive("primero ese"));
    const out = await h.outputs();
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${out[0]!.outbound_id}`;
    round = 0;
    const worker = h.worker(async request => {
      if (round++ === 0) {
        const runtime = JSON.parse(request.messages[1]!.content!).runtime;
        return batch("accept", "confirm_quote_naturally", { ...runtime.naturalConfirmation, evidence: runtime.currentEvidence });
      }
      return round === 2 ? finish("Guardado") : batch("unexpected", "clear_pending");
    });
    const job = await h.receive("dale reservame ese");
    await expect(worker.processor.process(job)).rejects.toThrow("infrastructure failure");
    expect(await h.appointments()).toHaveLength(0);
    expect(await h.outputs()).toHaveLength(1);
    const [source] = await db.sql`select processing_state from messages where id=${job.messageId}`;
    expect(source!.processing_state).toBe("pending");
    expect(worker.requests).toHaveLength(3);
  });
  test("provider failure after staged booking rolls back everything and permits retry", async () => {
    const h = await fixture();
    let round = 0;
    const prepare = h.worker(async request => !round++ ? batch("prepare", "prepare_booking", { serviceId: h.service, startsAt: "2035-04-02T10:00:00-03:00" }) : modelReply(request));
    await prepare.processor.process(await h.receive("primero ese"));
    const out = await h.outputs();
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${out[0]!.outbound_id}`;
    round = 0;
    const script = async (request: ToolConversationRequest) => {
      if (!round++) {
        const runtime = JSON.parse(request.messages[1]!.content!).runtime;
        return batch("accept", "confirm_quote_naturally", { ...runtime.naturalConfirmation, evidence: runtime.currentEvidence });
      }
      throw new Error("provider offline after staging");
    };
    const job = await h.receive("dale reservame ese");
    await expect(h.worker(script).processor.process(job)).rejects.toThrow("infrastructure failure");
    expect(await h.appointments()).toHaveLength(0);
    expect(await h.outputs()).toHaveLength(1);
    const [source] = await db.sql`select processing_state from messages where id=${job.messageId}`;
    expect(source!.processing_state).toBe("pending");
    round = 0;
    const retry = h.worker(async request => round === 0 ? script(request) : modelReply(request));
    await retry.processor.process(job);
    expect(await h.appointments()).toHaveLength(1);
    expect(await h.outputs()).toHaveLength(2);
  });
  test("manual sender and malformed provider input cannot fabricate an effect or fallback", async () => {
    const h = await fixture();
    let round = 0;
    const w = h.worker(async request => {
      if (!round++) return batch("ownership", "owned_appointments");
      expect(request.messages.at(-1)!.content).toContain("UNVERIFIED_SENDER");
      return modelReply(request);
    });
    await w.processor.process(await h.receive("arreglalo", false));
    expect(await h.appointments()).toHaveLength(0);
    const malformed = h.worker(async request => ({ ...finish(""), toolCalls: [] }));
    const job = await h.receive("algo distinto");
    await expect(malformed.processor.process(job)).rejects.toThrow("infrastructure failure");
    expect(await h.outputs()).toHaveLength(1);
  });
});
