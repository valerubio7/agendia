import { test as base } from "@playwright/test";
import { startSystem, type SystemHarness } from "./system.ts";

export const test = base.extend<{ system: SystemHarness }>({
  system: async ({}, use) => {
    const system = await startSystem();
    try { await use(system); } finally { await system.stop(); }
  },
});
