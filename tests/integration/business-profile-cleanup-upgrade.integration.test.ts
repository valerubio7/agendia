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
const retained = ["business_id", "display_name", "description", "address", "updated_at"];
const obsoleteProfile = ["business_hours", "offerings"];

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
    grants: await db.sql<{ grantee: string; table_name: string; privilege_type: string; is_grantable: string }[]>`select grantee,table_name,privilege_type,is_grantable
      from information_schema.table_privileges where table_schema='public'
      order by grantee,table_name,privilege_type`,
  };
}

test("forward profile cleanup preserves structured catalog, calendars and resource schedules", async () => {
  const db = await startTestPostgres();
  try {
    const names = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
    for (const name of names.filter(name => name < "0034"))
      await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
    const businessId = randomUUID(), serviceId = randomUUID(), resourceId = randomUUID();
    const schedule = { 1: [{ startMinute: 540, endMinute: 1080 }] };
    await db.sql`insert into businesses(id,name) values(${businessId},'Upgrade fixture')`;
    await db.sql`insert into business_profiles(business_id,display_name,description,address,business_hours,offerings)
      values(${businessId},'Retained name','Retained description','Retained address','DELETE HOURS','DELETE OFFERINGS')`;
    await db.sql`insert into services(id,business_id,name,duration_minutes,price_ars)
      values(${serviceId},${businessId},'Structured service',30,1200)`;
    await db.sql`insert into business_calendars(business_id,weekly_schedule) values(${businessId},${db.sql.json(schedule)})`;
    await db.sql`insert into resources(id,business_id,name,weekly_schedule)
      values(${resourceId},${businessId},'Structured resource',${db.sql.json(schedule)})`;
    await db.sql`insert into resource_services(business_id,resource_id,service_id) values(${businessId},${resourceId},${serviceId})`;
    const snapshot = async () => ({
      profiles: await db.sql`select business_id,display_name,description,address,updated_at from business_profiles`,
      services: await db.sql`select * from services`,
      calendars: await db.sql`select * from business_calendars`,
      resources: await db.sql`select * from resources`,
      assignments: await db.sql`select * from resource_services`,
      security: await security(db),
    });
    const before = await snapshot();
    for (const name of names.filter(name => name >= "0034"))
      await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
    expect(await columns(db)).toEqual(retained);
    expect(await snapshot()).toEqual(before);
  } finally {
    await db.stop();
  }
}, 120_000);

