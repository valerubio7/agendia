import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { scanForSecrets } from "./policy-checks.ts";

function collect(path: string, files: Record<string, string>): void {
  for (const name of readdirSync(path)) {
    if (["node_modules", ".next", ".git", "playwright-report", "test-results"].includes(name)) continue;
    const absolute = join(path, name);
    if (statSync(absolute).isDirectory()) collect(absolute, files);
    else if (/\.(?:ts|tsx|js|mjs|json|ya?ml|md|toml)$/.test(name)) files[relative(process.cwd(), absolute)] = readFileSync(absolute, "utf8");
  }
}

const files: Record<string, string> = {};
for (const root of ["apps", "packages", "scripts", "docs", ".github"]) collect(root, files);
const findings = scanForSecrets(files);
if (findings.length > 0) throw new Error(`Secret scan failed:\n${findings.join("\n")}`);
console.log(`security:scan passed: ${Object.keys(files).length} source and delivery files contain no provider credentials.`);
