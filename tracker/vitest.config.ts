import { defineConfig } from "vitest/config";

// Tracker unit tests run in a simulated browser (happy-dom).
export default defineConfig({
  define: { __DG_VARIANT__: JSON.stringify("default") },
  test: {
    root: "tracker",
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
