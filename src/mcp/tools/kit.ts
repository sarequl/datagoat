/**
 * Building blocks for MCP tool definitions. A tool is declarative: an input schema (zod, turned
 * into JSON Schema for `tools/list`), the REST permission it needs, the OAuth scopes that unlock
 * it, and a `request()` that maps arguments to one `/api/v1` call. The executor (../executor.ts)
 * does authorization, confirmation, idempotency, the in-process call and result formatting.
 */
import { z } from "zod";
import type { Permission } from "../../../shared/permissions";
import type { McpCaller } from "../auth";
import type { ApiRequest, ApiResult } from "../dispatch";
import { PERIODS } from "../periods";

export type Owner = "F0" | "W2" | "W3" | "W6";

export interface CallOptions {
  /** REST permissions granted to an OAuth caller for this call (default: the tool's permission). */
  grants?: Permission[];
  /** Run an OAuth call with access to every website of the user (website creation, usage). */
  allSites?: boolean;
}

export interface ToolContext {
  caller: McpCaller;
  now: number;
  origin: string;
  env: Cloudflare.Env;
  /** Call an /api/v1 handler in-process as the caller. */
  call(request: ApiRequest, options?: CallOptions): Promise<ApiResult>;
  /** The website the arguments target (explicit, or the credential's only website). */
  siteRef(args: { websiteId?: string | undefined }): string | undefined;
  /** Like siteRef, but a ToolError when no website can be determined. */
  requireSite(args: { websiteId?: string | undefined }): string;
  /** Timezone used to resolve `period` presets for a website. */
  siteTimezone(siteRef: string | undefined): Promise<string>;
}

export interface ToolResult {
  /** HTTP status of the underlying call (200 for custom tools). */
  status: number;
  body: unknown;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  access: "read" | "write";
  /** Irreversible or credential-issuing. */
  destructive?: boolean;
  /** Permission the REST endpoint checks for API tokens. */
  permission: Permission;
  /** OAuth scopes the connection must hold. */
  oauth: string[];
  /** Team that owns the REST endpoint (tests skip calls to endpoints still answering 501). */
  owner: Owner;
  /** Takes a `websiteId` argument. */
  site: boolean;
  /** OAuth callers need the owner role on the website. */
  oauthOwnerOnly?: boolean;
  request?: (args: Args, tc: ToolContext) => ApiRequest | Promise<ApiRequest>;
  /** Custom implementation for tools that are not one REST call. */
  run?: (args: Args, tc: ToolContext) => Promise<ToolResult>;
  /** Hook after a successful call (e.g. bind a minted credential to the OAuth connection). */
  after?: (args: Args, result: ApiResult, tc: ToolContext) => Promise<ApiResult | undefined>;
  /** Check arguments against the caller before running (throw ToolError). */
  guard?: (args: Args, tc: ToolContext) => Promise<void> | void;
  callOptions?: CallOptions;
}

// biome-ignore lint/suspicious/noExplicitAny: tool arguments are validated by each tool's zod schema
export type Args = Record<string, any>;

export class ToolError extends Error {
  constructor(
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

// ---------------------------------------------------------------------------
// Shared argument schemas
// ---------------------------------------------------------------------------

export const zWebsiteId = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "Website id (`_id` from websites_list) or tracking id. Optional with a df_ website key or a credential limited to one website.",
  );

export const rangeArgs = {
  period: z
    .enum(PERIODS)
    .optional()
    .describe(
      "Dashboard preset resolved in the website timezone. Use either period or startAt+endAt.",
    ),
  startAt: z
    .string()
    .max(40)
    .optional()
    .describe(
      "Range start: YYYY-MM-DD (whole days in the website timezone) or an ISO 8601 instant with Z or an offset. Requires endAt.",
    ),
  endAt: z.string().max(40).optional().describe("Range end (inclusive), same formats as startAt."),
  timezone: z.string().max(64).optional().describe("IANA timezone override, e.g. Europe/Paris."),
};

export const zFilters = z
  .record(z.string().max(40), z.union([z.string().max(2000), z.array(z.string().max(500)).max(50)]))
  .optional()
  .describe(
    'Segment filters, as in the dashboard. Keys: country, region, city, device, browser, os, referrer, page, entry_page, hostname, goal, visit_count, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref, source, via, channel (the "filter_" prefix is optional). Values: "[operator:]value[,value…]" with operators is (default), is_not, contains, does_not_contain, gte, lte. Example: {"country": "US", "page": "contains:/docs"}.',
  );

export const paginationArgs = {
  limit: z.number().int().min(1).max(1000).optional().describe("Rows to return (default 100)."),
  offset: z.number().int().min(0).optional().describe("Rows to skip."),
};

export const zFields = z
  .string()
  .max(500)
  .optional()
  .describe("Comma-separated response fields to include.");

/** Turn the `filters` argument into `filter_*` query parameters. */
export function filterQuery(filters: Record<string, string | string[]> | undefined) {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(filters ?? {})) {
    const key = rawKey.startsWith("filter_") ? rawKey : `filter_${rawKey}`;
    if (!/^filter_[a-z_]+$/.test(key)) throw new ToolError(`Invalid filter key: ${rawKey}`);
    out[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return out;
}

/** Resolve `period`/`startAt`/`endAt`/`timezone` to API query parameters. */
export async function rangeQuery(
  args: Args,
  tc: ToolContext,
  resolve: (period: string, timezone: string, now: number) => { startAt?: string; endAt?: string },
): Promise<Record<string, string | undefined>> {
  const { period, startAt, endAt, timezone } = args as {
    period?: string;
    startAt?: string;
    endAt?: string;
    timezone?: string;
  };
  if (period && (startAt || endAt)) {
    throw new ToolError("Use either period or startAt/endAt, not both");
  }
  if (Boolean(startAt) !== Boolean(endAt)) {
    throw new ToolError("startAt and endAt must be provided together");
  }
  if (!period) return { startAt, endAt, timezone };
  const tz = timezone ?? (await tc.siteTimezone(tc.siteRef(args)));
  let range: { startAt?: string; endAt?: string };
  try {
    range = resolve(period, tz, tc.now);
  } catch (err) {
    throw new ToolError(err instanceof Error ? err.message : String(err));
  }
  return { ...range, timezone };
}

export const enc = encodeURIComponent;
