import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntimePools } from "@agendia/db";
import { applyPostgresMigrations, startTestPostgres } from "../support/index.ts";

const directory = join(import.meta.dir, "../../packages/db/migrations");
const oldColumns = ["singleton", "automation_disabled", "incident_reference", "updated_at"];
test("global operational singleton preserves metadata with least-privilege instruction persistence", async () => {
  for (const upgrade of [false, true]) {
    const db = await startTestPostgres();
    const pools = createRuntimePools(db.container.getConnectionUri());
    try {
      let before;
      if (upgrade) {
        const names = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
        for (const name of names.filter(name => name < "0024")) {
          await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
        }
        await db.sql`insert into businesses(id,name) values('11111111-1111-4111-8111-111111111111','Existing business')`;
        await db.sql`update operational_controls set automation_disabled=true, incident_reference='Existing incident', updated_at='2025-01-01T00:00:00Z'`;
        before = [...await db.sql`select singleton,automation_disabled,incident_reference,updated_at from operational_controls`];
        for (const name of names.filter(name => name >= "0024")) {
          await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
        }
      } else await applyPostgresMigrations(db.sql, directory);
      expect((await db.sql`select to_regclass('public.platform_ai_instructions') as name`)[0]?.name).toBeNull();
      expect([...(await db.sql`select column_name,data_type,is_nullable,column_default from information_schema.columns
        where table_schema='public' and table_name='operational_controls' and column_name='additional_instructions'`)]).toEqual([
        { column_name: "additional_instructions", data_type: "text", is_nullable: "NO", column_default: "''::text" },
      ]);
      const metadata = [...await db.sql`select singleton,automation_disabled,incident_reference,updated_at from operational_controls`];
      expect(metadata).toHaveLength(1);
      if (upgrade) expect(before).toEqual(metadata);
      else expect(metadata[0]).toMatchObject({ singleton: true, automation_disabled: false, incident_reference: null });
      expect(await pools.admin.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: "" });
      const owner = (await db.sql`select current_user as name`)[0]!.name;
      for (const role of [owner, "agendia_runtime", "agendia_admin_runtime", "agendia_worker_runtime", "agendia_whatsapp_runtime"]) {
        for (const column of [...oldColumns, "additional_instructions"]) {
          const privileges = (await db.sql`select
            has_column_privilege(${role}, 'operational_controls', ${column}, 'SELECT') as read,
            has_column_privilege(${role}, 'operational_controls', ${column}, 'UPDATE') as write`)[0];
          expect(privileges).toEqual({
            read: role === owner || role === "agendia_worker_runtime" ||
              (role === "agendia_whatsapp_runtime" && column !== "additional_instructions") ||
              (role === "agendia_admin_runtime" && ["singleton", "additional_instructions"].includes(column)),
            write: role === owner || (role === "agendia_admin_runtime" && column === "additional_instructions"),
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
      expect(await pools.admin.run(undefined, r => r.updatePlatformAiInstructions(raw))).toEqual({ additionalInstructions: raw });
      expect(await pools.admin.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: raw });
      expect(await pools.worker.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: raw });
      await pools.admin.run(undefined, r => r.updatePlatformAiInstructions(""));
      expect(await pools.worker.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: "" });
      expect([...await db.sql`select singleton,automation_disabled,incident_reference,updated_at from operational_controls`]).toEqual(metadata);
      for (const role of ["agendia_runtime", "agendia_whatsapp_runtime", "agendia_worker_runtime", "agendia_admin_runtime"]) {
        const statements = ["insert into operational_controls(singleton) values(true)", "delete from operational_controls"];
        if (role !== "agendia_worker_runtime") statements.push("select * from operational_controls");
        if (role !== "agendia_admin_runtime") statements.push("update operational_controls set additional_instructions=''");
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
  }
}, 120_000);
