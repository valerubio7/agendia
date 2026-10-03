import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRuntimePools } from "@agendia/db";
import { applyPostgresMigrations, startTestPostgres } from "../support/index.ts";

const directory = join(import.meta.dir, "../../packages/db/migrations");
test("global singleton seeds on fresh and populated schemas with least-privilege persistence", async () => {
  for (const upgrade of [false, true]) {
    const db = await startTestPostgres();
    const pools = createRuntimePools(db.container.getConnectionUri());
    try {
      if (upgrade) {
        const names = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
        for (const name of names.filter(name => name < "0024")) {
          await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
        }
        await db.sql`insert into businesses(id,name) values('11111111-1111-4111-8111-111111111111','Existing business')`;
        for (const name of names.filter(name => name >= "0024")) {
          await db.sql.unsafe(await readFile(join(directory, name), "utf8"));
        }
      } else await applyPostgresMigrations(db.sql, directory);
      expect((await db.sql`select to_regclass('public.platform_ai_instructions') as name`)[0]?.name).toBe("platform_ai_instructions");
      expect([...(await db.sql`select * from platform_ai_instructions`)]).toEqual([{ singleton: true, additional_instructions: "" }]);
      const raw = " \n\tAtención 😀  ";
      await db.sql.begin(async tx => {
        await tx`set local role agendia_admin_runtime`;
        expect((await tx`update platform_ai_instructions set additional_instructions=${raw} where singleton returning additional_instructions`)[0]?.additional_instructions).toBe(raw);
      });
      expect(await pools.admin.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: raw });
      expect(await pools.worker.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: raw });
      await pools.admin.run(undefined, r => r.updatePlatformAiInstructions(""));
      expect(await pools.worker.run(undefined, r => r.platformAiInstructions())).toEqual({ additionalInstructions: "" });
      for (const [role, statement] of [
        ["agendia_runtime", "select * from platform_ai_instructions"],
        ["agendia_whatsapp_runtime", "select * from platform_ai_instructions"],
        ["agendia_worker_runtime", "update platform_ai_instructions set additional_instructions=''"],
        ["agendia_admin_runtime", "insert into platform_ai_instructions values(true,'')"],
        ["agendia_admin_runtime", "delete from platform_ai_instructions"],
      ]) {
        await expect(db.sql.begin(async tx => {
          await tx.unsafe(`set local role ${role}`);
          await tx.unsafe(statement!);
        })).rejects.toMatchObject({ code: "42501" });
      }
      await expect(db.sql`update platform_ai_instructions set additional_instructions=null`.execute()).rejects.toMatchObject({ code: "23502" });
      await expect(db.sql`insert into platform_ai_instructions values(false,'')`.execute()).rejects.toMatchObject({ code: "23514" });
      await expect(db.sql`insert into platform_ai_instructions values(true,'')`.execute()).rejects.toMatchObject({ code: "23505" });
    } finally {
      await pools.end();
      await db.stop();
    }
  }
}, 120_000);
