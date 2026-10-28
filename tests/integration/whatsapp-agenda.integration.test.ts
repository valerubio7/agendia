import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRuntimePools, tenantContext, type StoredAppointment } from "@agendia/db";
import { ToolAgentMessageSchema, type WeeklySchedule, type AiProvider, type ToolConversationProvider, type ToolConversationRequest } from "@agendia/domain";
import { normalizeBaileysMessage } from "../../packages/whatsapp-baileys/src/baileys-gateway.ts";
import { PostgresInboundHandler } from "../../apps/whatsapp-manager/src/inbound.ts";
import { PostgresWhatsAppAgenda } from "../../apps/message-worker/src/agent/adapters/agenda.ts";
import { converseAgent } from "../../apps/message-worker/src/agent/runtime.ts";
import type { AgentToolCommand, AgentToolResult } from "../../apps/message-worker/src/agent/tools.ts";
import { createMessageWorker } from "../../apps/message-worker/src/index.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

let db: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
const pn = "5491123456789@s.whatsapp.net";
const lid = "123456789@lid";
const otherPn = "14155552671@s.whatsapp.net";
const phone = "+5491123456789";
const startsAt = "2035-04-02T10:00:00-03:00";
const later = "2035-04-02T11:00:00-03:00";
interface Fixture {
  business: string;
  connection: string;
  session: string;
  service: string;
  resource: string;
  alternate: string;
  otherService: string;
  now: string;
  command: AgentToolCommand;
  textCalls: number;
  provider: {
    generate(): Promise<{ text: string; providerId: string; usageTokens: number }>;
  };
  agenda: PostgresWhatsAppAgenda;
}
interface Turn { messageId: string; outboundId: string; text: string }
const context = (h: Fixture) => tenantContext({ businessId: h.business, actorId: "message-worker", role: "internal_worker", requestId: randomUUID() });
const book = (h: Fixture, start = startsAt): AgentToolCommand => ({ name: "prepare_booking", arguments: { serviceId: h.service, startsAt: start } });
const job = (h: Fixture, messageId: string) => ({ businessId: h.business, messageId, correlationId: `test:${messageId}` });

beforeAll(async () => {
  db = await startTestPostgres();
  console.log(`whatsapp-agenda fixture container: ${db.container.getId()}`);
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(db.container.getConnectionUri());
  // A controllable ephemeral database fault proves rollback after the domain write,
  // not merely before admission. It is disabled for every unrelated fixture.
  await db.sql`create table public.agenda_fault_fixture(business_id uuid primary key, enabled boolean not null)`;
  await db.sql`grant select on public.agenda_fault_fixture to agendia_worker_runtime`;
  await db.sql.unsafe(`create function agenda_receipt_fault() returns trigger language plpgsql as $$
    begin
      if exists(select 1 from public.agenda_fault_fixture where business_id=NEW.business_id and enabled) then
        raise exception 'injected receipt persistence failure';
      end if;
      return NEW;
    end $$;
    create trigger agenda_receipt_fault before insert on whatsapp_agenda_receipts
      for each row execute function agenda_receipt_fault()`);
}, 120_000);
afterAll(async () => { await pools?.end(); await db?.stop(); });

