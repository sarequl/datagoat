/**
 * Dashboard filters, in the API's `filter_*` syntax (docs/api/contract.md §1.6):
 * `filter_<key>=[operator:]value[,value…]`. The dashboard keeps them in the URL under the same names,
 * so a filtered view is a shareable link and the params go to the API unchanged.
 */

export type FilterOp = "is" | "is_not" | "contains" | "does_not_contain" | "gte" | "lte";

export type FilterGroup = "Source" | "URL" | "Location" | "System" | "Behaviour" | "Custom";

export interface FilterDef {
  key: string;
  label: string;
  group: FilterGroup;
  ops: readonly FilterOp[];
  /** Breakdown endpoint and row field used for value suggestions. */
  suggest?: { endpoint: string; field: string };
  /** Fixed list of values (channels, devices). */
  values?: readonly string[];
  numeric?: boolean;
}

const EQ: readonly FilterOp[] = ["is", "is_not"];
const TEXT: readonly FilterOp[] = ["is", "is_not", "contains", "does_not_contain"];

export const CHANNELS = [
  "Organic Search",
  "Paid Search",
  "Organic Social",
  "Paid Social",
  "Referral",
  "Email",
  "Newsletter",
  "Affiliate",
  "AI",
  "Display",
  "Direct",
  "Other",
] as const;

export const FILTER_DEFS: readonly FilterDef[] = [
  { key: "channel", label: "Channel", group: "Source", ops: EQ, values: CHANNELS },
  {
    key: "referrer",
    label: "Referrer",
    group: "Source",
    ops: TEXT,
    suggest: { endpoint: "referrers", field: "referrer" },
  },
  ...(
    [
      ["utm_source", "UTM source"],
      ["utm_medium", "UTM medium"],
      ["utm_campaign", "UTM campaign"],
      ["utm_term", "UTM term"],
      ["utm_content", "UTM content"],
      ["ref", "ref parameter"],
      ["source", "source parameter"],
      ["via", "via parameter"],
    ] as const
  ).map(
    ([key, label]): FilterDef => ({
      key,
      label,
      group: "Source",
      ops: TEXT,
      suggest: { endpoint: "campaigns", field: key },
    }),
  ),
  {
    key: "page",
    label: "Page",
    group: "URL",
    ops: TEXT,
    suggest: { endpoint: "pages", field: "path" },
  },
  {
    key: "entry_page",
    label: "Entry page",
    group: "URL",
    ops: TEXT,
    suggest: { endpoint: "entry-pages", field: "path" },
  },
  {
    key: "hostname",
    label: "Hostname",
    group: "URL",
    ops: TEXT,
    suggest: { endpoint: "hostnames", field: "hostname" },
  },
  {
    key: "country",
    label: "Country",
    group: "Location",
    ops: EQ,
    suggest: { endpoint: "countries", field: "country" },
  },
  {
    key: "region",
    label: "Region",
    group: "Location",
    ops: TEXT,
    suggest: { endpoint: "regions", field: "region" },
  },
  {
    key: "city",
    label: "City",
    group: "Location",
    ops: TEXT,
    suggest: { endpoint: "cities", field: "city" },
  },
  {
    key: "browser",
    label: "Browser",
    group: "System",
    ops: EQ,
    suggest: { endpoint: "browsers", field: "browser" },
  },
  {
    key: "os",
    label: "OS",
    group: "System",
    ops: EQ,
    suggest: { endpoint: "operating-systems", field: "operating_system" },
  },
  {
    key: "device",
    label: "Device",
    group: "System",
    ops: EQ,
    values: ["desktop", "mobile", "tablet"],
  },
  {
    key: "visit_count",
    label: "Visit count",
    group: "Behaviour",
    ops: ["gte", "lte", "is", "is_not"],
    numeric: true,
  },
  {
    key: "goal",
    label: "Goal",
    group: "Custom",
    ops: EQ,
    suggest: { endpoint: "goals", field: "goal" },
  },
];

