import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startTestPostgres } from "../support/index.ts";

const migrations = join(import.meta.dir, "../../packages/db/migrations");

test("append-only upgrade removes nonempty guidance and preserves operational values and permissions", async () => {
  const db = await startTestPostgres();
  try {
    await db.sql.unsafe(await readFile(join(migrations, "0000_base.sql"), "utf8"));
    await db.sql`update operational_controls set additional_instructions='legacy 😀', automation_disabled=true,
      incident_reference='incident', updated_at='2025-01-01T00:00:00Z', initial_delay_seconds=0,
      active_delay_seconds=23, inactivity_reset_seconds=75`;
    const before = [...await db.sql`select singleton,automation_disabled,incident_reference,updated_at,
      initial_delay_seconds,active_delay_seconds,inactivity_reset_seconds from operational_controls`];
    await db.sql.unsafe(await readFile(join(migrations, "0001_remove_admin_ai_guidance.sql"), "utf8"));
    expect([...await db.sql`select singleton,automation_disabled,incident_reference,updated_at,
      initial_delay_seconds,active_delay_seconds,inactivity_reset_seconds from operational_controls`]).toEqual(before);
    expect(await db.sql`select column_name from information_schema.columns where table_schema='public'
      and table_name='operational_controls' and column_name='additional_instructions'`).toHaveLength(0);
    for (const role of ["agendia_runtime", "agendia_admin_runtime", "agendia_whatsapp_runtime", "agendia_worker_runtime"]) {
      const [acl] = await db.sql`select has_column_privilege(${role}, 'operational_controls', 'initial_delay_seconds', 'SELECT') read,
        has_column_privilege(${role}, 'operational_controls', 'initial_delay_seconds', 'UPDATE') write`;
      expect(acl).toEqual({ read: role !== "agendia_runtime", write: role === "agendia_admin_runtime" });
    }
  } finally { await db.stop(); }
}, 120_000);
