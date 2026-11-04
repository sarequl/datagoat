/**
 * Typed client for the DataGoat API (`/api/v1`, plus `/api/auth/me`). Shapes come from the
 * contract types in shared/api-types.ts. Errors carry the HTTP status and the server's message.
 */
import type {
  AccessToken,
  Account,
  Alert,
  AlertHistoryEntry,
  ApiSuccess,
  CreatedInvite,
  CreatedWebsite,
  CreatePaymentRequest,
  CreatePaymentResult,
  Funnel,
  FunnelResult,
  GoalColor,
  GoalCustomization,
  Me,
  Note,
  PaymentRow,
  PendingInvite,
  TeamMember,
  TrackedGoal,
  VisitorListRow,
  VisitorProfile,
  Website,
  WebsiteKey,
  WebsiteSummary,
} from "../../shared/api-types";

declare const __CLI_VERSION__: string;
export const VERSION = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev";

export type Query = Record<string, string | number | boolean | undefined | null>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string | undefined;
  fetch: typeof fetch;
  /** Called with `METHOD url → status` when --verbose is on. */
  trace?: (line: string) => void;
  timeoutMs?: number;
}

export type Envelope<T> = ApiSuccess<T> & Record<string, unknown>;

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; message?: unknown };
    if (b.error && typeof b.error === "object" && "message" in b.error) {
      return String((b.error as { message: unknown }).message);
    }
    if (typeof b.message === "string") return b.message;
    if (typeof b.error === "string") return b.error;
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return `Request failed with HTTP ${status}`;
}

