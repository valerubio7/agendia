import { expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebRuntime } from "../e2e/support/web-runtime.ts";

test("each runtime receives its own writable copy of a completed build", async () => {
  const build = await mkdtemp(join(tmpdir(), "agendia-build-test-"));
  const runtimes: Awaited<ReturnType<typeof createWebRuntime>>[] = [];
  try {
    await mkdir(join(build, ".next", "cache"), { recursive: true });
    await writeFile(join(build, ".next", "BUILD_ID"), "shared-build");
    await writeFile(join(build, ".next", "cache", "entry"), "original");
    runtimes.push(await createWebRuntime(process.cwd(), build));
    runtimes.push(await createWebRuntime(process.cwd(), build));
    expect(await readFile(join(runtimes[0]!.cwd, ".next", "BUILD_ID"), "utf8")).toBe("shared-build");
    await expect(access(join(runtimes[0]!.cwd, ".next", "cache", "entry"))).rejects.toThrow();
    await mkdir(join(runtimes[0]!.cwd, ".next", "cache"), { recursive: true });
    await writeFile(join(runtimes[0]!.cwd, ".next", "cache", "entry"), "changed");
    await expect(access(join(runtimes[1]!.cwd, ".next", "cache", "entry"))).rejects.toThrow();
    expect(await readFile(join(build, ".next", "cache", "entry"), "utf8")).toBe("original");
  } finally {
    for (const runtime of runtimes) await runtime.dispose();
    await rm(build, { recursive: true, force: true });
  }
});