export const FILTER_GROUPS: readonly FilterGroup[] = [
  "Source",
  "URL",
  "Location",
  "System",
  "Behaviour",
  "Custom",
];

export function filterDef(key: string): FilterDef | undefined {
  return FILTER_DEFS.find((d) => d.key === key);
}

export const OP_LABELS: Record<FilterOp, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  does_not_contain: "does not contain",
  gte: "at least",
  lte: "at most",
};

export interface ActiveFilter {
  key: string;
  op: FilterOp;
  values: string[];
}

const OPS: readonly FilterOp[] = ["is_not", "is", "does_not_contain", "contains", "gte", "lte"];

export function parseFilterValue(raw: string): { op: FilterOp; values: string[] } {
  let op: FilterOp = "is";
  let rest = raw;
  for (const candidate of OPS) {
    if (raw.startsWith(`${candidate}:`)) {
      op = candidate;
      rest = raw.slice(candidate.length + 1);
      break;
    }
  }
  const values = rest
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return { op, values };
}

export function serializeFilter(f: ActiveFilter): string {
  return `${f.op}:${f.values.join(",")}`;
}

/** Read `filter_*` keys from URL search params (values may be non-strings after parsing). */
export function filtersFromSearch(search: Record<string, unknown>): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  for (const [k, v] of Object.entries(search)) {
    if (!k.startsWith("filter_") || v === undefined || v === null || v === "") continue;
    const key = k.slice("filter_".length);
    if (!filterDef(key)) continue;
    const { op, values } = parseFilterValue(String(v));
    if (values.length) out.push({ key, op, values });
  }
  return out.sort(
    (a, b) =>
      FILTER_DEFS.findIndex((d) => d.key === a.key) - FILTER_DEFS.findIndex((d) => d.key === b.key),
  );
}

export function filtersToParams(filters: readonly ActiveFilter[]): Record<string, string> {
  return Object.fromEntries(filters.map((f) => [`filter_${f.key}`, serializeFilter(f)]));
}

/** Replace (or add) the filter for `f.key`; one filter per dimension, as the API requires. */
export function upsertFilter(filters: readonly ActiveFilter[], f: ActiveFilter): ActiveFilter[] {
  return [...filters.filter((x) => x.key !== f.key), f];
}

export function removeFilter(filters: readonly ActiveFilter[], key: string): ActiveFilter[] {
  return filters.filter((x) => x.key !== key);
}

export function describeFilter(f: ActiveFilter): string {
  const def = filterDef(f.key);
  return `${def?.label ?? f.key} ${OP_LABELS[f.op]} ${f.values.join(" or ")}`;
}

/**
 * Map dashboard filters onto `GET /api/v1/visitors` parameters, which only match exact values
 * (plus `visitedPageContains`). Returns the params and the filters that could not be applied.
 */
export function visitorListParams(filters: readonly ActiveFilter[]): {
  params: Record<string, string>;
  unsupported: ActiveFilter[];
} {
  const params: Record<string, string> = {};
  const unsupported: ActiveFilter[] = [];
  const direct = new Set([
    "country",
    "region",
    "city",
    "browser",
    "os",
    "device",
    "referrer",
    "hostname",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "source",
    "via",
  ]);
  for (const f of filters) {
    const value = f.values.join(",");
    if (f.key === "page" && f.op === "is") params.visitedPage = value;
    else if (f.key === "page" && f.op === "contains") params.visitedPageContains = value;
    else if (f.key === "goal" && f.op === "is" && f.values.length === 1) {
      params.completedGoal = value;
    } else if (f.key === "visit_count" && f.op === "is" && f.values.length === 1) {
      params.visitCount = value;
    } else if (direct.has(f.key) && f.op === "is") params[f.key] = value;
    else unsupported.push(f);
  }
  return { params, unsupported };
}