/** Every test owns its complete tenant, catalog, calendar and received-message sequence. */
async function fixture(): Promise<Fixture> {
  const h = {
    business: randomUUID(), connection: randomUUID(), session: randomUUID(),
    service: randomUUID(), resource: randomUUID(), alternate: randomUUID(), otherService: randomUUID(),
    now: "2035-04-01T08:00:00-03:00", textCalls: 0,
    command: { name: "read_catalog", arguments: {} } as AgentToolCommand,
  } as Fixture;
  const schedule: WeeklySchedule = Object.fromEntries([0, 1, 2, 3, 4, 5, 6]
    .map(day => [day, [{ startMinute: 540, endMinute: 1080 }]]));
  await db.sql`insert into businesses(id,name) values(${h.business},'Agenda integration')`;
  await db.sql`insert into agent_configs(business_id,active) values(${h.business},true)`;
  await db.sql`insert into business_profiles(business_id,display_name,description,address)
    values(${h.business},'Agenda integration','te agendé','Avenida Central 123')`;
  await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state) values(${h.connection},${h.business},${h.session},'CONNECTED')`;
  await db.sql`insert into business_calendars(business_id,weekly_schedule) values(${h.business},${db.sql.json(schedule)})`;
  await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values
    (${h.service},${h.business},'Corte',30,1500),(${h.otherService},${h.business},'Color',45,2500)`;
  await db.sql`insert into resources(id,business_id,name,weekly_schedule) values
    (${h.resource},${h.business},'Ana',${db.sql.json(schedule)}),(${h.alternate},${h.business},'Beatriz',${db.sql.json(schedule)})`;
  for (const resource of [h.resource, h.alternate]) {
    for (const service of [h.service, h.otherService]) {
      await db.sql`insert into resource_services(business_id,resource_id,service_id) values(${h.business},${resource},${service})`;
    }
  }
  h.provider = {
    generate: async () => { h.textCalls++; return { text: "Tu turno quedó confirmado por el modelo", providerId: "injected", usageTokens: 1 }; },
  };
  h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
  return h;
}
async function receive(h: Fixture, text: string, options: {
  remoteJid?: string; alternate?: string | null; providerId?: string; trusted?: boolean;
} = {}): Promise<string> {
  const providerId = options.providerId ?? randomUUID();
  const remoteJid = options.remoteJid ?? pn;
  const alternate = options.alternate === undefined ? (remoteJid === lid ? pn : lid) : options.alternate;
  const event = normalizeBaileysMessage(h.session, {
    key: { id: providerId, remoteJid, ...(alternate ? { remoteJidAlt: alternate } : {}) },
    message: { conversation: text },
  }, options.trusted !== false)!;
  await new PostgresInboundHandler(pools).handle(event);
  const [source] = await db.sql<{ id: string; conversation_id: string }[]>`select id,conversation_id from messages
    where business_id=${h.business} and connection_id=${h.connection} and provider_message_id=${providerId}`;
  if (!source) throw new Error("Fixture receive was not persisted");
  await db.sql`update conversations set reply_due_at=now()-interval '1 second' where id=${source.conversation_id}`;
  return source.id;
}
async function output(h: Fixture, messageId: string): Promise<Turn> {
  const [row] = await db.sql<{ outbound_id: string; text: string }[]>`select outbound_id,text from outbound_commands
    where business_id=${h.business} and source_message_id=${messageId}`;
  if (!row) throw new Error("No durable response was saved");
  return { messageId, outboundId: row.outbound_id, text: row.text };
}
async function turn(h: Fixture, text: string, command: AgentToolCommand = { name: "confirm_quote", arguments: {} },
  options: Parameters<typeof receive>[2] = {}): Promise<Turn> {
  const id = await receive(h, text, options);
  await processScript(h, id, [command]);
  return output(h, id);
}
async function processScript(h: Fixture, id: string, commands: AgentToolCommand[]) {
  const outcome = await h.agenda.withAgentSession(job(h, id), async session => {
    const results = [];
    for (const command of commands) results.push(await session.execute(command.name, command.arguments));
    return renderResult(commands[0]!, results[0]!);
  });
  if (outcome.status === "infrastructure_failure") throw new Error("Agent infrastructure failure");
  return outcome.status === "committed";
}
function renderResult(_command: AgentToolCommand, _result: AgentToolResult): string {
  return JSON.stringify({ kind: "reply" });
}
async function accept(h: Fixture, text = "dale reservame ese", options: Parameters<typeof receive>[2] = {}) {
  const id = await receive(h, text, options);
  const outcome = await h.agenda.withAgentSession(job(h, id), async session => {
    expect(session.context.naturalConfirmation).not.toBeNull();
    const command: AgentToolCommand = { name: "confirm_quote_naturally", arguments: {
      ...session.context.naturalConfirmation!, evidence: session.context.message,
    } };
    return renderResult(command, await session.execute(command.name, command.arguments));
  });
  expect(outcome.status).toBe("committed");
  return output(h, id);
}
async function changeSaved(h: Fixture, text: string, command: AgentToolCommand) {
  const before = await appointments(h);
  const effects = (await counts(h)).effects;
  const quote = await turn(h, text, command);
  expect(await appointments(h)).toEqual(before);
  expect((await counts(h)).effects).toBe(effects);
  expect(quote.text).toContain("Cambio propuesto");
  await delivered(quote);
  return accept(h, "dale cambialo");
}
/** Per-turn native scripts through the ACTUAL factory; no intent/keyword translation. */
async function factoryTurn(h: Fixture, text: string,
  calls: AgentToolCommand[] | ((request: ToolConversationRequest) => AgentToolCommand[]),
  statuses: AgentToolResult["status"][],
  final: string | ((results: AgentToolResult[]) => string)): Promise<Turn> {
  const id = await receive(h, text);
  const priorTextCalls = h.textCalls;
  let rounds = 0, generationCalls = 0, failure: unknown;
  const provider: AiProvider & ToolConversationProvider = {
    generate: async () => { generationCalls++; throw new Error("Native factory must not generate"); },
    converse: async request => {
      try {
        expect(request.tools.some(tool => tool.name === "confirm_quote_naturally")).toBe(true);
        expect(JSON.parse(request.messages[1]!.content!).runtime.currentEvidence).toBe(text);
        const message = !rounds++
          ? ToolAgentMessageSchema.parse({ role: "assistant", content: null, toolCalls:
            (typeof calls === "function" ? calls(request) : calls).map((call, index) => ({
              id: `factory-${index}`, name: call.name, arguments: call.arguments,
            })) })
          : (() => {
            expect(rounds).toBe(2);
            const results = request.messages.slice(-statuses.length).map(message => {
              expect(message.role).toBe("tool");
              return JSON.parse(message.content!) as AgentToolResult;
            });
            expect(results.map(result => result.status)).toEqual(statuses);
            return { role: "assistant" as const, content: typeof final === "string" ? final : final(results), toolCalls: [] };
          })();
        return { message, providerId: "factory-script", usageTokens: 0 };
      } catch (error) { failure = error; throw error; }
    },
  };
  const worker = createMessageWorker(pools, provider);
  await worker.process(job(h, id));
  if (failure) throw failure;
  expect(rounds).toBe(2);
  await worker.process(job(h, id));
  expect(rounds).toBe(2);
  expect(generationCalls).toBe(0);
  expect(h.textCalls).toBe(priorTextCalls);
  const receipts = await db.sql`select message_id from whatsapp_agenda_receipts where message_id=${id}`;
  expect(receipts).toHaveLength(1);
  expect(await db.sql`select outbound_id from outbound_commands where business_id=${h.business} and source_message_id=${id}`).toHaveLength(1);
  const effects = await db.sql`select payload from outbox_events where business_id=${h.business}
    and topic='appointment.changed' and stable_key=${`agenda:${id}`}`;
  expect(effects).toHaveLength(statuses.includes("staged_action") ? 1 : 0);
  if (effects.length) expect(effects[0]!.payload.sourceMessageId).toBe(id);
  return output(h, id);
}
const toolReply = (results: AgentToolResult[]) => {
  const result = results[0]!;
  if (!("message" in result) || !result.message) throw new Error("Expected backend prompt/quote");
  return result.message;
};
const factoryAcceptance = (request: ToolConversationRequest): AgentToolCommand[] => {
  const runtime = JSON.parse(request.messages[1]!.content!).runtime;
  expect(runtime.naturalConfirmation).not.toBeNull();
  return [{ name: "confirm_quote_naturally", arguments: { ...runtime.naturalConfirmation, evidence: runtime.currentEvidence } }];
};
const addressReply = (results: AgentToolResult[]) => {
  expect(results[0]!.status).toBe("data");
  const profile = (results[0] as { data: { address: string | null } }).data;
  expect(profile).toHaveProperty("address");
  return JSON.stringify({ kind: "reply", facts: ["read_business"], businessFields: ["address"] });
};
async function delivered(turn: Turn) {
  // Transport success is injected; these tests prove backend transactionality, not live delivery.
  await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${turn.outboundId}`;
}
async function appointments(h: Fixture): Promise<StoredAppointment[]> {
  return pools.worker.run(context(h), repo => repo.listAppointments(h.business));
}
async function counts(h: Fixture) {
  const [row] = await db.sql<{ clients: number; appointments: number; receipts: number; effects: number }[]>`select
    (select count(*)::int from clients where business_id=${h.business}) clients,
    (select count(*)::int from appointments where business_id=${h.business}) appointments,
    (select count(*)::int from whatsapp_agenda_receipts where business_id=${h.business}) receipts,
    (select count(*)::int from outbox_events where business_id=${h.business} and topic='appointment.changed') effects`;
  return row!;
}
async function changeEvidence(h: Fixture, response: Turn, saved: boolean) {
  const [audit] = await db.sql`select event_type,outcome from audit_events
    where business_id=${h.business} and request_id=${`test:${response.messageId}`}`;
  expect(audit).toEqual({ event_type: saved ? "whatsapp.agenda.saved" : "whatsapp.agenda.reply", outcome: "success" });
  const [receipt] = await db.sql`select outbound_id,operation from whatsapp_agenda_receipts where message_id=${response.messageId}`;
  expect(receipt).toEqual({ outbound_id: response.outboundId, operation: saved ? "confirm_quote_naturally" : "agent" });
  const effects = await db.sql`select payload from outbox_events
    where business_id=${h.business} and stable_key=${`agenda:${response.messageId}`} and topic='appointment.changed'`;
  expect(effects).toHaveLength(saved ? 1 : 0);
}
async function prepare(h: Fixture, start = startsAt) {
  const initial = await turn(h, `Reservar Corte el ${start.slice(0, 10)} a las ${start.slice(11, 16)}`, book(h, start));
  expect(initial.text).toBe("Decime tu nombre y apellido.");
  expect((await counts(h)).clients).toBe(0);
  const quote = await turn(h, "Mi nombre es María Pérez");
  expect(quote.text).toContain("Reserva propuesta");
  expect(quote.text).toContain("30 minutos, ARS 1500");
  await delivered(quote);
  return quote;
}
async function booked(h: Fixture) {
  await prepare(h);
  const saved = await accept(h);
  expect(saved.text).toContain("Guardado:");
  const [appointment] = await appointments(h);
  return appointment!;
}

async function pendingFrozenReschedule() {
  const h = await fixture();
  await db.sql`update services set duration_minutes=60,price_ars=3000 where id=${h.service}`;
  await db.sql`insert into clients(business_id,first_name,last_name,phone) values(${h.business},'Stored','Identity',${phone})`;
  const appointment = await pools.api.run(context(h), async repo => {
    const client = await repo.findClientByCanonicalPhone(phone);
    return repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource,
      startRaw: startsAt, clientId: client!.id }, { now: h.now, origin: "manual" });
  });
  await db.sql`update services set duration_minutes=15,price_ars=9999 where id=${h.service}`;
  const proposal: AgentToolCommand = { name: "prepare_change", arguments: { appointmentId: appointment.id, serviceId: h.service, startsAt: later } };
  const pending = await turn(h, "Reprogramar mi turno, prefiero Ana", proposal);
  expect(pending.text).toContain("Cambio propuesto");
  expect((await appointments(h))[0]).toEqual(appointment);
  expect((await counts(h)).effects).toBe(0);
  return { h, appointment, proposal };
}

describe("standalone sender-scoped WhatsApp agenda persistence", () => {
  test("catalog, own history and real adaptive same-day slots create no clients", async () => {
    const h = await fixture();
    const catalog = await turn(h, "Consultar servicios", { name: "read_catalog", arguments: {} });
    expect(catalog.text).toContain("Corte: 30 minutos, ARS 1500");
    const own = await turn(h, "Consultar turnos", { name: "owned_appointments", arguments: {} });
    expect(own.text).toContain("No tenés turnos");
    const available = await turn(h, "Horarios del Corte el 2035-04-02", { name: "availability", arguments: { serviceId: h.service, date: "2035-04-02" } });
    expect(available.text).toContain("09:00, 09:15, 09:30, 09:45");
    expect(available.text).toContain("17:30");
    expect(available.text).not.toContain("Ana");
    expect((await counts(h)).clients).toBe(0);
    expect((await counts(h)).appointments).toBe(0);
  });

  for (const [text, date, weekday] of [
    ["Consultar horarios del Corte mañana", "2026-10-15", "jueves"],
    ["Proba el viernes 16", "2026-10-16", "viernes"],
  ] as const) {
    test(`native date scope is disclosed despite raw or retained ${weekday}`, async () => {
      const h = await fixture();
      h.now = "2026-10-14T19:30:00-03:00";
      const proposal: AgentToolCommand = { name: "availability", arguments: {
        serviceId: h.service, date: "2026-10-19",
      } };
      for (const retained of [false, true]) {
        if (retained) await turn(h, "Consultar horarios el 2026-10-20, prefiero Beatriz", proposal);
        const response = await turn(h, text, proposal);
        expect(response.text).toContain("2026-10-19: 09:00");
        expect(response.text).not.toContain(date);
        expect(response.text).not.toContain("2026-10-20");
        const followup = await turn(h, "¿Qué horarios hay?", proposal);
        expect(followup.text).toContain("2026-10-19: 09:00");
      }
      expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    });
  }

  test("public availability references recover through fresh native tool results without changing the chosen service or resource", async () => {
    for (const kind of ["service", "resource"] as const) {
      for (const invalid of ["missing", "foreign", "inactive"] as const) {
        const h = await fixture(), foreign = await fixture();
        const bad = invalid === "missing" ? randomUUID() : invalid === "foreign" ? foreign[kind] : h[kind];
        if (invalid === "inactive") {
          if (kind === "service") await db.sql`update services set status='suspended' where id=${bad}`;
          else await db.sql`update resources set status='suspended' where id=${bad}`;
        }
        const events: unknown[] = [];
        h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now, event => events.push(event));
        const id = await receive(h, "Horarios del Corte mañana, prefiero Ana");
        let round = 0;
        const provider: ToolConversationProvider = { converse: async request => {
          const call = (name: string, args: Record<string, string>) => ({ message: { role: "assistant" as const, content: null,
            toolCalls: [{ id: `recovery_${round}`, name, arguments: args }] }, providerId: "fake", usageTokens: 0 });
          round++;
          if (round === 1) return call("availability", { serviceId: kind === "service" ? bad : h.service,
            resourceId: kind === "resource" ? bad : h.resource, date: "2035-04-02" });
          const result = JSON.parse(request.messages.at(-1)!.content!);
          if (round === 2) {
            expect(result).toMatchObject({ status: "rejected", code: `${kind.toUpperCase()}_REFERENCE_REQUIRED` });
            expect(result.message).toContain(kind === "service" ? "read_catalog" : "read_resources");
            expect(JSON.stringify(result)).not.toContain(bad);
            // Simulate the same chosen public entity becoming active again, not selecting another one.
            if (invalid === "inactive") {
              if (kind === "service") await db.sql`update services set status='active' where id=${bad}`;
              else await db.sql`update resources set status='active' where id=${bad}`;
            }
            return call(kind === "service" ? "read_catalog" : "read_resources", {});
          }
          if (round === 3) {
            const chosen = result.data.items.find((item: { name: string }) => item.name === (kind === "service" ? "Corte" : "Ana"));
            expect(chosen.id).toBe(h[kind]);
            return call("availability", { serviceId: kind === "service" ? chosen.id : h.service,
              resourceId: kind === "resource" ? chosen.id : h.resource, date: "2035-04-02" });
          }
          expect(result.status).toBe("data");
          expect(result.data.items.length).toBeGreaterThan(0);
          expect(result.data.items.every((item: { serviceId: string; resourceId: string }) => item.serviceId === h.service && item.resourceId === h.resource)).toBe(true);
          return { message: { role: "assistant", content: "Horarios verificados.", toolCalls: [] }, providerId: "fake", usageTokens: 0 };
        } };
        expect((await h.agenda.withAgentSession(job(h, id), session => converseAgent(provider, session,
          [...session.context.messages!], "reference-recovery"))).status).toBe("committed");
        expect(round).toBe(4);
        expect(events).toContainEqual({ code: "agent.tool_rejected", toolName: "availability",
          errorCode: "UNKNOWN_OWNED_ID", referenceFailureKind: kind });
        for (const secret of [bad, id, phone]) expect(JSON.stringify(events)).not.toContain(secret);
        expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
      }
    }
  });

  test("appointment denials retain private client results and emit only safe internal codes", async () => {
    const h = await fixture(), foreign = await fixture();
    const foreignAppointment = await booked(foreign);
    const events: unknown[] = [];
    h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now, event => events.push(event));
    const commands: AgentToolCommand[] = [
      { name: "availability", arguments: { serviceId: h.service, date: "2035-04-02", appointmentId: foreignAppointment.id } },
      { name: "availability", arguments: { serviceId: h.service, date: "2035-04-02", appointmentId: randomUUID() } },
      { name: "owned_appointment", arguments: { appointmentId: foreignAppointment.id } },
    ];
    const id = await receive(h, "Private customer request, name and phone must not be logged");
    const outcome = await h.agenda.withAgentSession(job(h, id), async session => {
      const results = [];
      for (const command of commands) {
        const result = await session.execute(command.name, command.arguments);
        expect(result).toMatchObject({ status: "rejected", code: "AGENDA_REJECTED" });
        expect(result).not.toHaveProperty("data");
        results.push(result);
      }
      expect(results[0]).toEqual(results[1]);
      return "No se guardó ningún cambio.";
    });
    expect(outcome.status).toBe("committed");
    expect(events.filter((e: any) => e.code === "agent.tool_rejected")).toEqual(commands.map(command => ({ code: "agent.tool_rejected",
      toolName: command.name, errorCode: "UNKNOWN_OWNED_ID", ...(command.name === "availability" ? { referenceFailureKind: "appointment_context" } : {}) })));
    const serialized = JSON.stringify(events);
    for (const forbidden of [id, h.business, h.service, foreign.service, foreignAppointment.id, phone, "Private customer", "arguments"])
      expect(serialized).not.toContain(forbidden);
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await factoryTurn(h, "Private request", [commands[0]!], ["rejected"], "No se guardó ningún cambio.");
      expect(warning.mock.calls).toEqual([
        [JSON.stringify({ code: "agent.tool_rejected", toolName: "availability", errorCode: "UNKNOWN_OWNED_ID", referenceFailureKind: "appointment_context" })],
        [JSON.stringify({ code: "agent.tool_completed", toolName: "availability", status: "rejected" })],
        [JSON.stringify({ code: "agent.turn_completed", toolCalls: 1, completedCalls: 1, failedCalls: 0 })],
      ]);
    } finally { warning.mockRestore(); }
  });

  test("without a current or retained date availability keeps the model-selected day", async () => {
    const h = await fixture();
    const response = await turn(h, "Consultar horarios del Corte", { name: "availability", arguments: {
      serviceId: h.service, date: "2035-04-03",
    } });
    expect(response.text).toContain("2035-04-03: 09:00");
  });

  for (const modelResource of ["other", "omitted"] as const) {
    test(`availability scopes ${modelResource} resource separately from retained preference`, async () => {
      const h = await fixture();
      const proposal: AgentToolCommand = { name: "availability", arguments: {
        serviceId: h.service, date: "2035-04-02", ...(modelResource === "other" ? { resourceId: h.alternate } : {}),
      } };
      await db.sql`update resources set weekly_schedule='{}'::jsonb where id=${h.resource}`;
      const unavailable = await turn(h, "Consultar horarios del Corte mañana, prefiero Ana", proposal);
      expect(unavailable.text).toContain(modelResource === "other" ? "Horarios disponibles con Beatriz" : "No hay horarios disponibles con Ana");
      expect(unavailable.text.includes("09:00")).toBe(modelResource === "other");
      h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
      const retained = await turn(h, "Consultar horarios del Corte", proposal);
      expect(retained.text).toContain(modelResource === "other" ? "Horarios disponibles con Beatriz" : "No hay horarios disponibles con Ana");
      const replaced = await turn(h, "Prefiero Beatriz", proposal);
      expect(replaced.text).toContain("Horarios disponibles con Beatriz: 2035-04-02: 09:00");
      const removed = await turn(h, "Sin preferencia", proposal);
      expect(removed.text).toContain(modelResource === "other" ? "Horarios disponibles con Beatriz: 2035-04-02: 09:00" : "Horarios disponibles: 2035-04-02: 09:00");
      const noChoice: AgentToolCommand = { name: "availability", arguments: { serviceId: h.service, date: "2035-04-03" } };
      const unknown = await turn(h, "Prefiero Desconocido", noChoice);
      expect(unknown.text).toBe("No reconocí el recurso solicitado. ¿Cuál querés?");
      h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
      const unresolved = await turn(h, "El 2035-04-03", noChoice);
      expect(unresolved.text).toBe(unknown.text);
      const resolved = await turn(h, "Prefiero Beatriz", proposal);
      expect(resolved.text).toContain("Horarios disponibles con Beatriz: 2035-04-02");
      expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    });
  }

  test("native availability honors supplied scope and preserves quote and owned reschedule binding", async () => {
    const h = await fixture();
    const proposal: AgentToolCommand = { name: "availability", arguments: { serviceId: h.service, date: "2035-04-02", resourceId: h.resource } };
    await db.sql`update resources set weekly_schedule='{}'::jsonb where id=${h.resource}`;
    const unrestricted = await turn(h, "Consultar horarios del Corte mañana", proposal);
    expect(unrestricted.text).toContain("No hay horarios disponibles con Ana para 2035-04-02");
    await prepare(h);
    const [quoted] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    const scoped = await turn(h, "Consultar horarios del Corte, prefiero Beatriz", proposal);
    expect(scoped.text).toContain("No hay horarios disponibles con Ana");
    const [afterQuote] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(afterQuote!.dialogue.quote).toEqual(quoted!.dialogue.quote);
    expect((await counts(h)).effects).toBe(0);
    await turn(h, "confirmo");
    const original = (await appointments(h))[0]!;
    await turn(h, "Reprogramar mi turno, prefiero Beatriz", { name: "prepare_change", arguments: { appointmentId: original.id, serviceId: h.service, startsAt: later } });
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
    const retained = await turn(h, "Consultar horarios del Corte el 2035-04-03", proposal);
    expect(retained.text).toContain("No hay horarios disponibles con Ana para 2035-04-02");
    const [afterBinding] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(afterBinding!.dialogue.reschedule).toEqual(pending!.dialogue.reschedule);
    expect((await appointments(h))[0]).toEqual(original);
    expect((await counts(h)).effects).toBe(1);
  });

  test("pending reschedule availability excludes own occupancy and rejects gaps shorter than frozen duration across restart", async () => {
    const { h, appointment, proposal } = await pendingFrozenReschedule();
    await pools.api.run(context(h), repo => repo.createAppointment(h.business, {
      serviceId: h.service, resourceId: h.resource, startRaw: "2035-04-02T11:30:00-03:00", clientId: appointment.client.id,
    }, { now: h.now, origin: "manual" }));
    const before = await appointments(h);
    h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
    const available = await turn(h, "Consultar horarios del Corte el 2035-04-02", {
      name: "availability", arguments: { serviceId: h.service, date: "2035-04-02", resourceId: h.resource },
    });
    expect(available.text).toContain("Horarios disponibles con Ana");
    expect(available.text).toContain("10:00");
    expect(available.text).not.toContain("11:00");
    expect(available.text).toContain("12:00");
    expect(await appointments(h)).toEqual(before);
    expect((await counts(h)).effects).toBe(0);
    const rejected = await turn(h, "El 2035-04-02 a las 11:00", { name: "prepare_change", arguments: {
      ...proposal.arguments, startsAt: later,
    } });
    expect(rejected.text).not.toContain("Cambio guardado");
    expect(await appointments(h)).toEqual(before);
    expect((await counts(h)).effects).toBe(0);
    const saved = await changeSaved(h, "El 2035-04-02 a las 12:00", { name: "prepare_change", arguments: {
      ...proposal.arguments, startsAt: "2035-04-02T12:00:00-03:00",
    } });
    expect(saved.text).toContain("Guardado:");
    expect(saved.text).toContain("60 minutos, ARS 3000");
    const current = (await appointments(h)).find(item => item.id === appointment.id)!;
    expect(current.terms).toEqual(appointment.terms);
    expect(current.startMs).toBe(Date.parse("2035-04-02T12:00:00-03:00"));
    expect(current.endMs - current.startMs).toBe(60 * 60000);
    expect((await counts(h)).effects).toBe(1);
  });

  test("explicit alternate-day reschedule query uses frozen duration and retained resource eligibility", async () => {
    const { h, appointment } = await pendingFrozenReschedule();
    await db.sql`insert into business_calendar_closures(business_id,kind,closed_date) values(${h.business},'date','2035-04-02')`;
    await pools.api.run(context(h), repo => repo.createAppointment(h.business, {
      serviceId: h.service, resourceId: h.resource, startRaw: "2035-04-03T11:00:00-03:00", clientId: appointment.client.id,
    }, { now: h.now, origin: "manual" }));
    const before = await appointments(h);
    h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
    const proposal: AgentToolCommand = { name: "availability", arguments: { serviceId: h.service, date: "2035-04-02" } };
    expect((await turn(h, "Consultar horarios del Corte el 2035-04-02", proposal)).text).toContain("No hay horarios disponibles con Ana para 2035-04-02");
    proposal.arguments.date = "2035-04-03";
    const available = await turn(h, "¿Y el otro día?", proposal);
    expect(available.text).toContain("Horarios disponibles con Ana: 2035-04-03");
    expect(available.text).toContain("10:00");
    expect(available.text).not.toContain("10:15");
    expect(await appointments(h)).toEqual(before);
    expect((await counts(h)).effects).toBe(0);
    await db.sql`update resources set status='suspended' where id=${h.resource}`;
    const unavailable = await turn(h, "Consultar horarios del Corte el 2035-04-02", proposal);
    expect(unavailable.text).toContain("No hay horarios disponibles con Ana");
    expect(unavailable.text).not.toContain("Horarios disponibles con Beatriz");
    expect(await appointments(h)).toEqual(before);
    expect((await counts(h)).effects).toBe(0);
  });

  for (const invalid of ["snapshot", "foreign", "binding-service", "model-service", "state", "started"] as const) {
    test(`pending reschedule availability rejects ${invalid} context before preference resolution`, async () => {
      const { h, appointment } = await pendingFrozenReschedule();
      if (invalid === "snapshot")
        await db.sql`update appointments set customer_resource_preference_id=${h.alternate} where id=${appointment.id}`;
      if (invalid === "foreign")
        await db.sql`update clients set phone='+14155552671' where id=${appointment.client.id}`;
      if (invalid === "binding-service")
        await db.sql`update whatsapp_agenda_dialogues set dialogue=jsonb_set(dialogue,'{reschedule,serviceId}',to_jsonb(${h.otherService}::text)) where business_id=${h.business}`;
      if (invalid === "state")
        await db.sql`update appointments set state='cancelled' where id=${appointment.id}`;
      if (invalid === "started") h.now = "2035-04-02T10:00:00-03:00";
      const before = await appointments(h);
      const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
      const rejected = await turn(h, "Consultar horarios del Corte el 2035-04-03, prefiero Desconocido", {
        name: "availability", arguments: {
          serviceId: invalid === "model-service" ? h.otherService : h.service, date: "2035-04-03", resourceId: h.alternate,
        },
      });
      const [retained] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(retained!.dialogue).toEqual(pending!.dialogue);
      expect(rejected.text).not.toContain("Horarios disponibles");
      expect(rejected.text).not.toContain("No reconocí el recurso");
      expect(rejected.text).toContain("guardó");
      expect(await appointments(h)).toEqual(before);
      expect((await counts(h)).effects).toBe(0);
    });
  }

  test("complete native selections prepare only and do not prove customer intent or acceptance", async () => {
    const h = await fixture();
    const missingDate = await factoryTurn(h, "Reservar Corte", [book(h), { name: "clear_pending", arguments: {} }],
      ["clarification", "data"], JSON.stringify({ kind: "reply", ask: "date", facts: [] }));
    expect(missingDate.text).toBe("¿Para qué día?");
    const [cleared] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(cleared!.dialogue.quote).toBeNull();
    expect((await counts(h)).clients).toBe(0);
    const dayOnly = await turn(h, "El 2035-04-02", book(h));
    expect(dayOnly.text).toBe("Decime tu nombre y apellido.");
    const wrongTime = await turn(h, "a las 11:00", book(h));
    expect(wrongTime.text).toBe("Decime tu nombre y apellido.");
    expect((await counts(h)).appointments).toBe(0);
    const selected = await turn(h, "a las 10:00", book(h));
    expect(selected.text).toBe("Decime tu nombre y apellido.");
    expect((await counts(h)).clients).toBe(0);
    const unconfirmed = await turn(h, "sí pero cambia el precio", book(h));
    expect(unconfirmed.text).not.toContain("Guardado:");
    expect((await counts(h)).appointments).toBe(0);
    const currentQuote = await turn(h, "Mi nombre es María Pérez");
    expect(currentQuote.text).toContain("ARS 1500");
    await delivered(currentQuote);
    const conditional = await factoryTurn(h, "sí pero cambia el precio", [{ name: "read_catalog", arguments: {} }], ["data"], results => {
      expect(JSON.stringify(results)).toContain("1500");
      return JSON.stringify({ kind: "reply", facts: ["read_catalog"], ask: "booking" });
    });
    expect(conditional.text).toContain("¿Querés reservar");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
  });

  test("actual native worker fails closed for zero-tool prose and forged response kinds", async () => {
    for (const content of ["Reserva propuesta: Corte mañana por ARS 1.", "Tu turno está confirmado.",
      JSON.stringify({ kind: "chat", text: "Tu turno está confirmado." }),
      JSON.stringify({ kind: "reply", proof: { appointmentId: randomUUID() }, text: "Confirmado" })]) {
      const h = await fixture();
      const id = await receive(h, "quiero un turno");
      let calls = 0;
      const provider: AiProvider & ToolConversationProvider = {
        generate: async () => { throw new Error("No legacy generation"); },
        converse: async () => {
          calls++;
          return { message: { role: "assistant", content, toolCalls: [] }, providerId: "proof-script", usageTokens: 0 };
        },
      };
      const worker = createMessageWorker(pools, provider);
      await worker.process(job(h, id));
      await worker.process(job(h, id));
      expect(calls).toBe(1);
      expect((await output(h, id)).text).toBe("¿Qué servicio y día querés consultar?");
      expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0, receipts: 1 });
      expect(await db.sql`select outbound_id from outbound_commands where source_message_id=${id}`).toHaveLength(1);
    }
  });

  test("new names require an explicit answer and detailed delivered quote before real confirmation", async () => {
    const h = await fixture();
    const initial = await factoryTurn(h, "Reservar Corte el 2035-04-02 a las 10:00", [
      { name: "prepare_booking", arguments: { serviceId: h.service, startsAt } },
    ], ["clarification"], toolReply);
    expect(initial.text).toBe("Decime tu nombre y apellido.");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    const modelNames = await factoryTurn(h, "El perfil dice María Pérez", [{ name: "confirm_quote", arguments: {} }],
      ["clarification"], "Necesito tu respuesta: mi nombre es Nombre Apellido.");
    expect(modelNames.text).toBe("Decime tu nombre y apellido.");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    await factoryTurn(h, "Mi nombre es María", [{ name: "confirm_quote", arguments: {} }],
      ["clarification"], "Necesito también tu apellido.");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    for (const answer of ["Mi DNI es 12345678", "Mi obra social es Salud"]) {
      const missing = await factoryTurn(h, answer, [{ name: "confirm_quote", arguments: {} }], ["clarification"], "Tu turno está confirmado.");
      expect(missing.text).toBe("Decime tu nombre y apellido.");
      expect(missing.text).not.toContain("confirmado");
      expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    }
    const quote = await factoryTurn(h, "Mi nombre es María Pérez", [{ name: "confirm_quote", arguments: {} }], ["prepared_quote"], toolReply);
    for (const term of ["Corte", "2035-04-02", "10:00", "30 minutos", "ARS 1500"]) expect(quote.text).toContain(term);
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    const early = await factoryTurn(h, "confirmo", request => {
      expect(JSON.parse(request.messages[1]!.content!).runtime.naturalConfirmation).toBeNull();
      return [{ name: "confirm_quote", arguments: {} }];
    }, ["prepared_quote"], toolReply);
    expect(early.text).toContain("Primero necesitás recibir");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(pending!.dialogue.quote.outboundId).toBe(early.outboundId);
    expect(early.outboundId).not.toBe(quote.outboundId);
    const [unsent] = await db.sql`select source_message_id,state,acknowledged_at from outbound_commands where outbound_id=${early.outboundId}`;
    expect(unsent).toEqual({ source_message_id: early.messageId, state: "generated", acknowledged_at: null });
    await delivered(early);
    const [sent] = await db.sql`select state,acknowledged_at from outbound_commands where outbound_id=${early.outboundId}`;
    expect(sent!.state).toBe("sent");
    expect(sent!.acknowledged_at).not.toBeNull();
    const saved = await factoryTurn(h, "dale reservame ese", request => {
      expect(JSON.parse(request.messages[1]!.content!).runtime.pending.quote.outboundId).toBe(early.outboundId);
      return factoryAcceptance(request);
    }, ["staged_action"], "Confirmado para Inventado mañana por ARS 1. Ya pagaste.");
    expect(saved.text).toContain("Guardado:");
    expect(saved.text).not.toContain("Inventado");
    expect(saved.text).not.toContain("pagaste");
    for (const term of ["Corte", "2035-04-02", "10:00", "30 minutos", "ARS 1500"]) expect(saved.text).toContain(term);
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, receipts: 8, effects: 1 });
    expect(await db.sql`select outbound_id from outbound_commands where business_id=${h.business}`).toHaveLength(8);
    expect(await db.sql`select outbound_id from outbound_commands where source_message_id=${saved.messageId}`).toHaveLength(1);
    const [appointment] = await appointments(h);
    expect(appointment!.client).toMatchObject({ firstName: "María", lastName: "Pérez", phone });
    expect(appointment!.origin).toBe("ai");
    const [scope] = await db.sql`select business_id from appointments where id=${appointment!.id}`;
    expect(scope!.business_id).toBe(h.business);
    expect(appointment!.startMs).toBe(Date.parse(startsAt));
    expect(appointment!.terms).toMatchObject({ serviceId: h.service, resourceId: h.resource, durationMinutes: 30, priceArs: 1500 });
    expect(appointment!.customerResourcePreference).toBeNull();
  });

  test("existing current client names are never requested or AI-edited", async () => {
    const h = await fixture();
    await db.sql`insert into clients(business_id,first_name,last_name,phone) values(${h.business},'Stored','Identity',${phone})`;
    const [identity] = await db.sql`select id,first_name,last_name,phone from clients where business_id=${h.business}`;
    const quote = await factoryTurn(h, "Reservar Corte el 2035-04-02 a las 10:00", [
      { name: "prepare_booking", arguments: { serviceId: h.service, startsAt } },
    ], ["prepared_quote"], toolReply);
    expect(quote.text).toContain("Reserva propuesta");
    expect(quote.text).not.toContain("Decime tu nombre y apellido.");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 0, effects: 0 });
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(pending!.dialogue.quote.outboundId).toBe(quote.outboundId);
    await delivered(quote);
    const [sent] = await db.sql`select source_message_id,state,acknowledged_at from outbound_commands where outbound_id=${quote.outboundId}`;
    expect(sent!.source_message_id).toBe(quote.messageId);
    expect(sent!.state).toBe("sent");
    expect(sent!.acknowledged_at).not.toBeNull();
    await factoryTurn(h, "dale, mi nombre es Inventado Modelo, reservame ese", factoryAcceptance,
      ["staged_action"], "Guardado: Inventado Modelo.");
    const [appointment] = await appointments(h);
    expect(appointment!.client).toMatchObject({ id: identity!.id, firstName: "Stored", lastName: "Identity", phone });
    expect([...await db.sql`select id,first_name,last_name,phone from clients where business_id=${h.business}`]).toEqual([identity!]);
    expect(appointment!.origin).toBe("ai");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, receipts: 2, effects: 1 });
    expect(await db.sql`select outbound_id from outbound_commands where business_id=${h.business}`).toHaveLength(2);
  });

  test("changed current service terms require a fresh delivered confirmation", async () => {
    const h = await fixture();
    await factoryTurn(h, "Reservar Corte el 2035-04-02 a las 10:00", [
      { name: "prepare_booking", arguments: { serviceId: h.service, startsAt } },
    ], ["clarification"], toolReply);
    const quote = await factoryTurn(h, "Mi nombre es María Pérez", [{ name: "confirm_quote", arguments: {} }], ["prepared_quote"], toolReply);
    expect(quote.text).toContain("30 minutos, ARS 1500");
    await delivered(quote);
    await db.sql`update services set duration_minutes=45,price_ars=2300 where id=${h.service}`;
    const fresh = await factoryTurn(h, "dale reservame ese", factoryAcceptance, ["prepared_quote"], toolReply);
    expect(fresh.text).toContain("Las condiciones cambiaron");
    expect(fresh.text).toContain("45 minutos, ARS 2300");
    expect(fresh.outboundId).not.toBe(quote.outboundId);
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    const early = await factoryTurn(h, "confirmo", request => {
      expect(JSON.parse(request.messages[1]!.content!).runtime.naturalConfirmation).toBeNull();
      return [{ name: "confirm_quote", arguments: {} }];
    }, ["prepared_quote"], toolReply);
    expect(early.text).toContain("Primero necesitás recibir");
    expect(early.text).toContain("45 minutos, ARS 2300");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(pending!.dialogue.quote.outboundId).toBe(early.outboundId);
    expect(early.outboundId).not.toBe(fresh.outboundId);
    const [unsent] = await db.sql`select source_message_id,state,acknowledged_at from outbound_commands where outbound_id=${early.outboundId}`;
    expect(unsent).toEqual({ source_message_id: early.messageId, state: "generated", acknowledged_at: null });
    await delivered(early);
    const [sent] = await db.sql`select state,acknowledged_at from outbound_commands where outbound_id=${early.outboundId}`;
    expect(sent!.state).toBe("sent");
    expect(sent!.acknowledged_at).not.toBeNull();
    const saved = await factoryTurn(h, "sí, reservame con esas condiciones nuevas", request => {
      expect(JSON.parse(request.messages[1]!.content!).runtime.pending.quote.outboundId).toBe(early.outboundId);
      return factoryAcceptance(request);
    }, ["staged_action"], "Guardado:");
    expect(saved.text).toContain("Guardado:");
    const [appointment] = await appointments(h);
    expect(appointment!.terms).toMatchObject({ durationMinutes: 45, priceArs: 2300 });
    expect(appointment!.endMs - appointment!.startMs).toBe(45 * 60000);
    expect(appointment!.client).toMatchObject({ firstName: "María", lastName: "Pérez", phone });
    expect(appointment!.origin).toBe("ai");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, receipts: 5, effects: 1 });
    expect(await db.sql`select outbound_id from outbound_commands where business_id=${h.business}`).toHaveLength(5);
  });

  for (const kind of ["book", "change"] as const) {
    for (const summaryDelivered of [false, true]) {
      test(`${kind}: sent detours preserve ${summaryDelivered ? "delivered" : "undelivered"} summary evidence across restart`, async () => {
        const h = await fixture();
        const original = kind === "change" ? await booked(h) : null;
        if (!original) {
          const prompt = await turn(h, "Reservar Corte el 2035-04-02 a las 10:00", book(h));
          await delivered(prompt);
          const [state] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
          expect(state!.dialogue.quote.outboundId).toBeNull();
        }
        const summary = original
          ? await turn(h, "Cambiar servicio a Color", { name: "prepare_change", arguments: {
            appointmentId: original.id, serviceId: h.otherService,
          } }) : await turn(h, "Mi nombre es María Pérez");
        if (summaryDelivered) await delivered(summary);
        const before = await appointments(h);
        const effects = (await counts(h)).effects;
        for (const [text, proposal] of [
          ["Consultar servicios", { name: "read_catalog", arguments: {} }],
          ["Consultar turnos", { name: "owned_appointments", arguments: {} }],
          ["Horarios del Corte el 2035-04-02", { name: "availability", arguments: { serviceId: h.service, date: "2035-04-02" } }],
          ["Consultar reserva", { name: "owned_appointments", arguments: {} }],
        ] satisfies [string, AgentToolCommand][]) {
          const detour = await turn(h, text, proposal);
          await delivered(detour);
          const [state] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
          expect(state!.dialogue.quote.outboundId).toBe(summary.outboundId);
          expect(await appointments(h)).toEqual(before);
          expect((await counts(h)).effects).toBe(effects);
        }
        h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
        const confirmation = await turn(h, "confirmo");
        if (!summaryDelivered) {
          expect(confirmation.text).toContain("Primero necesitás recibir");
          expect(await appointments(h)).toEqual(before);
          expect((await counts(h)).effects).toBe(effects);
          await delivered(confirmation);
          expect((await turn(h, "confirmo")).text).toContain("Guardado:");
        } else expect(confirmation.text).toContain("Guardado:");
        expect((await counts(h)).effects).toBe(effects + 1);
        expect((await appointments(h))[0]!.terms.serviceId).toBe(original ? h.otherService : h.service);
      });
    }

    test(`${kind}: superseded delivery cannot confirm refreshed terms via a sent catalog`, async () => {
      const h = await fixture();
      const original = kind === "change" ? await booked(h) : null;
      const summary = original
        ? await turn(h, "Cambiar servicio a Color", { name: "prepare_change", arguments: {
          appointmentId: original.id, serviceId: h.otherService,
        } }) : await prepare(h);
      await delivered(summary);
      const service = original ? h.otherService : h.service;
      const before = await appointments(h);
      const effects = (await counts(h)).effects;
      await db.sql`update services set duration_minutes=60,price_ars=3200 where id=${service}`;
      const fresh = await turn(h, "confirmo");
      expect(fresh.text).toContain("Las condiciones cambiaron");
      expect(fresh.text).toContain("60 minutos, ARS 3200");
      await delivered(summary);
      const catalog = await turn(h, "Consultar servicios", { name: "read_catalog", arguments: {} });
      await delivered(catalog);
      const [state] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(state!.dialogue.quote.outboundId).toBe(fresh.outboundId);
      h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
      const premature = await turn(h, "confirmo");
      expect(premature.text).toContain("Primero necesitás recibir");
      expect(await appointments(h)).toEqual(before);
      expect((await counts(h)).effects).toBe(effects);
      await delivered(premature);
      expect((await turn(h, "confirmo")).text).toContain("Guardado:");
      expect((await appointments(h))[0]!.terms).toMatchObject({ durationMinutes: 60, priceArs: 3200 });
      expect((await counts(h)).effects).toBe(effects + 1);
    });
  }

  test("capacity is locked and revalidated, with no orphan client or false replacement", async () => {
    const h = await fixture();
    await prepare(h);
    await db.sql`insert into clients(business_id,first_name,last_name,phone) values(${h.business},'Other','Client','+14155552671')`;
    for (const resourceId of [h.resource, h.alternate]) {
      await pools.api.run(context(h), async repo => {
        const other = await repo.findClientByCanonicalPhone("+14155552671");
        return repo.createAppointment(h.business, { serviceId: h.service, resourceId, startRaw: startsAt, clientId: other!.id }, { now: h.now, origin: "manual" });
      });
    }
    const denied = await turn(h, "confirmo");
    expect(denied.text).toContain("ya no está disponible");
    expect(denied.text).not.toContain("Guardado:");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 2, effects: 0 });
    expect((await appointments(h)).every(ap => ap.client.phone !== phone)).toBe(true);
  });

  test("concurrent duplicate job and inbound retries produce one booking and one terminal receipt", async () => {
    const h = await fixture();
    await prepare(h);
    const id = await receive(h, "confirmo", { providerId: "repeat-confirm" });
    await Promise.all([processScript(h, id, [{ name: "confirm_quote", arguments: {} }]), processScript(h, id, [{ name: "confirm_quote", arguments: {} }])]);
    expect((await output(h, id)).text).toContain("Guardado:");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
    const [receipt] = await db.sql`select count(*)::int count from whatsapp_agenda_receipts where message_id=${id}`;
    expect(receipt!.count).toBe(1);
    await receive(h, "confirmo", { providerId: "repeat-confirm" });
    await processScript(h, id, [{ name: "confirm_quote", arguments: {} }]);
    expect((await counts(h)).appointments).toBe(1);
    const repeatedYes = await turn(h, "confirmo", { name: "confirm_quote", arguments: {} });
    expect(repeatedYes.text).not.toContain("Guardado:");
    expect((await counts(h)).appointments).toBe(1);
  });

  test("PN and evidenced LID share durable dialogue, never another phone sharing a spoofed LID", async () => {
    const h = await fixture();
    await turn(h, "Reservar Corte el 2035-04-02 a las 10:00", book(h));
    const quote = await turn(h, "Mi nombre es María Pérez", undefined, { remoteJid: lid });
    expect(quote.text).toContain("Reserva propuesta");
    await delivered(quote);
    const spoof = await turn(h, "confirmo", undefined, { remoteJid: lid, alternate: otherPn });
    expect(spoof.text).toContain("No pude verificar");
    expect((await counts(h)).clients).toBe(0);
    const saved = await turn(h, "confirmo", undefined, { remoteJid: lid });
    expect(saved.text).toContain("Guardado:");
    expect((await appointments(h))[0]!.client.phone).toBe(phone);
  });

  test("missing evidence and user-typed other phone never resolve a LID, including after reconnect", async () => {
    const h = await fixture();
    await turn(h, "Consultar servicios", { name: "read_catalog", arguments: {} }, { remoteJid: lid });
    await db.sql`update whatsapp_connections set state='RECONNECTING' where id=${h.connection}`;
    await db.sql`update whatsapp_connections set state='CONNECTED' where id=${h.connection}`;
    const unresolved = await turn(h, "Reservar Corte, mi número es +5491123456789", book(h), { remoteJid: lid, alternate: null });
    expect(unresolved.text).toContain("No pude verificar");
    expect((await counts(h)).appointments).toBe(0);
    const history = await turn(h, "Reservar Corte", book(h), { trusted: false });
    expect(history.text).toContain("No pude verificar");
    expect((await counts(h)).clients).toBe(0);
  });

  test("rebinding either side fails closed and mappings are tenant/connection isolated", async () => {
    const a = await fixture();
    const b = await fixture();
    await turn(a, "Consultar servicios", { name: "read_catalog", arguments: {} });
    const changedLid = await turn(a, "Reservar Corte", book(a), { remoteJid: pn, alternate: "987654321@lid" });
    expect(changedLid.text).toContain("No pude verificar");
    const foreignPhone = await turn(a, "Reservar Corte", book(a), { remoteJid: otherPn, alternate: lid });
    expect(foreignPhone.text).toContain("No pude verificar");
    const independent = await turn(b, "Consultar servicios", { name: "read_catalog", arguments: {} }, { remoteJid: otherPn, alternate: lid });
    expect(independent.text).toContain("Corte");
    const foreignService = await turn(a, "Reservar Corte el 2035-04-02 a las 10:00", { name: "prepare_booking", arguments: { serviceId: b.service, startsAt } });
    expect(foreignService.text).toContain("No se guardó");
    expect((await counts(a)).clients).toBe(0);
    const [binding] = await db.sql`select count(*)::int count from whatsapp_sender_bindings where business_id=${a.business}`;
    expect(binding!.count).toBe(1);
  });

  test("current phone ownership prevents access after a manual client phone correction", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    await db.sql`update clients set phone='+14155552671' where id=${appointment.client.id}`;
    const denied = await turn(h, "Cancelar mi turno", { name: "cancel", arguments: { appointmentId: appointment.id } });
    expect(denied.text).toContain("No se guardó");
    expect((await appointments(h))[0]!.state).toBe("confirmed");
    const listed = await turn(h, "Consultar turnos", { name: "owned_appointments", arguments: {} });
    expect(listed.text).toContain("No tenés turnos");
  });

  test("notes use explicit customer text and cancellation has no start cutoff", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const modelOnly = await turn(h, "Consultar nota", { name: "notes", arguments: { appointmentId: appointment.id, notes: "invented" } });
    expect(modelOnly.text).toContain("Escribí");
    expect((await appointments(h))[0]!.notes).toBeNull();
    h.now = "2035-04-02T10:30:00-03:00";
    await turn(h, "nota: voy con mi hija", { name: "notes", arguments: { appointmentId: appointment.id, notes: "rewritten by model" } });
    expect((await appointments(h))[0]!.notes).toBe("voy con mi hija");
    const cancelled = await turn(h, "Cancelar mi turno", { name: "cancel", arguments: { appointmentId: appointment.id } });
    expect(cancelled.text).toContain("Cancelación guardada");
    expect((await appointments(h))[0]!.state).toBe("cancelled");
    const finalNotes = await turn(h, "nota: reopen", { name: "notes", arguments: { appointmentId: appointment.id, notes: "reopen" } });
    expect(finalNotes.text).toContain("No se guardó");
    expect((await appointments(h))[0]!.notes).toBe("voy con mi hija");
  });

  test("native mismatched operations may disclose proposals but cannot authorize structural saves", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const proposal: AgentToolCommand = { name: "prepare_change", arguments: { appointmentId: appointment.id, resourceId: h.alternate } };
    for (const text of ["Cambiar nota: llegaré tarde", "Cambiar nombre del turno", "Cambiar mi turno", "Cambiar horario"]) {
      const rejected = await turn(h, text, text === "Cambiar horario"
        ? { name: "prepare_change", arguments: { appointmentId: appointment.id, serviceId: h.service } } : proposal);
      expect((await appointments(h))[0]).toEqual(appointment);
      expect(rejected.text).not.toContain("Cambio guardado");
      await changeEvidence(h, rejected, false);
      if (text === "Cambiar horario") expect(rejected.text).not.toContain("Respondé «confirmo»");
    }
    await turn(h, "Reprogramar mi turno", proposal);
    const pendingNotes = await turn(h, "Cambiar nota: el 2035-04-02 a las 11:00", proposal);
    expect((await appointments(h))[0]).toEqual(appointment);
    await changeEvidence(h, pendingNotes, false);
    const notes = await turn(h, "Cambiar nota: llegaré tarde", { name: "notes", arguments: {
      appointmentId: appointment.id, notes: "model rewrite",
    } });
    expect(notes.text).toBe("Nota guardada.");
    expect((await appointments(h))[0]!.notes).toBe("llegaré tarde");
    expect((await appointments(h))[0]!.terms).toEqual(appointment.terms);
    const changed = await changeSaved(h, "Cambiar recurso a Beatriz", proposal);
    expect((await appointments(h))[0]!.terms.resourceId).toBe(h.alternate);
    expect((await appointments(h))[0]!.notes).toBe("llegaré tarde");
    await changeEvidence(h, changed, true);
  });

  test("native combined fields are disclosed without saving or claiming semantic agreement", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const cases = [
      ["Cambiar servicio del turno", { resourceId: h.alternate }],
      ["Cambiar servicio a Color", { serviceId: h.otherService, resourceId: h.alternate }],
      ["Cambiar recurso a Beatriz", { serviceId: h.otherService }],
      ["Cambiar recurso a Beatriz", { startsAt: later }],
      ["Reprogramar mi turno el 2035-04-02 a las 11:00", { serviceId: h.otherService, startsAt: later }],
      ["Reprogramar mi turno el 2035-04-02 a las 11:00", { resourceId: h.alternate, startsAt: later }],
    ] as const;
    for (const [text, fields] of cases) {
      const rejected = await turn(h, text, { name: "prepare_change", arguments: { appointmentId: appointment.id, ...fields } });
      expect((await appointments(h))[0]).toEqual(appointment);
      await changeEvidence(h, rejected, false);
      const [state] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(state!.dialogue.quote).toMatchObject({ kind: "change", appointmentId: appointment.id });
      expect(rejected.text).not.toContain("Guardado:");
      if ("serviceId" in fields) expect(state!.dialogue.quote.terms.serviceId).toBe(fields.serviceId);
      if ("resourceId" in fields) expect(state!.dialogue.quote.terms.resourceId).toBe(fields.resourceId);
      if ("startsAt" in fields) expect(Date.parse(state!.dialogue.quote.startsAt)).toBe(Date.parse(fields.startsAt));
    }
  });

  test("native selections survive arbitrary answers/restart but reject stale inspected structure", async () => {
    for (const kind of ["service", "resource"] as const) {
      const h = await fixture();
      const appointment = await booked(h);
      const field = kind === "service" ? "servicio" : "recurso";
      const name = kind === "service" ? "Color" : "Beatriz";
      const proposal: AgentToolCommand = { name: "prepare_change", arguments: { appointmentId: appointment.id,
        ...(kind === "service" ? { serviceId: h.otherService } : { resourceId: h.alternate }),
      } };
      const initial = await turn(h, `Cambiar ${field}`, proposal);
      h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
      for (const answer of ["11:00", "Desconocido", kind === "service" ? "Beatriz" : "Color"]) {
        const missing = await turn(h, answer, proposal);
        expect((await appointments(h))[0]).toEqual(appointment);
        await changeEvidence(h, missing, false);
        const [state] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
        expect(state!.dialogue.quote).toMatchObject({ kind: "change", appointmentId: appointment.id, sourceMessageId: initial.messageId });
      }
      await db.sql`update appointments set customer_resource_preference_id=${h.alternate} where id=${appointment.id}`;
      const inspected = (await appointments(h))[0]!;
      const stale = await turn(h, name, proposal);
      expect(stale.text).toContain("El turno cambió");
      expect((await appointments(h))[0]).toEqual(inspected);
      await changeEvidence(h, stale, false);
      const prepared = await turn(h, `Cambiar ${field}`, proposal);
      h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
      const selected = await turn(h, name, proposal);
      if (kind === "service") {
        expect((await appointments(h))[0]).toEqual(inspected);
        expect(prepared.text).toContain("45 minutos, ARS 2500");
        expect(selected.text).toContain("pendiente no cambió");
        const premature = await turn(h, "confirmo");
        expect(premature.text).toContain("Primero necesitás recibir");
        await delivered(premature);
        await accept(h);
      } else {
        await delivered(prepared);
        await accept(h, "dale cambialo");
      }
      const saved = (await appointments(h))[0]!;
      expect(saved.startsAt).toBe(appointment.startsAt);
      expect(saved.terms.serviceId).toBe(kind === "service" ? h.otherService : h.service);
      expect(saved.terms.resourceId).toBe(h.alternate); // Omitted assignment preserves the existing preference constraint.
      expect(saved.customerResourcePreference).toBe(h.alternate);
    }
  });

  test("native complete instants disclose a proposal without executing a model-selected target", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const requested = await turn(h, "Reprogramar mi turno", {
      name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later },
    });
    expect((await appointments(h))[0]).toEqual(appointment);
    expect(requested.text).toContain("Cambio propuesto");
    expect(requested.text).toContain("2035-04-02 a las 11:00");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
    await changeEvidence(h, requested, false);
  });

  test("a model reschedule time that disagrees with the customer's explicit selection cannot mutate", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const mismatched = await turn(h, "Reprogramar mi turno el 2035-04-02 a las 11:00", {
      name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: "2035-04-02T12:00:00-03:00" },
    });
    expect((await appointments(h))[0]).toEqual(appointment);
    expect(mismatched.text).toContain("Cambio propuesto: Corte, 2035-04-02 a las 12:00");
    expect((await counts(h)).effects).toBe(1);
    await changeEvidence(h, mismatched, false);
  });

  test("a clear matching customer reschedule saves directly with truthful audit, receipt and outbox", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const changed = await changeSaved(h, "Reprogramar mi turno el 2035-04-02 a las 11:00", {
      name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later },
    });
    const current = (await appointments(h))[0]!;
    expect(current.startMs).toBe(Date.parse(later));
    expect(current.terms).toEqual(appointment.terms);
    expect(changed.text).toContain("Guardado:");
    expect(changed.text).not.toContain("Respondé «confirmo»");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 2 });
    await changeEvidence(h, changed, true);
  });

  test("short reschedule answers bind to the durable owned appointment and never reuse booking selection", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const proposal: AgentToolCommand = { name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later } };
    const missing = await turn(h, "Reprogramar mi turno", proposal);
    expect((await appointments(h))[0]).toEqual(appointment);
    await changeEvidence(h, missing, false);
    const date = await turn(h, "El 2035-04-02", proposal);
    expect(date.text).toContain("pendiente no cambió");
    expect(date.text).not.toContain("¿Para qué día?");
    expect((await appointments(h))[0]).toEqual(appointment);
    await changeEvidence(h, date, false);
    // Use a new executor instance to prove the binding is persisted, not process memory.
    h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
    const retained = await turn(h, "a las 11:00", proposal);
    expect(retained.text).not.toContain("Cambio propuesto");
    await delivered(missing);
    const time = await accept(h, "dale cambialo");
    expect(time.text).toContain("Guardado:");
    const current = (await appointments(h))[0]!;
    expect(current.startMs).toBe(Date.parse(later));
    expect(current.terms).toEqual(appointment.terms);
    await changeEvidence(h, time, true);
    expect((await counts(h)).effects).toBe(2);
  });

  test("a pending reschedule cannot migrate to another appointment or survive changed inspected structure", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const other = await pools.api.run(context(h), repo => repo.createAppointment(h.business, {
      serviceId: h.service, resourceId: appointment.terms.resourceId,
      startRaw: "2035-04-02T12:00:00-03:00", clientId: appointment.client.id,
    }, { now: h.now, origin: "manual" }));
    await turn(h, "Reprogramar mi turno", {
      name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later },
    });
    const before = await appointments(h);
    const retargeted = await turn(h, "El 2035-04-02 a las 11:00", {
      name: "prepare_change", arguments: { appointmentId: other.id, startsAt: later },
    });
    expect(await appointments(h)).toEqual(before);
    await changeEvidence(h, retargeted, false);
    await db.sql`update appointments set customer_resource_preference_id=${h.alternate} where id=${appointment.id}`;
    const revised = await appointments(h);
    const stale = await turn(h, "El 2035-04-02 a las 11:00", {
      name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later },
    });
    expect(stale.text).toContain("El turno cambió");
    expect(await appointments(h)).toEqual(revised);
    await changeEvidence(h, stale, false);
    expect((await counts(h)).effects).toBe(1);
  });

  test("no redundant confirmation for clear reschedule, frozen terms and original resource first", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    await db.sql`update services set duration_minutes=60,price_ars=9999 where id=${h.service}`;
    const moved = await changeSaved(h, "Reprogramar mi turno el 2035-04-02 a las 11:00", { name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later } });
    expect(moved.text).toContain("Guardado:");
    const [current] = await appointments(h);
    expect(current!.terms).toEqual(appointment.terms);
    expect(current!.startMs).toBe(Date.parse(later));
    expect(moved.text).not.toContain("Respondé «confirmo»");
  });

  test("reschedule selects eligible alternate if original busy without inventing preference", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const otherResource = appointment.terms.resourceId === h.resource ? h.alternate : h.resource;
    await pools.api.run(context(h), repo => repo.createAppointment(h.business, {
      serviceId: h.service, resourceId: appointment.terms.resourceId, startRaw: later, clientId: appointment.client.id,
    }, { now: h.now, origin: "manual" }));
    await changeSaved(h, "Reprogramar mi turno el 2035-04-02 a las 11:00", { name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later } });
    const current = (await appointments(h)).find(ap => ap.id === appointment.id)!;
    expect(current.terms.resourceId).toBe(otherResource);
    expect(current.customerResourcePreference).toBeNull();
  });

  test("service change quotes current terms and rejects stale appointment changes", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const proposal: AgentToolCommand = { name: "prepare_change", arguments: { appointmentId: appointment.id, serviceId: h.otherService } };
    const quote = await turn(h, "Cambiar el servicio del turno a Color", proposal);
    expect(quote.text).toContain("Color");
    expect(quote.text).toContain("45 minutos, ARS 2500");
    expect((await appointments(h))[0]!.terms.serviceId).toBe(h.service);
    await delivered(quote);
    await db.sql`update appointments set customer_resource_preference_id=${h.alternate} where id=${appointment.id}`;
    const stale = await turn(h, "confirmo");
    expect(stale.text).toContain("El turno cambió");
    expect((await appointments(h))[0]!.terms.serviceId).toBe(h.service);
    const fresh = await turn(h, "Cambiar el servicio del turno a Color", proposal);
    await delivered(fresh);
    const saved = await turn(h, "confirmo");
    expect(saved.text).toContain("Guardado:");
    expect((await appointments(h))[0]!.terms).toMatchObject({ serviceId: h.otherService, durationMinutes: 45, priceArs: 2500 });
  });

  test("structural edits are blocked at start and preserve the original appointment", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    h.now = startsAt;
    const denied = await turn(h, "Reprogramar mi turno el 2035-04-02 a las 11:00", { name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later } });
    expect(denied.text).toContain("No se guardó");
    expect((await appointments(h))[0]).toEqual(appointment);
    const resourceOnly = await turn(h, "Cambiar recurso a Beatriz", { name: "prepare_change", arguments: { appointmentId: appointment.id, resourceId: h.alternate } });
    expect(resourceOnly.text).toContain("No se guardó");
    expect((await appointments(h))[0]).toEqual(appointment);
  });

  test("explicit preference metadata survives manual reassignment and suspended catalog", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    await db.sql`update resources set status='suspended' where id=${h.alternate}`;
    const arbitrary = await turn(h, "Consultar preferencia", { name: "preference", arguments: { appointmentId: appointment.id, resourceId: h.alternate } });
    expect(arbitrary.text).toContain("No se guardó");
    const expressed = await turn(h, "Prefiero Beatriz", { name: "preference", arguments: { appointmentId: appointment.id, resourceId: h.alternate } });
    expect(expressed.text).toContain("Preferencia guardada");
    const current = (await appointments(h))[0]!;
    expect(current.terms).toEqual(appointment.terms);
    expect(current.startsAt).toBe(appointment.startsAt);
    expect(current.customerResourcePreference).toBe(h.alternate);
    await db.sql`update appointments set resource_id=${h.resource} where id=${appointment.id}`;
    expect((await appointments(h))[0]!.customerResourcePreference).toBe(h.alternate);
    h.now = startsAt;
    const started = await turn(h, "Sin preferencia", { name: "preference", arguments: { appointmentId: appointment.id, resourceId: null } });
    expect(started.text).toContain("No se guardó");
    expect((await appointments(h))[0]!.customerResourcePreference).toBe(h.alternate);
  });

  test("same-day alternatives precede nearby dates and missing fields avoid routine resource prompts", async () => {
    const h = await fixture();
    const missing = await factoryTurn(h, "Reservar turno", [{ name: "read_catalog", arguments: {} }], ["data"], JSON.stringify({ kind: "reply", facts: [], ask: "date" }));
    expect(missing.text).toBe("¿Para qué día?");
    const unavailable = await turn(h, "Reservar Corte el 2035-04-02 a las 19:00", book(h, "2035-04-02T19:00:00-03:00"));
    expect(unavailable.text).toContain("2035-04-02: 09:00");
    expect(unavailable.text).not.toContain("2035-04-03");
    await db.sql`insert into business_calendar_closures(business_id,kind,closed_date) values(${h.business},'date','2035-04-02')`;
    const nearby = await turn(h, "Consultar horarios el 2035-04-02", { name: "availability", arguments: { serviceId: h.service, date: "2035-04-02" } });
    expect(nearby.text).toContain("No hay horarios disponibles para 2035-04-02");
    expect(nearby.text).not.toContain("2035-04-03");
    expect((await turn(h, "Otro día", { name: "availability", arguments: { serviceId: h.service, date: "2035-04-03" } })).text).toContain("2035-04-03: 09:00");
    expect((await counts(h)).clients).toBe(0);
  });

  test("post-write infrastructure failure rolls back client, booking, audit, outbox and response; retry recovers once", async () => {
    const h = await fixture();
    await prepare(h);
    const before = await counts(h);
    const [auditBefore] = await db.sql`select count(*)::int count from audit_events where business_id=${h.business}`;
    await db.sql`insert into public.agenda_fault_fixture(business_id,enabled) values(${h.business},true)`;
    const id = await receive(h, "confirmo");
    await expect(processScript(h, id, [{ name: "confirm_quote", arguments: {} }])).rejects.toThrow("Agent infrastructure failure");
    expect(await counts(h)).toEqual(before);
    const outputs = await db.sql`select * from outbound_commands where source_message_id=${id}`;
    expect(outputs).toHaveLength(0);
    const [source] = await db.sql`select processing_state from messages where id=${id}`;
    expect(source!.processing_state).toBe("pending");
    const [auditAfter] = await db.sql`select count(*)::int count from audit_events where business_id=${h.business}`;
    expect(auditAfter!.count).toBe(auditBefore!.count);
    await db.sql`update public.agenda_fault_fixture set enabled=false where business_id=${h.business}`;
    expect(await processScript(h, id, [{ name: "confirm_quote", arguments: {} }])).toBe(true);
    expect((await output(h, id)).text).toContain("Guardado:");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
    await processScript(h, id, [{ name: "confirm_quote", arguments: {} }]);
    expect((await counts(h)).effects).toBe(1);
  });

  test("two current customers concurrently confirming the same resource cannot both reserve", async () => {
    const h = await fixture();
    const selected: AgentToolCommand = { name: "prepare_booking", arguments: { serviceId: h.service, resourceId: h.resource, startsAt } };
    await turn(h, "Reservar Corte el 2035-04-02 a las 10:00", selected);
    const firstQuote = await turn(h, "Mi nombre es María Pérez");
    await delivered(firstQuote);
    const other = { remoteJid: otherPn, alternate: "987654321@lid" };
    await turn(h, "Reservar Corte el 2035-04-02 a las 10:00", selected, other);
    const secondQuote = await turn(h, "Mi nombre es John Smith", undefined, other);
    await delivered(secondQuote);
    const firstId = await receive(h, "confirmo");
    const secondId = await receive(h, "confirmo", other);
    await Promise.all([processScript(h, firstId, [{ name: "confirm_quote", arguments: {} }]), processScript(h, secondId, [{ name: "confirm_quote", arguments: {} }])]);
    const replies = [await output(h, firstId), await output(h, secondId)];
    expect(replies.filter(reply => reply.text.includes("Guardado:"))).toHaveLength(1);
    expect(replies.filter(reply => reply.text.includes("ya no está disponible"))).toHaveLength(1);
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
    expect((await appointments(h))[0]!.terms.resourceId).toBe(h.resource);
  });

  test("latest-inbound fence rejects stale provider plans without saving any mutation", async () => {
    const h = await fixture();
    h.command = book(h);
    const stale = await receive(h, "Reservar Corte");
    const newest = await receive(h, "Consultar servicios");
    expect(await processScript(h, stale, [h.command])).toBe(false);
    expect((await counts(h)).receipts).toBe(0);
    expect((await counts(h)).clients).toBe(0);
    h.command = { name: "read_catalog", arguments: {} };
    expect(await processScript(h, newest, [h.command])).toBe(true);
    expect((await output(h, newest)).text).toContain("Corte");
    const staleOutputs = await db.sql`select * from outbound_commands where source_message_id=${stale}`;
    expect(staleOutputs).toHaveLength(0);
  });

  test("forced RLS and least physical grants isolate evidence and dialogue from other tenants", async () => {
    const a = await fixture();
    const b = await fixture();
    await prepare(a);
    await prepare(b);
    const security = await db.sql`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where relname in ('whatsapp_sender_bindings','whatsapp_received_senders','whatsapp_agenda_dialogues','whatsapp_agenda_receipts')`;
    expect(security).toHaveLength(4);
    expect(security.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const [grants] = await db.sql`select
      has_table_privilege('agendia_worker_runtime','whatsapp_sender_bindings','INSERT') bind,
      has_table_privilege('agendia_worker_runtime','clients','UPDATE') edit_client,
      has_table_privilege('agendia_worker_runtime','services','UPDATE') edit_catalog,
      has_table_privilege('agendia_worker_runtime','appointments','DELETE') erase,
      has_table_privilege('agendia_worker_runtime','whatsapp_agenda_receipts','INSERT') receipt`;
    expect(grants).toEqual({ bind: false, edit_client: false, edit_catalog: false, erase: false, receipt: true });
    expect(await pools.worker.run(context(a), repo => repo.agendaSender("00000000-0000-4000-8000-000000000000"))).toBeNull();
    const [foreign] = await db.sql<{ message_id: string }[]>`select message_id from whatsapp_received_senders where business_id=${b.business} limit 1`;
    expect(await pools.worker.run(context(a), repo => repo.agendaSender(foreign!.message_id))).toBeNull();
    await expect(pools.worker.run(context(a), repo => repo.bindReceivedSender(a.business, a.connection, pn, {
      phone, pnJid: pn, lidJid: lid,
    }))).rejects.toMatchObject({ code: "42501" });
    await expect(Promise.resolve(db.sql`insert into whatsapp_sender_bindings(business_id,connection_id,phone,pn_jid)
      values(${a.business},${b.connection},'+541123456789','541123456789@s.whatsapp.net')`)).rejects.toMatchObject({ code: "23503" });
  });

  test("own appointment operations cannot be applied to another customer or tenant", async () => {
    const a = await fixture();
    const b = await fixture();
    const own = await booked(a);
    const foreign = await booked(b);
    for (const target of [own.id, foreign.id]) {
      const denied = await turn(a, "Cancelar mi turno", { name: "cancel", arguments: { appointmentId: target } }, {
        remoteJid: otherPn, alternate: "987654321@lid",
      });
      expect(denied.text).toContain("No se guardó");
    }
    expect((await appointments(a))[0]!.state).toBe("confirmed");
    expect((await appointments(b))[0]!.state).toBe("confirmed");
    const negated = await turn(a, "No quiero cancelar el turno", { name: "cancel", arguments: { appointmentId: own.id } });
    expect(negated.text).toContain("Indicá explícitamente");
    expect((await appointments(a))[0]!.state).toBe("confirmed");
  });

  test("explicit booking preference is persisted but unknown expressed resources are clarified", async () => {
    const h = await fixture();
    const proposed: AgentToolCommand = { name: "prepare_booking", arguments: { serviceId: h.service, resourceId: h.alternate, startsAt } };
    const unknown = await turn(h, "Reservar Corte el 2035-04-02 a las 10:00, prefiero Desconocido", book(h));
    expect(unknown.text).toContain("No reconocí el recurso");
    expect((await counts(h)).clients).toBe(0);
    await turn(h, "Reservar Corte el 2035-04-02 a las 10:00, prefiero Beatriz", proposed);
    const quote = await turn(h, "Mi nombre es María Pérez");
    await delivered(quote);
    await turn(h, "confirmo");
    const [appointment] = await appointments(h);
    expect(appointment!.customerResourcePreference).toBe(h.alternate);
    expect(appointment!.terms.resourceId).toBe(h.alternate);
  });

  test("unchanged-start service changes inside one hour remain allowed for manual-origin owned appointments", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    await db.sql`update appointments set origin='manual' where id=${appointment.id}`;
    h.now = "2035-04-02T09:45:00-03:00";
    const quote = await turn(h, "Cambiar el servicio del turno a Color", {
      name: "prepare_change", arguments: { appointmentId: appointment.id, serviceId: h.otherService },
    });
    expect(quote.text).toContain("Cambio propuesto");
    await delivered(quote);
    const changed = await turn(h, "confirmo");
    expect(changed.text).toContain("Guardado:");
    const current = (await appointments(h))[0]!;
    expect(current.startMs).toBe(appointment.startMs);
    expect(current.origin).toBe("manual");
    expect(current.terms.serviceId).toBe(h.otherService);
    expect(current.terms.durationMinutes).toBe(45);
    expect(current.terms.priceArs).toBe(2500);
  });

  test("new-start reschedule inside one hour and final-state preference changes preserve the original", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    h.now = "2035-04-02T09:45:00-03:00";
    const rejected = await turn(h, "Reprogramar mi turno el 2035-04-02 a las 10:15", {
      name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: "2035-04-02T10:15:00-03:00" },
    });
    expect(rejected.text).not.toContain("Cambio guardado");
    expect((await appointments(h))[0]).toEqual(appointment);
    await db.sql`update appointments set state='cancelled' where id=${appointment.id}`;
    const finalPreference = await turn(h, "Prefiero Beatriz", {
      name: "preference", arguments: { appointmentId: appointment.id, resourceId: h.alternate },
    });
    expect(finalPreference.text).toContain("No se guardó");
    const current = (await appointments(h))[0]!;
    expect(current.state).toBe("cancelled");
    expect(current.customerResourcePreference).toBeNull();
    expect(current.terms).toEqual(appointment.terms);
  });

  test("model attendance, catalog editing and term overrides never reach backend write authority", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    for (const operation of ["done", "no_show", "reopen", "edit_client", "edit_catalog", "override_terms"]) {
      const id = await receive(h, "Consultar mi turno");
      const outcome = await h.agenda.withAgentSession(job(h, id), async session => {
        expect(await session.execute(operation, { appointmentId: appointment.id })).toEqual({ status: "rejected", code: "INVALID_TOOL" });
        throw new Error("Reject unsupported action without a response");
      });
      expect(outcome.status).toBe("infrastructure_failure");
      const noOutput = await db.sql`select * from outbound_commands where source_message_id=${id}`;
      expect(noOutput).toHaveLength(0);
      expect((await appointments(h))[0]).toEqual(appointment);
    }
    expect((await counts(h)).effects).toBe(1);
  });

  test("execution summaries include zero calls, successful availability and invalid arguments after commit only", async () => {
    const h = await fixture();
    const events: unknown[] = [];
    h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now, event => events.push(event));
    for (const mode of ["none", "availability", "invalid"] as const) {
      events.length = 0;
      const id = await receive(h, "decime para que horario tenes disponible");
      const outcome = await h.agenda.withAgentSession(job(h, id), async session => {
        // Intentionally leave the call pending: the owner must drain before commit/summary.
        if (mode !== "none") void session.execute("availability", mode === "invalid" ? {} : { serviceId: h.service, date: "2035-04-02" });
        return "Respuesta de prueba.";
      });
      expect(outcome.status).toBe("committed");
      expect(events.at(-1)).toEqual({ code: "agent.turn_completed", toolCalls: mode === "none" ? 0 : 1,
        completedCalls: mode === "none" ? 0 : 1, failedCalls: 0 });
      if (mode !== "none") expect(events).toContainEqual({ code: "agent.tool_completed", toolName: "availability",
        status: mode === "invalid" ? "rejected" : "data" });
    }
    events.length = 0;
    await db.sql`insert into agenda_fault_fixture(business_id,enabled) values(${h.business},true)`;
    const id = await receive(h, "Consultar horarios");
    const outcome = await h.agenda.withAgentSession(job(h, id), async session => {
      await session.execute("read_catalog", {});
      return "No debe enviarse.";
    });
    expect(outcome.status).toBe("infrastructure_failure");
    expect(events).toEqual([{ code: "agent.tool_completed", toolName: "read_catalog", status: "data" }]);
    expect(await db.sql`select outbound_id from outbound_commands where source_message_id=${id}`).toHaveLength(0);
  });

  test("runtime uses native facts after a catalog reply", async () => {
    const h = await fixture();
    const catalog = await factoryTurn(h, "Consultar servicios", [{ name: "read_catalog", arguments: {} }], ["data"], results => {
      const data = (results[0] as { data: { items: { name: string }[] } }).data;
      return data.items.map(item => item.name).join(", ");
    });
    expect(catalog.text).toContain("Corte");
    const general = await factoryTurn(h, "¿Dónde están ubicados?", [{ name: "read_business", arguments: {} }], ["data"], addressReply);
    expect(general.text).toBe('Dirección registrada: "Avenida Central 123".');
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
  });

  test("runtime uses native facts after a completed booking", async () => {
    const h = await fixture();
    const initial = await factoryTurn(h, "Reservar Corte el 2035-04-02 a las 10:00", [
      { name: "prepare_booking", arguments: { serviceId: h.service, startsAt } },
    ], ["clarification"], toolReply);
    expect(initial.text).toBe("Decime tu nombre y apellido.");
    const quote = await factoryTurn(h, "Mi nombre es María Pérez", [{ name: "confirm_quote", arguments: {} }], ["prepared_quote"], toolReply);
    expect(quote.text).toContain("Reserva propuesta");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    await delivered(quote);
    const saved = await factoryTurn(h, "dale reservame ese", factoryAcceptance, ["staged_action"], "Guardado:");
    expect(saved.text).toContain("Guardado:");
    const before = await appointments(h);
    expect(before[0]!.client).toMatchObject({ firstName: "María", lastName: "Pérez", phone });
    expect(before[0]!.startMs).toBe(Date.parse(startsAt));
    expect(before[0]!.terms).toMatchObject({ durationMinutes: 30, priceArs: 1500 });
    expect(before[0]!.origin).toBe("ai");
    const general = await factoryTurn(h, "¿Cómo puedo llegar?", [{ name: "read_business", arguments: {} }], ["data"], addressReply);
    expect(general.text).toBe('Dirección registrada: "Avenida Central 123".');
    expect(await appointments(h)).toEqual(before);
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
  });

  test("runtime preserves pending names and delivered quotes across unrelated text detours", async () => {
    const h = await fixture();
    const initial = await factoryTurn(h, "Reservar Corte el 2035-04-02 a las 10:00", [
      { name: "prepare_booking", arguments: { serviceId: h.service, startsAt } },
    ], ["clarification"], toolReply);
    expect(initial.text).toBe("Decime tu nombre y apellido.");
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    const first = await factoryTurn(h, "¿Dónde están ubicados?", [{ name: "read_business", arguments: {} }], ["data"], addressReply);
    expect(first.text).toBe('Dirección registrada: "Avenida Central 123".');
    const [retained] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(retained!.dialogue).toEqual(pending!.dialogue);
    const quote = await factoryTurn(h, "Mi nombre es María Pérez", [{ name: "confirm_quote", arguments: {} }], ["prepared_quote"], toolReply);
    expect(quote.text).toContain("Reserva propuesta");
    await delivered(quote);
    const second = await factoryTurn(h, "¿Cómo puedo llegar?", request => {
      expect(JSON.parse(request.messages[1]!.content!).runtime.pending.quote.outboundId).toBe(quote.outboundId);
      return [{ name: "read_business", arguments: {} }];
    }, ["data"], addressReply);
    expect(second.text).toBe('Dirección registrada: "Avenida Central 123".');
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
    await factoryTurn(h, "dale reservame ese", factoryAcceptance, ["staged_action"], "Guardado:");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
  });

  test("runtime keeps short date and time answers in an active booking dialogue", async () => {
    const h = await fixture();
    const missing = await factoryTurn(h, "Reservar Corte", [{ name: "read_catalog", arguments: {} }], ["data"], JSON.stringify({ kind: "reply", facts: [], ask: "date" }));
    expect(missing.text).toBe("¿Para qué día?");
    const date = await factoryTurn(h, "El 2035-04-02", [
      { name: "availability", arguments: { serviceId: h.service, date: "2035-04-02" } },
    ], ["data"], results => {
      const slots = (results[0] as { data: { items: { startsAt: string }[] } }).data.items;
      expect(slots.some(slot => Date.parse(slot.startsAt) === Date.parse(startsAt))).toBe(true);
      return "Horarios disponibles: 2035-04-02 a las 10:00. ¿Cuál preferís?";
    });
    expect(date.text).toContain("Horarios disponibles");
    const selected = await factoryTurn(h, "a las 10:00", request => {
      expect(request.messages.some(message => message.content?.includes("El 2035-04-02"))).toBe(true);
      return [{ name: "prepare_booking", arguments: { serviceId: h.service, startsAt } }];
    }, ["clarification"], toolReply);
    expect(selected.text).toBe("Decime tu nombre y apellido.");
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(Date.parse(pending!.dialogue.quote.startsAt)).toBe(Date.parse(startsAt));
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
  });

  test("explicit preference keeps same-day alternatives on Ana when another resource is free at the requested time", async () => {
    const h = await fixture();
    await db.sql`insert into clients(business_id,first_name,last_name,phone) values(${h.business},'Other','Customer','+14155552671')`;
    await pools.api.run(context(h), async repo => {
      const other = await repo.findClientByCanonicalPhone("+14155552671");
      return repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource, startRaw: startsAt, clientId: other!.id }, { now: h.now, origin: "manual" });
    });
    const alternate = await pools.worker.run(context(h), repo => repo.listAppointmentAvailability(h.business,
      { serviceId: h.service, resourceId: h.alternate, date: "2035-04-02" }, { clock: () => h.now }));
    expect(alternate.some(slot => slot.startMs === Date.parse(startsAt))).toBe(true);
    const reply = await turn(h, "Reservar Corte el 2035-04-02 a las 10:00, prefiero Ana", book(h));
    expect(reply.text).not.toContain("10:00");
    expect(reply.text).not.toContain("10:15");
    expect(reply.text).toContain("con Ana");
    expect(reply.text).toContain("10:30");
    expect(reply.text).toContain("11:00");
    expect(reply.text).not.toContain("Guardado:");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 0 });
    const [audit] = await db.sql`select event_type from audit_events where request_id=${`test:${reply.messageId}`}`;
    expect(audit!.event_type).toBe("whatsapp.agenda.reply");
    const [receipt] = await db.sql`select outbound_id from whatsapp_agenda_receipts where message_id=${reply.messageId}`;
    expect(receipt!.outbound_id).toBe(reply.outboundId);
  });

  test("explicit preference expands nearby dates only for the requested resource", async () => {
    const h = await fixture();
    const nextDay = new Date("2035-04-03T12:00:00Z").getUTCDay();
    const schedule: WeeklySchedule = { [nextDay]: [{ startMinute: 540, endMinute: 1080 }] };
    await db.sql`update resources set weekly_schedule=${db.sql.json(schedule)} where id=${h.resource}`;
    const reply = await turn(h, "Reservar Corte el 2035-04-02 a las 10:00, prefiero Ana", book(h));
    expect(reply.text).toContain("2035-04-03");
    expect(reply.text).toContain("con Ana");
    expect(reply.text).not.toContain("2035-04-02:");
    expect((await counts(h)).clients).toBe(0);
    expect((await counts(h)).appointments).toBe(0);
    expect((await counts(h)).effects).toBe(0);
  });

  test("no preferred-resource slots yields a truthful reply, not another resource's availability", async () => {
    const h = await fixture();
    await db.sql`update resources set weekly_schedule='{}'::jsonb where id=${h.resource}`;
    const reply = await turn(h, "Reservar Corte el 2035-04-02 a las 10:00, prefiero Ana", book(h));
    expect(reply.text).toContain("No hay horarios disponibles");
    expect(reply.text).toContain("con Ana");
    expect(reply.text).not.toContain("10:00");
    expect(reply.text).not.toContain("Guardado:");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
  });

  test("confirmation capacity loss also preserves the delivered quote's explicit preference in alternatives", async () => {
    const h = await fixture();
    await turn(h, "Reservar Corte el 2035-04-02 a las 10:00, prefiero Ana", book(h));
    const quote = await turn(h, "Mi nombre es María Pérez");
    await delivered(quote);
    await db.sql`insert into clients(business_id,first_name,last_name,phone) values(${h.business},'Other','Customer','+14155552671')`;
    await pools.api.run(context(h), async repo => {
      const other = await repo.findClientByCanonicalPhone("+14155552671");
      return repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource, startRaw: startsAt, clientId: other!.id }, { now: h.now, origin: "manual" });
    });
    const reply = await turn(h, "confirmo");
    expect(reply.text).toContain("ya no está disponible");
    expect(reply.text).toContain("con Ana");
    expect(reply.text).not.toContain("10:00");
    expect(reply.text).toContain("10:30");
    expect(reply.text).not.toContain("Guardado:");
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 0 });
    expect((await appointments(h))[0]!.client.phone).toBe("+14155552671");
  });

  test("day-only preferred availability also remains scoped before a time has been selected", async () => {
    const h = await fixture();
    await db.sql`update resources set weekly_schedule='{}'::jsonb where id=${h.resource}`;
    const reply = await turn(h, "Reservar Corte el 2035-04-02, prefiero Ana", book(h));
    expect(reply.text).toContain("No hay horarios disponibles con Ana");
    expect(reply.text).not.toContain("10:00");
    expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
  });

  test("native booking assigns Beatriz while retaining Ana preference across restart and detour", async () => {
    const h = await fixture();
    const weekday = new Date("2035-04-02T12:00:00Z").getUTCDay();
    const schedule: WeeklySchedule = { [weekday]: [{ startMinute: 630, endMinute: 690 }] };
    await db.sql`update resources set weekly_schedule=${db.sql.json(schedule)} where id=${h.resource}`;
    const offered = await factoryTurn(h, "Reservar Corte el 2035-04-02, prefiero Ana", [
      { name: "prepare_booking", arguments: { serviceId: h.service, startsAt } },
    ], ["clarification"], toolReply);
    expect(offered.text).toContain("10:30");
    const detour = await factoryTurn(h, "¿Dónde están ubicados?", [{ name: "read_business", arguments: {} }], ["data"], addressReply);
    expect(detour.text).toBe('Dirección registrada: "Avenida Central 123".');
    // Each factoryTurn constructs a fresh worker: retained preference is durable, not in-memory.
    const selected = await factoryTurn(h, "10:30", [{ name: "prepare_booking", arguments: {
      serviceId: h.service, resourceId: h.alternate, startsAt: "2035-04-02T10:30:00-03:00",
    } }], ["clarification"], toolReply);
    expect(selected.text).toBe("Decime tu nombre y apellido.");
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(pending!.dialogue.quote.terms.resourceId).toBe(h.alternate);
    expect(pending!.dialogue.quote.preference).toBe(h.resource);
    const quote = await factoryTurn(h, "Mi nombre es María Pérez", [{ name: "confirm_quote", arguments: {} }], ["prepared_quote"], toolReply);
    await delivered(quote);
    const saved = await factoryTurn(h, "dale reservame ese", factoryAcceptance, ["staged_action"], "Guardado:");
    expect(saved.text).toContain("Guardado:");
    const appointment = (await appointments(h))[0]!;
    expect(appointment.terms.resourceId).toBe(h.alternate);
    expect(appointment.customerResourcePreference).toBe(h.resource);
    expect(appointment.startMs).toBe(Date.parse("2035-04-02T10:30:00-03:00"));
    expect(appointment.client).toMatchObject({ firstName: "María", lastName: "Pérez", phone });
    expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
  });

  test("quote capacity loss retains preference and verified names but requires a fresh alternative quote", async () => {
    const h = await fixture();
    await turn(h, "Reservar Corte el 2035-04-02 a las 10:00, prefiero Ana", book(h));
    const originalQuote = await turn(h, "Mi nombre es María Pérez");
    await delivered(originalQuote);
    await pools.api.run(context(h), repo => repo.createAppointment(h.business, {
      serviceId: h.service, resourceId: h.resource, startRaw: startsAt,
      newClient: { firstName: "Other", lastName: "Customer", phone: "+14155552671" },
    }, { now: h.now, origin: "manual" }));
    const failed = await turn(h, "confirmo");
    expect(failed.text).toContain("10:30");
    expect((await counts(h)).effects).toBe(0);
    h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
    const fresh = await turn(h, "10:30", { name: "prepare_booking", arguments: {
      serviceId: h.service, resourceId: h.alternate, startsAt: "2035-04-02T10:30:00-03:00",
    } });
    expect(fresh.text).toContain("Reserva propuesta");
    expect(fresh.text).not.toContain("Decime tu nombre y apellido.");
    expect(fresh.outboundId).not.toBe(originalQuote.outboundId);
    expect((await counts(h)).appointments).toBe(1);
    await delivered(fresh);
    const saved = await turn(h, "confirmo");
    expect(saved.text).toContain("Guardado:");
    const appointment = (await appointments(h)).find(ap => ap.client.phone === phone)!;
    expect(appointment.startMs).toBe(Date.parse("2035-04-02T10:30:00-03:00"));
    expect(appointment.terms.resourceId).toBe(h.alternate);
    expect(appointment.customerResourcePreference).toBe(h.resource);
    expect(await counts(h)).toMatchObject({ clients: 2, appointments: 2, effects: 1 });
  });

  test("only an explicit customer change or removal replaces pending booking preference", async () => {
    for (const expression of ["Prefiero Beatriz", "Sin preferencia"] as const) {
      const h = await fixture();
      await turn(h, "Reservar Corte el 2035-04-02, prefiero Ana", book(h));
      const changed = await turn(h, expression, book(h));
      expect(changed.text).toBe("Decime tu nombre y apellido.");
      const selected = await turn(h, "10:30", { name: "prepare_booking", arguments: {
        serviceId: h.service, resourceId: expression === "Prefiero Beatriz" ? h.resource : h.alternate,
        startsAt: "2035-04-02T10:30:00-03:00",
      } });
      expect(selected.text).toBe("Decime tu nombre y apellido.");
      const quote = await turn(h, "Mi nombre es María Pérez");
      await delivered(quote);
      await turn(h, "confirmo");
      const appointment = (await appointments(h))[0]!;
      expect(appointment.terms.resourceId).toBe(expression === "Prefiero Beatriz" ? h.resource : h.alternate);
      expect(appointment.customerResourcePreference).toBe(expression === "Prefiero Beatriz" ? h.alternate : null);
      expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
    }
  });

  test("native explicit assignment stays separate from retained preference through restart", async () => {
    for (const scenario of ["omitted", "conflicting", "changed", "removed"] as const) {
      const h = await fixture();
      const appointment = await booked(h);
      await db.sql`update appointments set resource_id=${h.alternate},resource_label='Beatriz' where id=${appointment.id}`;
      const before = (await appointments(h))[0]!;
      const proposal: AgentToolCommand = { name: "prepare_change", arguments: { appointmentId: appointment.id, resourceId: h.alternate, startsAt: later } };
      const missing = await turn(h, "Reprogramar mi turno, prefiero Ana", proposal);
      let deliveredProposal = missing;
      expect((await appointments(h))[0]).toEqual(before);
      await changeEvidence(h, missing, false);
      h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
      if (scenario === "changed" || scenario === "removed") {
        const expression = scenario === "changed" ? "Prefiero Beatriz" : "Sin preferencia";
        const pending = await turn(h, expression, proposal);
        deliveredProposal = pending;
        expect((await appointments(h))[0]).toEqual(before);
        await changeEvidence(h, pending, false);
      }
      const retained = await turn(h, "El 2035-04-02 a las 11:00", { name: "prepare_change", arguments: {
        appointmentId: appointment.id, startsAt: later,
        ...(scenario === "conflicting" ? { resourceId: h.alternate } : {}),
      } });
      expect(retained.text).toContain("pendiente no cambió");
      await delivered(deliveredProposal);
      const saved = await accept(h, "dale cambialo");
      const current = (await appointments(h))[0]!;
      const expected = scenario === "changed" || scenario === "removed" ? h.alternate : h.resource;
      expect(current.terms.resourceId).toBe(h.alternate);
      expect(current.customerResourcePreference).toBe(scenario === "removed" ? null : expected);
      expect(current.startMs).toBe(Date.parse(later));
      expect(current.terms.durationMinutes).toBe(before.terms.durationMinutes);
      expect(current.terms.priceArs).toBe(before.terms.priceArs);
      await changeEvidence(h, saved, true);
      expect((await counts(h)).effects).toBe(2);
    }
  });

  test("unknown reschedule preference remains unresolved across restart and model-selected date/resource", async () => {
    const h = await fixture();
    const appointment = await booked(h);
    const proposal: AgentToolCommand = { name: "prepare_change", arguments: { appointmentId: appointment.id, resourceId: h.alternate, startsAt: later } };
    const unknown = await turn(h, "Reprogramar mi turno, prefiero Desconocido", { name: "prepare_change", arguments: { appointmentId: appointment.id, startsAt: later } });
    expect(unknown.text).toContain("No reconocí el recurso");
    expect((await appointments(h))[0]).toEqual(appointment);
    await changeEvidence(h, unknown, false);
    h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
    const stillUnknown = await turn(h, "El 2035-04-02 a las 11:00", proposal);
    expect(stillUnknown.text).toContain("No reconocí el recurso");
    expect((await appointments(h))[0]).toEqual(appointment);
    await changeEvidence(h, stillUnknown, false);
    expect((await counts(h)).effects).toBe(1);
    const resolved = await changeSaved(h, "Prefiero Ana", proposal);
    expect((await appointments(h))[0]!.customerResourcePreference).toBe(h.resource);
    expect((await appointments(h))[0]!.terms.resourceId).toBe(h.alternate); // Explicit assignment is not preference metadata.
    await changeEvidence(h, resolved, true);
  });

  test("unknown booking resource survives restart without a supplied choice until explicit resolution or removal", async () => {
    for (const expression of ["Prefiero Ana", "Sin preferencia"] as const) {
      const h = await fixture();
      // Cover an existing time prompt and a fresh unknown-resource request.
      if (expression === "Prefiero Ana") await turn(h, "Reservar Corte el 2035-04-02", book(h));
      const unknown = await turn(h, "Reservar Corte el 2035-04-02, prefiero Desconocido", book(h));
      expect(unknown.text).toContain("No reconocí el recurso");
      h.agenda = new PostgresWhatsAppAgenda(pools, () => h.now);
      const proposal: AgentToolCommand = { name: "prepare_booking", arguments: {
        serviceId: h.service, resourceId: h.alternate, startsAt: "2035-04-02T10:30:00-03:00",
      } };
      const blocked = await turn(h, "10:30", book(h, "2035-04-02T10:30:00-03:00"));
      expect(blocked.text).toContain("No reconocí el recurso");
      const [state] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(state!.dialogue.quote).toBeNull();
      expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
      const [receipt] = await db.sql`select outbound_id from whatsapp_agenda_receipts where message_id=${blocked.messageId}`;
      expect(receipt!.outbound_id).toBe(blocked.outboundId);
      const resolved = await turn(h, expression, proposal);
      expect(resolved.text).toBe("Decime tu nombre y apellido.");
      const quote = await turn(h, "Mi nombre es María Pérez");
      expect(quote.text).toContain("Reserva propuesta");
      await delivered(quote);
      const saved = await turn(h, "confirmo");
      expect(saved.text).toContain("Guardado:");
      const appointment = (await appointments(h))[0]!;
      expect(appointment.terms.resourceId).toBe(h.alternate);
      expect(appointment.customerResourcePreference).toBe(expression === "Prefiero Ana" ? h.resource : null);
      expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 1 });
    }
  });

  test("native factual replies use only tenant facts and create no saved agenda effects", async () => {
    const foreign = await fixture();
    await db.sql`update business_profiles set address='Foreign street 999' where business_id=${foreign.business}`;
    for (const [question, name, expected] of [
      ["¿Qué novedades hay?", "read_business", "Dirección registrada"],
      ["¿Dónde están ubicados?", "read_business", 'Dirección registrada: "Avenida Central 123".'],
      ["¿Cuál es el horario de atención?", "read_calendar", "Horarios habituales"],
      ["Hola", "read_business", "Dirección registrada"],
      ["Dirección y horarios", "read_calendar", "Horarios habituales"],
      ["¿Abren mañana?", "read_calendar", "Horarios habituales"],
    ] as const) {
      const h = await fixture();
      const reply = await factoryTurn(h, question, [{ name, arguments: {} }], ["data"], results => {
        expect(JSON.stringify(results)).toContain(name === "read_business" ? "Avenida Central 123" : "weeklySchedule");
        return JSON.stringify({ kind: "reply", facts: [name], businessFields: ["address"] });
      });
      expect(reply.text).toContain(expected);
      expect(reply.text).not.toContain("Foreign street");
      expect(reply.text).not.toContain("te agendé");
      expect(h.textCalls).toBe(0);
      expect(await counts(h)).toMatchObject({ clients: 0, appointments: 0, effects: 0 });
      expect(await db.sql`select id from audit_events where business_id=${h.business} and event_type='whatsapp.agenda.saved'`).toHaveLength(0);
      expect(await db.sql`select message_id from whatsapp_agenda_receipts where message_id=${reply.messageId}`).toHaveLength(1);
      const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(pending!.dialogue).toEqual({ quote: null, awaitingNames: false });
    }
    const missing = await fixture();
    await db.sql`update business_profiles set address='' where business_id=${missing.business}`;
    await db.sql`update business_calendars set weekly_schedule='{}' where business_id=${missing.business}`;
    for (const [question, name] of [["¿Dónde están ubicados?", "read_business"], ["¿Cuál es el horario de atención?", "read_calendar"]] as const) {
      const reply = await factoryTurn(missing, question, [{ name, arguments: {} }], ["data"], results => {
        expect(JSON.stringify(results)).toContain(name === "read_business" ? '"address":null' : '"weeklySchedule":{}');
        return JSON.stringify({ kind: "reply", facts: [name], businessFields: ["address"] });
      });
      expect(reply.text).toContain("No hay");
    }
  });

  test("native tools preserve literal Hola catalog answers in pending changes", async () => {
    for (const kind of ["service", "resource"] as const) {
      const h = await fixture();
      const appointment = await booked(h);
      if (kind === "service") await db.sql`update services set name='Hola' where id=${h.otherService}`;
      else await db.sql`update resources set name='Hola' where id=${h.alternate}`;
      const command: AgentToolCommand = { name: "prepare_change", arguments: { appointmentId: appointment.id,
        ...(kind === "service" ? { serviceId: h.otherService } : { resourceId: h.alternate }),
      } };
      const before = await appointments(h);
      const prepared = await factoryTurn(h, kind === "service" ? "Cambiar servicio" : "Cambiar recurso", [command], ["prepared_quote"], toolReply);
      const reply = await factoryTurn(h, "Hola", [command], ["data"], '{"kind":"reply"}');
      expect(prepared.text).toContain(kind === "service" ? "Cambio propuesto: Hola" : "Cambio propuesto: Corte");
      expect(reply.text).toContain("pendiente no cambió");
      const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(pending!.dialogue.quote.terms[kind === "service" ? "serviceId" : "resourceId"]).toBe(kind === "service" ? h.otherService : h.alternate);
      expect(await appointments(h)).toEqual(before);
      await delivered(prepared);
      await factoryTurn(h, "dale cambialo", factoryAcceptance, ["staged_action"], "Cambio guardado");
      expect((await appointments(h))[0]!.terms[kind === "service" ? "serviceId" : "resourceId"]).toBe(kind === "service" ? h.otherService : h.alternate);
      expect(await counts(h)).toMatchObject({ clients: 1, appointments: 1, effects: 2 });
      expect(h.textCalls).toBe(0);
    }
  });

  test("actual worker factory executes native tools and rejects generate-only providers upfront", async () => {
    const h = await fixture();
    const catalog = await factoryTurn(h, "Consultar servicios", [{ name: "read_catalog", arguments: {} }], ["data"], results => {
      expect(JSON.stringify(results)).toContain("Corte");
      return "Corte";
    });
    expect(catalog.text).toContain("Corte");
    expect(h.textCalls).toBe(0);
    const other = await fixture();
    expect(() => createMessageWorker(pools, { generate: other.provider.generate })).toThrow("requires callable converse");
    expect(other.textCalls).toBe(0);
    expect(await counts(other)).toMatchObject({ clients: 0, appointments: 0, receipts: 0, effects: 0 });
    expect(await db.sql`select outbound_id from outbound_commands where business_id=${other.business}`).toHaveLength(0);
  });
});
