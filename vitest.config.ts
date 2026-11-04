import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Worker tests run inside workerd (Miniflare) with the real wrangler.jsonc bindings: a local D1
 * database migrated from migrations/, the KV namespace and the Rate Limiting bindings.
 * test/helpers/setup.ts applies every migration in order before the tests run.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // An extra, never-migrated database for the self-migration tests.
          d1Databases: { EMPTY_DB: "datagoat-empty-test" },
          bindings: {
            TEST_MIGRATIONS: migrations,
            SETUP_TOKEN: "test-setup-token-0123456789abcdef",
            SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
            ENCRYPTION_KEY: "test-encryption-key-0123456789abcdef0123456789",
            // Faster hashing in tests; production uses the wrangler.jsonc value (100000).
            PASSWORD_ITERATIONS: "10000",
          },
        },
      }),
    ],
    test: {
      include: ["test/worker/**/*.test.ts"],
      setupFiles: ["./test/helpers/setup.ts"],
    },
  };
});
