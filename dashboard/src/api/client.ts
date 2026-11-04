/**
 * Typed API client. Every call goes to the same origin with the session cookie; responses are the
 * DataFast-style envelopes from shared/api-types.ts. Errors throw `ApiClientError` with the HTTP
 * status and the server's message.
 *
 *   const sites = await apiGet<WebsiteSummary[]>("/api/v1/admin/websites");
 *   const overview = await apiGet<Overview[]>("/api/v1/analytics/overview", { websiteId, startAt, endAt });
 */
import type { ApiErrorBody, ApiSuccess, Pagination } from "../../../shared/api-types";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export interface Envelope<T> {
  data: T;
  pagination?: Pagination;
  raw: ApiSuccess<T> & Record<string, unknown>;
}

async function request<T>(
  method: string,
  path: string,
  query?: Query,
  body?: unknown,
): Promise<Envelope<T>> {
  const res = await fetch(buildUrl(path, query), {
    method,
    credentials: "same-origin",
    headers:
      body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    const err = json as Partial<ApiErrorBody> & { message?: string; error?: unknown };
    const message =
      (typeof err?.error === "object" && err.error && "message" in err.error
        ? String(err.error.message)
        : undefined) ??
      err?.message ??
      `Request failed with status ${res.status}`;
    throw new ApiClientError(res.status, message);
  }
  const env = json as ApiSuccess<T> & Record<string, unknown>;
  return { data: env.data, pagination: env.pagination, raw: env };
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>("GET", path, query),
  post: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>("POST", path, query, body ?? {}),
  put: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>("PUT", path, query, body ?? {}),
  patch: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>("PATCH", path, query, body ?? {}),
  delete: <T>(path: string, body?: unknown, query?: Query) =>
    request<T>("DELETE", path, query, body),
};

export async function apiGet<T>(path: string, query?: Query): Promise<T> {
  return (await api.get<T>(path, query)).data;
}
