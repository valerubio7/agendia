import { expect, test } from "bun:test";
import { join } from "node:path";
import { createRuntimePools } from "@agendia/db";
import { DEFAULT_REPLY_PACING } from "@agendia/domain";
import { applyPostgresMigrations, startTestPostgres } from "../support/index.ts";

const directory = join(import.meta.dir, "../../packages/db/migrations");
test("fresh migration preserves the operational singleton, pacing and least-privilege access", async () => {
  const db = await startTestPostgres();
  const pools = createRuntimePools(db.container.getConnectionUri());
  try {
    await applyPostgresMigrations(db.sql, directory);
    expect(await db.sql`select column_name from information_schema.columns where table_schema='public'
      and table_name='operational_controls' and column_name='additional_instructions'`).toHaveLength(0);
    await db.sql`update operational_controls set automation_disabled=true,incident_reference='Existing incident',updated_at='2025-01-01T00:00:00Z'`;
    const metadata = [...await db.sql`select singleton,automation_disabled,incident_reference,updated_at from operational_controls`];
    expect(await pools.admin.run(undefined, r => r.globalReplyPacing())).toEqual(DEFAULT_REPLY_PACING);
    const policy = { initialDelaySeconds: 0, activeDelaySeconds: 7, inactivityResetSeconds: 123 };
    expect(await pools.admin.run(undefined, r => r.updateResponseTiming(policy))).toEqual(policy);
    expect(await pools.manager.run(undefined, r => r.globalReplyPacing())).toEqual(policy);
    expect(await pools.worker.run(undefined, r => r.globalReplyPacing())).toEqual(policy);
    await expect(pools.admin.run(undefined, r => r.updateResponseTiming({ ...policy, activeDelaySeconds: -1 }))).rejects.toThrow();
    expect(await pools.admin.run(undefined, r => r.globalReplyPacing())).toEqual(policy);
    expect([...await db.sql`select singleton,automation_disabled,incident_reference,updated_at from operational_controls`]).toEqual(metadata);
    for (const role of ["agendia_runtime", "agendia_admin_runtime", "agendia_whatsapp_runtime", "agendia_worker_runtime"]) {
      for (const column of ["initial_delay_seconds", "active_delay_seconds", "inactivity_reset_seconds"]) {
        const [acl] = await db.sql`select has_column_privilege(${role}, 'operational_controls', ${column}, 'SELECT') read,
          has_column_privilege(${role}, 'operational_controls', ${column}, 'UPDATE') write`;
        expect(acl).toEqual({ read: role !== "agendia_runtime", write: role === "agendia_admin_runtime" });
      }
      for (const statement of ["insert into operational_controls(singleton) values(true)", "delete from operational_controls", "update operational_controls set automation_disabled=false"]) {
        await expect(db.sql.begin(async tx => { await tx.unsafe(`set local role ${role}`); await tx.unsafe(statement); })).rejects.toMatchObject({ code: "42501" });
      }
    }
  } finally { await pools.end(); await db.stop(); }
}, 120_000);
