import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

const directory = join(import.meta.dir, "../../packages/db/migrations");
const retired = ["contact", "faq", "policies", "additional_info"];
const retained = ["business_id", "display_name", "description", "address", "business_hours", "offerings", "updated_at"];

async function columns(db: TestPostgres) {
  const rows = await db.sql`select column_name from information_schema.columns
    where table_schema='public' and table_name='business_profiles' order by ordinal_position`;
  return rows.map(row => row.column_name);
}

async function security(db: TestPostgres) {
  return {
    rls: await db.sql`select relname,relrowsecurity,relforcerowsecurity,relacl::text
      from pg_class where oid in ('business_profiles'::regclass,'assistant_configs'::regclass,'messages'::regclass)
      order by relname`,
    policies: await db.sql`select * from pg_policies where schemaname='public' order by tablename,policyname`,
    grants: await db.sql`select grantee,table_name,privilege_type,is_grantable
      from information_schema.table_privileges where table_schema='public'
      order by grantee,table_name,privilege_type`,
  };
}

test("fresh migrations remove only the four retired profile columns", async () => {
  const db = await startTestPostgres();
  try {
    await applyPostgresMigrations(db.sql, directory);
    const names = await columns(db);
    expect(names.filter(name => retired.includes(name))).toEqual([]);
    expect(names).toEqual(retained);
    const state = await security(db);
    expect(state.rls.find(row => row.relname === "business_profiles")).toMatchObject({
      relrowsecurity: true, relforcerowsecurity: true,
    });
    expect(state.policies.find(row => row.policyname === "business_profiles_tenant")).toMatchObject({
      cmd: "ALL", roles: ["agendia_runtime"],
    });
  } finally {
    await db.stop();
  }
}, 120_000);

test("populated upgrade preserves active profiles, assistant legacy data, full history and security", async () => {
  const db = await startTestPostgres();
  try {
    // Inventory succeeds before 0022 exists: RED must be a schema assertion, not ENOENT.
    const names = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
    for (const name of names.filter(name => name < "0022")) {
      await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
    }
    const businesses = [randomUUID(), randomUUID()];
    for (const [index, businessId] of businesses.entries()) {
      const connectionId = randomUUID(), conversationId = randomUUID();
      await db.sql`insert into businesses(id,name,status) values(${businessId},${`Business ${index}`},'active')`;
      await db.sql`insert into business_profiles(
        business_id,display_name,description,address,business_hours,offerings,
        contact,faq,policies,additional_info,updated_at
      ) values(${businessId},${`Name ${index}`},${`Description ${index}`},${`Address ${index}`},
        ${`Hours ${index}`},${`Offerings ${index}`},${`Contact ${index}`},${`FAQ ${index}`},
        ${`Policies ${index}`},${`Info ${index}`},'2025-01-01T00:00:00Z')`;
      await db.sql`insert into assistant_configs(
        business_id,personality,tone,instructions,knowledge,rules,restrictions,active,revision
      ) values(${businessId},${`Personality ${index}`},${`Tone ${index}`},${`Instructions ${index}`},
        ${`Knowledge ${index}`},${`Rules ${index}`},${`Restrictions ${index}`},${index === 0},7)`;
      await db.sql`insert into whatsapp_connections(id,business_id,session_public_id,state,owner_id)
        values(${connectionId},${businessId},${randomUUID()},'CONNECTED','cleanup-test')`;
      await db.sql`insert into conversations(id,business_id,connection_id,remote_jid)
        values(${conversationId},${businessId},${connectionId},${`history-${index}`})`;
      for (const [sequence, direction, text, state] of [
        [1, "inbound", "Customer history", "generated"],
        [2, "outbound", "Manual business history", "sent"],
      ] as const) {
        await db.sql`insert into messages(id,business_id,conversation_id,connection_id,
          provider_message_id,sequence,direction,raw_text,received_at,processing_state)
          values(${randomUUID()},${businessId},${conversationId},${connectionId},${randomUUID()},
            ${sequence},${direction},${`${text} ${index}`},'2025-01-01T00:00:00Z',${state})`;
      }
    }
    const profiles = await db.sql`select business_id,display_name,description,address,business_hours,offerings,updated_at
      from business_profiles order by business_id`;
    expect(profiles).toHaveLength(2);
    expect((await columns(db)).filter(name => retired.includes(name))).toEqual(retired);
    const assistants = await db.sql`select * from assistant_configs order by business_id`;
    const conversations = await db.sql`select * from conversations order by id`;
    const history = await db.sql`select * from messages order by business_id,sequence`;
    expect(history).toHaveLength(4);
    const beforeSecurity = await security(db);
    for (const name of names.filter(name => name >= "0022")) {
      await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
    }
    const afterColumns = await columns(db);
    expect(afterColumns.filter(name => retired.includes(name))).toEqual([]);
    expect(afterColumns).toEqual(retained);
    expect([...(await db.sql`select * from business_profiles order by business_id`)]).toEqual([...profiles]);
    expect([...(await db.sql`select * from assistant_configs order by business_id`)]).toEqual([...assistants]);
    expect([...(await db.sql`select * from conversations order by id`)]).toEqual([...conversations]);
    expect([...(await db.sql`select * from messages order by business_id,sequence`)]).toEqual([...history]);
    expect(await security(db)).toEqual(beforeSecurity);
  } finally {
    await db.stop();
  }
}, 120_000);
