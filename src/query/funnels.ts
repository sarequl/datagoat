/**
 * Conversion funnels (plan §9): 2-8 ordered steps, each a pageview (URL match types, optional
 * hostname) or a custom goal (completed / not_completed). A visitor reaches step k when they
 * reached step k-1 and then, at or after that time and inside the range, did step k
 * (first occurrence). A `not_completed` goal step keeps the visitors from step k-1 who did not
 * complete the goal after reaching it. Revenue per step is the revenue (payments in the range)
 * of the visitors who reached it.
 *
 * Cost: one statement. Pageviews and the steps' goal events in the range are each read once
 * into a materialised CTE (`events_time`, `events_activity`); the steps chain over them.
 */
import { z } from "zod";
import type { FunnelStep, FunnelUrlMatchType } from "../../shared/api-types";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { toMajor } from "../lib/money";
import { escapeLike, join, list, prepare, raw, SqlFragment, sql } from "../lib/sql";
import { zGoalName } from "../lib/validate";
import { ACTIVITY, hasFilters, type QueryContext, rangeOn, sessionScope } from "./context";
import { payByVisitorSql } from "./event-breakdowns";

export const URL_MATCH_TYPES = [
  "equals",
  "contains",
  "starts_with",
  "ends_with",
  "not_equals",
  "not_contains",
  "wildcard",
] as const satisfies readonly FunnelUrlMatchType[];

export const zFunnelStepInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(["pageview", "goal"]),
    url: z.string().trim().min(1).max(1000).optional(),
    urlMatchType: z.enum(URL_MATCH_TYPES).optional(),
    hostname: z
      .string()
      .trim()
      .max(253)
      .transform((v) => v.toLowerCase())
      .optional(),
    goalName: zGoalName.optional(),
    goalCompletionType: z.enum(["completed", "not_completed"]).optional(),
    id: z.string().optional(),
    _id: z.string().optional(),
  })
  .superRefine((step, ctx) => {
    if (step.type === "pageview" && !step.url) {
      ctx.addIssue({ code: "custom", message: "pageview steps need a url", path: ["url"] });
    }
    if (step.type === "goal" && !step.goalName) {
      ctx.addIssue({ code: "custom", message: "goal steps need a goalName", path: ["goalName"] });
    }
  });

export type FunnelStepInput = z.output<typeof zFunnelStepInput>;

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "funnel";
}

/** Normalise input steps into stored steps (server-assigned `_id`, unique slug `id`). */
export function normaliseSteps(input: FunnelStepInput[]): FunnelStep[] {
  const used = new Set<string>();
  return input.map((s) => {
    let id = slugify(s.name);
    for (let n = 2; used.has(id); n++) id = `${slugify(s.name)}-${n}`;
    used.add(id);
    const step: FunnelStep = { _id: newId(), id, name: s.name, type: s.type };
    if (s.type === "pageview") {
      step.url = s.url;
      if (s.urlMatchType) step.urlMatchType = s.urlMatchType;
      if (s.hostname) step.hostname = s.hostname;
    } else {
      step.goalName = s.goalName;
    }
    step.goalCompletionType = s.goalCompletionType ?? "completed";
    return step;
  });
}

/** Split a step URL into path (and hostname when it is a full URL). */
export function stepTarget(step: FunnelStep): { path: string; hostname: string | null } {
  const url = step.url ?? "/";
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return {
        path: `${u.pathname}${u.search}${u.hash}` || "/",
        hostname: step.hostname ?? u.hostname.toLowerCase(),
      };
    } catch {
      // fall through: treat as a path
    }
  }
  return { path: url, hostname: step.hostname ?? null };
}

