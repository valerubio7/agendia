import { expect, test } from "bun:test";
import { join } from "node:path";
import { createRuntimePools } from "@agendia/db";
import { DEFAULT_REPLY_PACING } from "@agendia/domain";
import { applyPostgresMigrations, startTestPostgres } from "../support/index.ts";

const directory = join(import.meta.dir, "../../packages/db/migrations");
const oldColumns = ["singleton", "automation_disabled", "incident_reference", "updated_at"];
const pacingColumns = ["initial_delay_seconds", "active_delay_seconds", "inactivity_reset_seconds"];
test("global operational singleton preserves metadata with least-privilege instruction persistence", async () => {
  const db = await startTestPostgres();
  const pools = createRuntimePools(db.container.getConnectionUri());
  try {
      await applyPostgresMigrations(db.sql, directory);
      expect([...await db.sql`select singleton,automation_disabled,incident_reference from operational_controls`])
        .toEqual([{ singleton: true, automation_disabled: false, incident_reference: null }]);
      await db.sql`update operational_controls set automation_disabled=true, incident_reference='Existing incident', updated_at='2025-01-01T00:00:00Z'`;
      expect((await db.sql`select to_regclass('public.platform_ai_instructions') as name`)[0]?.name).toBeNull();
      expect([...(await db.sql`select column_name,data_type,is_nullable,column_default from information_schema.columns
        where table_schema='public' and table_name='operational_controls' and column_name='additional_instructions'`)]).toEqual([
        { column_name: "additional_instructions", data_type: "text", is_nullable: "NO", column_default: "''::text" },
      ]);
      const metadata = [...await db.sql`select singleton,automation_disabled,incident_reference,updated_at from operational_controls`];
      expect(metadata).toHaveLength(1);
      expect(metadata[0]).toMatchObject({ singleton: true, automation_disabled: true, incident_reference: 'Existing incident', updated_at: new Date('2025-01-01T00:00:00Z') });
      expect(await pools.admin.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: "", replyPacing: DEFAULT_REPLY_PACING });
      const columns = [...await db.sql`select column_name,data_type,is_nullable,column_default from information_schema.columns
        where table_schema='public' and table_name='operational_controls' and column_name in ('initial_delay_seconds','active_delay_seconds','inactivity_reset_seconds') order by column_name`];
      expect(columns).toEqual([
        { column_name: "active_delay_seconds", data_type: "integer", is_nullable: "NO", column_default: "90" },
        { column_name: "inactivity_reset_seconds", data_type: "integer", is_nullable: "NO", column_default: "3600" },
        { column_name: "initial_delay_seconds", data_type: "integer", is_nullable: "NO", column_default: "600" },
      ]);
      const owner = (await db.sql`select current_user as name`)[0]!.name;
      for (const role of [owner, "agendia_runtime", "agendia_admin_runtime", "agendia_worker_runtime", "agendia_whatsapp_runtime"]) {
        for (const column of [...oldColumns, "additional_instructions", ...pacingColumns]) {
          const privileges = (await db.sql`select
            has_column_privilege(${role}, 'operational_controls', ${column}, 'SELECT') as read,
            has_column_privilege(${role}, 'operational_controls', ${column}, 'UPDATE') as write`)[0];
          expect(privileges).toEqual({
            read: role === owner || role === "agendia_worker_runtime" ||
              (role === "agendia_whatsapp_runtime" && column !== "additional_instructions") ||
              (role === "agendia_admin_runtime" && ["singleton", "additional_instructions", ...pacingColumns].includes(column)),
            write: role === owner || (role === "agendia_admin_runtime" && ["additional_instructions", ...pacingColumns].includes(column)),
          });
        }
      }
      expect(await db.sql`select grantee from information_schema.column_privileges
        where table_schema='public' and table_name='operational_controls' and grantee='PUBLIC'`).toHaveLength(0);
      await db.sql.begin(async tx => {
        await tx`set local role agendia_whatsapp_runtime`;
        expect([...await tx`select singleton,automation_disabled,incident_reference,updated_at from operational_controls where singleton`]).toEqual(metadata);
      });
      const raw = " \n\tAtención 😀  ";
      const policy = { initialDelaySeconds: 0, activeDelaySeconds: 7, inactivityResetSeconds: 123 };
      expect(await pools.admin.run(undefined, r => r.updatePlatformAiInstructions(raw, policy))).toEqual({ additionalInstructions: raw, replyPacing: policy });
      const reloaded = createRuntimePools(db.container.getConnectionUri());
      try {
        expect(await reloaded.admin.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: raw, replyPacing: policy });
      } finally { await reloaded.end(); }
      expect(await pools.worker.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: raw, replyPacing: policy });
      expect(await pools.manager.run(undefined, r => r.globalReplyPacing())).toEqual(policy);
      await pools.admin.run(undefined, r => r.updatePlatformAiInstructions(""));
      expect(await pools.worker.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: "", replyPacing: policy });
      // Invalid policy must not partially overwrite the instructions.
      await expect(pools.admin.run(undefined, r => r.updatePlatformAiInstructions("lost", { ...policy, activeDelaySeconds: -1 }))).rejects.toThrow();
      expect(await pools.admin.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: "", replyPacing: policy });
      for (const column of pacingColumns) {
        for (const value of ["null", "-1", column === "inactivity_reset_seconds" ? "0" : "86401", "604801"]) {
          await expect(db.sql.unsafe(`update operational_controls set ${column}=${value}`).execute()).rejects.toMatchObject({ code: value === "null" ? "23502" : "23514" });
        }
      }
      await db.sql`update operational_controls set initial_delay_seconds=86400,active_delay_seconds=0,inactivity_reset_seconds=604800`;
      expect([...await db.sql`select singleton,automation_disabled,incident_reference,updated_at from operational_controls`]).toEqual(metadata);
      for (const role of ["agendia_runtime", "agendia_whatsapp_runtime", "agendia_worker_runtime", "agendia_admin_runtime"]) {
        const statements = ["insert into operational_controls(singleton) values(true)", "delete from operational_controls"];
        if (role !== "agendia_worker_runtime") statements.push("select * from operational_controls");
        if (role !== "agendia_admin_runtime") {
          statements.push("update operational_controls set additional_instructions=''");
          for (const column of pacingColumns) statements.push(`update operational_controls set ${column}=${column}`);
        }
        if (role === "agendia_runtime") statements.push("select initial_delay_seconds from operational_controls");
        for (const column of oldColumns) statements.push(`update operational_controls set ${column}=${column}`);
        if (role === "agendia_whatsapp_runtime" || role === "agendia_runtime") statements.push("select additional_instructions from operational_controls");
        for (const statement of statements) {
          await expect(db.sql.begin(async tx => {
            await tx.unsafe(`set local role ${role}`);
            await tx.unsafe(statement);
          })).rejects.toMatchObject({ code: "42501" });
        }
      }
      await expect(db.sql`update operational_controls set additional_instructions=null`.execute()).rejects.toMatchObject({ code: "23502" });
      await expect(db.sql`insert into operational_controls(singleton) values(false)`.execute()).rejects.toMatchObject({ code: "23514" });
      await expect(db.sql`insert into operational_controls(singleton) values(true)`.execute()).rejects.toMatchObject({ code: "23505" });
  } finally {
    await pools.end();
    await db.stop();
  }
}, 120_000);
