import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.example.toml' },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // Tests share one Miniflare instance per file; keep them serial so a
    // per-file database reset is not disturbed by parallel writers.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
