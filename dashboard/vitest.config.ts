import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dashboard component tests: happy-dom + Testing Library + the MSW mock API (msw/node).
export default defineConfig({
  root: "dashboard",
  plugins: [react()],
  define: { __MOCK_API__: "true" },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