/** SQL predicate matching a pageview step against columns `x.p` (path) and `x.h` (hostname). */
export function pageMatchSql(step: FunnelStep): SqlFragment {
  const { path, hostname } = stepTarget(step);
  const type = step.urlMatchType ?? "equals";
  const like = (pattern: string) => sql`x.p LIKE ${pattern} ESCAPE '\\'`;
  const equalsPart = (() => {
    const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
    const variants = [...new Set([trimmed, trimmed === "/" ? "/" : `${trimmed}/`])];
    return join(
      variants.map((v) => sql`x.p = ${v}`),
      " OR ",
    );
  })();
  let match: SqlFragment;
  switch (type) {
    case "equals":
      match = equalsPart;
      break;
    case "not_equals":
      match = sql`NOT (${equalsPart})`;
      break;
    case "contains":
      match = like(`%${escapeLike(path)}%`);
      break;
    case "not_contains":
      match = sql`NOT (${like(`%${escapeLike(path)}%`)})`;
      break;
    case "starts_with":
      match = like(`${escapeLike(path)}%`);
      break;
    case "ends_with":
      match = like(`%${escapeLike(path)}`);
      break;
    case "wildcard":
      match = like(escapeLike(path).replace(/\*/g, "%"));
      break;
  }
  return hostname ? sql`(${match}) AND x.h = ${hostname} COLLATE NOCASE` : match;
}

export interface FunnelStepResult {
  step: FunnelStep;
  visitors: number;
  revenueMinor: number;
}

export async function computeFunnel(
  qc: QueryContext,
  steps: FunnelStep[],
): Promise<FunnelStepResult[]> {
  if (steps.length === 0) return [];
  const visitorFilter = hasFilters(qc)
    ? sql`AND e.visitor_id IN (SELECT s.visitor_id FROM sessions s WHERE ${sessionScope(qc)})`
    : raw("");
  const goalNames = [
    ...new Set(steps.filter((s) => s.type === "goal").map((s) => s.goalName ?? "")),
  ];
  const ctes: SqlFragment[] = [];
  if (steps.some((s) => s.type === "pageview" || s.goalCompletionType === "not_completed")) {
    ctes.push(sql`pvs AS MATERIALIZED (SELECT e.visitor_id AS v, e.ts AS ts, e.hostname AS h, e.path AS p
      FROM events e WHERE e.site_id = ${qc.site.id} AND ${rangeOn("e.ts", qc.range)}
        AND e.type = 'pageview' ${visitorFilter})`);
  }
  if (goalNames.length) {
    ctes.push(sql`gs AS MATERIALIZED (SELECT e.visitor_id AS v, e.ts AS ts, e.name AS g
      FROM events e WHERE e.site_id = ${qc.site.id} AND e.${raw(ACTIVITY)} AND e.type = 'custom'
        AND ${rangeOn("e.ts", qc.range)} AND e.name IN ${list(goalNames)} ${visitorFilter})`);
  }
  steps.forEach((step, i) => {
    const prev = i > 0 ? raw(`f${i - 1}`) : null;
    const name = raw(`f${i}`);
    if (step.type === "pageview") {
      ctes.push(
        prev
          ? sql`${name} AS MATERIALIZED (SELECT x.v AS v, MIN(x.ts) AS t FROM pvs x
              JOIN ${prev} ON ${prev}.v = x.v AND x.ts >= ${prev}.t WHERE ${pageMatchSql(step)} GROUP BY x.v)`
          : sql`${name} AS MATERIALIZED (SELECT x.v AS v, MIN(x.ts) AS t FROM pvs x
              WHERE ${pageMatchSql(step)} GROUP BY x.v)`,
      );
      return;
    }
    const goal = step.goalName ?? "";
    if (step.goalCompletionType === "not_completed") {
      const base = prev
        ? sql`SELECT v, t FROM ${prev}`
        : raw("SELECT v, MIN(ts) AS t FROM pvs GROUP BY v");
      ctes.push(sql`${name} AS MATERIALIZED (SELECT b.v AS v, b.t AS t FROM (${base}) b
        LEFT JOIN (SELECT v, MAX(ts) AS last FROM gs WHERE g = ${goal} GROUP BY v) c ON c.v = b.v
        WHERE c.last IS NULL OR c.last < b.t)`);
      return;
    }
    ctes.push(
      prev
        ? sql`${name} AS MATERIALIZED (SELECT x.v AS v, MIN(x.ts) AS t FROM gs x
            JOIN ${prev} ON ${prev}.v = x.v AND x.ts >= ${prev}.t WHERE x.g = ${goal} GROUP BY x.v)`
        : sql`${name} AS MATERIALIZED (SELECT x.v AS v, MIN(x.ts) AS t FROM gs x
            WHERE x.g = ${goal} GROUP BY x.v)`,
    );
  });
  ctes.push(sql`pay AS MATERIALIZED (${payByVisitorSql(qc)})`);
  const selects = steps.map(
    (_, i) =>
      sql`SELECT ${raw(String(i))} AS i, COUNT(*) AS n, COALESCE(SUM(pay.rev), 0) AS rev
        FROM ${raw(`f${i}`)} f LEFT JOIN pay ON pay.v = f.v`,
  );
  // join() wraps parts in parentheses; CTE lists and compound selects must not be wrapped.
  const unwrapped = sql`WITH ${listOf(ctes, ", ")} ${listOf(selects, " UNION ALL ")} ORDER BY 1`;
  const res = await prepare(qc.db, unwrapped).all<{ i: number; n: number; rev: number }>();
  const byIndex = new Map((res.results ?? []).map((r) => [Number(r.i), r]));
  return steps.map((step, i) => ({
    step,
    visitors: Number(byIndex.get(i)?.n ?? 0),
    revenueMinor: Number(byIndex.get(i)?.rev ?? 0),
  }));
}

