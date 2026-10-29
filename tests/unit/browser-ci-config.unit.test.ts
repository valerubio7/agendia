import { expect, test } from "bun:test";
import config from "../../playwright.config.ts";

test("browser tests shard individually without adding workers", () => {
  expect(config.fullyParallel).toBe(true);
  expect(config.workers).toBe(1);
});

test("CI caches only versioned Chromium binaries and always installs OS dependencies", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()) as any;
  const job = workflow.jobs.browser_shards;
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(job.strategy.matrix.shard).toEqual([1, 2, 3]);
  const steps = job.steps as Array<Record<string, any>>;
  const cache = steps.find(step => step.id === "chromium-cache");
  expect(cache?.uses).toBe("actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830");
  expect(cache?.with).toEqual({
    path: "~/.cache/ms-playwright",
    key: "playwright-${{ runner.os }}-${{ runner.arch }}-ubuntu-24.04-${{ hashFiles('bun.lock') }}",
  });
  const deps = steps.find(step => step.run === "bunx --no-install playwright install-deps chromium");
  const binary = steps.find(step => step.run === "bunx --no-install playwright install chromium");
  expect(deps).toBeDefined();
  expect(deps?.if).toBeUndefined();
  expect(binary?.if).toBe("${{ steps.chromium-cache.outputs.cache-hit != 'true' }}");
  expect(steps.indexOf(cache!)).toBeLessThan(steps.indexOf(binary!));
  expect(steps.indexOf(deps!)).toBeLessThan(steps.indexOf(binary!));
  expect(steps.some(step => step.run === "bun run test:e2e --shard=${{ matrix.shard }}/3")).toBe(true);
});
