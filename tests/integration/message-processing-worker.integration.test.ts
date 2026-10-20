import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PgBoss } from "pg-boss";
import type { AiProvider, ToolAssistantMessage, ToolConversationProvider } from '@agendia/domain';
import { createRuntimePools, tenantContext, PostgresRepositories } from "@agendia/db";
import {
  BaileysAuthStateAdapter,
  BaileysAuthStore,
  BaileysGateway,
  InMemoryAuthRecordRepository,
  InMemoryKms,
} from "@agendia/whatsapp-baileys";
import {
  AiOutboxDispatcher,
  PostgresInboundHandler,
  PostgresOutboundDispatcher,
  type InboundWhatsAppEvent,
} from "../../apps/whatsapp-manager/src/index.ts";
import {
  PostgresAiJobProcessor,
  PostgresSummaryJobProcessor,
} from "../../apps/message-worker/src/index.ts";
import {
  applyPostgresMigrations,
  createRoleLogin,
  FakeBaileysSocket,
  immediateOutboxRecovery,
  startTestPostgres,
  type TestPostgres,
} from "../support/index.ts";

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const CA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  CB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNERSHIP = "cccccccc-1111-4111-8111-cccccccccccc";
const SA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  SB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
// Each retired varchar(8000) can contain 8000 astral Unicode characters.
const maximumLegacyText = "😀".repeat(8000);
const maximumStyle = ["Personalidad", "Tono"]
  .map((heading) => `${heading}:\n${maximumLegacyText}`)
  .join("\n\n");
const maximumBusinessInstructions = ["Instrucciones", "Conocimiento", "Reglas", "Restricciones"]
  .map((heading) => `${heading}:\n${maximumLegacyText}`)
  .join("\n\n");
const event = (
  overrides: Partial<InboundWhatsAppEvent> = {},
): InboundWhatsAppEvent => ({
  sessionPublicId: SA,
  providerMessageId: "m1",
  remoteJid: "54911@s.whatsapp.net",
  chatType: "individual",
  fromMe: false,
  kind: "text",
  text: "¿Cuándo llega?",
  receivedAt: Date.now(),
  ...overrides,
});
let db: TestPostgres,
  pools: ReturnType<typeof createRuntimePools>,
  boss: PgBoss;

