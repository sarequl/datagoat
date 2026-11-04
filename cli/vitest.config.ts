import { defineConfig } from "vitest/config";

// CLI tests run in Node against a mock HTTP server (test/mock-server.ts).
export default defineConfig({
  root: "cli",
  define: { __CLI_VERSION__: JSON.stringify("0.0.0-test") },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
