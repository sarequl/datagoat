/**
 * Response envelopes, exactly as DataFast documents them (plan §3.5):
 *
 *   success: { status: "success", data, pagination? , ...endpoint-specific top-level fields }
 *   error:   { status: "error", error: { code: <HTTP status>, message } }
 *
 * Exceptions documented by DataFast and kept for compatibility:
 *   - POST /api/v1/payments returns a plain `{ message, transaction_id }` body (W3 owns it).
 *   - 429 responses use `rateLimitBody()` below.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiErrorBody, ApiSuccess, Pagination } from "../../shared/api-types";
import type { ErrorStatus } from "./errors";

export type { Pagination };

export interface SuccessOptions {
  pagination?: Pagination;
  /** Extra top-level fields, e.g. `fields`, `interval`, `totals`, `meta`, `colors`, `counts`. */
  extra?: Record<string, unknown>;
  status?: ContentfulStatusCode;
  headers?: Record<string, string>;
}

export function successBody<T>(
  data: T,
  options: Omit<SuccessOptions, "status" | "headers"> = {},
): ApiSuccess<T> {
  const body: Record<string, unknown> = { status: "success", ...(options.extra ?? {}), data };
  if (options.pagination) body.pagination = options.pagination;
  return body as unknown as ApiSuccess<T>;
}

export function success<T>(c: Context, data: T, options: SuccessOptions = {}): Response {
  return c.json(successBody(data, options), options.status ?? 200, options.headers);
}

export function errorBody(code: ErrorStatus | number, message: string): ApiErrorBody {
  return { status: "error", error: { code, message } };
}

export function errorResponse(
  code: ErrorStatus,
  message: string,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ ...errorBody(code, message), ...extra }), {
    status: code,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** DataFast's documented 429 body. */
export function rateLimitBody(limit: number, remaining: number, resetEpochSeconds: number) {
  return {
    error: "Too many requests",
    message: `Rate limit exceeded. Try again after ${new Date(resetEpochSeconds * 1000).toISOString()}.`,
    limit,
    remaining,
    reset: resetEpochSeconds,
  };
}

/** Build pagination metadata. `hasMore` is included because DataFast returns it on lists. */
export function paginationOf(limit: number, offset: number, total: number): Pagination {
  return { limit, offset, total, hasMore: offset + limit < total };
}

/**
 * Placeholder handler for routes a feature team has not implemented yet. Teams replace
 * the call with their handler; the route path and owner stay in the route table.
 */
export function notImplemented(owner: string) {
  return (c: Context): Response =>
    errorResponse(
      501,
      `Not implemented yet: ${c.req.method} ${new URL(c.req.url).pathname} (owner: ${owner}). See docs/CONTRACTS.md.`,
    );
}
