/**
 * A tiny parameterised-SQL builder. Values interpolated into the `sql` tag become `?` bound
 * parameters; nested fragments are spliced in with their parameters in order. Use `raw()` only
 * for identifiers taken from a whitelist, never for user input.
 *
 *   const where = sql`s.site_id = ${siteId} AND s.started_at >= ${from}`;
 *   const q = sql`SELECT COUNT(*) AS n FROM sessions s WHERE ${where} AND ${filters}`;
 *   await prepare(env.DB, q).first();
 */
import { MAX_BOUND_PARAMS } from "./d1";

export class SqlFragment {
  constructor(
    readonly sql: string,
    readonly params: readonly unknown[],
  ) {}

  /** True for an empty/`1=1` fragment. */
  get isEmpty(): boolean {
    return this.sql.trim() === "" || this.sql.trim() === "1=1";
  }
}

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;

function normalise(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export function sql(
  strings: TemplateStringsArray,
  ...values: Array<SqlValue | SqlFragment | undefined>
): SqlFragment {
  let text = strings[0] ?? "";
  const params: unknown[] = [];
  values.forEach((value, i) => {
    if (value instanceof SqlFragment) {
      text += value.sql;
      params.push(...value.params);
    } else {
      text += "?";
      params.push(normalise(value));
    }
    text += strings[i + 1] ?? "";
  });
  return new SqlFragment(text, params);
}

/** Splice a trusted string verbatim (identifiers from a whitelist, numeric literals you produced). */
export function raw(text: string): SqlFragment {
  return new SqlFragment(text, []);
}

export const TRUE = raw("1=1");

/**
 * Join fragments with a separator, skipping empty ones. Every part and the result are wrapped in
 * parentheses, so the result is safe to splice next to other operators. Returns `1=1` for an
 * AND-join of nothing and `1=0` for an OR-join of nothing.
 */
export function join(fragments: readonly SqlFragment[], separator = " AND "): SqlFragment {
  const parts = fragments.filter((f) => !f.isEmpty);
  if (parts.length === 0) return separator.trim().toUpperCase() === "OR" ? raw("1=0") : TRUE;
  return new SqlFragment(
    `(${parts.map((f) => `(${f.sql})`).join(separator)})`,
    parts.flatMap((f) => [...f.params]),
  );
}

/** `(?, ?, ?)` for a non-empty list. */
export function list(values: readonly SqlValue[]): SqlFragment {
  if (values.length === 0) throw new Error("sql list() needs at least one value");
  return new SqlFragment(`(${values.map(() => "?").join(", ")})`, values.map(normalise));
}

/** Prepare a fragment against a D1 database. Throws when it exceeds D1's 100 bound parameters. */
export function prepare(db: D1Database, fragment: SqlFragment): D1PreparedStatement {
  if (fragment.params.length > MAX_BOUND_PARAMS) {
    throw new Error(
      `Query has ${fragment.params.length} bound parameters; D1 allows ${MAX_BOUND_PARAMS}`,
    );
  }
  const stmt = db.prepare(fragment.sql);
  return fragment.params.length ? stmt.bind(...fragment.params) : stmt;
}

/** Escape `%`, `_` and `\` for use in `LIKE ? ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
