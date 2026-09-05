import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../../package.json";

const repoRoot = join(import.meta.dir, "../..");
const fixtures = [
  {
    path: "tests/contracts/lint-known-violation.ts",
    source: 'export const invalidComparison = 1 == "1";\n',
    diagnostic: "lint/suspicious/noDoubleEquals",
  },
  {
    path: "tests/contracts/lint-known-violation.json",
    source: '{"environment":"staging","environment":"production"}\n',
    diagnostic: "lint/suspicious/noDuplicateObjectKeys",
  },
] as const;
const manifest = packageJson as typeof packageJson & {
  scripts: { lint?: string };
  devDependencies: Record<string, string>;
};

function runRootLint() {
  return spawnSync(process.execPath, ["run", "lint"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

afterEach(() => {
  for (const fixture of fixtures) rmSync(join(repoRoot, fixture.path), { force: true });
});

describe("root lint contract", () => {
  test("locks bun run lint and checks TypeScript and configuration files", () => {
    expect(manifest.scripts.lint).toBe("biome lint .");
    expect(manifest.devDependencies["@biomejs/biome"]).toMatch(/^\d+\.\d+\.\d+$/);

    for (const fixture of fixtures) {
      writeFileSync(join(repoRoot, fixture.path), fixture.source, "utf8");
      const result = runRootLint();
      rmSync(join(repoRoot, fixture.path));
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(fixture.diagnostic);
    }
  });
});
