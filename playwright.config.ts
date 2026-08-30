import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  workers: 1,
  projects: [
    { name: "system", testMatch: "system-*.spec.ts" },
    { name: "historical-harness", testIgnore: "system-*.spec.ts" },
  ],
  use: { baseURL: "http://127.0.0.1:3000" },
});
