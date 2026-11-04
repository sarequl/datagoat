import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.config.ts: every migration in migrations/, in order. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
