import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { Sql } from "postgres";
import { migrateDatabase } from "../../scripts/db/db-migrate.ts";
import { startTestPostgres } from "../support/postgres.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
async function fixture(body: (f: { cwd: string; folder: string; sql: Sql; run: () => Promise<void>; generate: (...args: string[]) => Promise<void> }) => Promise<void>) {
  // Historical SQL creates cluster-wide roles, so each fixture needs its own container.
  const database = await startTestPostgres();
  const cwd = await mkdtemp(join(tmpdir(), "agendia-kit-pg-"));
  const url = database.container.getConnectionUri();
  const sql = database.sql;
  try {
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    await cp(join(root, "drizzle.config.ts"), join(cwd, "drizzle.config.ts"));
    await mkdir(join(cwd, "packages/db/src"), { recursive: true });
    await cp(join(root, "packages/db/src/schema.ts"), join(cwd, "packages/db/src/schema.ts"));
    const folder = join(cwd, "packages/db/migrations");
    await cp(join(root, "packages/db/migrations"), folder, { recursive: true });
    const generate = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", join(root, "node_modules/drizzle-kit/bin.cjs"), "generate", ...args], {
        cwd, env: { PATH: process.env.PATH!, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain(".sql");
    };
    const run = () => migrateDatabase(url, { migrationsFolder: folder, connect: connectionString => new Client({ connectionString }) });
    await body({ cwd, folder, sql, run, generate });
  } finally { await database.stop(); await rm(cwd, { recursive: true, force: true }); }
}
async function state(sql: Sql) {
  return {
    columns: [...await sql`select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='public' order by table_name,ordinal_position`],
    rows: [...await sql`select * from businesses order by id`],
    ledger: [...await sql`select * from drizzle.__drizzle_migrations order by id`],
    counter: [...await sql`select * from drizzle.__drizzle_migrations_id_seq`],
    throttle: [...await sql`select * from login_throttle_global`],
    rls: [...await sql`select relname,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='public'::regnamespace order by relname`],
  };
}

test("Kit's unpinned ALTER and authored custom SQL apply, rerun unchanged, and freeze on first application", async () => {
  await fixture(async ({ cwd, folder, sql, run, generate }) => {
    await run();
    const id = crypto.randomUUID();
    await sql`insert into businesses(id,name) values(${id},'Retained')`;
    const before = await state(sql);
    const schema = join(cwd, "packages/db/src/schema.ts");
    await writeFile(schema, (await readFile(schema, "utf8")).replace('name: varchar("name", { length: 160 }).notNull(),', 'generationNote: text("generation_note"),\n  name: varchar("name", { length: 160 }).notNull(),'));
    await generate("--name=nullable_note");
    await run();
    const altered = await state(sql);
    expect(altered.rows).toEqual(before.rows.map(row => ({ ...row, generation_note: null })));
    expect(altered.ledger.slice(0, 9)).toEqual(before.ledger);
    expect(altered.ledger[9]!.hash).toBe(hash(await readFile(join(folder, "0009_nullable_note.sql"), "utf8")));
    await run();
    expect(await state(sql)).toEqual(altered);
    await generate("--custom", "--name=explicit_sql");
    const custom = join(folder, "0010_explicit_sql.sql");
    await writeFile(custom, "-- Draft before application\n");
    const authored = "ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY;\n--> statement-breakpoint\nUPDATE businesses SET generation_note = 'authored';\n";
    await writeFile(custom, authored);
    await run();
    const applied = await state(sql);
    expect(applied.rows).toEqual(before.rows.map(row => ({ ...row, generation_note: "authored" })));
    expect(applied.ledger.slice(0, 10)).toEqual(altered.ledger);
    expect(applied.ledger[10]!.hash).toBe(hash(authored));
    const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
    expect(journal.entries.slice(9).map((entry: { sha256?: string }) => entry.sha256)).toEqual([undefined, undefined]);
    await run();
    expect(await state(sql)).toEqual(applied);
    for (const file of ["0009_nullable_note.sql", "0010_explicit_sql.sql"]) {
      const path = join(folder, file), original = await readFile(path, "utf8");
      await writeFile(path, original + "\nUPDATE businesses SET name = 'must not execute';\n");
      await expect(run()).rejects.toThrow("Drizzle history is not an unchanged chronological prefix");
      expect(await state(sql)).toEqual(applied);
      await writeFile(path, original);
    }
  });
}, 30_000);

test("historical pins stay required; optional new pins are checked, never a replacement for stored hashes", async () => {
  await fixture(async ({ folder, sql, run, generate }) => {
    await run();
    await sql`insert into businesses(id,name) values(${crypto.randomUUID()},'Preserved')`;
    await generate("--custom", "--name=pinned_sql");
    const path = join(folder, "meta/_journal.json");
    const journal = JSON.parse(await readFile(path, "utf8"));
    const before = await state(sql);
    for (const entry of journal.entries.slice(0, 9)) {
      const pin = entry.sha256;
      delete entry.sha256;
      await writeFile(path, JSON.stringify(journal));
      await expect(run()).rejects.toThrow("Migration journal or file set is invalid");
      expect(await state(sql)).toEqual(before);
      entry.sha256 = pin;
    }
    journal.entries[9].sha256 = "0".repeat(64);
    await writeFile(path, JSON.stringify(journal));
    await expect(run()).rejects.toThrow("Migration source does not match journal checksum");
    expect(await state(sql)).toEqual(before);
    journal.entries[9].sha256 = null;
    await writeFile(path, JSON.stringify(journal));
    await expect(run()).rejects.toThrow("Migration journal or file set is invalid");
    expect(await state(sql)).toEqual(before);
    const source = join(folder, "0009_pinned_sql.sql");
    journal.entries[9].sha256 = hash(await readFile(source, "utf8"));
    await writeFile(path, JSON.stringify(journal));
    await run();
    const applied = await state(sql);
    expect(applied.ledger).toHaveLength(10);
    expect(applied.ledger[9]!.hash).toBe(journal.entries[9].sha256);
    await run();
    expect(await state(sql)).toEqual(applied);
    await writeFile(source, "UPDATE businesses SET name = 'must not execute';");
    journal.entries[9].sha256 = hash(await readFile(source, "utf8"));
    await writeFile(path, JSON.stringify(journal));
    await expect(run()).rejects.toThrow("Drizzle history is not an unchanged chronological prefix");
    expect(await state(sql)).toEqual(applied);
    const historical = journal.entries[0];
    historical.sha256 = "0".repeat(64);
    await writeFile(path, JSON.stringify(journal));
    await expect(run()).rejects.toThrow("Migration source does not match journal checksum");
    expect(await state(sql)).toEqual(applied);
  });
}, 30_000);
