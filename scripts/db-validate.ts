import { existsSync } from "node:fs";

export function validateReviewedMigration(exists: (path: string) => boolean = existsSync) {
  if (!exists("packages/db/migrations/0000_base.sql"))
    throw new Error("Missing reviewed base migration");
}

if (import.meta.main) {
  try {
    validateReviewedMigration();
    console.log("Reviewed base SQL migration is present; no generation or schema drift check performed.");
  } catch {
    console.error("Missing reviewed base migration");
    process.exitCode = 1;
  }
}
