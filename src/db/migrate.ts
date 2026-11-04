/**
 * Self-applying D1 migrations. The SQL files in migrations/ are bundled into the Worker
 * (migrations.generated.ts, written by scripts/gen-migrations.mjs) and applied on the first
 * request or cron run of each isolate, so a deploy works even when the deploy command skipped
 * `wrangler d1 migrations apply`.
 *
 * Bookkeeping uses wrangler's own `d1_migrations` table and file names, so `wrangler d1 migrations
 * apply` and the Worker agree and never apply a migration twice. Each migration runs as one
 * `db.batch()` (a transaction) that ends by recording its name; if another isolate applied it
 * concurrently the batch fails, rolls back, and is treated as success once the name is present.
 *
 * Cost: one D1 query per isolate when the schema is current (CREATE IF NOT EXISTS + SELECT in one
 * batch); nothing afterwards.
 */
import { MIGRATIONS } from "./migrations.generated";
import { splitSqlStatements } from "./sql-split";

export interface BundledMigration {
  name: string;
  sql: string;
}

export const MIGRATIONS_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)";

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export class SchemaNotReadyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SchemaNotReadyError";
  }
}

async function appliedNames(db: D1Database): Promise<Set<string>> {
  const [, rows] = await db.batch<{ name: string }>([
    db.prepare(MIGRATIONS_TABLE_SQL),
    db.prepare("SELECT name FROM d1_migrations"),
  ]);
  return new Set((rows?.results ?? []).map((r) => r.name));
}

/** Apply every migration in `migrations` that `d1_migrations` does not list, in order. */
export async function applyPendingMigrations(
  db: D1Database,
  migrations: readonly BundledMigration[] = MIGRATIONS,
): Promise<MigrationResult> {
  const done = await appliedNames(db);
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  for (const migration of migrations) {
    if (done.has(migration.name)) {
      result.alreadyApplied.push(migration.name);
      continue;
    }
    const statements = splitSqlStatements(migration.sql).map((s) => db.prepare(s));
    statements.push(db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name));
    try {
      await db.batch(statements);
      result.applied.push(migration.name);
    } catch (err) {
      // A concurrent isolate may have applied it first: the batch rolled back; check again.
      const now = await db
        .prepare("SELECT 1 AS ok FROM d1_migrations WHERE name = ?")
        .bind(migration.name)
        .first<{ ok: number }>();
      if (now) {
        result.alreadyApplied.push(migration.name);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new SchemaNotReadyError(`migration ${migration.name} failed: ${message}`, {
        cause: err,
      });
    }
  }
  return result;
}

let ready: Promise<void> | null = null;
let lastFailureAt = 0;
let lastFailure: SchemaNotReadyError | null = null;
const RETRY_AFTER_FAILURE_MS = 5_000;

/**
 * Make sure the schema is current, once per isolate. Throws SchemaNotReadyError (the app answers
 * 503) when migrations cannot be applied; retries at most every 5 seconds after a failure.
 */
export async function ensureSchema(db: D1Database, now = Date.now()): Promise<void> {
  if (lastFailure && now - lastFailureAt < RETRY_AFTER_FAILURE_MS) throw lastFailure;
  if (!ready) {
    ready = applyPendingMigrations(db).then(
      () => {
        lastFailure = null;
      },
      (err: unknown) => {
        ready = null;
        lastFailureAt = Date.now();
        lastFailure =
          err instanceof SchemaNotReadyError
            ? err
            : new SchemaNotReadyError(err instanceof Error ? err.message : String(err), {
                cause: err,
              });
        throw lastFailure;
      },
    );
  }
  return ready;
}

/** Test helper: forget the per-isolate "schema is current" state. */
export function resetSchemaState(): void {
  ready = null;
  lastFailure = null;
  lastFailureAt = 0;
}
