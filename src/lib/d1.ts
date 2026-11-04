/**
 * D1 helpers.
 *
 * Free-plan rules these helpers encode (plan §7, §9; D1 limits page):
 * - at most 100 bound parameters per statement (`MAX_BOUND_PARAMS`, `chunkForParams`)
 * - at most 50 queries per Worker invocation on Free; one `db.batch()` counts as ONE query,
 *   so group writes with `runBatch()`
 * - every written table row and every index entry touched counts as a written row
 *
 * `instrumentD1()` wraps a binding and reports `meta` for every statement. It routes `first()`
 * and `raw()` through `all()` so their `rows_read`/`rows_written` are visible too. The scheduler
 * uses it to enforce a per-run query budget; tests use it as the write-budget meter.
 */

export const MAX_BOUND_PARAMS = 100;
/** Statements per `db.batch()` call made by `runBatch()`. */
export const DEFAULT_BATCH_SIZE = 50;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Split `values` for `IN (...)` lists so each statement stays under D1's 100-parameter cap.
 * `reserved` is how many other parameters the statement binds.
 */
export function chunkForParams<T>(values: readonly T[], reserved = 0): T[][] {
  const room = MAX_BOUND_PARAMS - reserved;
  if (room < 1)
    throw new Error(`No room for IN-list values: ${reserved} parameters already reserved`);
  return chunk(values, room);
}

/** `?, ?, ?` placeholders for `count` values. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Run statements in as few `db.batch()` calls as possible (each batch is atomic and counts as one
 * query against the per-invocation limit). Returns results in input order.
 */
