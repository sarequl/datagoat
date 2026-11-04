/**
 * Typed client for the parts of DataGoat's /api/v1 the app uses. Pure TypeScript (no React
 * Native imports) so it is unit-tested from the repository root.
 */

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface WebsiteSummary {
  _id: string;
  domain: string;
  name: string | null;
  logo: string | null;
  trackingId: string;
  timezone: string;
  currency: string;
  role: "owner" | "member" | "viewer";
}

export interface MobileSession {
  token: string;
  tokenId: string;
  expiresAt: string;
  user: User;
  websites: WebsiteSummary[];
}

export interface Overview {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounce_rate: number;
  avg_session_duration: number;
  currency: string;
  revenue: number;
  payments: number;
  revenue_per_visitor: number;
  conversion_rate: number;
}

export interface TimeseriesPoint {
  timestamp: string;
  name?: string;
  visitors?: number;
  revenue?: number;
}

export type Breakdown =
  | "referrers"
  | "channels"
  | "campaigns"
  | "countries"
  | "devices"
  | "pages"
  | "goals";

export interface BreakdownRow {
  label: string;
  visitors: number;
  revenue: number | null;
}

export interface MobileDevice {
  id: string;
  platform: "ios" | "android";
  name: string | null;
  pushToken: string;
  notifySales: boolean;
  notifyAlerts: boolean;
  mutedSiteIds: string[];
}

export interface RegisterDevice {
  pushToken: string;
  platform: "ios" | "android";
  name?: string | null;
  notifySales?: boolean;
  notifyAlerts?: boolean;
  mutedSiteIds?: string[];
}

export interface Range {
  startAt: string;
  endAt: string;
  timezone: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isAuth(): boolean {
    return this.status === 401;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** "analytics.example.com", "https://analytics.example.com/" → "https://analytics.example.com". */
export function normalizeInstanceUrl(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = /^(localhost|127\.0\.0\.1|10\.|192\.168\.)/.test(url.hostname);
  if (url.protocol !== "https:" && !local) return null;
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
  return url.origin;
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { message?: string } | string } | null)?.error;
    const message =
      typeof err === "string" ? err : (err?.message ?? `Request failed (HTTP ${res.status})`);
    throw new ApiError(message, res.status);
  }
  return body;
}

function dataOf<T>(body: unknown): T {
  return (body as { data: T }).data;
}

/** Sign in on an instance; returns the mobile session (token + websites). */
export async function signIn(
  fetch: Fetch,
  instanceUrl: string,
  email: string,
  password: string,
  deviceName?: string,
): Promise<MobileSession> {
  let res: Response;
  try {
    res = await fetch(`${instanceUrl}/api/v1/mobile/session`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password, ...(deviceName ? { deviceName } : {}) }),
    });
  } catch {
    throw new ApiError(`Could not reach ${instanceUrl}`, 0);
  }
  if (res.status === 404) {
    throw new ApiError("This address is not a DataGoat instance (or it is too old).", 404);
  }
  return dataOf<MobileSession>(await parse(res));
}

const LABEL_KEYS: Record<Breakdown, string[]> = {
  referrers: ["referrer"],
  channels: ["channel"],
  campaigns: ["utm_campaign", "utm_source", "ref", "via", "source"],
  countries: ["country"],
  devices: ["device"],
  pages: ["path"],
  goals: ["goal"],
};

/** Pick a display label and the numbers from a breakdown row of any endpoint. */
export function toBreakdownRow(kind: Breakdown, row: Record<string, unknown>): BreakdownRow {
  let label = "";
  // Campaign rows nest their UTM fields under `campaign`.
  const source =
    kind === "campaigns" && row.campaign && typeof row.campaign === "object"
      ? { ...row, ...(row.campaign as Record<string, unknown>) }
      : row;
  for (const key of LABEL_KEYS[kind]) {
    const v = source[key];
    if (typeof v === "string" && v) {
      label = v;
      break;
    }
  }
  if (kind === "countries" && typeof row.image === "string" && label)
    label = `${row.image} ${label}`;
  if (kind === "pages" && typeof row.hostname === "string" && !label) label = row.hostname;
  return {
    label: label || "(none)",
    visitors: Number(row.visitors ?? 0),
    revenue: typeof row.revenue === "number" ? row.revenue : null,
  };
}

export function createApi(fetch: Fetch, instanceUrl: string, token: string) {
  const base = instanceUrl.replace(/\/+$/, "");
  async function request<T>(
    method: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${base}/api/v1/${path}`);
    for (const [k, v] of Object.entries(query))
      if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("No connection", 0);
    }
    return parse(res) as Promise<T>;
  }
  const site = (websiteId: string, range?: Range) => ({
    websiteId,
    ...(range ? { startAt: range.startAt, endAt: range.endAt, timezone: range.timezone } : {}),
  });

  return {
    async websites(): Promise<WebsiteSummary[]> {
      return dataOf(await request("GET", "admin/websites"));
    },
    async overview(websiteId: string, range: Range): Promise<Overview> {
      const rows = dataOf<Overview[]>(
        await request("GET", "analytics/overview", site(websiteId, range)),
      );
      const row = rows[0];
      if (!row) throw new ApiError("No data", 500);
      return row;
    },
    async timeseries(
      websiteId: string,
      range: Range,
      interval: "hour" | "day" | "week" | "month",
    ): Promise<TimeseriesPoint[]> {
      return dataOf(
        await request("GET", "analytics/timeseries", {
          ...site(websiteId, range),
          fields: "visitors,revenue",
          interval,
          limit: 1000,
        }),
      );
    },
    async realtime(websiteId: string): Promise<number> {
      const rows = dataOf<Array<{ visitors: number }>>(
        await request("GET", "analytics/realtime", site(websiteId)),
      );
      return rows[0]?.visitors ?? 0;
    },
    async breakdown(
      websiteId: string,
      kind: Breakdown,
      range: Range,
      limit = 10,
    ): Promise<BreakdownRow[]> {
      const rows = dataOf<Array<Record<string, unknown>>>(
        await request("GET", `analytics/${kind}`, { ...site(websiteId, range), limit }),
      );
      return rows.map((r) => toBreakdownRow(kind, r));
    },
    async devices(): Promise<MobileDevice[]> {
      return dataOf(await request("GET", "mobile/devices"));
    },
    async registerDevice(input: RegisterDevice): Promise<MobileDevice> {
      const rows = dataOf<MobileDevice[]>(await request("POST", "mobile/devices", {}, input));
      const row = rows[0];
      if (!row) throw new ApiError("Device not saved", 500);
      return row;
    },
    async deleteDevice(id: string): Promise<void> {
      await request("DELETE", `mobile/devices/${encodeURIComponent(id)}`);
    },
    async signOut(): Promise<void> {
      await request("DELETE", "mobile/session");
    },
  };
}

export type Api = ReturnType<typeof createApi>;
