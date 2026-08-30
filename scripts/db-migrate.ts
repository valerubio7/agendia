import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) {
  console.log("DATABASE_URL not set; real clean-database migration is covered by test:integration.");
} else {
  const sql = postgres(url, { max: 1 });
  for (const name of readdirSync("packages/db/migrations").filter((file) => file.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(`packages/db/migrations/${name}`, "utf8"));
  await sql.end();
  console.log("Applied reviewed migrations with the configured DDL role.");
}
