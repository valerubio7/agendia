import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { PostgresWhatsAppAgenda } from "../../apps/message-worker/src/agent/adapters/agenda.ts";
import { PostgresInboundHandler } from "../../apps/whatsapp-manager/src/inbound-handler.ts";
import { normalizeBaileysMessage } from "../../packages/whatsapp-baileys/src/baileys-gateway.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";
import type { ReceptionistToolSession, ReceptionistToolResult } from "../../apps/message-worker/src/agent/tools.ts";

let db: TestPostgres;
let pools: ReturnType<typeof createRuntimePools>;
const phone = "+5491123456789";
const start = "2035-04-02T10:00:00-03:00";
beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
  pools = createRuntimePools(db.container.getConnectionUri());
  await db.sql`create table public.receptionist_fault_fixture(business_id uuid primary key, enabled boolean not null)`;
  await db.sql`grant select on public.receptionist_fault_fixture to agendia_worker_runtime`;
  await db.sql.unsafe(`create function receptionist_receipt_fault() returns trigger language plpgsql as $$
    begin
      if exists(select 1 from public.receptionist_fault_fixture where business_id=NEW.business_id and enabled) then
        raise exception 'injected receipt failure';
      end if;
      return NEW;
    end $$;
    create trigger receptionist_receipt_fault before insert on whatsapp_agenda_receipts
      for each row execute function receptionist_receipt_fault()`);
}, 120_000);
afterAll(async () => { await pools?.end(); await db?.stop(); });
async function fixture(profile = true, knownClient = true, now = "2035-04-01T08:00:00-03:00") {
  const business = randomUUID(), connection = randomUUID(), session = randomUUID();
  const service = randomUUID(), resource = randomUUID();
  const schedule = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [day, [{ startMinute: 540, endMinute: 1080 }]]));
  await db.sql`insert into businesses(id,name) values(${business},'Tools')`;
  await db.sql`insert into assistant_configs(business_id,active) values(${business},true)`;
  if (profile) await db.sql`insert into business_profiles(business_id,display_name,description,address) values(${business},'Tools','Descripción','Dirección')`;
  await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state) values(${connection},${business},${session},'CONNECTED')`;
  await db.sql`insert into business_calendars(business_id,weekly_schedule) values(${business},${db.sql.json(schedule)})`;
  await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${service},${business},'Corte',30,1500)`;
  await db.sql`insert into resources(id,business_id,name,weekly_schedule) values(${resource},${business},'Ana',${db.sql.json(schedule)})`;
  await db.sql`insert into resource_services(business_id,resource_id,service_id) values(${business},${resource},${service})`;
  if (knownClient) await db.sql`insert into clients(business_id,first_name,last_name,phone) values(${business},'María','Pérez',${phone})`;
  const agenda = new PostgresWhatsAppAgenda(pools, () => now);
  async function receive(text: string, trusted = true, sender = "5491123456789") {
    const providerId = randomUUID();
    const event = normalizeBaileysMessage(session, { key: { id: providerId, remoteJid: `${sender}@s.whatsapp.net` }, message: { conversation: text } }, trusted)!;
    await new PostgresInboundHandler(pools).handle(event);
    const [row] = await db.sql`select id,conversation_id from messages where business_id=${business} and provider_message_id=${providerId}`;
    await db.sql`update conversations set reply_due_at=now()-interval '1 second' where id=${row!.conversation_id}`;
    return { businessId: business, messageId: row!.id as string, correlationId: `tools:${providerId}` };
  }
  const context = tenantContext({ businessId: business, actorId: "message-worker", role: "internal_worker", requestId: randomUUID() });
  const appointments = () => pools.worker.run(context, repo => repo.listAppointments(business));
  const run = async (text: string, callback: (tools: ReceptionistToolSession) => Promise<string>) => {
    let assertionFailure: unknown;
    const result = await agenda.withReceptionistSession(await receive(text), async tools => {
      try { return await callback(tools); }
      catch (error) { assertionFailure = error; throw error; }
    });
    if (assertionFailure) throw assertionFailure;
    expect(result.status).toBe("committed");
    return result;
  };
  return { business, service, resource, agenda, receive, appointments, run, context };
}
const data = (result: ReceptionistToolResult) => {
  expect(result.status).toBe("data");
  if (result.status !== "data") throw new Error("Expected data");
  return result.data;
};
async function prepareNatural(h: Awaited<ReturnType<typeof fixture>>, delivered = true) {
  const result = await h.run("ese horario", async tools => {
    expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("prepared_quote");
    return "Te paso la propuesta.";
  });
  if (result.status !== "committed") throw new Error("Missing quote");
  if (delivered) await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${result.outboundId}`;
  return result;
}
function naturalArguments(tools: ReceptionistToolSession) {
  const binding = tools.context.naturalConfirmation;
  if (!binding) throw new Error("Expected delivered quote binding");
  return { ...binding, evidence: tools.context.message };
}
describe("proof-bound customer output", () => {
  for (const wording of ["Hola, ¿en qué puedo ayudarte?", "Tu turno está confirmado."]) {
    test(`prose-only output has no operation effects, not semantic attestation: ${wording}`, async () => {
      const h = await fixture(true, false);
      const result = await h.run("quiero un turno", async () => JSON.stringify({ kind: "informational_prose", text: wording }));
      if (result.status !== "committed") throw new Error("Missing output");
      const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
      expect(output!.text).toBe(wording);
      expect(result.actions).toHaveLength(0);
      expect(await h.appointments()).toHaveLength(0);
      const [counts] = await db.sql`select (select count(*)::int from clients where business_id=${h.business}) clients,
        (select count(*)::int from outbox_events where business_id=${h.business} and topic='appointment.changed') effects`;
      expect(counts).toEqual({ clients: 0, effects: 0 });
    });
  }
  test("caught backend rejection without a backend reply overrides valid prose", async () => {
    const h = await fixture();
    const result = await h.run("ese horario", async tools => {
      expect(await tools.execute("prepare_booking", { serviceId: randomUUID(), startsAt: start }))
        .toEqual({ status: "rejected", code: "AGENDA_REJECTED" });
      return JSON.stringify({ kind: "informational_prose", text: "Todo salió bien." });
    });
    if (result.status !== "committed") throw new Error("Missing output");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
    expect(output!.text).toBe("No se guardó ningún cambio. No pude verificar la operación. ¿Podés aclarar qué necesitás?");
    expect(await h.appointments()).toHaveLength(0);
  });
  test("successful availability retry permits selective prose after a rejected reference", async () => {
    const h = await fixture();
    let wording: string;
    const result = await h.run("¿qué horario tenés?", async tools => {
      expect((await tools.execute("availability", { serviceId: randomUUID(), date: "2035-04-02" })).status).toBe("rejected");
      data(await tools.execute("read_catalog", {}));
      const slots = data(await tools.execute("availability", { serviceId: h.service, date: "2035-04-02" })) as {
        items: { presentation: { label: string } }[];
      };
      wording = `Podés venir ${slots.items[0]!.presentation.label}. ¿Te sirve?`;
      return JSON.stringify({ kind: "informational_prose", text: wording });
    });
    if (result.status !== "committed") throw new Error("Missing output");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
    expect(output!.text).toBe(wording!);
  });
  test("backend missing-names request overrides valid prose", async () => {
    const h = await fixture(true, false);
    let expected: string;
    const result = await h.run("ese horario", async tools => {
      const reply = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      expect(reply.status).toBe("clarification");
      if (reply.status !== "clarification") throw new Error("Missing name request");
      expected = reply.message!;
      expect(expected).toBe("Decime tu nombre y apellido.");
      return JSON.stringify({ kind: "informational_prose", text: "No necesito tu nombre." });
    });
    if (result.status !== "committed") throw new Error("Missing output");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
    expect(output!.text).toBe(expected!);
    expect(await h.appointments()).toHaveLength(0);
    const [clients] = await db.sql`select count(*)::int count from clients where business_id=${h.business}`;
    expect(clients!.count).toBe(0);
  });
  test("backend staged saved result overrides valid prose even after another rejected mutation", async () => {
    const h = await fixture();
    await prepareNatural(h);
    let appointmentId: string;
    const result = await h.run("dale reservame ese", async tools => {
      const saved = await tools.execute("confirm_quote_naturally", naturalArguments(tools));
      expect(saved.status).toBe("staged_action");
      if (saved.status !== "staged_action") throw new Error("Missing saved result");
      appointmentId = (saved.appointment as { id: string }).id;
      expect((await tools.execute("confirm_quote_naturally", naturalArguments(tools))).status).toBe("rejected");
      return JSON.stringify({ kind: "informational_prose", text: "No se guardó nada." });
    });
    if (result.status !== "committed") throw new Error("Missing output");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
    expect(output!.text).toStartWith("Guardado: Corte,");
    expect(output!.text).toContain(`Turno ${appointmentId!}.`);
    expect(output!.text).not.toContain("No se guardó nada.");
    expect(result.actions).toHaveLength(1);
    expect(await h.appointments()).toHaveLength(1);
  });
  for (const prose of ["Te propongo Corte mañana a las 10 por ARS 1.", "Tu turno está confirmado.",
    JSON.stringify({ kind: "chat", text: "Tu turno está confirmado." }),
    JSON.stringify({ kind: "confirmation", appointmentId: "forged" })]) {
    test(`unbound output cannot attest an operation: ${prose}`, async () => {
      const h = await fixture(true, false);
      const result = await h.run("quiero un turno", async () => prose);
      if (result.status !== "committed") throw new Error("Missing output");
      const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
      expect(output!.text).toBe("¿Qué servicio y día querés consultar?");
      expect(await h.appointments()).toHaveLength(0);
      const [counts] = await db.sql`select (select count(*)::int from clients where business_id=${h.business}) clients,
        (select count(*)::int from outbox_events where business_id=${h.business} and topic='appointment.changed') effects`;
      expect(counts).toEqual({ clients: 0, effects: 0 });
    });
  }
  for (const raw of ["Tu turno está confirmado. Ya pagaste.",
    JSON.stringify({ kind: "informational_prose", text: "Tu turno está confirmado. Ya pagaste." })]) test(`prepared quote excludes raw and valid-arm before/after prose: ${raw}`, async () => {
    const h = await fixture();
    let expected: string;
    const result = await h.run("ese horario", async tools => {
      const quote = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      expect(quote.status).toBe("prepared_quote");
      if (quote.status !== "prepared_quote") throw new Error("Missing quote");
      expected = quote.message;
      return raw;
    });
    if (result.status !== "committed") throw new Error("Missing output");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
    expect(output!.text).toBe(expected!);
    expect(output!.text).not.toContain("confirmado");
    expect(output!.text).not.toContain("pagaste");
    expect(output!.text).toContain("1500");
    expect(await h.appointments()).toHaveLength(0);
  });
});
describe("offer/action response coherence", () => {
  for (const delivered of [false, true]) for (const failure of ["catalog", "availability", "owned", "schema", "batch", "limit"] as const)
    test(`rejected B revokes A, delivered=${delivered}, failure=${failure}`, async () => {
      const h = await fixture(true, false);
      if (delivered) {
        const first = await h.run("mi nombre es María Pérez", async tools => {
          expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("prepared_quote");
          return '{"kind":"reply"}';
        });
        if (first.status !== "committed") throw new Error("Missing A");
        await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${first.outboundId}`;
      }
      const result = await h.run(delivered ? "sí, esa propuesta" : "mi nombre es María Pérez", async tools => {
        const consent = delivered ? naturalArguments(tools) : null;
        if (failure === "limit") for (let i = 0; i < (delivered ? 16 : 15); i++) await tools.execute("read_business", {});
        const a = !delivered ? tools.execute("prepare_booking", { serviceId: h.service, startsAt: start }) : Promise.resolve();
        if (failure !== "batch") await a;
        const b = tools.execute(failure === "owned" ? "prepare_change" : "prepare_booking",
          failure === "owned" ? { appointmentId: randomUUID(), startsAt: start }
            : ["schema", "batch", "limit"].includes(failure) ? {}
              : { serviceId: failure === "catalog" ? randomUUID() : h.service, startsAt: "2035-04-02T23:00:00-03:00" });
        const [, rejected] = await Promise.all([a, b]);
        expect(rejected.status).toBe(failure === "availability" ? "clarification" : "rejected");
        if (consent) expect((await tools.execute("confirm_quote_naturally", consent)).status).toBe("rejected");
        return '{"kind":"reply"}';
      });
      if (result.status !== "committed") throw new Error("Missing rejection output");
      const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
      expect(output!.text).not.toContain("Reserva propuesta");
      const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(pending!.dialogue.quote).toBeNull();
      expect(pending!.dialogue.awaitingNames).toBe(false);
      expect(pending!.dialogue.bookingNames).toEqual({ firstName: "María", lastName: "Pérez" });
      await h.run("confirmo", async tools => {
        expect(tools.context.naturalConfirmation).toBeNull();
        expect((await tools.execute("confirm_quote", {})).status).not.toBe("staged_action");
        return '{"kind":"reply"}';
      });
      expect(await h.appointments()).toHaveLength(0);
    });
  test("handled retarget refusal revokes only the quote, retaining structural context", async () => {
    const { h, ap } = await structuralFixture();
    const other = await savedAppointment(h, "2035-04-02T12:00:00-03:00");
    const result = await h.run("más tarde", async tools => {
      expect((await tools.execute("prepare_change", { appointmentId: ap.id, startsAt: "2035-04-02T11:00:00-03:00" })).status).toBe("prepared_quote");
      expect((await tools.execute("prepare_change", { appointmentId: other.id, startsAt: "2035-04-02T13:00:00-03:00" })).status).toBe("clarification");
      return '{"kind":"reply"}';
    });
    if (result.status !== "committed") throw new Error("Missing refusal");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
    expect(output!.text).not.toContain("Cambio propuesto");
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(pending!.dialogue.quote).toBeNull();
    expect(pending!.dialogue.reschedule.appointmentId).toBe(ap.id);
    expect(await h.appointments()).toHaveLength(2);
  });
  test("valid nameless replacement stays collectable after a rejected proposal", async () => {
    const h = await fixture(true, false);
    await h.run("María", async tools => {
      const draft = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      const member = tools.context.nameSources!.at(-1)!;
      await tools.execute("collect_booking_names", { namesReference: draft.namesReference,
        firstName: { value: "María", messageId: member.messageId, start: 0 } });
      await tools.execute("prepare_booking", { serviceId: randomUUID(), startsAt: start });
      const b = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: "2035-04-02T11:00:00-03:00" });
      expect(b.status).toBe("clarification");
      expect((b as any).message).toBe("Decime tu apellido.");
      expect(b.namesReference).toBeString();
      return '{"kind":"reply"}';
    });
    await h.run("Pérez", async tools => {
      const member = tools.context.nameSources!.at(-1)!;
      const b = await tools.execute("collect_booking_names", { namesReference: tools.context.namesReference,
        lastName: { value: "Pérez", messageId: member.messageId, start: 0 } });
      expect(b.status).toBe("prepared_quote");
      expect((b as any).quote.names).toEqual({ firstName: "María", lastName: "Pérez" });
      expect(Date.parse((b as any).quote.startsAt)).toBe(Date.parse("2035-04-02T11:00:00-03:00"));
      return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toHaveLength(0);
  });
  test("staged success wins over rejected/malformed preparations and clear_pending", async () => {
    const h = await fixture();
    await prepareNatural(h);
    const result = await h.run("confirmo", async tools => {
      expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action");
      await tools.execute("prepare_booking", { serviceId: randomUUID(), startsAt: start });
      await tools.execute("prepare_change", {});
      await tools.execute("clear_pending", {});
      return '{"kind":"reply"}';
    });
    if (result.status !== "committed") throw new Error("Missing action");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
    expect(output!.text).toStartWith("Guardado:");
    expect(output!.text).not.toContain("Reserva propuesta");
    expect(result.actions).toHaveLength(1);
    expect(await h.appointments()).toHaveLength(1);
  });
  test("infrastructure failure after staging and malformed preparation rolls back everything", async () => {
    const h = await fixture();
    await prepareNatural(h);
    const [before] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    await db.sql`insert into public.receptionist_fault_fixture(business_id,enabled) values(${h.business},true)`;
    const job = await h.receive("confirmo");
    const result = await h.agenda.withReceptionistSession(job, async tools => {
      expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action");
      await tools.execute("prepare_booking", {});
      return '{"kind":"reply"}';
    });
    expect(result.status).toBe("infrastructure_failure");
    expect(await h.appointments()).toHaveLength(0);
    const [after] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(after!.dialogue).toEqual(before!.dialogue);
    const [counts] = await db.sql`select
      (select count(*)::int from outbound_commands where source_message_id=${job.messageId}) outputs,
      (select count(*)::int from whatsapp_agenda_receipts where message_id=${job.messageId}) receipts,
      (select count(*)::int from outbox_events where business_id=${h.business} and topic='appointment.changed') effects`;
    expect(counts).toEqual({ outputs: 0, receipts: 0, effects: 0 });
  });
});
describe("native mismatched selections disclose proposals without attesting meaning or saving", () => {
  for (const [name, text, fields] of [
    ["notes are not a time change", "Cambiar nota: llegaré tarde", { startsAt: "2035-04-02T11:00:00-03:00" }],
    ["unsupported name change", "Cambiar nombre del turno", { startsAt: "2035-04-02T11:00:00-03:00" }],
    ["service choice cannot be invented", "Cambiar servicio del turno", {}],
    ["explicit time conflict uses a different available slot", "Reprogramar mi turno el 2035-04-02 a las 11:00", { startsAt: "2035-04-02T12:00:00-03:00" }],
    ["unspecified no-op selection", "Reprogramar mi turno", { startsAt: start }],
    ["explicit no-op service choice", "Cambiar servicio del turno a Corte", {}],
    ["resource request cannot change time", "Cambiar recurso del turno a Ana", { startsAt: "2035-04-02T11:00:00-03:00" }],
    ["temporal request cannot select a different valid service", "Reprogramar mi turno el 2035-04-02 a las 11:00", { startsAt: "2035-04-02T11:00:00-03:00" }],
  ] as const) test(name, async () => {
    const h = await fixture();
    await prepareNatural(h);
    await h.run("dale reservame ese", async tools => {
      expect((await tools.execute("confirm_quote_naturally", naturalArguments(tools))).status).toBe("staged_action");
      return "Listo.";
    });
    const [appointment] = await h.appointments();
    let selectedService = h.service;
    if (name === "temporal request cannot select a different valid service") {
      selectedService = randomUUID();
      await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${selectedService},${h.business},'Color',30,2000)`;
      await db.sql`insert into resource_services(business_id,resource_id,service_id) values(${h.business},${h.resource},${selectedService})`;
    }
    let selection: ReceptionistToolResult;
    await h.run(text, async tools => {
      const slots = data(await tools.execute("availability", { serviceId: selectedService, date: "2035-04-02", appointmentId: appointment!.id })) as { items: { startsAt: string }[] };
      if ("startsAt" in fields) expect(slots.items.some(slot => Date.parse(slot.startsAt) === Date.parse(fields.startsAt))).toBe(true);
      selection = await tools.execute("prepare_change", { appointmentId: appointment!.id, serviceId: selectedService,
        ...(name === "resource request cannot change time" ? { resourceId: h.resource } : {}), ...fields });
      return "Necesito el cambio que querés hacer.";
    });
    expect(await h.appointments()).toEqual([appointment!]);
    const changed = selectedService !== h.service || ("startsAt" in fields && Date.parse(fields.startsAt) !== appointment!.startMs);
    expect(selection!.status).toBe(changed ? "prepared_quote" : "data");
    expect(selection!.status).not.toBe("staged_action");
    if (selection!.status === "prepared_quote") expect(selection!.message).toContain("Cambio propuesto");
    await h.run("¿qué quedó pendiente?", async tools => {
      const pending = tools.context.pending as any;
      if (changed) {
        expect(pending.quote.terms.serviceId).toBe(selectedService);
        expect(Date.parse(pending.quote.startsAt)).toBe("startsAt" in fields ? Date.parse(fields.startsAt) : appointment!.startMs);
        expect(pending.reschedule.date).toBeUndefined(); expect(pending.reschedule.time).toBeUndefined();
      } else expect(pending.quote).toBeNull();
      return '{"kind":"reply"}';
    });
  });
});
async function structuralFixture() {
  const h = await fixture(), ap = await savedAppointment(h), color = randomUUID(), alternate = randomUUID();
  await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${color},${h.business},'Color',45,2500)`;
  await db.sql`insert into resources(id,business_id,name,weekly_schedule) select ${alternate},${h.business},'Beatriz',weekly_schedule from resources where id=${h.resource}`;
  await db.sql`insert into resource_services(business_id,resource_id,service_id) values
    (${h.business},${h.resource},${color}),(${h.business},${alternate},${h.service}),(${h.business},${alternate},${color})`;
  return { h, ap, color, alternate };
}
describe("native structural selections are proposals, not semantic consent", () => {
  for (const kind of ["natural service", "polite service", "natural resource", "negated date", "retained day"] as const) test(kind, async () => {
    const { h, ap, color, alternate } = await structuralFixture(), wednesday = "2035-04-04T11:00:00-03:00";
    if (kind === "retained day") await h.run("el miércoles a las 10", async tools => {
      expect((await tools.execute("prepare_change", { appointmentId: ap.id, startsAt: "2035-04-04T10:00:00-03:00" })).status).toBe("prepared_quote"); return '{"kind":"reply"}';
    });
    const text = kind === "natural service" ? "Me gustaría cambiar el servicio a Color" : kind === "polite service" ? "Cambiar servicio a Color por favor"
      : kind === "natural resource" ? "Me gustaría atenderme con Beatriz" : kind === "negated date" ? "No mañana; el miércoles a las 11" : "Reprogramar a las 11";
    await h.run(text, async tools => {
      const fields = kind.includes("service") ? { serviceId: color.toUpperCase() } : kind === "natural resource" ? { resourceId: alternate } : { startsAt: wednesday };
      const result = await tools.execute("prepare_change", { appointmentId: ap.id, ...fields });
      expect(result.status).toBe("prepared_quote");
      if (result.status !== "prepared_quote") throw new Error("Missing proposal");
      expect((result.quote as any).terms.serviceId).toBe(kind.includes("service") ? color : h.service);
      expect((result.quote as any).terms.resourceId).toBe(kind === "natural resource" ? alternate : h.resource);
      expect(Date.parse((result.quote as any).startsAt)).toBe(Date.parse(kind.includes("service") || kind === "natural resource" ? start : wednesday));
      expect((await tools.execute("confirm_quote", {})).status).not.toBe("staged_action"); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([ap]);
  });
  for (const accepts of [false, true]) test(`combined retained proposal preserves delivery and current acceptance; accept=${accepts}`, async () => {
    const { h, ap, color, alternate } = await structuralFixture(), later = "2035-04-04T11:00:00-03:00";
    await db.sql`update appointments set customer_resource_preference_id=${h.resource} where id=${ap.id}`;
    const [before] = await h.appointments();
    const prepared = await h.run("Color con Beatriz el miércoles", async tools => {
      expect((await tools.execute("prepare_change", { appointmentId: ap.id, serviceId: color, resourceId: alternate, startsAt: later })).status).toBe("prepared_quote"); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([before!]);
    if (prepared.status !== "committed") throw new Error("Missing combined proposal");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    let original: unknown;
    const repeated = await h.run(accepts ? "sí, esa propuesta" : "seguimos con esa", async tools => {
      original = structuredClone((tools.context.pending as any).quote);
      const consent = naturalArguments(tools);
      expect((await tools.execute("prepare_change", { appointmentId: ap.id, startsAt: "2035-04-04T14:00:00Z" })).status).toBe("data");
      if (accepts) expect((await tools.execute("confirm_quote_naturally", consent)).status).toBe("staged_action"); return '{"kind":"reply"}';
    });
    if (repeated.status !== "committed") throw new Error("Missing repeat");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${repeated.outboundId}`;
    expect(output!.text).not.toContain("Cambio propuesto");
    if (!accepts) {
      const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(pending!.dialogue.quote).toEqual(original); expect(await h.appointments()).toEqual([before!]);
    } else expect((await h.appointments())[0]).toMatchObject({ id: ap.id, customerResourcePreference: h.resource,
      startMs: Date.parse(later), client: before!.client, notes: before!.notes, state: before!.state,
      terms: { serviceId: color, resourceId: alternate, priceArs: 2500, durationMinutes: 45 } });
  });
  test("saved no-op withdraws an unrelated proposal instead of leaving it confirmable", async () => {
    const { h, ap, color } = await structuralFixture();
    await h.run("Reservar el 2035-04-05 a las 15:00", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: "2035-04-05T15:00:00-03:00" })).status).toBe("prepared_quote"); return '{"kind":"reply"}';
    }); // This unrelated booking must not supply structural date/time fields.
    await h.run("cambiar solo el servicio", async tools => {
      const result = await tools.execute("prepare_change", { appointmentId: ap.id, serviceId: color });
      expect((result as any).quote.startsAt).toBe(ap.startsAt); return '{"kind":"reply"}';
    });
    await h.run("dejalo como estaba", async tools => {
      expect((await tools.execute("prepare_change", { appointmentId: ap.id, serviceId: h.service, resourceId: h.resource, startsAt: ap.startsAt })).status).toBe("data"); return '{"kind":"reply"}';
    });
    await h.run("confirmo", async tools => { expect(tools.context.naturalConfirmation).toBeNull(); expect((await tools.execute("confirm_quote", {})).status).toBe("clarification"); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toEqual([ap]);
  });
  for (const guard of ["retarget", "stale", "final", "started", "foreign", "ineligible", "unavailable", "unresolved"] as const) test(`structural guard: ${guard}`, async () => {
    const { h, ap, alternate } = await structuralFixture(), later = "2035-04-02T11:00:00-03:00";
    let target = ap.id, resourceId = h.resource;
    if (guard === "retarget" || guard === "stale") await h.run("más tarde", async tools => { await tools.execute("prepare_change", { appointmentId: ap.id, startsAt: later }); return '{"kind":"reply"}'; });
    if (guard === "retarget") target = (await savedAppointment(h, "2035-04-02T12:00:00-03:00")).id;
    if (guard === "stale") await db.sql`update appointments set customer_resource_preference_id=${alternate} where id=${ap.id}`;
    if (guard === "final") await db.sql`update appointments set state='cancelled' where id=${ap.id}`;
    if (guard === "started") await db.sql`update appointments set start_raw='2035-04-01T07:00:00-03:00',start_ms=${Date.parse("2035-04-01T07:00:00-03:00")},end_ms=${Date.parse("2035-04-01T07:30:00-03:00")} where id=${ap.id}`;
    if (guard === "foreign") resourceId = (await fixture()).resource;
    if (guard === "ineligible") {
      resourceId = randomUUID(); await db.sql`insert into resources(id,business_id,name,weekly_schedule) select ${resourceId},${h.business},'Sin servicio',weekly_schedule from resources where id=${h.resource}`;
    }
    if (guard === "unavailable") await savedAppointment(h, later);
    if (guard === "unresolved") await h.run("prefiero Desconocido", async tools => { await tools.execute("prepare_change", { appointmentId: ap.id, startsAt: later }); return '{"kind":"reply"}'; });
    const before = await h.appointments();
    await h.run("Reprogramar mi turno el 2035-04-02 a las 11:00", async tools => {
      expect((await tools.execute("prepare_change", { appointmentId: target, resourceId, startsAt: later })).status).not.toBe("prepared_quote"); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual(before);
  });
  for (const change of ["terms", "selection"] as const) test(`changed ${change} requires a fresh delivered proposal`, async () => {
    const { h, ap, color } = await structuralFixture();
    const first = await h.run("Color", async tools => { expect((await tools.execute("prepare_change", { appointmentId: ap.id, serviceId: color })).status).toBe("prepared_quote"); return '{"kind":"reply"}'; });
    if (first.status !== "committed") throw new Error("Missing first proposal");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${first.outboundId}`;
    if (change === "terms") await db.sql`update services set price_ars=3000 where id=${color}`;
    const refreshed = await h.run("sí, con ese cambio", async tools => {
      const consent = naturalArguments(tools);
      const result = await tools.execute("prepare_change", { appointmentId: ap.id, serviceId: color, ...(change === "selection" ? { startsAt: "2035-04-02T11:00:00-03:00" } : {}) });
      expect(result.status).toBe("prepared_quote"); expect((result as any).quote.outboundId).toBeNull();
      expect((await tools.execute("confirm_quote_naturally", consent)).status).toBe("rejected"); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([ap]);
    const undelivered = await h.run("confirmo", async tools => { expect((await tools.execute("confirm_quote", {})).status).toBe("prepared_quote"); return '{"kind":"reply"}'; });
    if (refreshed.status !== "committed" || undelivered.status !== "committed") throw new Error("Missing refresh");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${undelivered.outboundId}`;
    await h.run("confirmo", async tools => { expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action"); return '{"kind":"reply"}'; });
    expect((await h.appointments())[0]!.terms.priceArs).toBe(change === "terms" ? 3000 : 2500);
  });
});
describe("native booking/query selections are not preference or consent evidence", () => {
  for (const operation of ["negated booking date", "polite booking resource", "polite structural resource"] as const) test(operation, async () => {
    const h = await fixture(), ap = operation === "polite structural resource" ? await savedAppointment(h) : null;
    await h.run(operation === "negated booking date" ? "No mañana; el miércoles a las 11" : "Prefiero Ana, por favor", async tools => {
      const result = await tools.execute(ap ? "prepare_change" : "prepare_booking", { ...(ap ? { appointmentId: ap.id } : {}),
        serviceId: h.service, resourceId: h.resource, startsAt: "2035-04-04T11:00:00-03:00" });
      expect(result.status).toBe("prepared_quote");
      expect((result as any).quote).toMatchObject({ preference: null, terms: { resourceId: h.resource } });
      expect(Date.parse((result as any).quote.startsAt)).toBe(Date.parse("2035-04-04T11:00:00-03:00")); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual(ap ? [ap] : []);
  });
  test("availability honors exact typed date/resource despite raw or retained fields, without updating preference", async () => {
    const { h, ap, alternate } = await structuralFixture();
    await h.run("El 2035-04-02", async tools => { await tools.execute("confirm_quote", {}); return '{"kind":"reply"}'; });
    await h.run("Prefiero Ana", async tools => { data(await tools.execute("availability", { serviceId: h.service, date: "2035-04-02" })); return '{"kind":"reply"}'; });
    await h.run("No mañana; el miércoles, ¿y con Beatriz?", async tools => {
      const result = data(await tools.execute("availability", { serviceId: h.service, date: "2035-04-04", resourceId: alternate })) as any;
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((slot: any) => slot.resourceId === alternate && slot.presentation.localDate === "2035-04-04")).toBe(true);
      return '{"kind":"reply"}';
    });
    await h.run("¿y ahora?", async tools => {
      expect((tools.context.pending as any).bookingPreference).toBe(h.resource);
      expect((tools.context.pending as any).requestedDate).toBe("2035-04-02"); return '{"kind":"reply"}';
    });
    const schedule = { 4: [{ startMinute: 540, endMinute: 1080 }] };
    await db.sql`update resources set weekly_schedule=${db.sql.json(schedule)} where id=${alternate}`;
    await h.run("Ese miércoles", async tools => {
      expect((data(await tools.execute("availability", { serviceId: h.service, date: "2035-04-04", resourceId: alternate })) as any).items).toEqual([]);
      return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([ap]);
  });
  for (const accepts of [false, true]) test(`identical delivered BOOK retains omitted resource and current consent; accept=${accepts}`, async () => {
    const { h, ap, alternate } = await structuralFixture();
    await h.run("Prefiero Ana", async tools => { await tools.execute("availability", { serviceId: h.service, date: "2035-04-04" }); return '{"kind":"reply"}'; });
    const first = await h.run("con Beatriz el miércoles", async tools => {
      const result = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: "2035-04-04T11:00:00-03:00", resourceId: alternate });
      expect(result.status).toBe("prepared_quote"); expect((result as any).quote).toMatchObject({ preference: h.resource, terms: { resourceId: alternate } }); return '{"kind":"reply"}';
    });
    if (first.status !== "committed") throw new Error("Missing book proposal");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${first.outboundId}`;
    let previous: unknown;
    const repeated = await h.run(accepts ? "sí, ese" : "¿sigue igual?", async tools => {
      previous = structuredClone((tools.context.pending as any).quote); const consent = naturalArguments(tools);
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: "2035-04-04T14:00:00Z" })).status).toBe("data");
      if (accepts) expect((await tools.execute("confirm_quote_naturally", consent)).status).toBe("staged_action"); return '{"kind":"reply"}';
    });
    if (repeated.status !== "committed") throw new Error("Missing retained response");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${repeated.outboundId}`;
    expect(output!.text).not.toContain("Reserva propuesta");
    if (accepts) expect((await h.appointments()).find(item => item.id !== ap.id)).toMatchObject({ customerResourcePreference: h.resource, terms: { resourceId: alternate } });
    else {
      const [state] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(state!.dialogue.quote).toEqual(previous); expect(await h.appointments()).toEqual([ap]);
    }
  });
  for (const change of ["slot", "resource", "service", "terms"] as const) test(`changed book ${change} needs fresh delivery/acceptance`, async () => {
    const { h, ap, alternate, color } = await structuralFixture();
    const args = { serviceId: h.service, startsAt: "2035-04-04T11:00:00-03:00", resourceId: h.resource };
    const first = await h.run("ese turno", async tools => { expect((await tools.execute("prepare_booking", args)).status).toBe("prepared_quote"); return '{"kind":"reply"}'; });
    if (first.status !== "committed") throw new Error("Missing first proposal");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${first.outboundId}`;
    if (change === "terms") await db.sql`update services set price_ars=3000 where id=${h.service}`;
    await h.run("mejor con ese cambio", async tools => {
      const old = naturalArguments(tools);
      const result = await tools.execute("prepare_booking", { ...args, ...(change === "slot" ? { startsAt: "2035-04-04T12:00:00-03:00" } : change === "resource" ? { resourceId: alternate } : change === "service" ? { serviceId: color } : {}) });
      expect(result.status).toBe("prepared_quote"); expect((result as any).quote.outboundId).toBeNull();
      expect((await tools.execute("confirm_quote_naturally", old)).status).toBe("rejected"); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([ap]);
    const undelivered = await h.run("confirmo", async tools => { expect((await tools.execute("confirm_quote", {})).status).toBe("prepared_quote"); return '{"kind":"reply"}'; });
    if (undelivered.status !== "committed") throw new Error("Missing refreshed delivery");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${undelivered.outboundId}`;
    await h.run("confirmo", async tools => { expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action"); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toHaveLength(2);
  });
  for (const guard of ["hours", "capacity"] as const) test(`retained BOOK revalidates ${guard} before preserving consent`, async () => {
    const h = await fixture(); await prepareNatural(h);
    if (guard === "hours") await db.sql`update resources set weekly_schedule='{}'::jsonb where id=${h.resource}`;
    else await pools.worker.run(h.context, async repo => { const client = await repo.findClientByCanonicalPhone(phone);
      await repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource, startRaw: start, clientId: client!.id }, { now: "2035-04-01T08:00:00-03:00", origin: "manual" }); });
    const before = await h.appointments();
    await h.run("dale", async tools => { const consent = naturalArguments(tools);
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("clarification");
      expect((await tools.execute("confirm_quote_naturally", consent)).status).toBe("rejected"); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toEqual(before);
  });
  test("fresh unknown preference blocks a repeated BOOK without a supplied choice", async () => {
    const h = await fixture(); await prepareNatural(h);
    await h.run("Prefiero Desconocida", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("clarification"); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toHaveLength(0);
  });
  test("temporary assignment does not resolve real unknown preference metadata", async () => {
    const h = await fixture(), args = { serviceId: h.service, startsAt: start };
    await h.run("Prefiero Desconocida", async tools => { expect((await tools.execute("prepare_booking", args)).status).toBe("clarification"); return '{"kind":"reply"}'; });
    await h.run("con esa profesional", async tools => { expect((await tools.execute("prepare_booking", { ...args, resourceId: h.resource })).status).toBe("prepared_quote"); return '{"kind":"reply"}'; });
    await h.run("¿y otros horarios?", async tools => { expect((tools.context.pending as any).bookingUnresolvedPreference).toBe(true);
      expect((await tools.execute("availability", { serviceId: h.service, date: "2035-04-04" })).status).toBe("clarification"); return '{"kind":"reply"}'; });
    await h.run("Sin preferencia", async tools => { expect((await tools.execute("prepare_booking", args)).status).toBe("data"); return '{"kind":"reply"}'; });
    await h.run("¿ahora?", async tools => { expect((tools.context.pending as any).bookingUnresolvedPreference).toBe(false); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toHaveLength(0);
  });
  for (const text of ["Prefiero Ana", "Prefiero Desconocida"]) test(`new BOOK isolates structural context: ${text}`, async () => {
    const { h, ap } = await structuralFixture();
    await h.run(text, async tools => { await tools.execute("prepare_change", { appointmentId: ap.id, startsAt: "2035-04-04T11:00:00-03:00" }); return '{"kind":"reply"}'; });
    await h.run("Mi nombre es Elena García", async tools => {
      const result = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: "2035-04-05T12:00:00-03:00" });
      expect(result.status).toBe("prepared_quote"); expect((result as any).quote).toMatchObject({ names: null, preference: null }); return '{"kind":"reply"}'; });
    await h.run("¿qué quedó?", async tools => { const pending = tools.context.pending as any;
      expect(pending.reschedule).toBeUndefined(); expect(pending.bookingNameFields).toBeUndefined();
      expect(pending.bookingUnresolvedPreference).toBe(false); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toEqual([ap]);
  });
  test("partial names survive complete booking selections without manufacturing temporal evidence", async () => {
    const h = await fixture(true, false), args = { serviceId: h.service, startsAt: "2035-04-04T11:00:00-03:00" };
    await h.run("María", async tools => {
      const draft = await tools.execute("prepare_booking", args), member = tools.context.nameSources!.at(-1)!;
      expect((await tools.execute("collect_booking_names", { namesReference: draft.namesReference, firstName: nameField(member.messageId, "María") })).status).toBe("clarification"); return '{"kind":"reply"}';
    });
    await h.run("No mañana; el miércoles a las 11", async tools => {
      const result = await tools.execute("prepare_booking", args);
      expect(result).toMatchObject({ status: "clarification", message: "Decime tu apellido." }); return '{"kind":"reply"}';
    });
    await h.run("¿qué quedó?", async tools => {
      const draft = tools.context.pending as any; expect(draft.bookingNameFields).toEqual({ firstName: "María" });
      expect(draft.requestedDate).toBeUndefined(); expect(draft.requestedTime).toBeUndefined(); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toHaveLength(0);
    const [clients] = await db.sql`select count(*)::int count from clients where business_id=${h.business}`; expect(clients!.count).toBe(0);
  });
});
describe("native delivered change consent", () => {
  test("relative proposal stays unchanged until delivery, then one authentic confirmation changes exactly once", async () => {
    const h = await fixture();
    await prepareNatural(h);
    await h.run("dale reservame ese", async tools => {
      expect((await tools.execute("confirm_quote_naturally", naturalArguments(tools))).status).toBe("staged_action");
      return "Reservado.";
    });
    const [original] = await h.appointments();
    const later = "2035-04-02T11:00:00-03:00";
    const prepared = await h.run("mmm mejor más tarde", async tools => {
      const quote = await tools.execute("prepare_change", { appointmentId: original!.id, startsAt: later });
      expect(quote.status).toBe("prepared_quote");
      if (quote.status === "prepared_quote") expect(Date.parse((quote.quote as { startsAt: string }).startsAt)).toBe(Date.parse(later));
      expect((await tools.execute("confirm_quote", {})).status).not.toBe("staged_action");
      return "Te propongo esta alternativa.";
    });
    expect(await h.appointments()).toEqual([original!]);
    await h.run("dale cambialo", async tools => {
      expect(tools.context.naturalConfirmation).toBeNull();
      expect((await tools.execute("confirm_quote_naturally", {
        evidence: tools.context.message, evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64),
      })).status).toBe("clarification");
      return "Primero necesitás recibir la propuesta.";
    });
    expect(await h.appointments()).toEqual([original!]);
    if (prepared.status !== "committed") throw new Error("Missing change quote");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${prepared.outboundId}`;
    expect(output!.text).toContain("11:00");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    const job = await h.receive("dale cambialo");
    const result = await h.agenda.withReceptionistSession(job, async tools => {
      const args = naturalArguments(tools);
      expect((await tools.execute("confirm_quote_naturally", args)).status).toBe("staged_action");
      expect((await tools.execute("confirm_quote_naturally", args)).status).toBe("rejected");
      return "Cambio guardado.";
    });
    expect(result.status).toBe("committed");
    if (result.status === "committed") expect(result.actions).toHaveLength(1);
    const changed = await h.appointments();
    expect(changed).toHaveLength(1);
    expect(changed[0]!.id).toBe(original!.id);
    expect(Date.parse(changed[0]!.startsAt)).toBe(Date.parse(later));
    expect((await h.agenda.withReceptionistSession(job, async () => { throw new Error("Retry must not execute"); })).status).toBe("not_current");
    expect(await h.appointments()).toEqual(changed);
    const [effects] = await db.sql`select count(*)::int count from outbox_events where business_id=${h.business}
      and topic='appointment.changed' and payload->>'sourceMessageId'=${job.messageId}`;
    expect(effects!.count).toBe(1);
  });
});
describe("canonical presentation without quote authority changes", () => {
  test("slots, quotes, pending and appointments carry the backend Monday label without changing the fingerprint", async () => {
    const h = await fixture();
    const zone = "America/Argentina/Buenos_Aires";
    const expected = { timeZone: zone, localDate: "2035-04-02", localTime: "10:00", weekday: "lunes" };
    let snapshot: string;
    const prepared = await h.run("ese horario", async tools => {
      const calendar = data(await tools.execute("read_calendar", {})) as any;
      expect(calendar.timeZone).toBe(zone);
      const availability = data(await tools.execute("availability", { serviceId: h.service, date: "2035-04-02" })) as any;
      expect(availability.items.find((item: any) => Date.parse(item.startsAt) === Date.parse(start)).presentation).toMatchObject(expected);
      const result = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      expect((result as any).presentation).toMatchObject(expected);
      if (result.status !== "prepared_quote") throw new Error("Missing quote");
      snapshot = JSON.stringify(result.quote);
      expect(snapshot).not.toContain("presentation");
      expect(snapshot).not.toContain("weekday");
      return "Te paso la propuesta.";
    });
    if (prepared.status !== "committed") throw new Error("Missing committed quote");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    await h.run("dale reservame ese", async tools => {
      const pending = tools.context.pending as any;
      // Delivery changes only the existing outbound binding, not presentation state.
      expect({ ...pending.quote, outboundId: null }).toEqual(JSON.parse(snapshot!));
      expect((tools.context as any).pendingPresentation).toMatchObject(expected);
      const binding = structuredClone(tools.context.naturalConfirmation);
      const result = await tools.execute("confirm_quote_naturally", naturalArguments(tools));
      expect(result.status).toBe("staged_action");
      if (result.status !== "staged_action") throw new Error("Missing staged appointment");
      expect((result.appointment as any).presentation).toMatchObject(expected);
      expect(tools.context.naturalConfirmation).toEqual(binding);
      const owned = data(await tools.execute("owned_appointments", {})) as any;
      expect(owned.items[0].presentation).toMatchObject(expected);
      return "Listo.";
    });
    expect(await h.appointments()).toHaveLength(1);
  });
});
describe("natural confirmation protocol", () => {
  for (const evidence of ["dale reservame ese", "dale resrvame ese"]) {
    test(`authentic delivered quote can be confirmed with ${evidence}`, async () => {
      const h = await fixture();
      await prepareNatural(h);
      const result = await h.run(evidence, async tools => {
        expect((await tools.execute("confirm_quote", {})).status).toBe("clarification");
        expect((await tools.execute("confirm_quote_naturally", naturalArguments(tools))).status).toBe("staged_action");
        return "Listo, quedó reservado.";
      });
      if (result.status === "committed") expect(result.actions).toHaveLength(1);
      expect(await h.appointments()).toHaveLength(1);
    });
  }
  test("rejects missing, stale, fabricated, previous and partial evidence without an effect", async () => {
    const h = await fixture();
    await prepareNatural(h);
    let previous: ReturnType<typeof naturalArguments>;
    await h.run("antes dije otra cosa", async tools => { previous = naturalArguments(tools); return "¿Querés aceptar la propuesta?"; });
    await h.run("dale reservame ese", async tools => {
      const args = naturalArguments(tools);
      for (const invalid of [
        {}, { ...args, quoteFingerprint: "f".repeat(64) }, { ...args, evidenceReference: "f".repeat(64) },
        { ...args, evidence: "confirmo" }, { ...args, evidence: "reservame ese" },
        { ...args, evidence: previous!.evidence }, { ...args, evidenceReference: previous!.evidenceReference },
      ]) expect((await tools.execute("confirm_quote_naturally", invalid)).status).toBe("rejected");
      return "Necesito una confirmación vinculada a esta propuesta.";
    });
    expect(await h.appointments()).toHaveLength(0);
  });
  test("undelivered and same-message quotes expose no natural confirmation binding", async () => {
    const h = await fixture();
    const fabricated = { evidence: "dale reservame ese", evidenceReference: "a".repeat(64), quoteFingerprint: "b".repeat(64) };
    const prepared = await h.run(fabricated.evidence, async tools => {
      expect(tools.context.naturalConfirmation).toBeNull();
      await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      expect((await tools.execute("confirm_quote_naturally", fabricated)).status).toBe("clarification");
      return "Primero te paso los detalles.";
    });
    await h.run(fabricated.evidence, async tools => {
      expect(tools.context.naturalConfirmation).toBeNull();
      expect((await tools.execute("confirm_quote_naturally", fabricated)).status).toBe("clarification");
      return "Necesitás recibir la propuesta.";
    });
    if (prepared.status !== "committed") throw new Error("Missing quote");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    const job = await h.receive(fabricated.evidence, false);
    const result = await h.agenda.withReceptionistSession(job, async tools => {
      expect(tools.context.naturalConfirmation).toBeNull();
      expect(await tools.execute("confirm_quote_naturally", fabricated)).toEqual({ status: "rejected", code: "UNVERIFIED_SENDER" });
      return "No pude verificar tu número.";
    });
    expect(result.status).toBe("committed");
    expect(await h.appointments()).toHaveLength(0);
  });
  test("binding cannot confirm a replacement quote or a quote from another tenant", async () => {
    const h = await fixture(), other = await fixture();
    await prepareNatural(h);
    await prepareNatural(other);
    let otherBinding: ReturnType<typeof naturalArguments>;
    await other.run("dale", async tools => { otherBinding = naturalArguments(tools); return "¿Lo reservamos?"; });
    await h.run("dale reservame ese", async tools => {
      const args = naturalArguments(tools);
      expect((await tools.execute("confirm_quote_naturally", { ...args, quoteFingerprint: otherBinding!.quoteFingerprint })).status).toBe("rejected");
      await tools.execute("prepare_booking", { serviceId: h.service, startsAt: "2035-04-02T11:00:00-03:00" });
      expect((await tools.execute("confirm_quote_naturally", args)).status).toBe("rejected");
      return "Te paso la nueva propuesta, que requiere otra confirmación.";
    });
    expect(await h.appointments()).toHaveLength(0);
  });
  test("changed live terms require a fresh quote and binding, not a saved booking", async () => {
    const h = await fixture();
    await prepareNatural(h);
    await db.sql`update services set price_ars=2500 where id=${h.service}`;
    let oldFingerprint: string;
    const fresh = await h.run("dale reservame ese", async tools => {
      const args = naturalArguments(tools);
      oldFingerprint = args.quoteFingerprint;
      const result = await tools.execute("confirm_quote_naturally", args);
      expect(result.status).toBe("prepared_quote");
      if (result.status === "prepared_quote") expect(result.quote).toHaveProperty("terms.priceArs", 2500);
      expect((await tools.execute("confirm_quote_naturally", args)).status).toBe("rejected");
      return "Cambiaron las condiciones: necesitás aceptar el detalle actualizado.";
    });
    expect(await h.appointments()).toHaveLength(0);
    if (fresh.status !== "committed") throw new Error("Missing refreshed quote");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${fresh.outboundId}`;
    await h.run("dale reservame ese", async tools => {
      const args = naturalArguments(tools);
      expect(args.quoteFingerprint).not.toBe(oldFingerprint!);
      expect((await tools.execute("confirm_quote_naturally", { ...args, quoteFingerprint: oldFingerprint! })).status).toBe("rejected");
      expect((await tools.execute("confirm_quote_naturally", args)).status).toBe("staged_action");
      expect((await tools.execute("confirm_quote_naturally", args)).status).toBe("rejected");
      return "Reserva guardada.";
    });
    expect((await h.appointments())[0]!.terms.priceArs).toBe(2500);
  });
  test("natural change confirmation rechecks current ownership", async () => {
    const h = await fixture();
    const appointment = await pools.api.run(h.context, async repo => {
      const client = await repo.findClientByCanonicalPhone(phone);
      return repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource, startRaw: start, clientId: client!.id }, { now: "2035-04-01T08:00:00-03:00", origin: "manual" });
    });
    const prepared = await h.run("más tarde", async tools => {
      await tools.execute("prepare_change", { appointmentId: appointment.id, startsAt: "2035-04-02T11:00:00-03:00" });
      return "Propuesta de cambio.";
    });
    if (prepared.status !== "committed") throw new Error("Missing change quote");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    await db.sql`update clients set phone='+14155552671' where business_id=${h.business}`;
    await h.run("dale cambialo", async tools => {
      expect((await tools.execute("confirm_quote_naturally", naturalArguments(tools))).status).toBe("rejected");
      return "No pude verificar ese turno con tu número.";
    });
    expect((await h.appointments())[0]!.startsAt).toBe(start);
  });
  test("capacity loss cannot be overridden by natural confirmation", async () => {
    const h = await fixture();
    await prepareNatural(h);
    await pools.api.run(h.context, async repo => {
      const client = await repo.findClientByCanonicalPhone(phone);
      await repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource, startRaw: start, clientId: client!.id }, { now: "2035-04-01T08:00:00-03:00", origin: "manual" });
    });
    await h.run("dale reservame ese", async tools => {
      expect((await tools.execute("confirm_quote_naturally", naturalArguments(tools))).status).toBe("clarification");
      return "Ese horario ya no está disponible.";
    });
    expect(await h.appointments()).toHaveLength(1);
  });
  test("natural effects and output roll back on receipt failure, then retry only once", async () => {
    const h = await fixture();
    await prepareNatural(h);
    await db.sql`insert into public.receptionist_fault_fixture(business_id,enabled) values(${h.business},true)`;
    const job = await h.receive("dale reservame ese");
    let staged: ReceptionistToolResult | undefined;
    const callback = async (tools: ReceptionistToolSession) => {
      staged = await tools.execute("confirm_quote_naturally", naturalArguments(tools));
      return "Reservado.";
    };
    expect((await h.agenda.withReceptionistSession(job, callback)).status).toBe("infrastructure_failure");
    expect(staged?.status).toBe("staged_action");
    expect(await h.appointments()).toHaveLength(0);
    const [counts] = await db.sql`select
      (select count(*)::int from outbound_commands where source_message_id=${job.messageId}) outputs,
      (select count(*)::int from whatsapp_agenda_receipts where message_id=${job.messageId}) receipts,
      (select count(*)::int from outbox_events where business_id=${h.business} and topic='appointment.changed') effects`;
    expect(counts).toEqual({ outputs: 0, receipts: 0, effects: 0 });
    await db.sql`update public.receptionist_fault_fixture set enabled=false where business_id=${h.business}`;
    expect((await h.agenda.withReceptionistSession(job, callback)).status).toBe("committed");
    expect((await h.agenda.withReceptionistSession(job, async () => { throw new Error("Retry must not run"); })).status).toBe("not_current");
    expect(await h.appointments()).toHaveLength(1);
  });
});
async function savedAppointment(h: Awaited<ReturnType<typeof fixture>>, startsAt = start) {
  return pools.api.run(h.context, async repo => {
    const client = await repo.findClientByCanonicalPhone(phone);
    return repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource, startRaw: startsAt,
      ...(client ? { clientId: client.id } : { newClient: { firstName: "María", lastName: "Pérez", phone } }) },
      { now: "2035-04-01T08:00:00-03:00", origin: "manual" });
  });
}
async function cancellationArguments(tools: ReceptionistToolSession, appointmentId: string) {
  const current = data(await tools.execute("owned_appointment", { appointmentId })) as { cancellationReference: string };
  expect(current.cancellationReference).toMatch(/^[a-f0-9]{64}$/u);
  return { appointmentId, binding: { evidence: tools.context.message, evidenceReference: current.cancellationReference } };
}
async function cancellationEffects(messageId: string) {
  const [counts] = await db.sql`select
    (select count(*)::int from outbound_commands where source_message_id=${messageId}) outputs,
    (select count(*)::int from whatsapp_agenda_receipts where message_id=${messageId} and operation='cancel') receipts,
    (select count(*)::int from outbox_events where topic='appointment.changed' and payload->>'sourceMessageId'=${messageId}) effects`;
  return counts;
}
describe("current-read bound native cancellation (not semantic consent attestation)", () => {
  for (const text of ["quería cancelar mi turno", "sí quiero cancelar", "que me canceles el turno", "Hola, necesito que me canceles el turno", "sí, ese por favor"]) {
    test(`authentic interpreted request cancels without a redundant prompt: ${text}`, async () => {
      const h = await fixture();
      const appointment = await savedAppointment(h);
      // The affirmative case has an actual prior question; the double supplies interpretation, not evidence of LLM understanding.
      if (text === "sí, ese por favor") await h.run("¿mi turno?", async tools => {
        data(await tools.execute("owned_appointment", { appointmentId: appointment.id }));
        return JSON.stringify({ kind: "informational_prose", text: "¿Querés cancelar ese turno?" });
      });
      const job = await h.receive(text);
      const result = await h.agenda.withReceptionistSession(job, async tools => {
        const args = await cancellationArguments(tools, appointment.id);
        expect((await tools.execute("cancel", args)).status).toBe("staged_action");
        expect((await tools.execute("cancel", args)).status).toBe("rejected");
        return JSON.stringify({ kind: "informational_prose", text: "No se guardó nada." });
      });
      expect(result.status).toBe("committed");
      if (result.status !== "committed") throw new Error("Missing cancellation");
      expect(result.actions).toEqual([{ operation: "cancel", appointmentId: appointment.id }]);
      expect(await h.appointments()).toEqual([{ ...appointment, state: "cancelled" }]);
      const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
      expect(output!.text).toBe(`Cancelación guardada. Turno ${appointment.id}.`);
      expect(await cancellationEffects(job.messageId)).toEqual({ outputs: 1, receipts: 1, effects: 1 });
      expect((await h.agenda.withReceptionistSession(job, async () => "unused")).status).toBe("not_current");
    });
  }
  for (const native of [true, false]) test(`selected cancel bypasses pending names; native=${native}`, async () => {
    const h = await fixture(true, false);
    await h.run("ese horario", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("clarification");
      return '{"kind":"reply"}';
    });
    const appointment = await savedAppointment(h, "2035-04-02T11:00:00-03:00");
    await h.run(native ? "quería cancelar mi turno" : "cancelar mi turno", async tools => {
      expect((tools.context.pending as any).awaitingNames).toBe(true);
      const args = native ? await cancellationArguments(tools, appointment.id) : { appointmentId: appointment.id };
      expect((await tools.execute("cancel", args)).status).toBe("staged_action");
      return '{"kind":"reply"}';
    });
    expect((await h.appointments())[0]!.state).toBe("cancelled");
  });
  test("selected contextual cancellation cannot be consumed as acceptance of an unrelated delivered quote", async () => {
    const h = await fixture();
    const appointment = await savedAppointment(h, "2035-04-02T11:00:00-03:00");
    await prepareNatural(h);
    await h.run("sí", async tools => {
      expect(tools.context.naturalConfirmation).not.toBeNull();
      expect((await tools.execute("cancel", await cancellationArguments(tools, appointment.id))).status).toBe("staged_action");
      return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([{ ...appointment, state: "cancelled" }]);
  });
  test("rejects missing, partial, forged, previous inbound and cross-owned-target references without effects", async () => {
    const h = await fixture();
    const first = await savedAppointment(h), second = await savedAppointment(h, "2035-04-02T11:00:00-03:00");
    let old: Awaited<ReturnType<typeof cancellationArguments>>;
    await h.run("quería cancelar mi turno", async tools => { old = await cancellationArguments(tools, first.id); return '{"kind":"reply"}'; });
    const job = await h.receive("quería cancelar mi turno");
    expect((await h.agenda.withReceptionistSession(job, async tools => {
      const args = await cancellationArguments(tools, first.id);
      await cancellationArguments(tools, second.id); // Even another freshly inspected OWNED target cannot reuse the first reference.
      for (const invalid of [{ appointmentId: first.id }, { ...args, binding: {} },
        { ...args, binding: { evidence: args.binding.evidence } }, old!,
        { ...args, binding: { ...args.binding, evidence: "cancelar" } },
        { ...args, binding: { ...args.binding, evidenceReference: "f".repeat(64) } },
        { ...args, appointmentId: second.id }]) expect((await tools.execute("cancel", invalid)).status).toBe("rejected");
      return '{"kind":"reply"}';
    })).status).toBe("committed");
    expect(await h.appointments()).toEqual([first, second]);
    expect(await cancellationEffects(job.messageId)).toEqual({ outputs: 1, receipts: 0, effects: 0 });
  });
  test("old references cannot cross sender, tenant/connection or unverified source", async () => {
    const h = await fixture(), other = await fixture();
    const appointment = await savedAppointment(h);
    let args: Awaited<ReturnType<typeof cancellationArguments>>;
    await h.run("quería cancelar mi turno", async tools => { args = await cancellationArguments(tools, appointment.id); return '{"kind":"reply"}'; });
    // The schema permits one connection per business; the other tenant also supplies a distinct connection.
    for (const [owner, sender, trusted] of [[h, "14155552671", true],
      [other, "5491123456789", true], [h, "5491123456789", false]] as const) {
      const job = await owner.receive(args!.binding.evidence, trusted, sender);
      expect((await owner.agenda.withReceptionistSession(job, async tools => {
        expect((await tools.execute("cancel", args!)).status).toBe("rejected");
        return '{"kind":"reply"}';
      })).status).toBe("committed");
      expect(await cancellationEffects(job.messageId)).toEqual({ outputs: 1, receipts: 0, effects: 0 });
    }
    expect(await h.appointments()).toEqual([appointment]);
  });
  for (const change of ["snapshot", "terminal", "ownership", "already-terminal"] as const) test(`fresh read is revalidated after ${change} changes`, async () => {
    const h = await fixture();
    const appointment = await savedAppointment(h);
    const job = await h.receive("quería cancelar mi turno");
    expect((await h.agenda.withReceptionistSession(job, async tools => {
      if (change === "already-terminal") await db.sql`update appointments set state='cancelled' where id=${appointment.id}`;
      const args = await cancellationArguments(tools, appointment.id);
      if (change === "snapshot") await db.sql`update appointments set notes='Actualizada' where id=${appointment.id}`;
      if (change === "terminal") await db.sql`update appointments set state='cancelled' where id=${appointment.id}`;
      if (change === "ownership") await db.sql`update clients set phone='+14155552671' where business_id=${h.business}`;
      expect((await tools.execute("cancel", args)).status).toBe("rejected");
      return '{"kind":"reply"}';
    })).status).toBe("committed");
    const [current] = await h.appointments();
    expect(current!.state).toBe(change === "terminal" || change === "already-terminal" ? "cancelled" : "confirmed");
    expect(await cancellationEffects(job.messageId)).toEqual({ outputs: 1, receipts: 0, effects: 0 });
  });
  test("receipt failure rolls cancellation and dialogue back; exact retry commits only once", async () => {
    const h = await fixture();
    const appointment = await savedAppointment(h, "2035-04-02T11:00:00-03:00");
    await prepareNatural(h);
    await db.sql`insert into public.receptionist_fault_fixture(business_id,enabled) values(${h.business},true)`;
    const job = await h.receive("quería cancelar mi turno");
    let pending: unknown, staged: ReceptionistToolResult | undefined;
    const callback = async (tools: ReceptionistToolSession) => {
      if (pending) expect(tools.context.pending).toEqual(pending);
      pending = tools.context.pending;
      staged = await tools.execute("cancel", await cancellationArguments(tools, appointment.id));
      return '{"kind":"reply"}';
    };
    expect((await h.agenda.withReceptionistSession(job, callback)).status).toBe("infrastructure_failure");
    expect(staged!.status).toBe("staged_action");
    expect(await h.appointments()).toEqual([appointment]);
    expect(await cancellationEffects(job.messageId)).toEqual({ outputs: 0, receipts: 0, effects: 0 });
    await db.sql`update public.receptionist_fault_fixture set enabled=false where business_id=${h.business}`;
    expect((await h.agenda.withReceptionistSession(job, callback)).status).toBe("committed");
    expect((await h.agenda.withReceptionistSession(job, callback)).status).toBe("not_current");
    expect(await cancellationEffects(job.messageId)).toEqual({ outputs: 1, receipts: 1, effects: 1 });
    expect((await h.appointments())[0]!.state).toBe("cancelled");
  });
});
const nameField = (messageId: string, value: string, start = 0) => ({ messageId, value, start });
const nameRuntime = (tools: ReceptionistToolSession) => tools.context as typeof tools.context & {
  namesReference: string | null; nameSources: { messageId: string; text: string }[];
};
async function pendingNames(h: Awaited<ReturnType<typeof fixture>>) {
  return h.run("ese horario", async tools => {
    const result = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
    expect(result.status).toBe("clarification");
    expect((result as any).namesReference).toMatch(/^[a-f0-9]{64}$/u);
    return '{"kind":"reply"}';
  });
}
describe("native booking names: provenance enforcement, not semantic name ownership", () => {
  test("bare full names prepare only; delivered later acceptance creates the literal client", async () => {
    const h = await fixture(true, false);
    await pendingNames(h);
    const quote = await h.run("María Pérez", async tools => {
      const runtime = nameRuntime(tools), current = runtime.nameSources.at(-1)!;
      const result = await tools.execute("collect_booking_names", { namesReference: runtime.namesReference,
        firstName: nameField(current.messageId, "María"), lastName: nameField(current.messageId, "Pérez", 6) });
      expect(result.status).toBe("prepared_quote");
      expect((await tools.execute("confirm_quote", {})).status).not.toBe("staged_action");
      return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toHaveLength(0);
    const [before] = await db.sql`select count(*)::int count from clients where business_id=${h.business}`;
    expect(before!.count).toBe(0);
    if (quote.status !== "committed") throw new Error("Missing quote");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${quote.outboundId}`;
    await h.run("confirmo", async tools => { expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action"); return '{"kind":"reply"}'; });
    expect((await h.appointments())[0]!.client).toMatchObject({ firstName: "María", lastName: "Pérez", phone });
  });
  test("authenticated earlier group names are available when the latest fragment asks availability", async () => {
    const h = await fixture(true, false);
    const earlier = await h.receive("María Pérez");
    await h.run("¿tenés lugar?", async tools => {
      const runtime = nameRuntime(tools);
      expect(runtime.nameSources).toContainEqual({ messageId: earlier.messageId, text: "María Pérez" });
      expect(JSON.stringify(tools.context.messages)).toContain(earlier.messageId);
      const draft = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      expect((await tools.execute("collect_booking_names", { namesReference: (draft as any).namesReference,
        firstName: nameField(earlier.messageId, "María"), lastName: nameField(earlier.messageId, "Pérez", 6) })).status).toBe("prepared_quote");
      return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toHaveLength(0);
  });
  test("partial fields survive reload and alternatives; surname correction retains the given name", async () => {
    const h = await fixture(true, false);
    await pendingNames(h);
    for (const [value, field, expected] of [["María", "firstName", "Decime tu apellido."],
      ["Pérez", "lastName", null], ["Gómez", "lastName", null]] as const) {
      await h.run(value, async tools => {
        const runtime = nameRuntime(tools), current = runtime.nameSources.at(-1)!;
        if (field === "lastName") expect((tools.context.pending as any).bookingNameFields.firstName).toBe("María");
        const reference = value === "Pérez"
          ? (await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).namesReference : runtime.namesReference;
        const result = await tools.execute("collect_booking_names", { namesReference: reference, [field]: nameField(current.messageId, value) });
        expect(result.status).toBe(expected ? "clarification" : "prepared_quote");
        if (expected) expect((result as any).message).toBe(expected);
        else expect((result as any).quote.names).toEqual({ firstName: "María", lastName: value });
        // An unavailable selection returns alternatives without losing the partial name.
        if (value === "María") expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: "2035-04-02T23:00:00-03:00" })).status).toBe("clarification");
        return '{"kind":"reply"}';
      });
    }
    await h.run("otro horario", async tools => {
      const result = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: "2035-04-02T11:00:00-03:00" });
      expect((result as any).quote.names).toEqual({ firstName: "María", lastName: "Gómez" });
      await tools.execute("clear_pending", {});
      return '{"kind":"reply"}';
    });
    await h.run("¿y ahora?", async tools => { expect(tools.context.pending).toEqual({ quote: null, awaitingNames: false }); expect(nameRuntime(tools).namesReference).toBeNull(); return '{"kind":"reply"}'; });
  });
  for (const accepts of [false, true]) test(`identical names preserve delivered quote authority; later acceptance=${accepts}`, async () => {
    const h = await fixture(true, false);
    const original = await h.run("mi nombre es María Pérez", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("prepared_quote");
      return '{"kind":"reply"}';
    });
    if (original.status !== "committed") throw new Error("Missing original");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${original.outboundId}`;
    let previousQuote: unknown;
    const repeated = await h.run(accepts ? "María Pérez, confirmo" : "María Pérez", async tools => {
      previousQuote = structuredClone((tools.context.pending as any).quote);
      const runtime = nameRuntime(tools), current = runtime.nameSources.at(-1)!, consent = naturalArguments(tools);
      const result = await tools.execute("collect_booking_names", { namesReference: runtime.namesReference,
        firstName: nameField(current.messageId, "María"), lastName: nameField(current.messageId, "Pérez", 6) });
      // This double supplies interpretation; repeated names themselves are never consent.
      if (accepts) expect(await tools.execute("confirm_quote_naturally", consent)).toMatchObject({ status: "staged_action" });
      expect(result.status).toBe("data");
      return JSON.stringify({ kind: "informational_prose", text: "Gracias, ya tengo tu nombre y apellido." });
    });
    if (repeated.status !== "committed") throw new Error("Missing repeat reply");
    expect(repeated.actions).toHaveLength(accepts ? 1 : 0);
    expect(await h.appointments()).toHaveLength(accepts ? 1 : 0);
    const [clientCount] = await db.sql`select count(*)::int count from clients where business_id=${h.business}`;
    expect(clientCount!.count).toBe(accepts ? 1 : 0);
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${repeated.outboundId}`;
    expect(output!.text).not.toContain("Reserva propuesta");
    if (accepts) expect(output!.text).toStartWith("Guardado:");
    else {
      const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
      expect(pending!.dialogue.quote).toEqual(previousQuote);
      expect(pending!.dialogue.quote.outboundId).toBe(original.outboundId);
      expect(output!.text).toBe("Gracias, ya tengo tu nombre y apellido.");
    }
  });
  for (const [field, value, prompt] of [["firstName", "María", "Decime tu apellido."],
    ["lastName", "Pérez", "Decime tu nombre."]] as const) test(`unchanged partial ${field} asks only for the missing field and clears cleanly`, async () => {
    const h = await fixture(true, false);
    await pendingNames(h);
    await h.run(value, async tools => {
      const runtime = nameRuntime(tools), current = runtime.nameSources.at(-1)!;
      expect(await tools.execute("collect_booking_names", { namesReference: runtime.namesReference, [field]: nameField(current.messageId, value) }))
        .toMatchObject({ status: "clarification", message: prompt });
      return '{"kind":"reply"}';
    });
    let previous: unknown;
    const repeated = await h.run(value, async tools => {
      previous = structuredClone(tools.context.pending);
      const runtime = nameRuntime(tools), current = runtime.nameSources.at(-1)!;
      expect(await tools.execute("collect_booking_names", { namesReference: runtime.namesReference, [field]: nameField(current.messageId, value) }))
        .toMatchObject({ status: "clarification", message: prompt });
      return '{"kind":"reply"}';
    });
    if (repeated.status !== "committed") throw new Error("Missing partial repeat");
    const [pending] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${repeated.outboundId}`;
    expect(pending!.dialogue).toEqual(previous);
    expect(output!.text).toBe(prompt);
    expect(await h.appointments()).toHaveLength(0);
    await h.run("dejalo", async tools => { await tools.execute("clear_pending", {}); return '{"kind":"reply"}'; });
    await h.run("¿qué quedó?", async tools => { expect(tools.context.pending).toEqual({ quote: null, awaitingNames: false }); return '{"kind":"reply"}'; });
  });
  test("corrected delivered names invalidate old references, quote consent and delivery", async () => {
    const h = await fixture(true, false);
    const original = await h.run("mi nombre es María Pérez", async tools => { await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start }); return '{"kind":"reply"}'; });
    if (original.status !== "committed") throw new Error("Missing original");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${original.outboundId}`;
    const corrected = await h.run("Gómez", async tools => {
      const runtime = nameRuntime(tools), current = runtime.nameSources.at(-1)!, consent = naturalArguments(tools);
      const args = { namesReference: runtime.namesReference, lastName: nameField(current.messageId, "Gómez") };
      const result = await tools.execute("collect_booking_names", args);
      expect((result as any).quote).toMatchObject({ names: { firstName: "María", lastName: "Gómez" }, outboundId: null, sourceMessageId: current.messageId });
      expect((result as any).namesReference).not.toBe(args.namesReference);
      expect((await tools.execute("collect_booking_names", args)).status).toBe("rejected");
      expect((await tools.execute("confirm_quote_naturally", consent)).status).toBe("rejected");
      expect((await tools.execute("confirm_quote", {})).status).not.toBe("staged_action");
      return '{"kind":"reply"}';
    });
    const refreshed = await h.run("confirmo", async tools => { expect((await tools.execute("confirm_quote", {})).status).toBe("prepared_quote"); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toHaveLength(0);
    if (corrected.status !== "committed" || refreshed.status !== "committed") throw new Error("Missing correction");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${refreshed.outboundId}`;
    await h.run("confirmo", async tools => { expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action"); return '{"kind":"reply"}'; });
    expect((await h.appointments())[0]!.client.lastName).toBe("Gómez");
  });
  test("invalid draft references, spans and untrusted group members cannot modify fields", async () => {
    const h = await fixture(true, false), other = await fixture(true, false);
    await pendingNames(h);
    const untrusted = await h.receive("María", false), foreign = await other.receive("María");
    let foreignReference: unknown;
    await other.run("María", async tools => {
      foreignReference = (await tools.execute("prepare_booking", { serviceId: other.service, startsAt: start })).namesReference;
      return '{"kind":"reply"}';
    });
    await h.run("María", async tools => {
      const runtime = nameRuntime(tools), current = runtime.nameSources.at(-1)!;
      expect(runtime.nameSources.some(row => row.messageId === untrusted.messageId)).toBe(false);
      const patch = { namesReference: runtime.namesReference, firstName: nameField(current.messageId, "María") };
      for (const invalid of [{ firstName: patch.firstName }, { ...patch, namesReference: "f".repeat(64) },
        { ...patch, namesReference: foreignReference }, { ...patch, lastName: nameField(foreign.messageId, "María") },
        { ...patch, firstName: nameField(untrusted.messageId, "María") }, { ...patch, firstName: nameField(foreign.messageId, "María") },
        { ...patch, firstName: nameField(current.messageId, "Inventada") }, { ...patch, firstName: nameField(current.messageId, "María", 1) }])
        expect((await tools.execute("collect_booking_names", invalid)).status).toBe("rejected");
      await tools.execute("clear_pending", {});
      expect((await tools.execute("collect_booking_names", patch)).status).toBe("rejected");
      return '{"kind":"reply"}';
    });
    await h.run("¿qué quedó?", async tools => { expect(tools.context.pending).toEqual({ quote: null, awaitingNames: false }); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toHaveLength(0);
    const job = await h.receive("María", false);
    expect((await h.agenda.withReceptionistSession(job, async tools => {
      expect(nameRuntime(tools).namesReference).toBeNull();
      expect((await tools.execute("collect_booking_names", { namesReference: "a".repeat(64), firstName: nameField(job.messageId, "María") })).status).toBe("rejected");
      return '{"kind":"reply"}';
    })).status).toBe("committed");
  });
  test("history and identical previous-inbound references cannot become current name evidence", async () => {
    const h = await fixture(true, false);
    const historical = await h.receive("María");
    const prepared = await pendingNames(h);
    if (prepared.status !== "committed") throw new Error("Missing draft");
    await db.sql`update outbound_commands set state='sent',send_started_at=now(),acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    let oldReference: string | null | undefined;
    await h.run("María", async tools => { oldReference = nameRuntime(tools).namesReference; return '{"kind":"reply"}'; });
    await h.run("María", async tools => {
      const runtime = nameRuntime(tools), current = runtime.nameSources.at(-1)!;
      expect(runtime.nameSources.some(row => row.messageId === historical.messageId)).toBe(false);
      const args = { namesReference: runtime.namesReference, firstName: nameField(current.messageId, "María") };
      expect((await tools.execute("collect_booking_names", { ...args, firstName: nameField(historical.messageId, "María") })).status).toBe("rejected");
      expect((await tools.execute("collect_booking_names", { ...args, namesReference: oldReference })).status).toBe("rejected");
      const replaced = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      expect(replaced.namesReference).not.toBe(args.namesReference);
      expect((await tools.execute("collect_booking_names", args)).status).toBe("rejected");
      return '{"kind":"reply"}';
    });
    await h.run("sin nombres", async tools => { expect((tools.context.pending as any).bookingNameFields).toBeUndefined(); return '{"kind":"reply"}'; });
    expect(await h.appointments()).toHaveLength(0);
  });
  test("each published member's sender is revalidated when applying its field", async () => {
    const h = await fixture(true, false), earlier = await h.receive("María");
    await pendingNames(h);
    await h.receive("Otro mensaje", true, "14155552671"); // Establish a real fixture binding before reassigning the earlier row.
    await h.run("mi apellido es Pérez", async tools => {
      const runtime = nameRuntime(tools);
      expect(runtime.nameSources.some(row => row.messageId === earlier.messageId)).toBe(true);
      await db.sql`update whatsapp_received_senders set phone='+14155552671' where message_id=${earlier.messageId}`;
      expect((await tools.execute("collect_booking_names", { namesReference: runtime.namesReference,
        firstName: nameField(earlier.messageId, "María") })).status).toBe("rejected");
      return '{"kind":"reply"}';
    });
  });
  test("registered client identity is authoritative and exposes no names capability", async () => {
    const h = await fixture();
    await h.run("Otro Nombre", async tools => {
      const result = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      expect((result as any).namesReference).toBeNull();
      expect((await tools.execute("collect_booking_names", { namesReference: "a".repeat(64), firstName: nameField(randomUUID(), "Otro") })).status).toBe("rejected");
      return '{"kind":"reply"}';
    });
    const [client] = await db.sql`select first_name,last_name from clients where business_id=${h.business}`;
    expect(client).toEqual({ first_name: "María", last_name: "Pérez" });
  });
});
async function metadataArguments(tools: ReceptionistToolSession, appointmentId: string, operation: "notes" | "preference", value: string | null,
  messageId = tools.context.nameSources!.at(-1)!.messageId) {
  const owned = data(await tools.execute("owned_appointment", { appointmentId })) as Record<string, string>;
  expect(owned[`${operation}Reference`]).toMatch(/^[a-f0-9]{64}$/u);
  const member = tools.context.nameSources!.find(row => row.messageId === messageId)!;
  const binding: { evidenceReference: string; messageId: string; evidence: string; start?: number; resourceReference?: string } = {
    evidenceReference: owned[`${operation}Reference`]!, messageId, evidence: member.text,
  };
  if (value !== null && operation === "notes") binding.start = member.text.indexOf(value);
  if (value !== null && operation === "preference") {
    const resources = data(await tools.execute("read_resources", {})) as { items: { id: string; resourceReference: string }[] };
    binding.resourceReference = resources.items.find(row => row.id === value)!.resourceReference;
    expect(binding.resourceReference).toMatch(/^[a-f0-9]{64}$/u);
  }
  return { appointmentId, ...(operation === "notes" ? { notes: value } : { resourceId: value }), binding };
}
describe("native metadata: authentic provenance, not semantic request attestation", () => {
  for (const operation of ["notes", "preference"] as const) for (const clear of [false, true]) {
    test(`natural ${operation} ${clear ? "clear" : "replace"} changes only metadata`, async () => {
      const h = await fixture(), ap = await savedAppointment(h), alternative = randomUUID();
      await db.sql`insert into resources(id,business_id,name,weekly_schedule)
        select ${alternative},${h.business},'Beatriz',weekly_schedule from resources where id=${h.resource}`;
      await db.sql`update appointments set notes='Anterior',customer_resource_preference_id=${h.resource} where id=${ap.id}`;
      const [before] = await h.appointments(), literal = "  café ☕  sin azúcar 👩🏽‍🦱\n";
      const value = clear ? null : operation === "notes" ? literal : alternative;
      const text = clear ? "Sacá lo que te había pedido" : operation === "notes" ? `Dejame esto anotado: ${literal}` : "Me gustaría que figure Beatriz como preferencia";
      const result = await h.run(text, async tools => {
        const args = await metadataArguments(tools, ap.id, operation, value);
        expect((await tools.execute(operation, args)).status).toBe("staged_action");
        expect((await tools.execute(operation, args)).status).toBe("rejected");
        return '{"kind":"informational_prose","text":"No se guardó nada."}';
      });
      expect(await h.appointments()).toEqual([{ ...before!, [operation === "notes" ? "notes" : "customerResourcePreference"]: value }]);
      if (result.status !== "committed") throw new Error("Missing metadata reply");
      const [output] = await db.sql`select text from outbound_commands where outbound_id=${result.outboundId}`;
      expect(output!.text).toBe(operation === "notes" ? "Nota guardada." : "Preferencia guardada. No cambia la asignación ni garantiza disponibilidad.");
      expect(result.actions).toEqual([{ operation, appointmentId: ap.id }]);
    });
  }
  test("an earlier authenticated group member can supply a literal note", async () => {
    const h = await fixture(), ap = await savedAppointment(h);
    const earlier = await h.receive("Por favor dejá escrito: acceso por la rampa ♿");
    await h.run("y avisame por acá", async tools => {
      expect((await tools.execute("notes", await metadataArguments(tools, ap.id, "notes", "acceso por la rampa ♿", earlier.messageId))).status).toBe("staged_action");
      return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([{ ...ap, notes: "acceso por la rampa ♿" }]);
  });
  for (const operation of ["notes", "preference"] as const) test(`${operation} rejects invalid bindings even on legacy-valid text`, async () => {
    const h = await fixture(), ap = await savedAppointment(h), second = await savedAppointment(h, "2035-04-02T11:00:00-03:00"), alternative = randomUUID();
    await db.sql`insert into resources(id,business_id,name,weekly_schedule) select ${alternative},${h.business},'Beatriz',weekly_schedule from resources where id=${h.resource}`;
    const text = operation === "notes" ? "nota: café ☕" : "prefiero Ana", value = operation === "notes" ? "café ☕" : h.resource;
    let old: Awaited<ReturnType<typeof metadataArguments>>, foreignResourceReference: string;
    await h.run(text, async tools => { old = await metadataArguments(tools, ap.id, operation, value); return '{"kind":"reply"}'; });
    if (operation === "preference") {
      const other = await fixture();
      await other.run(text, async tools => { foreignResourceReference = (data(await tools.execute("read_resources", {})) as any).items[0].resourceReference; return '{"kind":"reply"}'; });
    }
    const result = await h.run(text, async tools => {
      const args = await metadataArguments(tools, ap.id, operation, value), binding = args.binding;
      const current = data(await tools.execute("owned_appointment", { appointmentId: ap.id })) as Record<string, string>;
      data(await tools.execute("owned_appointment", { appointmentId: second.id }));
      for (const invalid of [{ ...args, binding: {} }, { ...args, binding: { evidence: text } },
        { ...args, binding: { ...binding, evidenceReference: "f".repeat(64) } },
        { ...args, binding: { ...binding, evidenceReference: current[operation === "notes" ? "preferenceReference" : "notesReference"] } },
        { ...args, binding: { ...binding, evidenceReference: current.cancellationReference } }, old!, { ...args, appointmentId: second.id },
        { ...args, binding: { ...binding, evidence: text + " inventado" } },
        operation === "notes" ? { ...args, notes: "Inventada" } : { ...args, resourceId: alternative },
        operation === "notes" ? { ...args, binding: { ...binding, start: binding.start! + 1 } } : { ...args, binding: { ...binding, resourceReference: foreignResourceReference! } },
        operation === "notes" ? { ...args, notes: "\u0000" } : { ...args, binding: { ...binding, resourceReference: "f".repeat(64) } }])
        expect((await tools.execute(operation, invalid)).status).toBe("rejected");
      return '{"kind":"reply"}';
    });
    if (result.status === "committed") expect(result.actions).toEqual([]);
    expect(await h.appointments()).toEqual([ap, second]);
    const [effects] = await db.sql`select count(*)::int count from outbox_events where business_id=${h.business} and topic='appointment.changed'`;
    expect(effects!.count).toBe(0);
    for (const trusted of [false, true]) {
      const job = await h.receive(text, trusted, trusted ? "14155552671" : "5491123456789");
      expect((await h.agenda.withReceptionistSession(job, async tools => {
        expect((await tools.execute(operation, old!)).status).toBe("rejected"); return '{"kind":"reply"}';
      })).status).toBe("committed");
    }
    expect(await h.appointments()).toEqual([ap, second]);
  });
  for (const origin of ["foreign", "untrusted", "history", "reassigned"] as const) test(`note evidence rejects ${origin} group members`, async () => {
    const h = await fixture(), ap = await savedAppointment(h), text = "nota: rampa";
    const sourceOwner = origin === "foreign" ? await fixture() : h;
    const member = await sourceOwner.receive(text, origin !== "untrusted");
    if (origin === "history") {
      const closed = await h.run("hola", async () => '{"kind":"reply"}');
      if (closed.status === "committed") await db.sql`update outbound_commands set state='sent',send_started_at=now(),acknowledged_at=now() where outbound_id=${closed.outboundId}`;
    }
    if (origin === "reassigned") await h.receive("Hola", true, "14155552671");
    await h.run(text, async tools => {
      const args = await metadataArguments(tools, ap.id, "notes", "rampa");
      if (origin === "reassigned") await db.sql`update whatsapp_received_senders set phone='+14155552671' where message_id=${member.messageId}`;
      expect((await tools.execute("notes", { ...args, binding: { ...args.binding, messageId: member.messageId, evidence: text } })).status).toBe("rejected");
      return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([ap]);
  });
  for (const operation of ["notes", "preference"] as const) for (const change of ["notes", "preference", "start", "ownership", "resource_name", "resource_status"] as const) {
    if (operation === "notes" && change.startsWith("resource_")) continue;
    test(`${operation} revalidates ${change} after inspection`, async () => {
      const h = await fixture(), ap = await savedAppointment(h);
      let expected: Awaited<ReturnType<typeof h.appointments>>;
      await h.run("Anotá rampa y mi preferencia por Ana", async tools => {
        const args = await metadataArguments(tools, ap.id, operation, operation === "notes" ? "rampa" : h.resource);
        if (change === "notes") await db.sql`update appointments set notes='Externa' where id=${ap.id}`;
        if (change === "preference") await db.sql`update appointments set customer_resource_preference_id=${h.resource} where id=${ap.id}`;
        if (change === "start") await db.sql`update appointments set start_raw='2035-04-02T11:00:00-03:00',start_ms=${Date.parse("2035-04-02T11:00:00-03:00")},end_ms=${Date.parse("2035-04-02T11:30:00-03:00")} where id=${ap.id}`;
        if (change === "ownership") await db.sql`update clients set phone='+14155552671' where business_id=${h.business}`;
        if (change === "resource_name") await db.sql`update resources set name='Actualizada' where id=${h.resource}`;
        if (change === "resource_status") await db.sql`update resources set status='suspended' where id=${h.resource}`;
        expected = await h.appointments();
        expect((await tools.execute(operation, args)).status).toBe("rejected"); return '{"kind":"reply"}';
      });
      expect(await h.appointments()).toEqual(expected!);
    });
  }
  test("preference is not assignment eligibility; suspended catalog retains legacy metadata policy and native visibility", async () => {
    const h = await fixture(), ap = await savedAppointment(h), alternative = randomUUID(), otherService = randomUUID();
    await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${otherService},${h.business},'Otro',30,1800)`;
    await db.sql`insert into resources(id,business_id,name,weekly_schedule) select ${alternative},${h.business},'Beatriz',weekly_schedule from resources where id=${h.resource}`;
    await db.sql`insert into resource_services(business_id,resource_id,service_id) values(${h.business},${alternative},${otherService})`;
    await db.sql`update services set status='suspended' where id=${h.service}`;
    await db.sql`update resources set status='suspended' where id=${h.resource}`;
    await h.run("Que figure Beatriz como mi preferencia", async tools => {
      expect((await tools.execute("preference", await metadataArguments(tools, ap.id, "preference", alternative))).status).toBe("staged_action"); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([{ ...ap, customerResourcePreference: alternative }]);
    await db.sql`update resources set status='suspended' where id=${alternative}`;
    await h.run("prefiero Ana", async tools => {
      expect((data(await tools.execute("read_resources", {})) as any).items).toEqual([]);
      expect((await tools.execute("preference", { appointmentId: ap.id, resourceId: h.resource })).status).toBe("staged_action"); return '{"kind":"reply"}';
    });
    expect(await h.appointments()).toEqual([{ ...ap, customerResourcePreference: h.resource }]);
  });
  for (const operation of ["notes", "preference"] as const) for (const state of ["started", "done", "cancelled", "no_show"] as const) {
    test(`${operation} preserves lifecycle policy for ${state}`, async () => {
      const h = await fixture(true, true, state === "started" ? "2035-04-02T10:30:00-03:00" : undefined), ap = await savedAppointment(h);
      if (state !== "started") await db.sql`update appointments set state=${state} where id=${ap.id}`;
      const [before] = await h.appointments(), allowed = operation === "notes" && state === "started";
      await h.run("Anotá rampa y mi preferencia por Ana", async tools => {
        expect((await tools.execute(operation, await metadataArguments(tools, ap.id, operation, operation === "notes" ? "rampa" : h.resource))).status)
          .toBe(allowed ? "staged_action" : "rejected"); return '{"kind":"reply"}';
      });
      expect(await h.appointments()).toEqual([{ ...before!, ...(allowed ? { notes: "rampa" } : {}) }]);
    });
  }
  test("literal 2000-character notes save exactly; NUL remains forbidden by the existing DAL", async () => {
    const h = await fixture(), ap = await savedAppointment(h), literal = "á".repeat(2000);
    await h.run(`Anotá: ${literal}`, async tools => {
      expect((await tools.execute("notes", await metadataArguments(tools, ap.id, "notes", literal))).status).toBe("staged_action"); return '{"kind":"reply"}';
    });
    await expect(pools.api.run(h.context, repo => repo.setAppointmentNotes(h.business, ap.id, { notes: "\u0000" },
      { actor: "customer", channel: "ai", now: "2035-04-01T08:00:00-03:00" }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await h.appointments()).toEqual([{ ...ap, notes: literal }]);
  });
  for (const operation of ["notes", "preference"] as const) test(`${operation} rolls back output/receipt/effect/dialogue then retries once`, async () => {
    const h = await fixture(), ap = await savedAppointment(h, "2035-04-02T11:00:00-03:00");
    await prepareNatural(h);
    await db.sql`insert into public.receptionist_fault_fixture(business_id,enabled) values(${h.business},true)`;
    const job = await h.receive("Anotá rampa y mi preferencia por Ana");
    let staged: ReceptionistToolResult | undefined, pending: unknown;
    const callback = async (tools: ReceptionistToolSession) => {
      if (pending) expect(tools.context.pending).toEqual(pending);
      pending = tools.context.pending;
      staged = await tools.execute(operation, await metadataArguments(tools, ap.id, operation, operation === "notes" ? "rampa" : h.resource));
      return '{"kind":"reply"}';
    };
    const counts = async () => (await db.sql`select
      (select count(*)::int from outbound_commands where source_message_id=${job.messageId}) outputs,
      (select count(*)::int from whatsapp_agenda_receipts where message_id=${job.messageId} and operation=${operation}) receipts,
      (select count(*)::int from outbox_events where topic='appointment.changed' and payload->>'sourceMessageId'=${job.messageId}) effects`)[0];
    expect((await h.agenda.withReceptionistSession(job, callback)).status).toBe("infrastructure_failure");
    expect(staged!.status).toBe("staged_action"); expect(await h.appointments()).toEqual([ap]);
    expect(await counts()).toEqual({ outputs: 0, receipts: 0, effects: 0 });
    await db.sql`update public.receptionist_fault_fixture set enabled=false where business_id=${h.business}`;
    expect((await h.agenda.withReceptionistSession(job, callback)).status).toBe("committed");
    expect((await h.agenda.withReceptionistSession(job, callback)).status).toBe("not_current");
    expect(await counts()).toEqual({ outputs: 1, receipts: 1, effects: 1 });
    expect(await h.appointments()).toEqual([{ ...ap, [operation === "notes" ? "notes" : "customerResourcePreference"]: operation === "notes" ? "rampa" : h.resource }]);
    const [dialogue] = await db.sql`select dialogue from whatsapp_agenda_dialogues where business_id=${h.business}`;
    expect(dialogue!.dialogue).toEqual({ quote: null, awaitingNames: false });
  });
});
describe("transactional receptionist tools", () => {
  test("informal input reaches tools; calendar facts are not availability", async () => {
    const h = await fixture();
    const result = await h.run("che q onda", async tools => {
      expect(data(await tools.execute("read_business", {}))).toEqual({ displayName: "Tools", description: "Descripción", address: "Dirección" });
      expect(data(await tools.execute("read_calendar", {}))).toHaveProperty("weeklySchedule");
      const slots = data(await tools.execute("availability", { serviceId: h.service, date: "2035-04-02" })) as { items: unknown[] };
      expect(slots.items.length).toBeGreaterThan(0);
      expect(data(await tools.execute("owned_appointments", {}))).toEqual({ items: [], hasMore: false });
      expect((await tools.execute("owned_appointment", { appointmentId: randomUUID() })).status).toBe("rejected");
      return "Respuesta natural y fundamentada.";
    });
    expect(result.status).toBe("committed");
  });
  test("prepared quote is not committed; delivery, later confirmation and retry are enforced", async () => {
    const h = await fixture();
    const quote = await h.run("me sirve ese", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("prepared_quote");
      expect((await tools.execute("confirm_quote", {})).status).not.toBe("staged_action");
      return "Te paso los detalles.";
    });
    expect(await h.appointments()).toHaveLength(0);
    expect(quote.status).toBe("committed");
    const undelivered = await h.run("confirmo", async tools => {
      expect((await tools.execute("confirm_quote", {})).status).toBe("prepared_quote");
      return "Necesitás recibir los detalles.";
    });
    expect(await h.appointments()).toHaveLength(0);
    if (undelivered.status !== "committed") throw new Error("Missing quote output");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${undelivered.outboundId}`;
    const job = await h.receive("confirmo");
    const saved = await h.agenda.withReceptionistSession(job, async tools => {
      expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action");
      return "Listo, quedó reservado.";
    });
    expect(saved.status).toBe("committed");
    if (saved.status === "committed") expect(saved.actions).toHaveLength(1);
    expect(await h.appointments()).toHaveLength(1);
    expect((await h.agenda.withReceptionistSession(job, async () => { throw new Error("Retry must not run"); })).status).toBe("not_current");
    expect(await h.appointments()).toHaveLength(1);
    const [receipt] = await db.sql`select count(*)::int count from whatsapp_agenda_receipts where message_id=${job.messageId}`;
    expect(receipt!.count).toBe(1);
  });
  test("tenant and current sender ownership are checked, never supplied by model", async () => {
    const h = await fixture(), other = await fixture();
    const foreign = await pools.api.run(other.context, async repo => {
      const client = await repo.findClientByCanonicalPhone(phone);
      return repo.createAppointment(other.business, { serviceId: other.service, resourceId: other.resource, startRaw: start, clientId: client!.id }, { now: "2035-04-01T08:00:00-03:00", origin: "manual" });
    });
    await h.run("mostrame", async tools => {
      expect((await tools.execute("owned_appointment", { appointmentId: foreign.id })).status).toBe("rejected");
      expect((await tools.execute("prepare_change", { appointmentId: foreign.id, startsAt: start })).status).toBe("rejected");
      expect((await tools.execute("availability", { serviceId: h.service, date: "2035-04-02", appointmentId: foreign.id })).status).toBe("rejected");
      expect((await tools.execute("availability", { serviceId: other.service, date: "2035-04-02" })).status).toBe("rejected");
      return "No pude verificar ese turno.";
    });
    await db.sql`update clients set phone='+14155552671' where business_id=${other.business}`;
    await other.run("mostrame", async tools => {
      expect(data(await tools.execute("owned_appointments", {}))).toEqual({ items: [], hasMore: false });
      expect((await tools.execute("owned_appointment", { appointmentId: foreign.id })).status).toBe("rejected");
      return "No hay turnos con este número.";
    });
  });
  test("callback failure rolls back staged mutation and response, without leaking errors", async () => {
    const h = await fixture();
    const prepared = await h.run("ese horario", async tools => { await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start }); return "Detalles"; });
    if (prepared.status !== "committed") throw new Error("Missing quote");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    const job = await h.receive("confirmo");
    const result = await h.agenda.withReceptionistSession(job, async tools => {
      expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action");
      throw new Error("private infrastructure detail");
    });
    expect(result).toEqual({ status: "infrastructure_failure" });
    expect(await h.appointments()).toHaveLength(0);
    const retry = await h.agenda.withReceptionistSession(job, async tools => { await tools.execute("confirm_quote", {}); return "Reservado"; });
    expect(retry.status).toBe("committed");
    expect(await h.appointments()).toHaveLength(1);
  });
  test("receipt persistence failure rolls back effect and natural output together", async () => {
    const h = await fixture();
    const prepared = await h.run("ese", async tools => { await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start }); return "Detalles"; });
    if (prepared.status !== "committed") throw new Error("Missing quote");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    await db.sql`insert into public.receptionist_fault_fixture(business_id,enabled) values(${h.business},true)`;
    const job = await h.receive("confirmo");
    const result = await h.agenda.withReceptionistSession(job, async tools => { await tools.execute("confirm_quote", {}); return "Reservado"; });
    expect(result.status).toBe("infrastructure_failure");
    expect(await h.appointments()).toHaveLength(0);
    const [counts] = await db.sql`select
      (select count(*)::int from outbound_commands where source_message_id=${job.messageId}) outputs,
      (select count(*)::int from whatsapp_agenda_receipts where message_id=${job.messageId}) receipts,
      (select count(*)::int from outbox_events where business_id=${h.business} and topic='appointment.changed') effects`;
    expect(counts).toEqual({ outputs: 0, receipts: 0, effects: 0 });
    await db.sql`update public.receptionist_fault_fixture set enabled=false where business_id=${h.business}`;
    const retry = await h.agenda.withReceptionistSession(job, async tools => { await tools.execute("confirm_quote", {}); return "Reservado"; });
    expect(retry.status).toBe("committed");
    expect(await h.appointments()).toHaveLength(1);
  });
  test("availability is revalidated and a change of mind replaces the pending quote", async () => {
    const h = await fixture();
    const later = "2035-04-02T11:00:00-03:00";
    const prepared = await h.run("mejor otro", async tools => {
      await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start });
      const changed = await tools.execute("prepare_booking", { serviceId: h.service, startsAt: later });
      expect(changed.status).toBe("prepared_quote");
      if (changed.status === "prepared_quote") expect(Date.parse((changed.quote as { startsAt: string }).startsAt)).toBe(Date.parse(later));
      return "Esta es tu nueva propuesta.";
    });
    if (prepared.status !== "committed") throw new Error("Missing quote");
    const [output] = await db.sql`select text from outbound_commands where outbound_id=${prepared.outboundId}`;
    expect(output!.text).toContain("11:00");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    await pools.api.run(h.context, async repo => {
      const client = await repo.findClientByCanonicalPhone(phone);
      await repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource, startRaw: later, clientId: client!.id }, { now: "2035-04-01T08:00:00-03:00", origin: "manual" });
    });
    await h.run("confirmo", async tools => {
      expect((await tools.execute("confirm_quote", {})).status).toBe("clarification");
      return "Ese horario ya no está disponible.";
    });
    expect(await h.appointments()).toHaveLength(1);
  });
  test("change is only prepared, while notes/preference/cancel retain actual-message guards", async () => {
    const h = await fixture();
    const appointment = await pools.api.run(h.context, async repo => {
      const client = await repo.findClientByCanonicalPhone(phone);
      return repo.createAppointment(h.business, { serviceId: h.service, resourceId: h.resource, startRaw: start, clientId: client!.id }, { now: "2035-04-01T08:00:00-03:00", origin: "manual" });
    });
    const prepared = await h.run("mmm mejor más tarde", async tools => {
      const availability = data(await tools.execute("availability", { serviceId: h.service, date: "2035-04-02", appointmentId: appointment.id })) as { items: { startsAt: string }[] };
      expect(availability.items.some(slot => Date.parse(slot.startsAt) === Date.parse(start))).toBe(true);
      expect((await tools.execute("prepare_change", { appointmentId: appointment.id, startsAt: "2035-04-02T11:00:00-03:00" })).status).toBe("prepared_quote");
      expect((await tools.execute("cancel", { appointmentId: appointment.id })).status).toBe("rejected");
      expect((await tools.execute("notes", { appointmentId: appointment.id, notes: "invented" })).status).toBe("rejected");
      expect((await tools.execute("preference", { appointmentId: appointment.id, resourceId: h.resource })).status).toBe("rejected");
      return "Te propongo este cambio.";
    });
    expect((await h.appointments())[0]!.startsAt).toBe(start);
    if (prepared.status !== "committed") throw new Error("Missing quote");
    await db.sql`update outbound_commands set state='sent',acknowledged_at=now() where outbound_id=${prepared.outboundId}`;
    await h.run("confirmo", async tools => {
      expect((await tools.execute("confirm_quote", {})).status).toBe("staged_action");
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("rejected");
      return "Cambio reservado.";
    });
    expect(Date.parse((await h.appointments())[0]!.startsAt)).toBe(Date.parse("2035-04-02T11:00:00-03:00"));
    await h.run("nota: necesito acceso", async tools => {
      expect((await tools.execute("notes", { appointmentId: appointment.id, notes: "model replacement" })).status).toBe("staged_action");
      return "Nota guardada.";
    });
    expect((await h.appointments())[0]!.notes).toBe("necesito acceso");
    await h.run("cancelar mi turno", async tools => {
      expect((await tools.execute("cancel", { appointmentId: appointment.id })).status).toBe("staged_action");
      return "Turno cancelado.";
    });
    expect((await h.appointments())[0]!.state).toBe("cancelled");
  });
  test("unresolved customer resource preference survives without another valid selection", async () => {
    const h = await fixture();
    await h.run("prefiero Desconocida", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("clarification");
      return "¿Con quién preferís?";
    });
    await h.run("a esa hora", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("clarification");
      return "Necesito aclarar el recurso.";
    });
    await h.run("sin preferencia", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).status).toBe("prepared_quote");
      return "Te paso el detalle.";
    });
    await h.run("ya no quiero reservar", async tools => {
      expect(data(await tools.execute("clear_pending", {}))).toEqual({ pending: null });
      return "De acuerdo, dejamos la propuesta.";
    });
    await h.run("confirmo", async tools => {
      expect((await tools.execute("confirm_quote", {})).status).toBe("clarification");
      return "No hay una propuesta pendiente.";
    });
    expect(await h.appointments()).toHaveLength(0);
  });
  test("unverified sender cannot read or mutate owned state", async () => {
    const h = await fixture();
    const job = await h.receive("mostrame", false);
    const result = await h.agenda.withReceptionistSession(job, async tools => {
      expect(await tools.execute("owned_appointments", {})).toEqual({ status: "rejected", code: "UNVERIFIED_SENDER" });
      expect(await tools.execute("prepare_booking", { serviceId: h.service, startsAt: start })).toEqual({ status: "rejected", code: "UNVERIFIED_SENDER" });
      return "No pude verificar el número.";
    });
    expect(result.status).toBe("committed");
  });
  test("unavailable business facts are different from infrastructure failure", async () => {
    const h = await fixture(false);
    await h.run("hola", async tools => {
      expect((await tools.execute("read_business", {})).status).toBe("unavailable_data");
      expect((await tools.execute("cancel", { appointmentId: randomUUID() })).status).toBe("rejected");
      return "No hay perfil registrado.";
    });
  });
});
