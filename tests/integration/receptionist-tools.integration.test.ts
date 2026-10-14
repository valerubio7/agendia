import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { PostgresWhatsAppAgenda } from "../../apps/message-worker/src/whatsapp-agenda.ts";
import { PostgresInboundHandler } from "../../apps/whatsapp-manager/src/inbound-handler.ts";
import { normalizeBaileysMessage } from "../../packages/whatsapp-baileys/src/baileys-gateway.ts";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";
import type { ReceptionistToolSession, ReceptionistToolResult } from "../../apps/message-worker/src/receptionist-tools.ts";

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
async function fixture(profile = true) {
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
  await db.sql`insert into clients(business_id,first_name,last_name,phone) values(${business},'María','Pérez',${phone})`;
  const agenda = new PostgresWhatsAppAgenda(pools, { proposeAgenda: async () => { throw new Error("No classifier allowed"); } }, () => "2035-04-01T08:00:00-03:00");
  async function receive(text: string, trusted = true) {
    const providerId = randomUUID();
    const event = normalizeBaileysMessage(session, { key: { id: providerId, remoteJid: "5491123456789@s.whatsapp.net" }, message: { conversation: text } }, trusted)!;
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
  test("unresolved customer resource preference survives another model selection", async () => {
    const h = await fixture();
    await h.run("prefiero Desconocida", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, resourceId: h.resource, startsAt: start })).status).toBe("clarification");
      return "¿Con quién preferís?";
    });
    await h.run("a esa hora", async tools => {
      expect((await tools.execute("prepare_booking", { serviceId: h.service, resourceId: h.resource, startsAt: start })).status).toBe("clarification");
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