test("fresh migrations retain the three-field profile and two-field assistant with activation defaults", async () => {
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
    // Missing forward migrations must fail schema assertions, not file reads.
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
    const profiles = await db.sql`select business_id,display_name,description,address,updated_at
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
    expect(afterColumns.filter(name => obsoleteProfile.includes(name))).toEqual([]);
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
    const removedGrant = { grantee: "agendia_whatsapp_runtime", table_name: "operational_controls", privilege_type: "SELECT", is_grantable: "NO" };
    expect(beforeSecurity.grants.filter(row => row.grantee === removedGrant.grantee &&
      row.table_name === removedGrant.table_name && row.privilege_type === removedGrant.privilege_type)).toEqual([removedGrant]);
    const afterSecurity = await security(db);
    expect(afterSecurity.rls).toEqual(beforeSecurity.rls);
    const newTables = ["services", "clients", "business_calendars", "business_calendar_closures",
      "resources", "resource_services", "appointments", "appointment_operation_receipts",
      "whatsapp_sender_bindings", "whatsapp_received_senders", "whatsapp_agenda_dialogues", "whatsapp_agenda_receipts"];
    const owners = await db.sql<{ owner: string }[]>`select current_user owner`;
    const owner = owners[0]!.owner;
    const expectedGrants: typeof beforeSecurity.grants[number][] = [];
    const grant = (grantee: string, tables: string[], privileges: string[], is_grantable = "NO") => {
      for (const table_name of tables) for (const privilege_type of privileges)
        expectedGrants.push({ grantee, table_name, privilege_type, is_grantable });
    };
    grant(owner, newTables, ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"], "YES");
    grant("agendia_runtime", newTables.slice(0, 5).concat("appointments"), ["SELECT", "INSERT", "UPDATE"]);
    grant("agendia_runtime", ["business_calendar_closures"], ["DELETE"]);
    grant("agendia_runtime", ["resource_services"], ["SELECT", "INSERT", "DELETE"]);
    grant("agendia_runtime", ["appointment_operation_receipts"], ["SELECT", "INSERT"]);
    grant("agendia_whatsapp_runtime", ["whatsapp_sender_bindings"], ["SELECT", "INSERT", "UPDATE"]);
    grant("agendia_whatsapp_runtime", ["whatsapp_received_senders"], ["INSERT"]);
    grant("agendia_worker_runtime", newTables.slice(0, 7).concat("whatsapp_sender_bindings", "whatsapp_received_senders"), ["SELECT"]);
    grant("agendia_worker_runtime", ["clients", "appointments", "outbox_events"], ["INSERT"]);
    grant("agendia_worker_runtime", ["appointments"], ["UPDATE"]);
    grant("agendia_worker_runtime", ["whatsapp_agenda_dialogues"], ["SELECT", "INSERT", "UPDATE"]);
    grant("agendia_worker_runtime", ["whatsapp_agenda_receipts"], ["SELECT", "INSERT"]);
    const key = (row: unknown) => JSON.stringify(row);
    expect(afterSecurity.grants.filter(row => !beforeSecurity.grants.some(old => key(old) === key(row))).map(key).sort())
      .toEqual(expectedGrants.map(key).sort());
    expect(beforeSecurity.grants.filter(row => !afterSecurity.grants.some(next => key(next) === key(row))))
      .toEqual([removedGrant]);
    const oldPolicies = new Set(beforeSecurity.policies.map(row => `${row.tablename}:${row.policyname}`));
    expect(afterSecurity.policies.filter(row => oldPolicies.has(`${row.tablename}:${row.policyname}`)))
      .toEqual(beforeSecurity.policies);
    const addedPolicies = afterSecurity.policies.filter(row => !oldPolicies.has(`${row.tablename}:${row.policyname}`));
    const expectedPolicies = newTables.slice(0, 7).map(table => `${table}:${table}_tenant:ALL:agendia_runtime`);
    expectedPolicies.push("appointment_operation_receipts:appointment_operation_owner:ALL:agendia_runtime");
    for (const table of newTables.slice(8)) for (const role of ["manager", "worker"])
      expectedPolicies.push(`${table}:tenant_${role}:ALL:agendia_${role === "manager" ? "whatsapp" : "worker"}_runtime`);
    for (const table of newTables.slice(0, 7)) expectedPolicies.push(`${table}:agenda_worker_read:SELECT:agendia_worker_runtime`);
    expectedPolicies.push("clients:agenda_worker_client_create:INSERT:agendia_worker_runtime",
      "appointments:agenda_worker_appointment_create:INSERT:agendia_worker_runtime",
      "appointments:agenda_worker_appointment_change:UPDATE:agendia_worker_runtime",
      "outbox_events:agenda_worker_outbox:INSERT:agendia_worker_runtime");
    expect(addedPolicies.map(row => `${row.tablename}:${row.policyname}:${row.cmd}:${row.roles.join(",")}`).sort())
      .toEqual(expectedPolicies.sort());
    const normalizePredicate = (value: string) => value.toLowerCase().replace(/::text|[()\s]/g, "");
    const tenantPredicate = normalizePredicate(beforeSecurity.policies.find(row => row.policyname === "business_profiles_tenant")!.qual);
    for (const policy of addedPolicies) {
      expect(policy.permissive).toBe("PERMISSIVE");
      const predicate = policy.policyname === "appointment_operation_owner"
        ? tenantPredicate + "andactor_id=nullifcurrent_setting'app.actor_id',true,''::uuidandcurrent_setting'app.actor_role',true='business_user'"
        : tenantPredicate;
      expect(policy.qual === null ? null : normalizePredicate(policy.qual))
        .toBe(policy.cmd === "INSERT" ? null : predicate);
      expect(policy.with_check === null ? null : normalizePredicate(policy.with_check))
        .toBe(policy.cmd === "SELECT" ? null : predicate);
    }
    const flags = await db.sql`select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any(${newTables})`;
    expect(flags).toHaveLength(newTables.length);
    expect(flags.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  } finally {
    await db.stop();
  }
}, 120_000);
