import { defineConfig } from "@playwright/test";

const config = defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  fullyParallel: true,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});

if (process.env.CI) config.reporter = [["list"], ["html", { open: "never" }]];

export default config;
