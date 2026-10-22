import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("./secret-scan.ts", import.meta.url));
const requiredRoots = ["apps", "packages", "scripts", ".github"];

function withFixture(run: (cwd: string) => void, missingRoot?: string): void {
  const cwd = mkdtempSync(join(tmpdir(), "secret-scan-test-"));
  try {
    for (const root of requiredRoots) {
      if (root !== missingRoot) mkdirSync(join(cwd, root));
    }
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function scan(cwd: string) {
  const result = spawnSync(process.execPath, ["--no-env-file", "run", scanner], {
    cwd,
    // Next.js types require NODE_ENV, but this CLI fixture deliberately has no environment.
    env: {} as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function expectFailure(cwd: string, message: string): void {
  const result = scan(cwd);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr.includes(message)).toBe(true);
}

test("CLI succeeds when the optional docs root is absent", () => {
  withFixture((cwd) => {
    const result = scan(cwd);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("security:scan passed: 0 source and delivery files contain no provider credentials.\n");
  });
});

test("CLI includes present docs in the scanned file count", () => {
  withFixture((cwd) => {
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "guide.md"), "Harmless documentation.\n");
    const result = scan(cwd);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("security:scan passed: 1 source and delivery files contain no provider credentials.\n");
  });
});

test("CLI rejects a synthetic credential in present docs without exposing it", () => {
  withFixture((cwd) => {
    mkdirSync(join(cwd, "docs"));
    const syntheticCredential = "sk-" + "A".repeat(24);
    writeFileSync(join(cwd, "docs", "guide.md"), syntheticCredential);
    const result = scan(cwd);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.includes("docs/guide.md: DeepSeek credential pattern")).toBe(true);
    expect((result.stdout + result.stderr).includes(syntheticCredential)).toBe(false);
  });
});

for (const root of requiredRoots) {
  test(`CLI fails when required root ${root} is absent`, () => {
    withFixture((cwd) => expectFailure(cwd, "ENOENT"), root);
  });
}

test("CLI propagates non-ENOENT errors when docs is a file", () => {
  withFixture((cwd) => {
    writeFileSync(join(cwd, "docs"), "Not a directory.\n");
    expectFailure(cwd, "ENOTDIR");
  });
});

test("CLI propagates nested ENOENT errors inside present docs", () => {
  withFixture((cwd) => {
    mkdirSync(join(cwd, "docs"));
    symlinkSync("missing.md", join(cwd, "docs", "dangling.md"));
    expectFailure(cwd, "ENOENT");
  });
});
