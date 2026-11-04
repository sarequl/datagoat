import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Dashboard build. Output goes straight into public/ (served by Workers Static Assets) next to the
 * tracker in public/js/. `--mode mock` serves the dashboard with the MSW mock API so pages can be
 * built before the backend exists (see dashboard/README section in docs/dashboard.md).
 */
export default defineConfig(({ mode }) => ({
  root: "dashboard",
  base: "/",
  plugins: [react(), tailwindcss()],
  publicDir: mode === "mock" ? "mock-public" : false,
  define: {
    __MOCK_API__: JSON.stringify(mode === "mock"),
  },
  build: {
    outDir: "../public",
    emptyOutDir: false,
    manifest: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: Number(process.env.DASHBOARD_PORT ?? 5173),
    strictPort: false,
    proxy:
      mode === "mock"
        ? undefined
        : {
            "/api": "http://localhost:8787",
            "/mcp": "http://localhost:8787",
            "/oauth": "http://localhost:8787",
            "/js": "http://localhost:8787",
          },
  },
}));