export async function runBatch(
  db: D1Database,
  statements: readonly D1PreparedStatement[],
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<D1Result[]> {
  const results: D1Result[] = [];
  for (const group of chunk(statements, batchSize)) {
    if (group.length === 0) continue;
    results.push(...(await db.batch(group)));
  }
  return results;
}

/**
 * Run a `SELECT ... WHERE col IN (<list>)` over an arbitrarily long list by chunking it.
 * `build(placeholders, chunk)` returns the statement for one chunk; rows are concatenated.
 * All chunks go in one `db.batch()` call (one query against the invocation limit).
 */
export async function selectInChunks<Row, T>(
  db: D1Database,
  values: readonly T[],
  reserved: number,
  build: (placeholderList: string, chunkValues: T[]) => D1PreparedStatement,
): Promise<Row[]> {
  if (values.length === 0) return [];
  const stmts = chunkForParams(values, reserved).map((c) => build(placeholders(c.length), c));
  const results = await runBatch(db, stmts);
  return results.flatMap((r) => (r.results ?? []) as Row[]);
}

/** `first()` that keeps `meta` (D1's own `first()` discards it). */
export async function firstWithMeta<T>(
  stmt: D1PreparedStatement,
): Promise<{ row: T | null; meta: D1Meta }> {
  const res = await stmt.all<T>();
  return { row: (res.results?.[0] as T | undefined) ?? null, meta: res.meta };
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

export type D1CallKind = "run" | "all" | "first" | "raw" | "batch" | "exec";

export interface D1CallEvent {
  kind: D1CallKind;
  sql: string;
  /** Present for prepared statements (one entry per statement; batches emit one per statement). */
  meta?: D1Meta;
}

export type D1Observer = (event: D1CallEvent) => void;

/** Called before every query is sent; throw to refuse it (used for query budgets). */
export type D1Gate = (kind: D1CallKind) => void;

interface Unwrappable {
  readonly __inner: D1PreparedStatement;
  readonly __sql: string;
}

class InstrumentedStatement implements Unwrappable {
  constructor(
    readonly __inner: D1PreparedStatement,
    readonly __sql: string,
    private readonly observe: D1Observer,
    private readonly gate: D1Gate | undefined,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new InstrumentedStatement(
      this.__inner.bind(...values),
      this.__sql,
      this.observe,
      this.gate,
    ) as unknown as D1PreparedStatement;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.gate?.("all");
    const res = await this.__inner.all<T>();
    this.observe({ kind: "all", sql: this.__sql, meta: res.meta });
    return res;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.gate?.("run");
    const res = await this.__inner.run<T>();
    this.observe({ kind: "run", sql: this.__sql, meta: res.meta });
    return res;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    this.gate?.("first");
    const res = await this.__inner.all<Record<string, unknown>>();
    this.observe({ kind: "first", sql: this.__sql, meta: res.meta });
    const row = res.results?.[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    this.gate?.("raw");
    const res = await this.__inner.all<Record<string, unknown>>();
    this.observe({ kind: "raw", sql: this.__sql, meta: res.meta });
    const rows = res.results ?? [];
    const arrays = rows.map((r) => Object.values(r));
    if (options?.columnNames) {
      const names = rows[0] ? Object.keys(rows[0]) : [];
      return [names, ...arrays] as T[];
    }
    return arrays as T[];
  }
}

function unwrap(stmt: D1PreparedStatement): { inner: D1PreparedStatement; sql: string } {
  const s = stmt as unknown as Partial<Unwrappable>;
  return s.__inner ? { inner: s.__inner, sql: s.__sql ?? "" } : { inner: stmt, sql: "" };
}

/**
 * Wrap a D1 binding so every statement reports its `meta` to `observe`. The wrapper is a drop-in
 * `D1Database` (prepare, batch, exec, dump, withSession pass through).
 */
export function instrumentD1(db: D1Database, observe: D1Observer, gate?: D1Gate): D1Database {
  const wrapped = {
    prepare(query: string): D1PreparedStatement {
      return new InstrumentedStatement(
        db.prepare(query),
        query,
        observe,
        gate,
      ) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      gate?.("batch");
      const unwrapped = statements.map(unwrap);
      const results = await db.batch<T>(unwrapped.map((u) => u.inner));
      results.forEach((r, i) => {
        observe({ kind: "batch", sql: unwrapped[i]?.sql ?? "", meta: r.meta });
      });
      return results;
    },
    async exec(query: string): Promise<D1ExecResult> {
      gate?.("exec");
      const res = await db.exec(query);
      observe({ kind: "exec", sql: query });
      return res;
    },
    dump(): Promise<ArrayBuffer> {
      return (db as unknown as { dump(): Promise<ArrayBuffer> }).dump();
    },
    withSession(constraintOrBookmark?: string) {
      return db.withSession(constraintOrBookmark as D1SessionConstraint);
    },
  };
  return wrapped as unknown as D1Database;
}

/** Totals collected by `createD1Meter()`. */
export interface D1Usage {
  /** Queries counted against the per-invocation limit (a batch counts once). */
  queries: number;
  statements: number;
  rowsRead: number;
  rowsWritten: number;
}

/**
 * Meter a D1 binding: returns the wrapped binding and a live usage counter.
 * `maxQueries` makes the wrapper throw `QueryBudgetExceeded` before exceeding the budget.
 */
export function createD1Meter(
  db: D1Database,
  options: { maxQueries?: number } = {},
): { db: D1Database; usage: D1Usage; log: D1CallEvent[]; reset(): void } {
  const usage: D1Usage = { queries: 0, statements: 0, rowsRead: 0, rowsWritten: 0 };
  const log: D1CallEvent[] = [];
  const gate: D1Gate = () => {
    if (options.maxQueries !== undefined && usage.queries >= options.maxQueries) {
      throw new QueryBudgetExceeded(options.maxQueries);
    }
    usage.queries += 1;
  };
  const observe: D1Observer = (event) => {
    log.push(event);
    usage.statements += event.kind === "exec" ? 0 : 1;
    usage.rowsRead += event.meta?.rows_read ?? 0;
    usage.rowsWritten += event.meta?.rows_written ?? 0;
  };
  return {
    db: instrumentD1(db, observe, gate),
    usage,
    log,
    reset() {
      usage.queries = 0;
      usage.statements = 0;
      usage.rowsRead = 0;
      usage.rowsWritten = 0;
      log.length = 0;
    },
  };
}

export class QueryBudgetExceeded extends Error {
  constructor(readonly budget: number) {
    super(`D1 query budget of ${budget} exceeded for this invocation`);
    this.name = "QueryBudgetExceeded";
  }
}

/** Parse a JSON text column, returning `fallback` on null or invalid JSON. */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** SQLite integer booleans. */
export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}
