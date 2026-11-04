import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.config.ts: every migration in migrations/, in order. */
      TEST_MIGRATIONS: D1Migration[];
      /** Injected by vitest.config.ts: a D1 database no migration was applied to. */
      EMPTY_DB: D1Database;
    }
  }
}