function listOf(parts: SqlFragment[], separator: string): SqlFragment {
  let text = "";
  const params: unknown[] = [];
  parts.forEach((p, i) => {
    if (i > 0) text += separator;
    text += p.sql;
    params.push(...p.params);
  });
  return new SqlFragment(text, params);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** DataFast's FunnelResult `data` and `metrics`. */
export function renderFunnelResult(
  qc: QueryContext,
  funnel: { id: string; name: string; slug: string; steps: FunnelStep[] },
  results: FunnelStepResult[],
) {
  const first = results[0]?.visitors ?? 0;
  const currency = qc.site.currency;
  const data = results.map((r, i) => {
    const prev = i > 0 ? (results[i - 1]?.visitors ?? 0) : r.visitors;
    return {
      id: r.step.id ?? String(i),
      label: r.step.name,
      value: r.visitors,
      stepIndex: i,
      stepType: r.step.type,
      revenue: toMajor(r.revenueMinor, currency),
      conversionRate: first > 0 ? round2((100 * r.visitors) / first) : 0,
      dropoffFromPrevious: i > 0 && prev > 0 ? round2((100 * (prev - r.visitors)) / prev) : 0,
    };
  });
  const completions = results[results.length - 1]?.visitors ?? 0;
  const firstRevenue = toMajor(results[0]?.revenueMinor ?? 0, currency);
  return {
    funnel,
    data,
    metrics: {
      totalVisitors: first,
      completions,
      overallConversionRate: first > 0 ? round2((100 * completions) / first) : 0,
      overallRevenuePerVisitor: first > 0 ? round2(firstRevenue / first) : 0,
      timezone: qc.timezone,
      startAt: qc.range ? new Date(qc.range.startMs).toISOString() : null,
      endAt: qc.range ? new Date(qc.range.endMs - 1).toISOString() : null,
      lastUpdated: new Date(qc.now).toISOString(),
    },
  };
}

export function assertStepCount(steps: unknown[], min: number, max: number): void {
  if (steps.length < min || steps.length > max) {
    throw new ApiError(400, `steps: a funnel needs ${min} to ${max} steps`);
  }
}
