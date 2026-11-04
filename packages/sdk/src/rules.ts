/**
 * Goal and parameter rules from DataFast's documented JavaScript API (plan §3.3). The SDK checks
 * them before handing a call to the tracker so mistakes surface in development instead of being
 * dropped silently by the collector.
 */

export const GOAL_NAME_RE = /^[a-z0-9_:-]{1,64}$/;
export const PARAM_NAME_RE = /^[a-z0-9_-]{1,64}$/;
export const MAX_PARAMS = 10;
export const MAX_VALUE_LENGTH = 255;
// Commands of window.datafast(); a goal with one of these names would be read as the command.
export const RESERVED_GOALS = new Set(["identify", "payment", "consent"]);

export type ParamValue = string | number | boolean | null | undefined;
export type GoalParams = Record<string, ParamValue>;

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** Lowercases the name; rejects anything else DataFast would reject. */
export function normalizeGoalName(name: string): Validation<string> {
  const value = String(name).trim().toLowerCase();
  if (!GOAL_NAME_RE.test(value)) {
    return {
      ok: false,
      error: `Invalid goal name "${name}": use up to 64 characters a-z, 0-9, _, - or :`,
    };
  }
  if (RESERVED_GOALS.has(value)) {
    return { ok: false, error: `"${value}" is reserved; use identify()/payment() instead` };
  }
  return { ok: true, value };
}

/**
 * Converts kebab-case names to snake_case (as the tracker does for data-fast-goal-* attributes),
 * stringifies values, truncates them to 255 characters and drops empty ones.
 */
export function normalizeParams(
  params: GoalParams | undefined,
): Validation<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!params) return { ok: true, value: out };
  for (const [rawKey, rawValue] of Object.entries(params)) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const key = rawKey.trim().toLowerCase().replace(/-/g, "_");
    if (!PARAM_NAME_RE.test(key)) {
      return { ok: false, error: `Invalid parameter name "${rawKey}": use a-z, 0-9, _ or -` };
    }
    out[key] = String(rawValue).slice(0, MAX_VALUE_LENGTH);
  }
  if (Object.keys(out).length > MAX_PARAMS) {
    return { ok: false, error: `Too many parameters: at most ${MAX_PARAMS}` };
  }
  return { ok: true, value: out };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** DataFast visitor ids are UUID v4 (cookie mode). */
export function isVisitorId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

/** DataFast session ids are `s` + UUID v4. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value[0] === "s" && UUID_V4_RE.test(value.slice(1));
}
