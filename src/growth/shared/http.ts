/**
 * Outbound HTTP for growth integrations. Every provider call goes through `requestJson`, which
 * adds a timeout, parses JSON and turns non-2xx answers into `ProviderError` (with the provider's
 * own message when it sends one). Callers pass the `fetch` to use: `ctx.fetch` inside cron jobs
 * (counted against the subrequest budget), `globalThis.fetch` in request handlers. Tests replace
 * either with a mock; no test talks to a real provider.
 */

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    /** Seconds the provider asked us to wait (429 Retry-After), when given. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** 4xx other than 408/429 will not succeed on retry. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body (serialised) or a prepared body such as URLSearchParams. */
  json?: unknown;
  body?: BodyInit;
  timeoutMs?: number;
}

function messageFrom(provider: string, status: number, body: unknown, text: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = b.error;
    if (typeof err === "string") return `${provider}: ${err}`;
    if (err && typeof err === "object") {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === "string") return `${provider}: ${m}`;
    }
    for (const key of ["message", "error_description", "detail", "description", "title"]) {
      if (typeof b[key] === "string") return `${provider}: ${b[key] as string}`;
    }
    const errors = b.errors;
    if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
      const first = errors[0] as Record<string, unknown>;
      const m = first.message ?? first.detail;
      if (typeof m === "string") return `${provider}: ${m}`;
    }
  }
  // An HTML error page (a firewall or block page) says nothing useful in 160 characters of markup.
  if (/^\s*<(!doctype|html|head|body|div|style)\b/i.test(text))
    return `${provider}: HTTP ${status} (blocked: the server answered with a web page, not the API)`;
  const snippet = text.slice(0, 160).trim();
  return `${provider}: HTTP ${status}${snippet ? ` ${snippet}` : ""}`;
}

export async function requestJson<T = unknown>(
  fetcher: Fetcher,
  provider: string,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  let body = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["content-type"] ??= "application/json";
  }
  let res: Response;
  try {
    res = await fetcher(url, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProviderError(provider, 0, `${provider}: request failed (${reason})`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const retry = Number(res.headers.get("retry-after"));
    throw new ProviderError(
      provider,
      res.status,
      messageFrom(provider, res.status, parsed, text),
      Number.isFinite(retry) && retry > 0 ? retry : null,
    );
  }
  return parsed as T;
}

export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
