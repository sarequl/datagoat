import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { mockApiPlugin } from './src/mocks/plugin.ts';

// The dashboard is a static SPA. In dev and preview it talks to a typed mock
// of the frozen `/api/v1` contract (design/api.md); in production the Worker
// serves both the assets and the real API, so this plugin never runs there.
export default defineConfig({
  plugins: [react(), mockApiPlugin()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
