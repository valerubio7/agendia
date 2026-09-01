import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PgBoss } from "pg-boss";
import { createRuntimePools, tenantContext } from "@agendia/db";
import { DeepSeekAdapter } from "@agendia/ai-deepseek";
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
const SA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  SB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
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
  await db.sql`insert into business_profiles(business_id,display_name,offerings,business_hours) values(${A},'A','envíos','cerrado'),(${B},'B','SECRETO-B','cerrado')`;
  await db.sql`insert into assistant_configs(business_id,active,instructions) values(${A},true,'ayuda'),(${B},false,'no usar')`;
  await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state,owner_id) values(${CA},${A},${SA},'CONNECTED','manager-1'),(${CB},${B},${SB},'CONNECTED','manager-2')`;
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

describe("PostgreSQL messaging workers", () => {
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
      event({ providerMessageId: "own", fromMe: true }),
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
    expect(await db.sql`select raw_text from messages`).toHaveLength(1);
    expect(await db.sql`select stable_key from inbox_events`).toHaveLength(6);
    expect(
      await db.sql`select id from outbox_events where topic='ai.generate' and published_at is null`,
    ).toHaveLength(1);
    expect(await boss.fetch("ai-generate")).toHaveLength(0);
  });

  test("recovers committed ai outbox without direct queue publication", async () => {
    expect(
      await readFile(
        join(
          import.meta.dir,
          "../../apps/whatsapp-manager/src/inbound-handler.ts",
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

  test("builds tenant context from PostgreSQL and falls back without a required summary", async () => {
    const conversation = (
      await db.sql<
        { id: string }[]
      >`select id from conversations where business_id=${A}`
    )[0]!;
    await db.sql`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) values(${A},${conversation.id},1,0,${db.sql.json({ facts: ["cliente nuevo"], requests: [], commitments: [], preferences: [], openItems: [] })})`;
    const calls: string[] = [];
    const provider = new DeepSeekAdapter({
      apiKey: "test-only",
      fetcher: async (_u, i) => {
        calls.push(String(i?.body));
        return new Response(
          JSON.stringify({
            id: "d1",
            choices: [{ message: { content: "Llega mañana" } }],
          }),
          { status: 200 },
        );
      },
    });
    const worker = new PostgresAiJobProcessor(pools, provider, 500);
    await worker.process({
      businessId: A,
      messageId: (
        await db.sql<
          { id: string }[]
        >`select id from messages where provider_message_id='m1'`
      )[0]!.id,
      correlationId: "job-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("envíos");
    expect(calls[0]).not.toContain("SECRETO-B");
    expect(
      await db.sql`select outbound_id from outbound_commands`,
    ).toHaveLength(1);
    await db.sql`delete from conversation_summaries where business_id=${A}`;
    await db.sql`update messages set raw_text=repeat('x',800),processing_state='pending' where provider_message_id='m1'`;
    await worker.process({
      businessId: A,
      messageId: (
        await db.sql<
          { id: string }[]
        >`select id from messages where provider_message_id='m1'`
      )[0]!.id,
      correlationId: "job-2",
    });
    expect(calls).toHaveLength(2);
    expect(
      await db.sql`select id from technical_events where code='ai.context_unavailable'`,
    ).toHaveLength(0);
    await db.sql`insert into conversation_summaries(business_id,conversation_id,version,covered_through,structured_summary) values(${A},${conversation.id},2,0,${db.sql.json({ facts: [] })})`;
    await db.sql`update messages set raw_text='retry',processing_state='pending' where provider_message_id='m1'`;
    const timeout = new PostgresAiJobProcessor(
      pools,
      new DeepSeekAdapter({
        apiKey: "hidden",
        fetcher: async () => {
          throw new Error("timeout hidden");
        },
      }),
      500,
    );
    await timeout.process({
      businessId: A,
      messageId: (
        await db.sql<
          { id: string }[]
        >`select id from messages where provider_message_id='m1'`
      )[0]!.id,
      correlationId: "job-timeout",
    });
    expect(
      await db.sql`select id from technical_events where code='ai.timeout'`,
    ).toHaveLength(1);
    expect(
      await db.sql`select id from audit_events where event_type='ai.failed'`,
    ).toHaveLength(1);
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
          generate: async () => {
            calls.push("called");
            return { text: "ok", providerId: "id", usageTokens: 1 };
          },
        },
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
          generate: async (request) => {
            aiCalls.push(request);
            return { text: "ok", providerId: "id", usageTokens: 1 };
          },
        },
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
    await ai.process({
      businessId: A,
      messageId: second.id,
      correlationId: "ai:summary-2",
    });
    expect(aiCalls[1].context.summary).toContain("turnos:1");
    expect(aiCalls[1].context.recent).toEqual(["segundo descubierto"]);
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
          generate: async () => ({
            text: "fallback",
            providerId: "id",
            usageTokens: 1,
          }),
        },
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
          generate: async (request) => {
            contexts.push(request.context);
            return { text: "fallback", providerId: "id", usageTokens: 1 };
          },
        },
        500,
      );
    await current.process({
      businessId: A,
      messageId: row.id,
      correlationId: "current-response",
    });
    expect(contexts[0].summary).toContain("estado previo");
    expect(contexts[0].recent[0]).toContain("tercero");
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
});
