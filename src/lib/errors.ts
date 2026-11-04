/**
 * Typed API errors. Throw an ApiError anywhere in a handler; the app-level error handler
 * turns it into the DataFast-compatible envelope `{status: "error", error: {code, message}}`.
 */
export type ErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 405
  | 409
  | 410
  | 413
  | 415
  | 422
  | 429
  | 500
  | 501
  | 502
  | 503
  | 504;

export class ApiError extends Error {
  readonly status: ErrorStatus;
  readonly headers: Record<string, string> | undefined;
  /** Extra top-level fields merged into the error body (rarely needed). */
  readonly extra: Record<string, unknown> | undefined;

  constructor(
    status: ErrorStatus,
    message: string,
    options: {
      headers?: Record<string, string>;
      extra?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.status = status;
    this.headers = options.headers;
    this.extra = options.extra;
  }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const unauthorized = (message = "Unauthorized") => new ApiError(401, message);
export const forbidden = (message = "Forbidden") => new ApiError(403, message);
export const notFound = (message = "Not found") => new ApiError(404, message);
export const conflict = (message: string) => new ApiError(409, message);
export const payloadTooLarge = (message = "Request body too large") => new ApiError(413, message);

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