export class Client {
  constructor(private readonly options: ClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    return `${this.options.baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  /** Raw request: returns the parsed JSON body (any shape) or throws ApiError. */
  async raw<T = unknown>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const url = this.url(path, query);
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `datagoat-cli/${VERSION}`,
    };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.options.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new ApiError(
        0,
        `Could not reach ${this.options.baseUrl}: ${(err as Error).message}`,
        null,
      );
    }
    this.options.trace?.(`${method} ${url} → ${res.status}`);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    if (!res.ok) {
      const retry = res.headers.get("retry-after");
      const suffix = res.status === 429 && retry ? ` (retry after ${retry}s)` : "";
      throw new ApiError(res.status, `${errorMessage(res.status, parsed)}${suffix}`, parsed);
    }
    return parsed as T;
  }

  /** Envelope request (`{status, data, …}`). */
  request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<Envelope<T>> {
    return this.raw<Envelope<T>>(method, path, query, body);
  }

  async data<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    return (await this.request<T>(method, path, query, body)).data;
  }

  // -------------------------------------------------------------- typed endpoints

  me = () => this.data<Me>("GET", "/api/auth/me");
  account = async () => (await this.data<Account[]>("GET", "/api/v1/admin/account"))[0] as Account;
  updateAccount = (name: string) =>
    this.data<unknown[]>("PUT", "/api/v1/admin/account", {}, { name });

  websites = () => this.data<WebsiteSummary[]>("GET", "/api/v1/admin/websites");
  website = async (id: string) =>
    (await this.data<Website[]>("GET", `/api/v1/admin/websites/${enc(id)}`))[0] as Website;
  createWebsite = (body: { domain: string; timezone: string; name?: string; currency?: string }) =>
    this.data<CreatedWebsite[]>("POST", "/api/v1/admin/websites", {}, body);
  updateWebsite = (id: string, body: Record<string, unknown>) =>
    this.data<Website[]>("PUT", `/api/v1/admin/websites/${enc(id)}`, {}, body);
  deleteWebsite = (id: string) =>
    this.data<unknown[]>("DELETE", `/api/v1/admin/websites/${enc(id)}`);

  keys = (site: string) => this.data<WebsiteKey[]>("GET", `${W(site)}/apikeys`);
  createKey = (site: string, body: { name?: string; includePii?: boolean }) =>
    this.data<Array<WebsiteKey & { key: string }>>("POST", `${W(site)}/apikeys`, {}, body);
  rollKey = (site: string, id: string) =>
    this.data<Array<WebsiteKey & { key: string }>>("PUT", `${W(site)}/apikeys/${enc(id)}`, {}, {});
  deleteKey = (site: string, id: string) =>
    this.data<unknown[]>("DELETE", `${W(site)}/apikeys/${enc(id)}`);

  tokens = () => this.data<AccessToken[]>("GET", "/api/v1/admin/access-tokens");
  createToken = (body: Record<string, unknown>) =>
    this.data<Array<AccessToken & { key: string }>>(
      "POST",
      "/api/v1/admin/access-tokens",
      {},
      body,
    );
  deleteToken = (id: string) =>
    this.data<unknown[]>("DELETE", `/api/v1/admin/access-tokens/${enc(id)}`);

  team = (site: string) => this.data<TeamMember[]>("GET", `${W(site)}/team`);
  invites = (site: string) => this.data<PendingInvite[]>("GET", `${W(site)}/team/invites`);
  invite = (site: string, email: string, role: string) =>
    this.data<CreatedInvite[]>("POST", `${W(site)}/team`, {}, { email, role });
  removeMember = (site: string, userId: string) =>
    this.data<unknown[]>("DELETE", `${W(site)}/team`, {}, { userId });
  setRole = (site: string, userId: string, role: string) =>
    this.data<unknown[]>("PUT", `${W(site)}/team`, {}, { userId, role });

  trackedGoals = (site: string) => this.data<TrackedGoal[]>("GET", `${W(site)}/goals`);
  goalCustomizations = (site: string, goalName?: string) =>
    this.request<GoalCustomization[]>("GET", `${W(site)}/goals/customizations`, {
      goalName,
    }) as Promise<Envelope<GoalCustomization[]> & { colors?: GoalColor[] }>;
  customizeGoal = (site: string, body: Record<string, unknown>) =>
    this.data<GoalCustomization[]>("PATCH", `${W(site)}/goals/customizations`, {}, body);
  resetGoal = (site: string, goalName: string) =>
    this.data<unknown[]>("DELETE", `${W(site)}/goals/customizations`, { goalName });
  trackGoal = (site: string | undefined, body: Record<string, unknown>) =>
    this.data<unknown[]>("POST", "/api/v1/goals", { websiteId: site }, body);
  deleteGoalEvents = (query: Query) => this.data<unknown[]>("DELETE", "/api/v1/goals", query);

  funnels = (site: string) => this.data<Funnel[]>("GET", `${W(site)}/funnels`);
  funnel = (site: string | undefined, id: string, query: Query) =>
    this.data<FunnelResult[]>("GET", `/api/v1/analytics/funnels/${enc(id)}`, {
      websiteId: site,
      ...query,
    });
  createFunnel = (site: string, body: Record<string, unknown>) =>
    this.data<Funnel[]>("POST", `${W(site)}/funnels`, {}, body);
  updateFunnel = (site: string, id: string, body: Record<string, unknown>) =>
    this.data<Funnel[]>("PUT", `${W(site)}/funnels/${enc(id)}`, {}, body);
  deleteFunnel = (site: string, id: string) =>
    this.data<unknown[]>("DELETE", `${W(site)}/funnels/${enc(id)}`);

  notes = (site: string, query: Query) => this.request<Note[]>("GET", `${W(site)}/notes`, query);
  createNote = (site: string, body: Record<string, unknown>) =>
    this.data<Note[]>("POST", `${W(site)}/notes`, {}, body);
  updateNote = (site: string, id: string, body: Record<string, unknown>) =>
    this.data<Note[]>("PUT", `${W(site)}/notes/${enc(id)}`, {}, body);
  deleteNote = (site: string, id: string) =>
    this.data<unknown[]>("DELETE", `${W(site)}/notes/${enc(id)}`);

  alerts = (site: string) => this.data<Alert[]>("GET", `${W(site)}/alerts`);
  createAlert = (site: string, body: Record<string, unknown>) =>
    this.data<Alert[]>("POST", `${W(site)}/alerts`, {}, body);
  updateAlert = (site: string, id: string, body: Record<string, unknown>) =>
    this.data<Alert[]>("PUT", `${W(site)}/alerts/${enc(id)}`, {}, body);
  deleteAlert = (site: string, id: string) =>
    this.data<unknown[]>("DELETE", `${W(site)}/alerts/${enc(id)}`);
  alertHistory = (site: string, query: Query) =>
    this.request<AlertHistoryEntry[]>("GET", `${W(site)}/alerts/history`, query);
  testAlert = (site: string, id: string) =>
    this.data<unknown[]>("POST", `${W(site)}/alerts/${enc(id)}/test`, {}, {});

  visitors = (site: string | undefined, query: Query) =>
    this.request<VisitorListRow[]>("GET", "/api/v1/visitors", { websiteId: site, ...query });
  visitor = (site: string | undefined, id: string) =>
    this.data<VisitorProfile>("GET", `/api/v1/visitors/${enc(id)}`, { websiteId: site });

  payments = (site: string | undefined, query: Query) =>
    this.request<PaymentRow[]>("GET", "/api/v1/payments", { websiteId: site, ...query });
  createPayment = (site: string | undefined, body: CreatePaymentRequest) =>
    this.raw<CreatePaymentResult>("POST", "/api/v1/payments", { websiteId: site }, body);
  deletePayments = (site: string | undefined, query: Query) =>
    this.data<unknown[]>("DELETE", "/api/v1/payments", { websiteId: site, ...query });
  identify = (site: string | undefined, body: Record<string, unknown>) =>
    this.raw<Record<string, unknown>>("POST", "/api/v1/identify", { websiteId: site }, body);

  analytics = (report: string, site: string | undefined, query: Query) =>
    this.request<unknown>("GET", `/api/v1/analytics/${report}`, { websiteId: site, ...query });
}

const enc = encodeURIComponent;
const W = (site: string) => `/api/v1/admin/websites/${enc(site)}`;
