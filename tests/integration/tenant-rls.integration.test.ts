import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Sql } from "postgres";
import { tenantContext, withTenantTransaction } from "../../packages/db/src/tenant-context.ts";
import { applyPostgresMigrations, assertNonEmptyTenantRows, startTestPostgres, type TestPostgres } from "../../packages/test-support/src/index.ts";

let database: TestPostgres;
let admin: Sql;
const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  database = await startTestPostgres();
  admin = database.sql;
  await applyPostgresMigrations(admin, join(import.meta.dir, "../../packages/db/migrations"));
  await admin`insert into businesses (id, name) values (${tenantA}, 'A'), (${tenantB}, 'B')`;
  await admin`insert into tenant_records (business_id, value) values (${tenantA}, 'solo-a'), (${tenantB}, 'solo-b')`;
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

describe("forced tenant RLS", () => {
  test("fails closed without transaction context and leaves the pool clean", async () => {
    const rows = await admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_runtime");
      return tx`select value from tenant_records order by value`;
    });
    expect(rows.length).toBe(0);
  });

  test("returns only the server-derived tenant and rejects cross-tenant writes", async () => {
    const own = await withTenantTransaction(admin, tenantContext({ businessId: tenantA, actorId: "user-a", role: "business_user", requestId: "req-a" }),
      (tx) => tx<{ value: string }[]>`select value from tenant_records order by value`);
    expect(own.map((row) => row.value)).toEqual(["solo-a"]);

    const crossWrite = withTenantTransaction(admin, tenantContext({ businessId: tenantA, actorId: "user-a", role: "business_user", requestId: "req-b" }),
      (tx) => tx`insert into tenant_records (business_id, value) values (${tenantB}, 'intrusion')`);
    await expect(crossWrite).rejects.toThrow(/row-level security|policy/i);
  });

  test("keeps the administration role away from tenant content", async () => {
    const access = admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_admin_runtime");
      return tx`select value from tenant_records`;
    });
    await expect(access).rejects.toThrow(/permission denied/i);
  });

  test("deduplicates a provider event into one message and one durable effect", async () => {
    const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await admin`insert into whatsapp_connections (id, business_id) values (${connectionId}, ${tenantA})`;
    await admin`insert into conversations (id, business_id, connection_id, remote_jid) values (${conversationId}, ${tenantA}, ${connectionId}, '549111@s.whatsapp.net')`;
    const ingest = () => admin.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`insert into inbox_events (business_id, source, stable_key) values (${tenantA}, 'baileys', 'provider-1') on conflict do nothing returning id`;
      if (inserted.length === 0) return;
      await tx`insert into messages (business_id, conversation_id, connection_id, provider_message_id, sequence, direction, raw_text, received_at) values (${tenantA}, ${conversationId}, ${connectionId}, 'provider-1', 1, 'inbound', 'Hola', now())`;
      await tx`insert into outbox_events (business_id, topic, stable_key, payload) values (${tenantA}, 'ai.generate', 'ai:provider-1', ${tx.json({ conversationId, sequence: 1 })})`;
    });
    await Promise.all([ingest(), ingest()]);
    expect((await admin`select id from messages where provider_message_id = 'provider-1'`).length).toBe(1);
    expect((await admin`select id from outbox_events where stable_key = 'ai:provider-1'`).length).toBe(1);
  });

  test("persists outbound claims under the owning tenant and connection", async () => {
    const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const outboundId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await admin`insert into outbound_commands (outbound_id, business_id, conversation_id, connection_id, text, state) values (${outboundId}, ${tenantA}, ${conversationId}, ${connectionId}, 'Respuesta', 'generated')`;
    const own = await admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_whatsapp_runtime");
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      return tx<{ outbound_id: string }[]>`select outbound_id from outbound_commands`;
    });
    expect(own.map((row) => row.outbound_id)).toEqual([outboundId]);
    const crossTenant = await admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_whatsapp_runtime");
      await tx`select set_config('app.tenant_id', ${tenantB}, true)`;
      return tx`select outbound_id from outbound_commands`;
    });
    expect(crossTenant).toHaveLength(0);
  });

  test("projects safe technical activity for administration", async () => {
    const occurredAt = "2026-03-01T10:03:00.000Z";
    await admin`insert into technical_events (business_id, component, code, severity, safe_details, occurred_at) values (${tenantA}, 'whatsapp-manager', 'whatsapp.send_failed', 'error', ${admin.json({ outboundRef: 'out_abc' })}, ${occurredAt})`;
    const projection = await admin<{ last_technical_activity_at: Date }[]>`select last_technical_activity_at from businesses where id = ${tenantA}`;
    expect(projection[0]?.last_technical_activity_at.toISOString()).toBe(occurredAt);
  });

  test("reconstructs summary plus recent raw history after a database restart boundary", async () => {
    const connectionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await admin`insert into whatsapp_connections (id, business_id) values (${connectionId}, ${tenantB})`;
    await admin`insert into conversations (id, business_id, connection_id, remote_jid) values (${conversationId}, ${tenantB}, ${connectionId}, '549222@s.whatsapp.net')`;
    for (const [sequence, text] of [[1, "Primero"], [2, "Segundo"], [3, "Reciente"]] as const) {
      await admin`insert into messages (business_id, conversation_id, connection_id, provider_message_id, sequence, direction, raw_text, received_at) values (${tenantB}, ${conversationId}, ${connectionId}, ${`ctx-${sequence}`}, ${sequence}, 'inbound', ${text}, now())`;
    }
    await admin`insert into conversation_summaries (business_id, conversation_id, version, covered_through, structured_summary) values (${tenantB}, ${conversationId}, 1, 2, ${admin.json({ facts: ["Primero y segundo"] })})`;
    const raw = await admin<{ sequence: number; raw_text: string }[]>`select sequence, raw_text from messages where business_id = ${tenantB} and conversation_id = ${conversationId} order by sequence`;
    const summary = await admin<{ covered_through: number }[]>`select covered_through from conversation_summaries where business_id = ${tenantB} and conversation_id = ${conversationId}`;
    expect(raw.map((row) => row.raw_text)).toEqual(["Primero", "Segundo", "Reciente"]);
    expect(Number(summary[0]?.covered_through)).toBe(2);
  });

  test("rejects a vacuous tenant-isolation collection before evaluating every row", () => {
    expect(() => assertNonEmptyTenantRows([], tenantA)).toThrow(/non-empty/i);
    expect(() => assertNonEmptyTenantRows([{ business_id: tenantA }], tenantA)).not.toThrow();
  });

  test("denies cross-tenant data across every v1 repository boundary", async () => {
    const connectionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const connectionB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const conversationB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await admin`insert into business_profiles (business_id, display_name) values (${tenantA}, 'A'), (${tenantB}, 'B')`;
    await admin`insert into assistant_configs (business_id) values (${tenantA}), (${tenantB})`;
    await admin`insert into audit_events (business_id, actor_id, event_type, outcome, request_id, stream_sequence, previous_hash, event_hash, hmac_key_version) values
      (${tenantA}, 'worker', 'ai.failed', 'failure', 'req-audit-a', 1, 'GENESIS', ${"a".repeat(64)}, 'v1'),
      (${tenantB}, 'worker', 'ai.failed', 'failure', 'req-audit-b', 1, 'GENESIS', ${"b".repeat(64)}, 'v1')`;
    await admin`insert into technical_events (business_id, component, code, severity) values (${tenantB}, 'ai-provider', 'ai.failed', 'error')`;
    await admin`insert into whatsapp_auth_records (business_id, connection_id, record_name, version, nonce, ciphertext, auth_tag) values
      (${tenantA}, ${connectionA}, 'creds', 1, decode('00', 'hex'), decode('01', 'hex'), decode('02', 'hex')),
      (${tenantB}, ${connectionB}, 'creds', 1, decode('03', 'hex'), decode('04', 'hex'), decode('05', 'hex'))`;
    await admin`insert into outbound_commands (outbound_id, business_id, conversation_id, connection_id, text, state) values ('ffffffff-ffff-4fff-8fff-ffffffffffff', ${tenantB}, ${conversationB}, ${connectionB}, 'Respuesta B', 'generated')`;

    const queryAs = (role: string, table: string) => admin.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      return tx.unsafe<{ business_id: string }[]>(`select business_id::text from ${table} order by business_id`);
    });
    for (const table of ["business_profiles", "assistant_configs", "audit_events", "technical_events"]) {
      const rows = await queryAs("agendia_runtime", table);
      assertNonEmptyTenantRows(rows, tenantA);
    }
    for (const table of ["whatsapp_connections", "whatsapp_auth_records", "conversations", "messages", "outbound_commands"]) {
      const rows = await queryAs("agendia_whatsapp_runtime", table);
      assertNonEmptyTenantRows(rows, tenantA);
    }
    const adminContent = admin.begin(async (tx) => {
      await tx.unsafe("set local role agendia_admin_runtime");
      return tx`select raw_text from messages`;
    });
    await expect(adminContent).rejects.toThrow(/permission denied/i);
  });
});
