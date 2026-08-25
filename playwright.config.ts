import { defineConfig } from "@playwright/test";

const dataDir = process.env.E2E_DATA_DIR;
if (!dataDir) throw new Error("E2E_DATA_DIR is required");

export default defineConfig({
  expect: { timeout: 5_000 },
  forbidOnly: true,
  fullyParallel: false,
  globalTimeout: 60_000,
  outputDir: "test-results",
  reporter: [["list"]],
  retries: 0,
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    actionTimeout: 5_000,
    baseURL: "http://127.0.0.1:4173",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
    navigationTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { height: 900, width: 1440 },
  },
  webServer: process.env.E2E_EXTERNAL_SERVER
    ? undefined
    : {
        command: "node server.js",
        env: {
          DATA_DIR: dataDir,
          HOST: "127.0.0.1",
          NODE_ENV: "production",
          PORT: "4173",
        },
        port: 4173,
        reuseExistingServer: false,
        stderr: "pipe",
        stdout: "pipe",
        timeout: 20_000,
      },
  workers: 1,
});
