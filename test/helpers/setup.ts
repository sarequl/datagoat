import { applyD1Migrations, env } from "cloudflare:test";

// Applies every file in migrations/ in order (readD1Migrations sorts by number). Idempotent:
// already-applied migrations are skipped, so this is safe to run before every test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
