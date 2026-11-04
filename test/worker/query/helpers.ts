/** Helpers for query-layer tests: build a QueryContext directly and capture executed SQL. */
import { env } from "cloudflare:test";
import type { Site } from "../../../src/lib/sites";
import { parseRange } from "../../../src/lib/time";
import type { QueryContext } from "../../../src/query/context";

export function qcFor(
  site: Site,
  range: { startAt: string; endAt: string } | null,
  overrides: Partial<QueryContext> & { envOverrides?: Partial<Cloudflare.Env> } = {},
): QueryContext {
  const { envOverrides, ...rest } = overrides;
  const now = rest.now ?? Date.now();
  return {
    db: env.DB,
    env: { ...env, ...(envOverrides ?? {}) } as Cloudflare.Env,
    site,
    range: range ? parseRange(range, site.timezone, undefined, now) : null,
    timezone: site.timezone,
    filters: [],
    now,
    includePii: true,
    publicView: false,
    ...rest,
  };
}

export interface Captured {
  sql: string;
  params: unknown[];
}

/** Wrap a D1 binding and record every statement (SQL + bound parameters) that runs. */
export function capturing(db: D1Database): { db: D1Database; statements: Captured[] } {
  const statements: Captured[] = [];
  type Wrapped = D1PreparedStatement & {
    __inner: D1PreparedStatement;
    __sql: string;
    __params: unknown[];
  };
  const wrap = (sql: string, inner: D1PreparedStatement, params: unknown[] = []): Wrapped => {
    const record = () => statements.push({ sql, params });
    return {
      __inner: inner,
      __sql: sql,
      __params: params,
      bind: (...p: unknown[]) => wrap(sql, inner.bind(...p), p),
      all: () => {
        record();
        return inner.all();
      },
      first: (col?: string) => {
        record();
        return col === undefined ? inner.first() : inner.first(col);
      },
      run: () => {
        record();
        return inner.run();
      },
      raw: () => {
        record();
        return inner.raw();
      },
    } as unknown as Wrapped;
  };
  const wrapped = {
    prepare: (sql: string) => wrap(sql, db.prepare(sql)),
    batch: (stmts: Wrapped[]) => {
      for (const s of stmts) statements.push({ sql: s.__sql, params: s.__params });
      return db.batch(stmts.map((s) => s.__inner));
    },
    exec: (q: string) => db.exec(q),
  };
  return { db: wrapped as unknown as D1Database, statements };
}

/** `EXPLAIN QUERY PLAN` details of a captured statement. */
export async function plan(c: Captured): Promise<string[]> {
  const stmt = env.DB.prepare(`EXPLAIN QUERY PLAN ${c.sql}`);
  const res = await (c.params.length ? stmt.bind(...c.params) : stmt).all<{ detail: string }>();
  return (res.results ?? []).map((r) => r.detail);
}

/** Bulk-insert `n` visitors, each with one session, spread over [startMs, startMs + spanMs). */
export async function bulkSessions(
  siteId: string,
  n: number,
  startMs: number,
  spanMs: number,
  options: { prefix?: string } = {},
): Promise<void> {
  const prefix = options.prefix ?? "v";
  const step = Math.max(1, Math.floor(spanMs / n));
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ?4 - 1)
       INSERT INTO visitors (site_id, id, first_seen_at, first_session_id)
       SELECT ?1, ?5 || i, ?2 + i * ?3, 's' || ?5 || i FROM k`,
    ).bind(siteId, startMs, step, n, prefix),
    env.DB.prepare(
      `WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ?4 - 1)
       INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, session_number, entry_path, exit_path,
         pageviews, interactions, channel, source, referrer_domain, country, device, browser, os, hostname)
       SELECT ?1, 's' || ?5 || i, ?5 || i, ?2 + i * ?3, ?2 + i * ?3 + 60000, 1 + (i % 3), '/p' || (i % 20), '/p' || (i % 20),
         1 + (i % 4), 0,
         CASE i % 4 WHEN 0 THEN 'Organic Search' WHEN 1 THEN 'Direct' WHEN 2 THEN 'Organic Social' ELSE 'Referral' END,
         CASE i % 4 WHEN 0 THEN 'Google' WHEN 2 THEN 'X' ELSE NULL END,
         CASE i % 4 WHEN 0 THEN 'google.com' WHEN 2 THEN 't.co' WHEN 3 THEN 'blog.example' ELSE NULL END,
         CASE i % 5 WHEN 0 THEN 'US' WHEN 1 THEN 'DE' WHEN 2 THEN 'FR' WHEN 3 THEN 'GB' ELSE 'IN' END,
         CASE i % 3 WHEN 0 THEN 'desktop' WHEN 1 THEN 'mobile' ELSE 'tablet' END,
         CASE i % 3 WHEN 0 THEN 'Chrome' WHEN 1 THEN 'Mobile Safari' ELSE 'Firefox' END,
         CASE i % 3 WHEN 0 THEN 'Mac OS' WHEN 1 THEN 'iOS' ELSE 'Windows' END,
         'example.com'
       FROM k`,
    ).bind(siteId, startMs, step, n, prefix),
  ]);
}
