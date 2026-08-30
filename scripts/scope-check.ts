import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PRODUCT_HTTP_ROUTES } from "../packages/contracts/src/http.ts";
import { checkV1Scope } from "./policy-checks.ts";

function pathsBelow(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((name) => {
    const absolute = join(path, name);
    return statSync(absolute).isDirectory() ? pathsBelow(absolute) : [relative(process.cwd(), absolute)];
  });
}

const findings = checkV1Scope(PRODUCT_HTTP_ROUTES, [
  ...pathsBelow("apps/api/src/routes"),
  ...pathsBelow("apps/web/app"),
]);
if (findings.length > 0) throw new Error(`V1 scope check failed:\n${findings.join("\n")}`);
console.log(`scope:check passed: ${PRODUCT_HTTP_ROUTES.length} allowlisted routes and no conversation viewer capability.`);
