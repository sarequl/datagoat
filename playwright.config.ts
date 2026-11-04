import { defineConfig, devices } from "@playwright/test";

/**
 * Projects:
 * - `dashboard-mock`: the dashboard on Vite in mock mode (MSW). Dashboard teams test UI here
 *   before the backend exists.
 * - `worker`: the built app on `wrangler dev` with a fresh local D1 (scripts/e2e-worker.sh): the
 *   real first-run setup, sign-in and API behaviour end to end.
 * - `tracker`: each tracker build in Chromium against that Worker, checking the stored rows
 *   (runs after `worker`, which performs first-run setup).
 */
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 5174);
const WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 8788);

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "dashboard-mock",
      testMatch: /dashboard-mock\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${MOCK_PORT}` },
    },
    {
      name: "worker",
      testMatch: /worker\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${WORKER_PORT}` },
    },
    {
      // W1: the three tracker builds against the same Worker, after first-run setup.
      name: "tracker",
      testMatch: /tracker\.spec\.ts/,
      dependencies: ["worker"],
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${WORKER_PORT}` },
    },
  ],
  webServer: [
    {
      command: `npx vite --config dashboard/vite.config.ts --mode mock --port ${MOCK_PORT} --strictPort`,
      url: `http://localhost:${MOCK_PORT}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "bash scripts/e2e-worker.sh",
      url: `http://localhost:${WORKER_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { E2E_WORKER_PORT: String(WORKER_PORT) },
    },
  ],
});
