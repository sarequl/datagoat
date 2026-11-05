/**
 * HTTP helpers for provider APIs. All calls go through the `fetch` of an AdapterContext so the
 * cron's subrequest budget is respected (and tests can mock it).
 */
import type { AdapterContext, FetchFn } from "./types";

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }

  /** The credentials are wrong, revoked or expired. */
  get isAuth(): boolean {
    return this.status === 401;
  }

  /** The credentials are valid but may not read this resource. */
  get isPermission(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** Thrown by a budgeted fetch when the invocation's subrequest budget is used up. */
export class FetchBudgetExceeded extends Error {
  constructor() {
    super("Subrequest budget for this run is used up");
    this.name = "FetchBudgetExceeded";
  }
}

/** Wrap a fetch so at most `max` calls are made; the counter is exposed for tests and logs. */
export function budgetedFetch(inner: FetchFn, max: number): FetchFn & { used(): number } {
  let used = 0;
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (used >= max) return Promise.reject(new FetchBudgetExceeded());
    used += 1;
    return inner(input, init);
  }) as FetchFn & { used(): number };
  f.used = () => used;
  return f;
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // OAuth-style errors (`{error: "invalid_token", error_description: "…"}`): the description reads better.
    if (typeof b.error_description === "string") return b.error_description;
    const err = b.error;
    if (err && typeof err === "object") {
      const m = (err as Record<string, unknown>).message ?? (err as Record<string, unknown>).detail;
      if (typeof m === "string") return m;
    }
    if (typeof err === "string") return err;
    for (const key of ["message", "detail", "title"]) {
      if (typeof b[key] === "string") return b[key] as string;
    }
    const errors = b.errors;
    if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
      const e = errors[0] as Record<string, unknown>;
      if (typeof e.detail === "string") return e.detail;
      if (typeof e.title === "string") return e.title;
    }
  }
  return fallback;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
}

export const USER_AGENT = "DataGoat (+https://github.com/sarequl/datagoat)";

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
}

/** Request JSON; throws ProviderHttpError on non-2xx (with the provider's error message). */
export async function requestJson<T>(
  ctx: Pick<AdapterContext, "fetch">,
  url: string,
  options: RequestOptions = {},
): Promise<JsonResponse<T>> {
  const res = await ctx.fetch(url, {
    method: options.method ?? "GET",
    // Workers send no User-Agent by default, which some API firewalls block.
    headers: { accept: "application/json", "user-agent": USER_AGENT, ...(options.headers ?? {}) },
    body: options.body,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    throw new ProviderHttpError(
      res.status,
      messageOf(body, `HTTP ${res.status} from ${new URL(url).host}`),
      body,
    );
  }
  return { data: body as T, headers: res.headers };
}

export async function getJson<T>(
  ctx: Pick<AdapterContext, "fetch">,
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  return (await requestJson<T>(ctx, url, { headers })).data;
}

/** `?a=1&b=2` from a record (undefined values skipped; arrays repeat the key). */
export function query(params: Record<string, string | number | boolean | undefined | string[]>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) sp.append(k, item);
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** A short, safe error message for storage and the status endpoint (never contains secrets). */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/(rk|sk|pk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_***").slice(0, 300);
}
