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
    // Above Testing Library's 5 s async timeout (src/test/setup.ts), so a slow wait fails as a
    // clear assertion, and full pages (overview: ~20 requests, lazy map chunk) render slowly in
    // happy-dom.
    testTimeout: 20_000,
  },
});
