import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
async function files(folder: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(folder, name));
    else result[name] = await readFile(join(folder, name), "utf8");
  }
  return result;
}
async function fixture(body: (f: { cwd: string; migrations: string; generate: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> }) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "agendia-kit-"));
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["db:generate"]).toBe("drizzle-kit generate");
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { "db:generate": pkg.scripts["db:generate"] } }));
    await symlink(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
    await cp(join(root, "drizzle.config.ts"), join(cwd, "drizzle.config.ts"));
    await mkdir(join(cwd, "packages/db/src"), { recursive: true });
    await cp(join(root, "packages/db/src/schema.ts"), join(cwd, "packages/db/src/schema.ts"));
    const migrations = join(cwd, "packages/db/migrations");
    await cp(join(root, "packages/db/migrations"), migrations, { recursive: true });
    const generate = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "run", "db:generate", ...args], {
        cwd, env: { PATH: process.env.PATH!, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      // Bun's script echo is not Kit stderr.
      return { code, stdout, stderr: stderr.replace(/^\$ drizzle-kit generate[^\n]*\n/, "") };
    };
    await body({ cwd, migrations, generate });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("stock generation of the complete current baseline is byte-preserving twice", async () => {
  await fixture(async ({ migrations, generate }) => {
    const before = await files(migrations);
    expect(Object.keys(before).filter(name => name.endsWith("_snapshot.json"))).toEqual(["meta/0008_snapshot.json"]);
    const first = await generate();
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("No schema changes, nothing to migrate");
    expect(await files(migrations)).toEqual(before);
    expect(await generate()).toEqual(first);
    expect(await files(migrations)).toEqual(before);
  });
}, 30_000);

test("db:generate exposes stock help, name and custom options without database configuration", async () => {
  await fixture(async ({ migrations, generate }) => {
    const before = await files(migrations);
    const result = await generate("--help");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const flag of ["--name", "--custom", "--config", "--help"]) expect(result.stdout).toContain(flag);
    expect(await files(migrations)).toEqual(before);
  });
});

test("a nullable column produces only ALTER and preserves all historical pins and source bytes", async () => {
  await fixture(async ({ cwd, migrations, generate }) => {
    const before = await files(migrations);
    const schema = join(cwd, "packages/db/src/schema.ts");
    const original = await readFile(schema, "utf8");
    await writeFile(schema, original.replace('name: varchar("name", { length: 160 }).notNull(),', 'generationNote: text("generation_note"),\n  name: varchar("name", { length: 160 }).notNull(),'));
    const result = await generate("--name=nullable_note");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("0009_nullable_note.sql");
    const after = await files(migrations);
    expect(after["0009_nullable_note.sql"]!.trim()).toBe('ALTER TABLE "businesses" ADD COLUMN "generation_note" text;');
    for (const [name, source] of Object.entries(before)) if (name !== "meta/_journal.json") expect(after[name]).toBe(source);
    const previous = JSON.parse(before["meta/_journal.json"]!);
    const journal = JSON.parse(after["meta/_journal.json"]!);
    expect(journal.entries.slice(0, 9)).toEqual(previous.entries);
    expect(journal.entries).toHaveLength(10);
    expect(journal.entries[9]).toEqual({ idx: 9, version: "7", when: expect.any(Number), tag: "0009_nullable_note", breakpoints: true });
    expect(journal.entries[9].when).toBeGreaterThan(previous.entries[8].when);
    const snapshot = JSON.parse(after["meta/0009_snapshot.json"]!);
    expect(snapshot.prevId).toBe(JSON.parse(before["meta/0008_snapshot.json"]!).id);
    expect(snapshot.id).not.toBe(snapshot.prevId);
    expect(snapshot.tables["public.businesses"].columns.generation_note.notNull).toBe(false);
    expect(Object.keys(after).filter(name => !(name in before)).sort()).toEqual(["0009_nullable_note.sql", "meta/0009_snapshot.json"]);
    const repeat = await generate();
    expect(repeat.code).toBe(0);
    expect(repeat.stderr).toBe("");
    expect(repeat.stdout).toContain("No schema changes, nothing to migrate");
    expect(await files(migrations)).toEqual(after);
  });
}, 30_000);

test("stock custom SQL is editable before application without a sealing command", async () => {
  await fixture(async ({ migrations, generate }) => {
    const before = await files(migrations);
    const result = await generate("--custom", "--name=explicit_sql");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("0009_explicit_sql.sql");
    const authored = "ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY;\n";
    await writeFile(join(migrations, "0009_explicit_sql.sql"), authored);
    const after = await files(migrations);
    const journal = JSON.parse(after["meta/_journal.json"]!);
    expect(journal.entries.slice(0, 9)).toEqual(JSON.parse(before["meta/_journal.json"]!).entries);
    expect(journal.entries[9].sha256).toBeUndefined();
    expect(journal.entries[9].idx).toBe(9);
    expect(journal.entries[9].tag).toBe("0009_explicit_sql");
    expect(JSON.parse(after["meta/0009_snapshot.json"]!).prevId).toBe(JSON.parse(before["meta/0008_snapshot.json"]!).id);
    for (const [name, source] of Object.entries(before)) if (name !== "meta/_journal.json") expect(after[name]).toBe(source);
    const repeat = await generate();
    expect(repeat.code).toBe(0);
    expect(repeat.stderr).toBe("");
    expect(repeat.stdout).toContain("No schema changes, nothing to migrate");
    expect(await files(migrations)).toEqual(after);
  });
}, 30_000);
