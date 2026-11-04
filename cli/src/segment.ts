/**
 * Shared analytics flags: date range (`--period`, `--from`, `--to`, `--timezone`), pagination,
 * fields, and dashboard-style filters (`-F key=value`, `-F key:op=value`, `-F key=op:value`,
 * plus friendly aliases like `--country`).
 */
import { isPeriod, PERIODS, resolvePeriod } from "../../src/mcp/periods";
import type { FlagSpec } from "./args";
import { type Ctx, UsageError } from "./context";

export const FILTER_KEYS = [
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "referrer",
  "page",
  "entry_page",
  "hostname",
  "goal",
  "visit_count",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "source",
  "via",
  "channel",
] as const;

const OPERATORS = ["is", "is_not", "contains", "does_not_contain", "gte", "lte"] as const;

export const RANGE_FLAGS: Record<string, FlagSpec> = {
  period: {
    type: "string",
    value: "<period>",
    description: `Preset in the website timezone: ${PERIODS.join(", ")}`,
  },
  from: {
    type: "string",
    value: "<date>",
    description: "Start: YYYY-MM-DD or ISO time with Z/offset",
  },
  to: { type: "string", value: "<date>", description: "End (inclusive), same formats as --from" },
  timezone: { type: "string", value: "<tz>", description: "IANA timezone override" },
};

export const PAGE_FLAGS: Record<string, FlagSpec> = {
  limit: { type: "string", value: "<n>", description: "Max rows (default 50)" },
  offset: { type: "string", value: "<n>", description: "Rows to skip" },
};

const kebab = (key: string) => key.replace(/_/g, "-");

/** Friendly filter aliases (`--country US`, `--utm-source google`), each repeatable. */
export const FILTER_ALIAS_FLAGS: Record<string, FlagSpec> = Object.fromEntries(
  FILTER_KEYS.map((key) => [
    kebab(key),
    { type: "multi", value: "<value>", description: `Filter by ${key.replace(/_/g, " ")}` },
  ]),
);

export const FILTER_FLAGS: Record<string, FlagSpec> = {
  filter: {
    type: "multi",
    short: "F",
    value: "<key=value>",
    description: "Filter, repeatable: key=value, key:operator=value or key=operator:value",
  },
  ...FILTER_ALIAS_FLAGS,
};

export const ANALYTICS_FLAGS: Record<string, FlagSpec> = {
  ...RANGE_FLAGS,
  ...PAGE_FLAGS,
  fields: { type: "string", value: "<a,b>", description: "Comma-separated fields to return" },
  ...FILTER_FLAGS,
};

function parseOne(raw: string): { key: string; op: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new UsageError(`Invalid filter "${raw}". Use key=value.`);
  let key = raw.slice(0, eq).trim().replace(/-/g, "_");
  let value = raw.slice(eq + 1).trim();
  let op = "is";
  const colon = key.indexOf(":");
  if (colon > 0) {
    op = key.slice(colon + 1);
    key = key.slice(0, colon);
  } else {
    const m = /^([a-z_]+):(.*)$/.exec(value);
    if (m && (OPERATORS as readonly string[]).includes(m[1] as string)) {
      op = m[1] as string;
      value = m[2] as string;
    }
  }
  if (key.startsWith("filter_")) key = key.slice("filter_".length);
  if (!(FILTER_KEYS as readonly string[]).includes(key)) {
    throw new UsageError(`Unknown filter key "${key}". Keys: ${FILTER_KEYS.join(", ")}`);
  }
  if (!(OPERATORS as readonly string[]).includes(op)) {
    throw new UsageError(`Unknown filter operator "${op}". Operators: ${OPERATORS.join(", ")}`);
  }
  if (!value) throw new UsageError(`Filter ${key} needs a value`);
  return { key, op, value };
}

/** Collect -F and alias flags into `filter_*` query parameters. */
export function filterParams(ctx: Ctx): Record<string, string> {
  const merged = new Map<string, { op: string; values: string[] }>();
  const add = (key: string, op: string, value: string) => {
    const prev = merged.get(key);
    if (prev && prev.op !== op) {
      throw new UsageError(`Do not mix operators for ${key} (${prev.op} and ${op})`);
    }
    const entry = prev ?? { op, values: [] };
    entry.values.push(value);
    merged.set(key, entry);
  };
  for (const raw of ctx.flags.list("filter")) {
    const f = parseOne(raw);
    add(f.key, f.op, f.value);
  }
  for (const key of FILTER_KEYS) {
    for (const raw of ctx.flags.list(kebab(key))) {
      const f = parseOne(`${key}=${raw}`);
      add(f.key, f.op, f.value);
    }
  }
  const out: Record<string, string> = {};
  for (const [key, { op, values }] of merged) {
    out[`filter_${key}`] = op === "is" ? values.join(",") : `${op}:${values.join(",")}`;
  }
  return out;
}

const ISO_NO_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** `startAt`/`endAt`/`timezone` from --period or --from/--to. */
export async function rangeParams(
  ctx: Ctx,
  site: string | undefined,
): Promise<Record<string, string | undefined>> {
  const period = ctx.flags.string("period");
  const from = ctx.flags.string("from");
  const to = ctx.flags.string("to");
  const timezone = ctx.flags.string("timezone");
  for (const [flag, v] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (v && ISO_NO_ZONE.test(v)) {
      throw new UsageError(
        `--${flag} ${v} is ambiguous: use YYYY-MM-DD or add Z / an offset (e.g. ${v}Z)`,
      );
    }
  }
  if (period && (from || to)) throw new UsageError("Use --period or --from/--to, not both");
  if (Boolean(from) !== Boolean(to)) throw new UsageError("--from and --to go together");
  if (!period) return { startAt: from, endAt: to, timezone };
  if (!isPeriod(period))
    throw new UsageError(`Unknown --period. Use one of: ${PERIODS.join(", ")}`);
  const tz = timezone ?? (await ctx.timezoneFor(site));
  return { ...resolvePeriod(period, tz, ctx.io.now()), timezone };
}

export function pageParams(ctx: Ctx, defaultLimit?: number) {
  return {
    limit: ctx.flags.int("limit", { min: 1, max: 1000 }) ?? defaultLimit,
    offset: ctx.flags.int("offset", { min: 0 }),
  };
}