beforeAll(async () => {
  db = await startTestPostgres();
  await applyPostgresMigrations(
    db.sql,
    join(import.meta.dir, "../../packages/db/migrations"),
  );
  await db.sql`insert into businesses(id,name,status) values(${A},'Tenant A','active'),(${B},'Tenant B','active')`;
  await db.sql`insert into business_profiles(business_id,display_name,description) values(${A},'A','envíos'),(${B},'B','SECRETO-B')`;
  await db.sql`update business_profiles set description='RETAINED_DESCRIPTION',address='RETAINED_ADDRESS' where business_id=${A}`;
  await db.sql`insert into assistant_configs(business_id,active,style,business_instructions) values(${A},true,${maximumStyle},${maximumBusinessInstructions}),(${B},false,'STYLE-B','no usar')`;
  await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state,owner_id) values(${CA},${A},${SA},'CONNECTED','manager-1'),(${CB},${B},${SB},'CONNECTED','manager-2')`;
  await db.sql`update whatsapp_connections set ownership_token=${OWNERSHIP} where id=${CA}`;
  const workerUrl = await createRoleLogin(
    db,
    "unit23_worker",
    "agendia_worker_runtime",
  );
  pools = createRuntimePools(db.container.getConnectionUri());
  boss = new PgBoss({
    connectionString: workerUrl,
    schema: "pgboss",
    createSchema: false,
  });
  await boss.start();
  await boss.createQueue("ai-generate");
}, 120_000);
afterAll(async () => {
  await boss?.stop();
  await pools?.end();
  await db?.stop();
});

const makeEligible = async () => {
  await db.sql`update conversations set reply_due_at=now()-interval '1 second' where reply_due_at is not null`;
  await db.sql`update outbox_events set next_attempt_at=now()-interval '1 second' where published_at is null`;
};

describe("PostgreSQL messaging workers", () => {
  test("persists initial pacing and a fixed grouped deadline across dispatcher restart", async () => {
    const inbound = new PostgresInboundHandler(pools);
    const first = await inbound.handle(event({ providerMessageId: "pace-1", remoteJid: "pace@s.whatsapp.net", text: "primero" }));
    const before = (await db.sql`select next_attempt_at,created_at from outbox_events where stable_key='ai:pace-1'`)[0]!;
    const wait = new Date(before.next_attempt_at).getTime() - new Date(before.created_at).getTime();
    expect(wait).toBeGreaterThanOrEqual(600_000);
    expect(wait).toBeLessThan(601_000);
    await inbound.handle(event({ providerMessageId: "pace-2", remoteJid: "pace@s.whatsapp.net", text: "segundo" }));
    expect((await inbound.handle(event({ providerMessageId: "pace-2", remoteJid: "pace@s.whatsapp.net" }))).outcome).toBe("duplicate");
    const after = (await db.sql`select next_attempt_at,payload from outbox_events where stable_key='ai:pace-2'`)[0]!;
    expect(after.next_attempt_at).toEqual(before.next_attempt_at);
    let earlyCalls = 0;
    await new PostgresAiJobProcessor(pools, { generate: async () => { throw new Error('Unexpected generate'); }, converse: async () => {
      earlyCalls++;
      return { message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: 'test', usageTokens: 1 };
    } } as AiProvider & ToolConversationProvider).process({ businessId: A, messageId: after.payload.messageId, correlationId: 'early' });
    expect(earlyCalls).toBe(0);
    const dispatcher = new AiOutboxDispatcher(pools, boss, immediateOutboxRecovery);
    expect(await dispatcher.dispatchBatch()).toBe(0);
    // Leave this isolated burst terminal so the legacy scenarios remain independent.
    await db.sql`update outbox_events set published_at=now() where stable_key in ('ai:pace-1','ai:pace-2')`;
    expect(first.outcome).toBe("accepted");
  });
  test("routes before tenant access, deduplicates and filters text-only events", async () => {
    const inbound = new PostgresInboundHandler(pools),
      socket = new FakeBaileysSocket([]),
      auth = new BaileysAuthStateAdapter(
        new BaileysAuthStore(
          new InMemoryAuthRecordRepository(),
          new InMemoryKms({ test: Buffer.alloc(32, 7) }, "test"),
        ),
      ),
      gateway = new BaileysGateway(
        (id) => auth.load(A, id),
        () => socket,
      );
    expect(
      (
        await inbound.handle(
          event({ sessionPublicId: "cccccccc-3333-4333-8333-cccccccccccc" }),
        )
      ).outcome,
    ).toBe("unknown_session");
    await gateway.connect(
      CA,
      () => undefined,
      (e) => inbound.handle(e),
      SA,
    );
    await socket.emit("messages.upsert", {
      messages: [
        {
          key: { id: "m1", remoteJid: "54911@s.whatsapp.net", fromMe: false },
          message: { conversation: "¿Cuándo llega?" },
        },
      ],
    });
    expect((await inbound.handle(event())).outcome).toBe("duplicate");
    for (const e of [
      event({ providerMessageId: "group", chatType: "group" }),
      event({ providerMessageId: "own", fromMe: true, kind: "image", text: null }),
      event({ providerMessageId: "media", kind: "image", text: null }),
      event({ sessionPublicId: SB, providerMessageId: "inactive" }),
    ])
      await inbound.handle(e);
    await db.sql`update businesses set status='suspended' where id=${B}`;
    await db.sql`update assistant_configs set active=true where business_id=${B}`;
    expect(
      (
        await inbound.handle(
          event({ sessionPublicId: SB, providerMessageId: "suspended" }),
        )
      ).outcome,
    ).toBe("automation_inactive");
    expect(await db.sql`select raw_text from messages where provider_message_id='m1'`).toHaveLength(1);
    expect(await db.sql`select stable_key from inbox_events where stable_key not like 'pace-%'`).toHaveLength(6);
    expect(
      await db.sql`select id from outbox_events where topic='ai.generate' and published_at is null`,
    ).toHaveLength(1);
    expect(await boss.fetch("ai-generate")).toHaveLength(0);
  });

  test("recovers committed ai outbox without direct queue publication", async () => {
    await makeEligible();
    expect(
      await readFile(
        join(
          import.meta.dir,
          "../../apps/whatsapp-manager/src/inbound.ts",
        ),
        "utf8",
      ),
    ).not.toContain("queue.send");
    const failed = new AiOutboxDispatcher(
      pools,
      {
        send: async () => {
          throw new Error("broker unavailable");
        },
      },
      immediateOutboxRecovery,
    );
    expect(await failed.dispatchBatch()).toBe(0);
    expect(
      await db.sql`select id from outbox_events where topic='ai.generate' and published_at is null`,
    ).toHaveLength(1);
    expect(await boss.fetch("ai-generate")).toHaveLength(0);
    const restarted = new AiOutboxDispatcher(
      pools,
      boss,
      immediateOutboxRecovery,
    );
    expect(await restarted.dispatchBatch()).toBe(1);
    expect(
      await db.sql`select id from outbox_events where topic='ai.generate' and published_at is null`,
    ).toHaveLength(0);
    const jobs = await boss.fetch<{
      businessId: string;
      messageId: string;
      correlationId: string;
    }>("ai-generate");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({
      businessId: A,
      correlationId: "ai:m1",
    });
  });

  test("fails closed on oversized required settings, then grounds native facts and retries without tenant leakage", async () => {
    const conversation = (
      await db.sql<
        { id: string }[]
      >`select conversation_id as id from messages where provider_message_id='m1' and business_id=${A}`
    )[0]!;
    await db.sql`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) values(${A},${conversation.id},1,0,${db.sql.json({ facts: ["cliente nuevo"], requests: [], commitments: [], preferences: [], openItems: [] })})`;
    const calls: string[] = [];
    const provider = { generate: async () => { throw new Error('Unexpected generate'); }, converse: async (request: unknown) => {
      calls.push(JSON.stringify(request));
      const message = calls.length === 1
        ? { role: 'assistant' as const, content: null, toolCalls: [{ id: 'business', name: 'read_business', arguments: {} }] }
        : { role: 'assistant' as const, content: '{"kind":"reply","facts":["read_business"],"businessFields":["address"]}', toolCalls: [] };
      return { message, providerId: 'native-mock', usageTokens: 1 };
    } };
    const worker = new PostgresAiJobProcessor(pools, provider, 500);
    await db.sql`update messages set raw_text='¿Dónde están ubicados?' where provider_message_id='m1'`;
    const messageId = (await db.sql`select id from messages where provider_message_id='m1'`)[0]!.id;
    const job = { businessId: A, messageId, correlationId: 'job-1' };
    expect(maximumStyle.length).toBe(32022);
    expect(maximumBusinessInstructions.length).toBe(64058);
    expect(Buffer.byteLength(maximumStyle + maximumBusinessInstructions, 'utf8')).toBe(192080);
    expect(Buffer.byteLength(maximumStyle + maximumBusinessInstructions, 'utf8')).toBeGreaterThan(128 * 1024);
    await expect(worker.process(job)).rejects.toThrow('Receptionist infrastructure failure');
    expect(calls).toHaveLength(0);
    expect(await db.sql`select outbound_id from outbound_commands`).toHaveLength(0);
    expect((await db.sql`select processing_state from messages where id=${messageId}`)[0]!.processing_state).toBe('pending');
    // Malformed optional summary cannot rescue oversized required settings or invoke a provider.
    await db.sql`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) values(${A},${conversation.id},2,0,${db.sql.json({ facts: [] })})`;
    await expect(worker.process({ ...job, correlationId: 'invalid-oversized' })).rejects.toThrow('Receptionist infrastructure failure');
    expect(calls).toHaveLength(0);
    await db.sql`update messages set raw_text=repeat('x',800) where id=${messageId}`;
    await expect(worker.process({ ...job, correlationId: 'oversized-800-retry' })).rejects.toThrow('Receptionist infrastructure failure');
    expect(calls).toHaveLength(0);
    expect(await db.sql`select outbound_id from outbound_commands`).toHaveLength(0);
    expect((await db.sql`select style,business_instructions from assistant_configs where business_id=${A}`)[0]).toMatchObject({ style: maximumStyle, business_instructions: maximumBusinessInstructions });
    expect((await db.sql`select processing_state from messages where id=${messageId}`)[0]!.processing_state).toBe('pending');
    await db.sql`update messages set raw_text='¿Dónde están ubicados?' where id=${messageId}`;
    await db.sql`delete from conversation_summaries where business_id=${A} and version=2`;
    await db.sql`update assistant_configs set style='Estilo A',business_instructions='Instrucciones A' where business_id=${A}`;
    await worker.process(job);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!).messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'business', content: JSON.stringify({ status: 'data', data: { displayName: 'A', description: 'RETAINED_DESCRIPTION', address: 'RETAINED_ADDRESS' }, namesReference: null }) });
    for (const included of ['¿Dónde están ubicados?', 'RETAINED_ADDRESS', 'RETAINED_DESCRIPTION', 'cliente nuevo', 'Estilo A', 'Instrucciones A'])
      expect(calls[0]).toContain(included);
    for (const excluded of ['STYLE-B', 'SECRETO-B', 'no usar']) expect(calls[0]).not.toContain(excluded);
    const [reply] = await db.sql`select text from outbound_commands`;
    expect(reply!.text).toBe('Dirección registrada: "RETAINED_ADDRESS".');
    expect(reply!.text).not.toMatch(/STYLE-B|SECRETO-B|cliente nuevo|Instrucciones A/);
    expect(
      await db.sql`select outbound_id from outbound_commands`,
    ).toHaveLength(1);
    expect(
      await db.sql`select id from technical_events where code='ai.context_unavailable'`,
    ).toHaveLength(0);
    expect(
      await db.sql`select id from technical_events where code='ai.timeout'`,
    ).toHaveLength(0);
    expect(
      await db.sql`select id from audit_events where event_type='ai.failed'`,
    ).toHaveLength(0);
    expect(
      await db.sql`select outbound_id from outbound_commands`,
    ).toHaveLength(1);
  });

  test("dispatches once through the owned connection and preserves crash ambiguity", async () => {
    const sent: Array<{ connectionId: string; remoteJid: string }> = [];
    const ok = new PostgresOutboundDispatcher(
      pools,
      {
        send: async (c) => {
          sent.push({ connectionId: c.connectionId, remoteJid: c.remoteJid });
          return { outcome: "ack" as const, providerMessageId: "ack-1" };
        },
      },
      "manager-1",
      () => [OWNERSHIP],
    );
    expect(await ok.dispatchNext()).toBe(true);
    expect(sent).toEqual([
      { connectionId: CA, remoteJid: "54911@s.whatsapp.net" },
    ]);
    const row = (
      await db.sql<
        { conversation_id: string }[]
      >`select conversation_id from outbound_commands limit 1`
    )[0]!;
    await db.sql`insert into outbound_commands(business_id,conversation_id,connection_id,text,state) values(${A},${row.conversation_id},${CA},'rechazada','generated')`;
    const rejected = new PostgresOutboundDispatcher(
      pools,
      { send: async () => ({ outcome: "rejected" as const }) },
      "manager-1",
      () => [OWNERSHIP],
    );
    expect(await rejected.dispatchNext()).toBe(true);
    await db.sql`insert into outbound_commands(business_id,conversation_id,connection_id,text,state) values(${A},${row.conversation_id},${CA},'ambigua','generated')`;
    let attempts = 0;
    const crash = new PostgresOutboundDispatcher(
      pools,
      {
        send: async () => {
          attempts++;
          throw new Error("raw provider secret");
        },
      },
      "manager-1",
      () => [OWNERSHIP],
    );
    expect(await crash.dispatchNext()).toBe(true);
    expect(await crash.dispatchNext()).toBe(false);
    expect(attempts).toBe(1);
    expect(
      (
        await db.sql<
          { state: string }[]
        >`select state from outbound_commands order by created_at`
      ).map((r) => r.state),
    ).toEqual(["sent", "failed", "delivery_unknown"]);
    expect(
      (
        await db.sql<
          { event_type: string }[]
        >`select event_type from audit_events where business_id=${A} and event_type in ('whatsapp.send_failed','whatsapp.delivery_unknown') order by stream_sequence`
      ).map((row) => row.event_type),
    ).toEqual(["whatsapp.send_failed", "whatsapp.delivery_unknown"]);
    await pools.manager.run(
      tenantContext({
        businessId: B,
        actorId: "manager-2",
        role: "internal_worker",
        requestId: "outbound:b",
      }),
      (repo) =>
        repo.recordRuntimeEvent(B, {
          code: "whatsapp.send_failed",
          outcome: "failure",
          source: "whatsapp-manager",
          requestId: "outbound:b",
          severity: "error",
        }),
    );
    expect(
      (
        await db.sql<
          { business_id: string; event_type: string }[]
        >`select business_id,event_type from audit_events where event_type='whatsapp.send_failed' order by business_id`
      ).map((row) => ({ ...row })),
    ).toEqual([
      { business_id: A, event_type: "whatsapp.send_failed" },
      { business_id: B, event_type: "whatsapp.send_failed" },
    ]);
    await expect(
      Promise.resolve(
        db.sql`update audit_events set metadata=${db.sql.json({ rawError: "secret" })} where business_id=${A}`,
      ),
    ).rejects.toThrow("append-only");
    expect(
      JSON.stringify(
        await db.sql`select code,safe_details from technical_events where business_id in (${A},${B}) and code like 'whatsapp.%'`,
      ),
    ).not.toMatch(/rechazada|ambigua|secret|@s\.whatsapp/);
  });

  test("native replies preserve an 800-character pending input and suppress duplicate generation", async () => {
    const inbound = new PostgresInboundHandler(pools);
    await inbound.handle(event({ providerMessageId: 'native-800', remoteJid: 'native-800@s.whatsapp.net', text: 'x'.repeat(800) }));
    await makeEligible();
    const row = (await db.sql`select id from messages where provider_message_id='native-800'`)[0]!;
    const requests: any[] = [];
    const worker = new PostgresAiJobProcessor(pools, {
      generate: async () => { throw new Error('Unexpected generate'); },
      converse: async request => {
        requests.push(request);
        return { message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: 'test', usageTokens: 1 };
      },
    } as AiProvider & ToolConversationProvider, 500);
    const job = { businessId: A, messageId: row.id, correlationId: 'native-800' };
    await worker.process(job);
    await worker.process(job);
    expect(requests).toHaveLength(1);
    expect(requests[0].messages.at(-1).content).toBe('x'.repeat(800));
    expect((await db.sql`select text from outbound_commands where source_message_id=${row.id}`).map(r => r.text)).toEqual(['¿Podés aclarar qué necesitás?']);
    expect((await db.sql`select processing_state from messages where id=${row.id}`)[0]!.processing_state).toBe('generated');
    await db.sql`update outbox_events set published_at=now() where stable_key='ai:native-800'`;
  });

  test("reclaims crashes, deduplicates publication and isolates two tenants", async () => {
    await db.sql`update businesses set status='active' where id=${B}`;
    await db.sql`update assistant_configs set active=true where business_id=${B}`;
    const inbound = new PostgresInboundHandler(pools);
    expect(
      (
        await inbound.handle(
          event({ providerMessageId: "m2", remoteJid: "a2@s.whatsapp.net" }),
        )
      ).outcome,
    ).toBe("accepted");
    expect(
      (
        await inbound.handle(
          event({
            sessionPublicId: SB,
            providerMessageId: "b1",
            remoteJid: "b1@s.whatsapp.net",
          }),
        )
      ).outcome,
    ).toBe("accepted");
    expect(
      (
        await inbound.handle(
          event({ providerMessageId: "m2", remoteJid: "a2@s.whatsapp.net" }),
        )
      ).outcome,
    ).toBe("duplicate");
    await makeEligible();
    const lostAck = new AiOutboxDispatcher(
      pools,
      {
        send: async (name, data, options) => {
          await boss.send(name, data, options);
          throw new Error("crash after publish");
        },
      },
      { ...immediateOutboxRecovery, batchSize: 1 },
    );
    expect(await lostAck.dispatchBatch()).toBe(0);
    expect(
      await pools.manager.run(undefined, (r) =>
        r.claimAiOutbox("33333333-3333-4333-8333-333333333333", 1, 0),
      ),
    ).toHaveLength(1);
    const dispatchers = [
      new AiOutboxDispatcher(pools, boss, immediateOutboxRecovery),
      new AiOutboxDispatcher(pools, boss, immediateOutboxRecovery),
    ];
    expect(
      (await Promise.all(dispatchers.map((d) => d.dispatchBatch()))).reduce(
        (sum, n) => sum + n,
        0,
      ),
    ).toBe(2);
    const outbox = await db.sql<
      { id: string; business_id: string; payload: { messageId: string } }[]
    >`select id,business_id,payload from outbox_events where stable_key in ('ai:m2','ai:b1') order by business_id`;
    expect(outbox.map((row) => row.business_id)).toEqual([A, B]);
    expect(
      await db.sql`select id from pgboss.job where id in ${db.sql(outbox.map((row) => row.id))}`,
    ).toHaveLength(2);
    const calls: string[] = [];
    const worker = new PostgresAiJobProcessor(
        pools,
        {
          generate: async () => { throw new Error('Unexpected generate'); },
          converse: async () => {
            calls.push("called");
            return { message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: "id", usageTokens: 1 };
          },
        } as AiProvider & ToolConversationProvider,
        500,
      ),
      job = {
        businessId: A,
        messageId: outbox[0]!.payload.messageId,
        correlationId: "ai:m2",
      };
    await worker.process(job);
    await worker.process(job);
    expect(calls).toHaveLength(1);
    expect(
      await db.sql`select outbound_id from outbound_commands where source_message_id=${job.messageId}`,
    ).toHaveLength(1);
  });

  test("generates monotonic summaries from ordered raw history without blocking responses", async () => {
    const inbound = new PostgresInboundHandler(pools),
      aiCalls: any[] = [],
      ai = new PostgresAiJobProcessor(
        pools,
        {
          generate: async () => { throw new Error('Unexpected generate'); },
          converse: async (request) => {
            aiCalls.push(request);
            return { message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: "id", usageTokens: 1 };
          },
        } as AiProvider & ToolConversationProvider,
        300,
      );
    await inbound.handle(
      event({
        providerMessageId: "summary-1",
        remoteJid: "summary@s.whatsapp.net",
        text: "primero " + "x".repeat(380),
      }),
    );
    const first = (
        await db.sql<
          { id: string; conversation_id: string }[]
        >`select id,conversation_id from messages where provider_message_id='summary-1'`
      )[0]!,
      job = {
        businessId: A,
        messageId: first.id,
        correlationId: "ai:summary-1",
      },
      plan = await ai.planSummary(job);
    expect(plan).toMatchObject({
      businessId: A,
      conversationId: first.conversation_id,
      coveredThrough: 1,
    });
    await makeEligible();
    await ai.process(job);
    expect(aiCalls).toHaveLength(1);
    const requests: any[] = [],
      summaries = new PostgresSummaryJobProcessor(pools, {
        summarize: async (request) => {
          requests.push(request);
          return {
            facts: [`turnos:${request.messages.length}`],
            requests: [],
            commitments: [],
            preferences: [],
            openItems: [],
          };
        },
      });
    expect(await summaries.process(plan!)).toBe("updated");
    expect(await summaries.process(plan!)).toBe("stale");
    await inbound.handle(
      event({
        providerMessageId: "summary-2",
        remoteJid: "summary@s.whatsapp.net",
        text: "segundo descubierto",
      }),
    );
    const second = (
        await db.sql<
          { id: string }[]
        >`select id from messages where provider_message_id='summary-2'`
      )[0]!,
      plan2 = await ai.planSummary({
        businessId: A,
        messageId: second.id,
        correlationId: "ai:summary-2",
      });
    await makeEligible();
    await ai.process({
      businessId: A,
      messageId: second.id,
      correlationId: "ai:summary-2",
    });
    expect(aiCalls).toHaveLength(2);
    expect(await db.sql`select outbound_id from outbound_commands where source_message_id in (${first.id},${second.id})`).toHaveLength(2);
    expect(await summaries.process(plan2!)).toBe("updated");
    expect(requests[1]).toMatchObject({
      prior: { facts: ["turnos:1"] },
      messages: [{ sequence: 2, text: "segundo descubierto" }],
    });
    const rows = await db.sql<
      { version: number; covered_through: string }[]
    >`select version,covered_through from conversation_summaries where conversation_id=${first.conversation_id} order by version`;
    expect(rows.map((r) => [r.version, Number(r.covered_through)])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(
      await db.sql`select raw_text from messages where conversation_id=${first.conversation_id}`,
    ).toHaveLength(2);
    expect(await summaries.process({ ...plan2!, businessId: B })).toBe("stale");
  });

  test("contains summary timeout, preserves the prior version and permits durable retry", async () => {
    const inbound = new PostgresInboundHandler(pools);
    await inbound.handle(
      event({
        providerMessageId: "summary-3",
        remoteJid: "summary-failure@s.whatsapp.net",
        text: "tercero " + "z".repeat(200),
      }),
    );
    const row = (
        await db.sql<
          { id: string; conversation_id: string }[]
        >`select id,conversation_id from messages where provider_message_id='summary-3'`
      )[0]!,
      ai = new PostgresAiJobProcessor(
        pools,
        {
          generate: async () => { throw new Error('Unexpected generate'); },
          converse: async () => ({ message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: 'id', usageTokens: 1 }),
        } as AiProvider & ToolConversationProvider,
        40,
      ),
      plan = await ai.planSummary({
        businessId: A,
        messageId: row.id,
        correlationId: "retry-summary",
      });
    await db.sql`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) values(${A},${row.conversation_id},1,0,${db.sql.json({ facts: ["estado previo"], requests: [], commitments: [], preferences: [], openItems: [] })})`;
    const failing = new PostgresSummaryJobProcessor(pools, {
      summarize: async () => {
        throw new Error("provider timeout secret");
      },
    });
    await expect(failing.process(plan!)).rejects.toThrow();
    expect(
      await db.sql`select version from conversation_summaries where conversation_id=${row.conversation_id}`,
    ).toHaveLength(1);
    expect(
      await db.sql`select id from technical_events where code='ai.summary_failed' and business_id=${A}`,
    ).toHaveLength(1);
    await db.sql`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) values(${A},${row.conversation_id},2,0,${db.sql.json({ facts: [] })})`;
    const contexts: any[] = [],
      current = new PostgresAiJobProcessor(
        pools,
        {
          generate: async () => { throw new Error('Unexpected generate'); },
          converse: async (request) => {
            contexts.push(JSON.parse(request.messages[1]!.content!));
            return { message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: "id", usageTokens: 1 };
          },
        } as AiProvider & ToolConversationProvider,
        500,
      );
    await makeEligible();
    await current.process({
      businessId: A,
      messageId: row.id,
      correlationId: "current-response",
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].summary.facts).toEqual(['estado previo']);
    expect((await db.sql`select structured_summary from conversation_summaries where conversation_id=${row.conversation_id} and version=1`)[0]!.structured_summary.facts).toEqual(["estado previo"]);
    expect(
      await db.sql`select outbound_id from outbound_commands where source_message_id=${row.id}`,
    ).toHaveLength(1);
    const retry = new PostgresSummaryJobProcessor(pools, {
      summarize: async () => ({
        facts: ["recuperado"],
        requests: [],
        commitments: [],
        preferences: [],
        openItems: [],
      }),
    });
    expect(await retry.process(plan!)).toBe("updated");
    expect(await retry.process(plan!)).toBe("stale");
    expect(
      (
        await db.sql<
          { version: number; covered_through: string }[]
        >`select version,covered_through from conversation_summaries where conversation_id=${row.conversation_id} order by version`
      ).map((value) => [value.version, Number(value.covered_through)]),
    ).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
    ]);
  });

  test("native context retains complete long groups, instructions and manual suffix boundaries", async () => {
    const inbound = new PostgresInboundHandler(pools);
    const remoteJid = 'full-group@s.whatsapp.net';
    const texts = Array.from({ length: 55 }, (_, index) => index === 0 ? ' \t' + '😀'.repeat(9000) + '\n ' : `input-${index}`);
    for (const [index, text] of texts.entries())
      await inbound.handle(event({ providerMessageId: `full-${index}`, remoteJid, text }));
    const row = (await db.sql`select id,conversation_id from messages where provider_message_id='full-54'`)[0]!;
    const content = { facts: ['previous'], requests: [], commitments: [], preferences: [], openItems: [] };
    await db.sql`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) values(${A},${row.conversation_id},1,54,${db.sql.json(content)}),( ${A},${row.conversation_id},2,55,${db.sql.json({ facts: [] })})`;
    const additionalInstructions = ' \n\tGlobal Atención 😀  ';
    await pools.admin.run(undefined, r => r.updatePlatformAiInstructions(additionalInstructions));
    const payloads: any[] = [];
    const worker = new PostgresAiJobProcessor(pools, { generate: async () => { throw new Error('Unexpected generate'); }, converse: async request => {
      payloads.push(request);
      return { message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: 'native-mock', usageTokens: 1 };
    } } as AiProvider & ToolConversationProvider);
    await makeEligible();
    const context = tenantContext({ businessId: A, actorId: 'test', role: 'internal_worker', requestId: 'full-source' });
    const source = await pools.worker.run(context, r => r.loadAiMessage(row.id, true));
    expect(source!.currentGroup.map(turn => turn.raw_text)).toEqual(texts);
    expect(source!.summaries.find(summary => summary.version === 1)!.structured_summary).toEqual(content);
    await worker.process({ businessId: A, messageId: row.id, correlationId: 'full' });
    expect(payloads).toHaveLength(1);
    const chunks = payloads[0].messages.map((message: any) => {
      try { return JSON.parse(message.content); } catch { return null; }
    }).filter((value: any) => value?.section === 'currentInput');
    expect(JSON.parse(chunks.map((chunk: any) => chunk.text).join('')).text).toBe(texts.join('\n'));
    expect(JSON.stringify(payloads[0])).toContain('Global Atención');
    expect(JSON.stringify(payloads[0])).not.toMatch(/STYLE-B|SECRETO-B/);
    expect((await db.sql`select text from outbound_commands where source_message_id=${row.id}`)[0]!.text).toBe('¿Podés aclarar qué necesitás?');
    expect(await db.sql`select id from messages where conversation_id=${row.conversation_id}`).toHaveLength(55);
    await worker.process({ businessId: B, messageId: row.id, correlationId: 'foreign' });
    expect(payloads).toHaveLength(1);
    await inbound.handle(event({ providerMessageId: 'full-manual', remoteJid, fromMe: true, text: 'manual closure' }));
    for (const [index, text] of ['next-one', 'next-two'].entries())
      await inbound.handle(event({ providerMessageId: `full-next-${index}`, remoteJid, text }));
    const latest = (await db.sql`select id from messages where provider_message_id='full-next-1'`)[0]!;
    await makeEligible();
    const suffix = await pools.worker.run(context, r => r.loadAiMessage(latest.id, true));
    expect(suffix!.currentGroup.map(turn => turn.raw_text)).toEqual(['next-one', 'next-two']);
    expect(suffix!.turns.map(turn => turn.raw_text)).toEqual([...texts, 'manual closure', 'next-one', 'next-two']);
    expect(suffix!.summaries.find(summary => summary.version === 1)!.structured_summary).toEqual(content);
    await worker.process({ businessId: A, messageId: latest.id, correlationId: 'suffix' });
    expect(payloads).toHaveLength(2);
    expect(payloads[1].messages.at(-1).content).toBe('next-one\nnext-two');
    expect((await db.sql`select text from outbound_commands where source_message_id=${latest.id}`)[0]!.text).toBe('¿Podés aclarar qué necesitás?');
    await pools.admin.run(undefined, r => r.updatePlatformAiInstructions(''));
    await db.sql`update outbox_events set published_at=now() where stable_key like 'ai:full-%'`;
  });

  test("derives closures from failure, manual identity and claimed source, not delayed sent sequence or legacy guesses", async () => {
    const inbound = new PostgresInboundHandler(pools);
    const context = tenantContext({ businessId: A, actorId: 'test', role: 'internal_worker', requestId: 'closure' });
    for (const kind of ['failure', 'provider-failure', 'superseded-failure', 'manual', 'claimed', 'unclaimed', 'legacy', 'legacy-unknown'] as const) {
      const remoteJid = `closure-${kind}@s.whatsapp.net`;
      const accept = async (suffix: string, text: string) => {
        await inbound.handle(event({ remoteJid, providerMessageId: `${kind}-${suffix}`, text }));
        return (await db.sql`select id,conversation_id from messages where provider_message_id=${`${kind}-${suffix}`}`)[0]!;
      };
      const first = await accept('first', 'prior');
      await makeEligible();
      if (kind === 'failure') await pools.worker.run(context, r => r.failAi(first.id, A, 'ai.timeout'));
      if (kind === 'provider-failure') {
        // A historical generation failure remains a closure even after retiring free replies.
        await pools.worker.run(context, r => r.failAi(first.id, A, 'ai.provider_unavailable'));
        expect((await db.sql`select processing_state from messages where id=${first.id}`)[0]!.processing_state).toBe('ai_failed');
        expect(await db.sql`select outbound_id from outbound_commands where conversation_id=${first.conversation_id}`).toHaveLength(0);
      }
      if (kind === 'manual') await inbound.handle(event({ remoteJid, providerMessageId: 'manual-closure', text: 'prior', fromMe: true }));
      let command: any;
      if (kind === 'claimed' || kind === 'unclaimed') {
        command = await pools.worker.run(context, r => r.saveGenerated(first.id, A, 'prior'));
        if (kind === 'claimed') {
          await db.sql`update outbound_commands set state='failed' where state='generated' and outbound_id<>${command.outbound_id}`;
          const claimed = await pools.manager.run(context, r => r.claimOwnedOutbound('manager-1', [OWNERSHIP]));
          expect(claimed?.outbound_id).toBe(command.outbound_id);
        }
      }
      if (kind.startsWith('legacy')) {
        command = (await db.sql`insert into outbound_commands(business_id,conversation_id,connection_id,text,state,send_started_at,provider_message_id) values(${A},${first.conversation_id},${CA},'prior','sent',now(),${kind === 'legacy' ? 'legacy-ack' : null}) returning outbound_id`)[0]!;
      }
      const latest = await accept('latest', ' \tcurrent\n ');
      if (kind === 'superseded-failure') await pools.worker.run(context, r => r.failAi(first.id, A, 'ai.timeout'));
      if (kind === 'claimed') await pools.manager.run(context, r => r.finishOutbound(command.outbound_id, 'sent', 'delayed-ack', OWNERSHIP));
      if (kind.startsWith('legacy')) await db.sql`insert into messages(business_id,conversation_id,connection_id,provider_message_id,sequence,direction,raw_text,received_at,processing_state) values(${A},${first.conversation_id},${CA},${kind === 'legacy' ? 'legacy-ack' : 'unknown-ack'},3,'outbound','prior',now(),'sent')`;
      await makeEligible();
      const source = await pools.worker.run(context, r => r.loadAiMessage(latest.id, true));
      const requests: any[] = [];
      await new PostgresAiJobProcessor(pools, { generate: async () => { throw new Error('Unexpected generate'); }, converse: async request => {
        requests.push(request);
        return { message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: 'test', usageTokens: 1 };
      } } as AiProvider & ToolConversationProvider).process({ businessId: A, messageId: latest.id, correlationId: kind });
      const closed = ['failure', 'provider-failure', 'manual', 'claimed'].includes(kind);
      expect(source!.currentGroup.map(turn => turn.raw_text).join('\n')).toBe(closed ? ' \tcurrent\n ' : 'prior\n \tcurrent\n ');
      expect(requests).toHaveLength(1);
      expect(requests[0].messages.at(-1).content).toBe(closed ? ' \tcurrent\n ' : 'prior\n \tcurrent\n ');
      expect(await pools.worker.run(context, r => r.loadAiMessage(first.id, true))).toBeNull();
      await db.sql`update outbox_events set published_at=now() where payload->>'messageId' in (${first.id},${latest.id})`;
    }
  });

  test("persists strict reset boundaries and retains initial pacing until a sent reply", async () => {
    const inbound = new PostgresInboundHandler(pools);
    await inbound.handle(event({ providerMessageId: 'boundary-start', remoteJid: 'boundary@s.whatsapp.net' }));
    for (const [index, gap, replied, delay] of [[1, 0, false, 600], [2, 0, true, 90], [3, 3600.001, true, 600]] as const) {
      await db.sql.begin(async tx => {
        await tx`update conversations set reply_due_at=null,last_reply_at=case when ${replied} then now()-interval '2 hours' else null end,last_exchange_at=now()-${gap}*interval '1 second' where remote_jid='boundary@s.whatsapp.net'`;
        await new PostgresRepositories(tx).ingestInbound({ businessId: A, connectionId: CA, providerId: `boundary-${index}`, remoteJid: 'boundary@s.whatsapp.net', text: 'medianoche', receivedAt: new Date('2026-01-01T00:00:00Z'), classification: 'accepted' });
        const row = (await tx`select extract(epoch from reply_due_at-last_exchange_at) seconds from conversations where remote_jid='boundary@s.whatsapp.net'`)[0]!;
        expect(Math.round(Number(row.seconds)*1000)).toBe(delay*1000);
      });
    }
    await db.sql`update outbox_events set published_at=now() where stable_key like 'ai:boundary-%'`;
  });

  test("groups ordered context, rejects stale work and preserves the latest job under contention", async () => {
    const inbound = new PostgresInboundHandler(pools);
    const accept = async (id: string, text: string) => {
      await inbound.handle(event({ providerMessageId: id, remoteJid: 'race@s.whatsapp.net', text }));
      const row = (await db.sql<{ id: string; conversation_id: string }[]>`select id,conversation_id from messages where provider_message_id=${id}`)[0]!;
      return { businessId: A, messageId: row.id, correlationId: id };
    };
    const first = await accept('race-1', 'uno');
    const second = await accept('race-2', 'dos');
    await makeEligible();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const requests: any[] = [];
    const run = pools.worker.run.bind(pools.worker);
    let reads = 0;
    pools.worker.run = async (context, fn) => {
      // Pause before the native transaction, not after its atomic response commits.
      if (context?.requestId === 'race-2' && ++reads === 2) { enter(); await gate; }
      return run(context, fn);
    };
    const worker = new PostgresAiJobProcessor(pools, { generate: async () => { throw new Error('Unexpected generate'); }, converse: async request => {
      requests.push(request);
      return { message: { role: 'assistant', content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: 'test', usageTokens: 1 };
    } } as AiProvider & ToolConversationProvider);
    await worker.process(first);
    expect(requests).toHaveLength(0);
    const context = tenantContext({ businessId: A, actorId: 'test', role: 'internal_worker', requestId: 'race-source' });
    expect((await pools.worker.run(context, r => r.loadAiMessage(second.messageId, true)))!.currentGroup.map(turn => turn.raw_text)).toEqual(['uno', 'dos']);
    const old = worker.process(second);
    await entered;
    const latest = await accept('race-3', 'tres');
    expect((await pools.worker.run(context, r => r.loadAiMessage(latest.messageId, true)))!.currentGroup.map(turn => turn.raw_text)).toEqual(['uno', 'dos', 'tres']);
    // Its persisted deadline was already due; ingestion must not slide it.
    const reserve = pools.worker.reserveAdvisoryLock.bind(pools.worker);
    let contention!: () => void;
    const contended = new Promise<void>(resolve => { contention = resolve; });
    pools.worker.reserveAdvisoryLock = async (key, wait) => {
      const release = await reserve(key);
      if (!release && wait) { contention(); return reserve(key, true); }
      return release;
    };
    const waiting = worker.process(latest);
    await contended; // Observe an actual failed PostgreSQL lock attempt, not a timing guess.
    finish();
    await Promise.all([old, waiting]);
    pools.worker.reserveAdvisoryLock = reserve;
    pools.worker.run = run;
    expect(requests).toHaveLength(1);
    expect(requests.at(-1).messages.at(-1).content).toBe('uno\ndos\ntres');
    expect(await db.sql`select outbound_id from outbound_commands where source_message_id=${second.messageId}`).toHaveLength(0);
    expect(await db.sql`select outbound_id from outbound_commands where source_message_id=${latest.messageId} and state='generated'`).toHaveLength(1);
    await worker.process({ ...latest, businessId: B });
    expect(requests).toHaveLength(1);

    const fourth = await accept('race-4', 'cuatro');
    const sent: string[] = [];
    const dispatcher = new PostgresOutboundDispatcher(pools, { send: async command => {
      sent.push(command.text);
      // The atomic claim already happened: this new inbound cannot retract it.
      await accept('race-5', 'cinco');
      return { outcome: 'ack', providerMessageId: 'race-ack' };
    } }, 'manager-1', () => [OWNERSHIP]);
    // Older unrelated test commands are still generated; make this assertion isolated.
    await db.sql`update outbound_commands set state='failed' where state='generated' and source_message_id<>${latest.messageId}`;
    expect(await dispatcher.dispatchNext()).toBe(false);
    expect(sent).toHaveLength(0);
    await worker.process(fourth);
    expect(await dispatcher.dispatchNext()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('¿Podés aclarar qué necesitás?');
    expect(await dispatcher.dispatchNext()).toBe(false);
    const conversation = (await db.sql<{ id: string }[]>`select id from conversations where remote_jid='race@s.whatsapp.net'`)[0]!;
    expect((await db.sql`select state from outbound_commands where source_message_id=${latest.messageId}`)[0]!.state).toBe('failed');
    // Successful delivery is activity, but an already-open initial burst retains its deadline.
    await db.sql`update conversations set reply_due_at=null where id=${conversation.id}`;
    await accept('race-6', 'activo');
    const active = (await db.sql`select reply_due_at,last_exchange_at from conversations where id=${conversation.id}`)[0]!;
    expect(new Date(active.reply_due_at).getTime()-new Date(active.last_exchange_at).getTime()).toBe(90_000);

    const published: object[] = [];
    const restarted = new AiOutboxDispatcher(pools, { send: async (_name, data) => { published.push(data!); return 'test'; } });
    await db.sql`update outbox_events set published_at=now() where published_at is null and stable_key<>'ai:race-6'`;
    expect(await restarted.dispatchBatch()).toBe(0);
    await makeEligible();
    expect(await restarted.dispatchBatch()).toBe(1);
    expect(published).toHaveLength(1);
  });

  test("live global policy changes affect new bursts, never pending deadlines or their outbox schedule", async () => {
    const inbound = new PostgresInboundHandler(pools);
    const remoteJid = "configured-pace@s.whatsapp.net";
    const policy = { initialDelaySeconds: 17, activeDelaySeconds: 4, inactivityResetSeconds: 20 };
    const read = async (providerId: string) => (await db.sql`select c.reply_due_at,c.last_exchange_at,o.next_attempt_at,o.published_at
      from conversations c join messages m on m.conversation_id=c.id
      join outbox_events o on o.payload->>'messageId'=m.id::text
      where m.provider_message_id=${providerId}`)[0]!;
    try {
      await pools.admin.run(undefined, r => r.updatePlatformAiInstructions("", policy));
      await inbound.handle(event({ remoteJid, providerMessageId: "configured-1", receivedAt: Date.parse("2099-01-01") }));
      const first = await read("configured-1");
      expect(first.reply_due_at.getTime() - first.last_exchange_at.getTime()).toBe(17_000);
      expect(first.next_attempt_at).toEqual(first.reply_due_at);
      expect(first.last_exchange_at.getUTCFullYear()).not.toBe(2099);
      await pools.admin.run(undefined, r => r.updatePlatformAiInstructions("", { ...policy, initialDelaySeconds: 0, activeDelaySeconds: 0 }));
      expect(await read("configured-1")).toEqual(first);
      await inbound.handle(event({ remoteJid, providerMessageId: "configured-2", receivedAt: 0 }));
      const pending = await read("configured-2");
      expect(pending.reply_due_at).toEqual(first.reply_due_at);
      expect(pending.next_attempt_at).toEqual(first.reply_due_at);
      expect((await read("configured-1")).next_attempt_at).toEqual(first.next_attempt_at);
      // A genuinely new conversation sees the zero wait immediately with the same long-lived handler.
      await inbound.handle(event({ remoteJid: "configured-zero@s.whatsapp.net", providerMessageId: "configured-zero" }));
      const zero = await read("configured-zero");
      expect(zero.reply_due_at).toEqual(zero.last_exchange_at);
      expect(zero.next_attempt_at).toEqual(zero.reply_due_at);
      await pools.admin.run(undefined, r => r.updatePlatformAiInstructions("", policy));
      for (const [suffix, gap, delay] of [["active", 10, 4_000], ["reset", 21, 17_000]] as const) {
        const jid = `configured-${suffix}@s.whatsapp.net`;
        await db.sql`insert into conversations(business_id,connection_id,remote_jid,last_reply_at,last_exchange_at)
          values(${A},${CA},${jid},now()-interval '1 hour',clock_timestamp()-${gap}*interval '1 second')`;
        await inbound.handle(event({ remoteJid: jid, providerMessageId: `configured-${suffix}`, receivedAt: 0 }));
        const current = await read(`configured-${suffix}`);
        expect(current.reply_due_at.getTime() - current.last_exchange_at.getTime()).toBe(delay);
        expect(current.next_attempt_at).toEqual(current.reply_due_at);
      }
    } finally {
      await pools.admin.run(undefined, r => r.updatePlatformAiInstructions("", { initialDelaySeconds: 600, activeDelaySeconds: 90, inactivityResetSeconds: 3600 }));
      await db.sql`update outbox_events set published_at=now() where stable_key like 'ai:configured-%'`;
    }
  });
});

// One disposable database per case: never wake legacy fixtures or another source's job.
describe("bounded generation retries through real pg-boss work", () => {
  for (const mode of ["transient", "superseded", "permanent", "rejection"] as const) {
    test(`${mode}: same published job, bounded attempts, atomic effects and source fence`, async () => {
      const db = await startTestPostgres();
      const pools = createRuntimePools(db.container.getConnectionUri());
      const boss = new PgBoss({ connectionString: db.container.getConnectionUri(), schema: "pgboss", createSchema: false });
      try {
      await applyPostgresMigrations(db.sql, join(import.meta.dir, "../../packages/db/migrations"));
      await boss.start();
      const business = randomUUID(), connection = randomUUID(), session = randomUUID();
      const service = randomUUID(), resource = randomUUID(), queue = `t8-${mode}`;
      const phone = "+5491123456789", remoteJid = "5491123456789@s.whatsapp.net";
      const text = "quería cancelar mi turno";
      const schedule = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [day, [{ startMinute: 540, endMinute: 1080 }]]));
      await db.sql`insert into businesses(id,name) values(${business},'Retry fixture')`;
      await db.sql`insert into assistant_configs(business_id,active,style,business_instructions) values(${business},true,'Breve','Agenda')`;
      await db.sql`insert into business_profiles(business_id,display_name) values(${business},'Retry fixture')`;
      await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state) values(${connection},${business},${session},'CONNECTED')`;
      await db.sql`insert into business_calendars(business_id,weekly_schedule) values(${business},${db.sql.json(schedule)})`;
      await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars) values(${service},${business},'Corte',30,1500)`;
      await db.sql`insert into resources(id,business_id,name,weekly_schedule) values(${resource},${business},'Ana',${db.sql.json(schedule)})`;
      await db.sql`insert into resource_services(business_id,resource_id,service_id) values(${business},${resource},${service})`;
      const context = tenantContext({ businessId: business, actorId: "test", role: "internal_worker", requestId: queue });
      const appointment = await pools.api.run(context, r => r.createAppointment(business, {
        serviceId: service, resourceId: resource, startRaw: "2035-04-02T11:00:00-03:00",
        newClient: { firstName: "María", lastName: "Pérez", phone },
      }, { now: "2035-04-01T08:00:00-03:00", origin: "manual" }));
      const receive = async (suffix: string) => {
        const providerMessageId = `${queue}-${suffix}`;
        expect((await new PostgresInboundHandler(pools).handle(event({ sessionPublicId: session, providerMessageId,
          remoteJid, text, senderEvidence: { phone, pnJid: remoteJid, lidJid: null } }))).outcome).toBe("accepted");
        return (await db.sql`select id,conversation_id from messages where business_id=${business} and provider_message_id=${providerMessageId}`)[0]!;
      };
      const source = await receive("old"), correlationId = `ai:${queue}-old`;
      await db.sql`update conversations set reply_due_at=now()-interval '1 second' where id=${source.conversation_id}`;
      await db.sql`update outbox_events set next_attempt_at=now()-interval '1 second' where stable_key=${correlationId}`;
      // Deliberately conflicting queue defaults prove send-level options win.
      await boss.createQueue(queue, { retryLimit: 0, retryDelay: 99, retryBackoff: false });
      expect(await new AiOutboxDispatcher(pools, boss, { queueName: queue, batchSize: 1 }).dispatchBatch()).toBe(1);
      const outbox = (await db.sql`select id,payload,published_at,claim_token from outbox_events where stable_key=${correlationId}`)[0]!;
      expect(outbox.published_at).not.toBeNull();
      expect(outbox.claim_token).toBeNull();
      const job = (await db.sql`select id,data,singleton_key,retry_limit,retry_delay,retry_backoff from pgboss.job where name=${queue} and id=${outbox.id}`)[0]!;
      expect(job).toEqual({ id: outbox.id, data: { ...outbox.payload, correlationId }, singleton_key: correlationId,
        retry_limit: 2, retry_delay: 5, retry_backoff: true });

      const effects = async () => (await db.sql`select
        (select count(*)::int from outbound_commands where source_message_id=${source.id}) outputs,
        (select count(*)::int from whatsapp_agenda_receipts where message_id=${source.id}) receipts,
        (select count(*)::int from outbox_events where topic='appointment.changed' and payload->>'sourceMessageId'=${source.id}) effects`)[0]!;
      const attempts: { id: string; data: unknown; retry: number }[] = [];
      const staged: string[] = [], correlations: string[] = [];
      let enter!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const provider: AiProvider & ToolConversationProvider = {
        generate: async () => { throw new Error("Unexpected generate"); },
        converse: async request => {
          correlations.push(request.correlationId);
          const last = request.messages.at(-1)!;
          const call = (id: string, name: string, args: NonNullable<ToolAssistantMessage["toolCalls"]>[number]["arguments"]) => ({ message: { role: "assistant" as const, content: null,
            toolCalls: [{ id, name, arguments: args }] }, providerId: "retry-double", usageTokens: 1 });
          if (last.role !== "tool") return mode === "rejection"
            ? call("cancel", "cancel", { appointmentId: randomUUID() })
            : call("inspect", "owned_appointment", { appointmentId: appointment.id });
          const result = JSON.parse(last.content!);
          if (last.toolCallId === "inspect") return call("cancel", "cancel", { appointmentId: appointment.id,
            binding: { evidence: text, evidenceReference: result.data.cancellationReference } });
          staged.push(result.status);
          if (mode !== "rejection" && (attempts.length === 1 || mode === "permanent"))
            throw new Error("isolated provider failure after staged cancellation");
          return { message: { role: "assistant", content: '{"kind":"reply","ask":"clarify"}', toolCalls: [] }, providerId: "retry-double", usageTokens: 1 };
        },
      };
      const processor = new PostgresAiJobProcessor(pools, provider);
      const workerId = await boss.work<{ businessId: string; messageId: string; correlationId: string }, void,
        { includeMetadata: true; pollingIntervalSeconds: number }>(queue,
        { includeMetadata: true, pollingIntervalSeconds: 60 }, async jobs => {
          const current = jobs[0]!;
          attempts.push({ id: current.id, data: current.data, retry: current.retryCount });
          enter();
          await processor.process(current.data); // pg-boss itself catches throws and schedules retries.
        });
      const state = async (expected: string, retryCount?: number) => {
        const deadline = Date.now() + 4_000;
        let current;
        do {
          current = (await db.sql`select state,retry_count,start_after>now() scheduled from pgboss.job where name=${queue} and id=${job.id}`)[0]!;
          if (current.state === expected && (retryCount === undefined || current.retry_count === retryCount)) return current;
          await Bun.sleep(10);
        } while (Date.now() < deadline);
        throw new Error(`Expected ${expected}, observed ${JSON.stringify(current)}`);
      };
      const retry = async (count: number) => {
        const waiting = await state("retry", count);
        expect(waiting).toMatchObject({ retry_count: count, scheduled: true });
        const changed = await db.sql`update pgboss.job set start_after=now()-interval '1 second'
          where name=${queue} and id=${job.id} and state='retry' returning id`;
        expect(changed.map(r => r.id)).toEqual([job.id]);
        boss.notifyWorker(workerId); // 12.28.0 takes work()'s worker ID, not the queue name.
      };
      try {
        await Promise.race([entered, Bun.sleep(4_000).then(() => { throw new Error("Worker did not enter"); })]);
        let newer: Awaited<ReturnType<typeof receive>> | undefined;
        if (mode !== "rejection") {
          await state("retry");
          expect(staged).toEqual(["staged_action"]);
          expect(await effects()).toEqual({ outputs: 0, receipts: 0, effects: 0 });
          expect((await db.sql`select state from appointments where id=${appointment.id}`)[0]!.state).toBe("confirmed");
          expect((await db.sql`select processing_state from messages where id=${source.id}`)[0]!.processing_state).toBe("pending");
          if (mode === "superseded") newer = await receive("new");
          await retry(0);
          if (mode === "permanent") await retry(1);
        }
        const terminal = await state(mode === "permanent" ? "failed" : "completed");
        const count = mode === "permanent" ? 3 : mode === "rejection" ? 1 : 2;
        expect(terminal.retry_count).toBe(count - 1);
        expect(attempts).toEqual(Array.from({ length: count }, (_, retry) => ({ id: job.id, data: job.data, retry })));
        expect(correlations.every(value => value === correlationId)).toBe(true);
        expect(staged).toEqual(mode === "permanent" ? ["staged_action", "staged_action", "staged_action"]
          : mode === "transient" ? ["staged_action", "staged_action"] : mode === "rejection" ? ["rejected"] : ["staged_action"]);
        const saved = mode === "transient";
        expect(await effects()).toEqual({ outputs: saved || mode === "rejection" ? 1 : 0, receipts: saved || mode === "rejection" ? 1 : 0, effects: saved ? 1 : 0 });
        expect(await db.sql`select id from audit_events where business_id=${business} and event_type='whatsapp.agenda.saved'`).toHaveLength(saved ? 1 : 0);
        expect((await db.sql`select state from appointments where id=${appointment.id}`)[0]!.state).toBe(saved ? "cancelled" : "confirmed");
        expect((await db.sql`select processing_state from messages where id=${source.id}`)[0]!.processing_state)
          .toBe(saved || mode === "rejection" ? "generated" : mode === "superseded" ? "superseded" : "pending");
        if (newer) {
          expect(correlations).toHaveLength(3); // Only the first attempt's inspect/cancel/failure; retry never calls provider.
          expect(await db.sql`select outbound_id from outbound_commands where source_message_id=${newer.id}`).toHaveLength(0);
          expect((await db.sql`select processing_state from messages where id=${newer.id}`)[0]!.processing_state).toBe("pending");
          expect(await db.sql`select id from pgboss.job where data->>'messageId'=${newer.id}`).toHaveLength(0);
        }
        if (saved || mode === "rejection") {
          const before = correlations.length;
          await processor.process(job.data); // Receipt/source fence also suppresses a duplicate delivery.
          expect(correlations).toHaveLength(before);
          expect(await effects()).toEqual({ outputs: 1, receipts: 1, effects: saved ? 1 : 0 });
          expect((await db.sql`select operation from whatsapp_agenda_receipts where message_id=${source.id}`)[0]!.operation).toBe(saved ? "cancel" : "receptionist");
          expect((await db.sql`select text from outbound_commands where source_message_id=${source.id}`)[0]!.text).toBe(saved
            ? `Cancelación guardada. Turno ${appointment.id}.`
            : "Indicá explícitamente si querés cancelar tu turno.");
        }
        expect(await db.sql`select id from pgboss.job where name=${queue}`).toHaveLength(1);
      } finally {
        await boss.offWork(queue, { id: workerId, wait: true });
      }
      } finally {
        await boss.stop();
        await pools.end();
        await db.stop();
      }
    }, 120_000);
  }
});
