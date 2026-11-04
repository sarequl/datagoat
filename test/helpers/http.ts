/**
 * Request helpers: call the Worker exactly as a client would (through its fetch handler).
 *
 *   const res = await api("/api/v1/admin/websites", { token: key.secret });
 *   expect(res.status).toBe(200);
 *   expect(res.body.data).toHaveLength(1);
 */
import { exports } from "cloudflare:workers";

export const ORIGIN = "https://datagoat.test";

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Bearer credential. */
  token?: string;
  /** Raw Cookie header (e.g. from `sessionCookie()`). */
  cookie?: string;
  /** Origin header; defaults to ORIGIN for unsafe cookie-authenticated requests. */
  origin?: string | null;
  headers?: Record<string, string>;
}

// biome-ignore lint/suspicious/noExplicitAny: tests inspect arbitrary JSON bodies
export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  /** Set-Cookie values. */
  cookies: string[];
  raw: Response;
}

// biome-ignore lint/suspicious/noExplicitAny: tests inspect arbitrary JSON bodies
export async function api<T = any>(
  path: string,
  options: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin !== null && !["GET", "HEAD"].includes(method)) {
    headers.set("origin", options.origin ?? ORIGIN);
  }
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const worker = (exports as unknown as { default: Fetcher }).default;
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return {
    status: res.status,
    headers: res.headers,
    body: parsed as T,
    cookies: res.headers.getSetCookie(),
    raw: res,
  };
}

/** Extract `name=value` for the Cookie header from a Set-Cookie list. */
export function cookieFrom(setCookies: string[], name: string): string | undefined {
  const line = setCookies.find((c) => c.startsWith(`${name}=`));
  return line?.split(";")[0];
}
