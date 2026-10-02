import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

export interface MigrationDependencies {
  connect(url: string): {
    unsafe(query: string): PromiseLike<unknown>;
    end(): PromiseLike<void>;
  };
  list(): string[];
  read(name: string): string;
}
const systemDependencies: MigrationDependencies = {
  connect: (url) => postgres(url, { max: 1 }),
  list: () => readdirSync("packages/db/migrations"),
  read: (name) => readFileSync(`packages/db/migrations/${name}`, "utf8"),
};

// Replays all reviewed SQL, without production's checksum/pending tracking.
export async function migrateDevelopmentDatabase(
  url: string | undefined = process.env.DATABASE_URL,
  dependencies: MigrationDependencies = systemDependencies,
) {
  if (!url?.trim()) throw new Error("DATABASE_URL is required");
  const sql = dependencies.connect(url);
  try {
    for (const name of dependencies.list().filter((file) => file.endsWith(".sql")).sort())
      await sql.unsafe(dependencies.read(name));
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  try {
    await migrateDevelopmentDatabase();
    console.log("Replayed reviewed migrations on the clean development database.");
  } catch {
    // Driver errors can contain connection credentials or SQL; never print them.
    console.error(process.env.DATABASE_URL?.trim()
      ? "Development migration failed; database details withheld."
      : "DATABASE_URL is required");
    process.exitCode = 1;
  }
}
