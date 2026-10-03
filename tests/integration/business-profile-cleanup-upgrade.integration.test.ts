import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPostgresMigrations, startTestPostgres, type TestPostgres } from "../support/index.ts";

const directory = join(import.meta.dir, "../../packages/db/migrations");
const retired = ["contact", "faq", "policies", "additional_info"];
const legacyAssistant = ["personality", "tone", "instructions", "knowledge", "rules", "restrictions"];
const headings = ["Personalidad", "Tono", "Instrucciones", "Conocimiento", "Reglas", "Restricciones"];
function headed(row: Record<string, any>, start: number, end: number) {
  return legacyAssistant.slice(start, end).flatMap((key, offset) => row[key] === "" ? [] : [`${headings[start + offset]}:\n${row[key]}`]).join("\n\n");
}
async function assistantColumns(db: TestPostgres) {
  return (await db.sql`select column_name from information_schema.columns
    where table_schema='public' and table_name='assistant_configs' order by ordinal_position`).map(row => row.column_name);
}
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

test("fresh migrations retain the five-field profile and two-field assistant with activation defaults", async () => {
  const db = await startTestPostgres();
  try {
    await applyPostgresMigrations(db.sql, directory);
    const names = await columns(db);
    expect(names.filter(name => retired.includes(name))).toEqual([]);
    expect(names).toEqual(retained);
    const assistantNames = await assistantColumns(db);
    expect(assistantNames.filter(name => legacyAssistant.includes(name))).toEqual([]);
    expect(assistantNames).toContain("style");
    expect(assistantNames).toContain("business_instructions");
    const businessId = randomUUID();
    await db.sql`insert into businesses(id,name,status) values(${businessId},'Default assistant','active')`;
    await db.sql`insert into assistant_configs(business_id,active) values(${businessId},true)`;
    expect((await db.sql`select style,business_instructions,active,revision from assistant_configs`)[0]).toEqual({ style: "", business_instructions: "", active: true, revision: 0 });
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

test("populated upgrade consolidates every assistant text while preserving profiles, metadata, history and security", async () => {
  const db = await startTestPostgres();
  try {
    // Inventory succeeds before 0023 exists: RED must be a schema assertion, not ENOENT.
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
      ) values(${businessId},${index ? "😀".repeat(8_000) : ""},${index ? "😀".repeat(8_000) : " \n\t "},${index ? "😀".repeat(8_000) : "  Instructions\n"},
        ${index ? "😀".repeat(8_000) : ""},${index ? "😀".repeat(8_000) : "\tRules "},${index ? "😀".repeat(8_000) : "\nRestrictions\n"},${index === 0},7)`;
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
    const migration = names.find(name => name.startsWith("0023_"));
    if (migration) {
      const source = await readFile(join(directory, migration), "utf8");
      const beforeColumns = await assistantColumns(db);
      // SET ROLE restricts even a superuser session. Test zero and partial visibility.
      for (const tenantId of ["", businesses[0]!]) {
        await db.sql.begin(async tx => {
          await tx`set local role agendia_runtime`;
          await tx`select set_config('app.tenant_id',${tenantId},true)`;
          const visible = await tx`select business_id from assistant_configs`;
          expect(visible).toHaveLength(tenantId ? 1 : 0);
          await expect(tx.savepoint(async restricted => {
            await restricted.unsafe(source);
          })).rejects.toThrow("requires current_user with BYPASSRLS or superuser");
        });
        expect(await assistantColumns(db)).toEqual(beforeColumns);
        expect([...(await db.sql`select * from assistant_configs order by business_id`)]).toEqual([...assistants]);
        expect(await security(db)).toEqual(beforeSecurity);
      }
      // A successful conversion must remain rollbackable by an enclosing transaction.
      await expect(db.sql.begin(async tx => {
        await tx.unsafe(source);
        const names = await tx`select column_name from information_schema.columns
          where table_schema='public' and table_name='assistant_configs'`;
        expect(names.some(row => row.column_name === "style")).toBe(true);
        expect(names.some(row => row.column_name === "personality")).toBe(false);
        throw new Error("outer transaction rollback proof");
      })).rejects.toThrow("outer transaction rollback proof");
      expect(await assistantColumns(db)).toEqual(beforeColumns);
      expect([...(await db.sql`select * from assistant_configs order by business_id`)]).toEqual([...assistants]);
      expect(await security(db)).toEqual(beforeSecurity);
    }
    await db.sql.begin(async tx => {
      for (const name of names.filter(name => name >= "0022")) {
        await tx.unsafe(await readFile(join(directory, name), "utf8"));
      }
    });
    const afterColumns = await columns(db);
    expect(afterColumns.filter(name => retired.includes(name))).toEqual([]);
    expect(afterColumns).toEqual(retained);
    expect([...(await db.sql`select * from business_profiles order by business_id`)]).toEqual([...profiles]);
    expect((await assistantColumns(db)).filter(name => legacyAssistant.includes(name))).toEqual([]);
    const converted = await db.sql`select * from assistant_configs order by business_id`;
    expect([...converted]).toEqual(assistants.map(row => {
      const metadata = Object.fromEntries(Object.entries(row).filter(([key]) => !legacyAssistant.includes(key)));
      return { ...metadata, style: headed(row, 0, 2), business_instructions: headed(row, 2, 6) };
    }));
    expect([...(await db.sql`select * from conversations order by id`)]).toEqual([...conversations]);
    expect([...(await db.sql`select * from messages order by business_id,sequence`)]).toEqual([...history]);
    expect(await security(db)).toEqual(beforeSecurity);
  } finally {
    await db.stop();
  }
}, 120_000);
