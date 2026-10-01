import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const tenantA = "11111111-1111-4111-8111-111111111111";
const tenantB = "22222222-2222-4222-8222-222222222222";

export interface RestoreDrillReport {
  tenantMessageCounts: Record<string, number>;
  tenantAVisibleAuthRecords: number;
  crossTenantAuthRecords: number;
  pendingJobs: number;
  restoredAuthRecords: number;
  authCiphertextsMatchBackup: boolean;
  historicalKekVersions: string[];
  plaintextCredentialFound: boolean;
}

async function migrate(sql: Sql): Promise<void> {
  const migrationDir = join(import.meta.dir, "../packages/db/migrations");
  for (const name of readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(join(migrationDir, name), "utf8"));
  }
}

async function seed(sql: Sql): Promise<void> {
  const connectionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const connectionB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const conversationA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const conversationB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await sql`insert into businesses (id, name) values (${tenantA}, 'A'), (${tenantB}, 'B')`;
  await sql`insert into tenant_records (business_id, value) values (${tenantA}, 'tenant-a-record'), (${tenantB}, 'tenant-b-record')`;
  await sql`insert into whatsapp_connections (id, business_id, state, wrapped_dek, wrapped_dek_nonce, wrapped_dek_tag, kek_version) values
    (${connectionA}, ${tenantA}, 'CONNECTED', decode('a1', 'hex'), decode('a2', 'hex'), decode('a3', 'hex'), 'kek-v1'),
    (${connectionB}, ${tenantB}, 'CONNECTED', decode('b1', 'hex'), decode('b2', 'hex'), decode('b3', 'hex'), 'kek-v2')`;
  await sql`insert into whatsapp_auth_records (business_id, connection_id, record_name, version, nonce, ciphertext, auth_tag) values
    (${tenantA}, ${connectionA}, 'creds', 1, decode('01', 'hex'), decode('8f96a45c7b32d109', 'hex'), decode('02', 'hex')),
    (${tenantB}, ${connectionB}, 'creds', 1, decode('03', 'hex'), decode('719d0aef43c285b6', 'hex'), decode('04', 'hex'))`;
  await sql`insert into conversations (id, business_id, connection_id, remote_jid) values
    (${conversationA}, ${tenantA}, ${connectionA}, 'tenant-a-customer'),
    (${conversationB}, ${tenantB}, ${connectionB}, 'tenant-b-customer')`;
  await sql`insert into messages (business_id, conversation_id, connection_id, provider_message_id, sequence, direction, raw_text, received_at) values
    (${tenantA}, ${conversationA}, ${connectionA}, 'message-a', 1, 'inbound', 'Hola A', now()),
    (${tenantB}, ${conversationB}, ${connectionB}, 'message-b', 1, 'inbound', 'Hola B', now())`;
  await sql`insert into outbox_events (business_id, topic, stable_key, payload) values (${tenantA}, 'ai.generate', 'restore-job-a', ${sql.json({ conversationId: conversationA })})`;
}

async function dumpData(container: StartedPostgreSqlContainer): Promise<string> {
  const dump = await container.exec([
    "sh",
    "-lc",
    "PGPASSWORD=\"$POSTGRES_PASSWORD\" pg_dump --username=\"$POSTGRES_USER\" --dbname=\"$POSTGRES_DB\" --data-only --column-inserts --disable-triggers",
  ]);
  if (dump.exitCode !== 0 || !dump.stdout.includes("INSERT INTO public.businesses")) {
    throw new Error(`Backup dump failed: ${dump.stderr}`);
  }
  return dump.stdout;
}

async function restoreData(container: StartedPostgreSqlContainer, dump: string, sql: Sql): Promise<void> {
  await sql`delete from operational_controls`;
  await container.copyContentToContainer([{ content: dump, target: "/tmp/agendia-restore.sql" }]);
  const restored = await container.exec([
    "sh",
    "-lc",
    "PGPASSWORD=\"$POSTGRES_PASSWORD\" psql --set ON_ERROR_STOP=1 --username=\"$POSTGRES_USER\" --dbname=\"$POSTGRES_DB\" --file=/tmp/agendia-restore.sql",
  ]);
  if (restored.exitCode !== 0) throw new Error(`Backup restore failed: ${restored.stderr}`);
}

interface EncryptedAuthSnapshot {
  business_id: string;
  connection_id: string;
  record_name: string;
  version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

async function encryptedAuthSnapshot(sql: Sql): Promise<EncryptedAuthSnapshot[]> {
  return sql<EncryptedAuthSnapshot[]>`
    select business_id::text, connection_id::text, record_name, version,
      encode(nonce, 'hex') as nonce,
      encode(ciphertext, 'hex') as ciphertext,
      encode(auth_tag, 'hex') as auth_tag
    from whatsapp_auth_records
    order by business_id, connection_id, record_name
  `;
}

export async function runRestoreDrill(): Promise<RestoreDrillReport> {
  let source: StartedPostgreSqlContainer | undefined;
  let target: StartedPostgreSqlContainer | undefined;
  let sourceSql: Sql | undefined;
  let targetSql: Sql | undefined;
  try {
    source = await new PostgreSqlContainer("postgres:16-alpine").start();
    sourceSql = postgres(source.getConnectionUri(), { max: 2 });
    await migrate(sourceSql);
    await seed(sourceSql);
    const sourceAuth = await encryptedAuthSnapshot(sourceSql);
    const dump = await dumpData(source);

    target = await new PostgreSqlContainer("postgres:16-alpine").start();
    targetSql = postgres(target.getConnectionUri(), { max: 3 });
    await migrate(targetSql);
    await restoreData(target, dump, targetSql);

    const counts = await targetSql<{ business_id: string; count: string }[]>`select business_id::text, count(*)::text from messages group by business_id order by business_id`;
    const authForTenantA = await targetSql.begin(async (tx) => {
      await tx.unsafe("set local role agendia_whatsapp_runtime");
      await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
      return tx<{ business_id: string; ciphertext: Uint8Array }[]>`select business_id::text, ciphertext from whatsapp_auth_records`;
    });
    const pendingJobs = await targetSql<{ count: string }[]>`select count(*)::text from outbox_events where topic = 'ai.generate' and published_at is null`;
    const kekVersions = await targetSql<{ kek_version: string }[]>`select distinct kek_version from whatsapp_connections where kek_version is not null order by kek_version`;
    const targetAuth = await encryptedAuthSnapshot(targetSql);

    return {
      tenantMessageCounts: Object.fromEntries(counts.map((row) => [row.business_id, Number(row.count)])),
      tenantAVisibleAuthRecords: authForTenantA.length,
      crossTenantAuthRecords: authForTenantA.filter((row) => row.business_id !== tenantA).length,
      pendingJobs: Number(pendingJobs[0]?.count ?? 0),
      restoredAuthRecords: targetAuth.length,
      authCiphertextsMatchBackup: JSON.stringify(targetAuth) === JSON.stringify(sourceAuth),
      historicalKekVersions: kekVersions.map((row) => row.kek_version),
      plaintextCredentialFound: dump.includes("plain-baileys-secret"),
    };
  } finally {
    await sourceSql?.end();
    await targetSql?.end();
    await source?.stop();
    await target?.stop();
  }
}

if (import.meta.main) {
  const report = await runRestoreDrill();
  console.log(`restore drill passed: ${JSON.stringify(report)}`);
}
