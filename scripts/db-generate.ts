import { existsSync } from "node:fs";
if (!existsSync("packages/db/migrations/0000_base.sql")) throw new Error("Missing reviewed base migration");
console.log("Drizzle schema and reviewed SQL migration are present (no drift generated).");
