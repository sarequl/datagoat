/**
 * Request validation helpers on top of zod. Every failure throws ApiError(400) with a message
 * that names the offending field, so handlers stay linear:
 *
 *   const body = await parseJsonBody(c, CreateWebsiteBody);
 *   const q = parseQuery(c, ListQuery, { strict: true });
 *   const { limit, offset } = parsePagination(c.req.query(), { max: 1000 });
 */
import type { Context } from "hono";
import { z } from "zod";
import { ApiError } from "./errors";
import { isValidTimeZone } from "./time";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "body";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Read the raw body as text with a size cap (413 when exceeded). */
export async function readBodyText(c: Context, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > maxBytes) throw new ApiError(413, `Request body exceeds ${maxBytes} bytes`);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new ApiError(413, `Request body exceeds ${maxBytes} bytes`);
  }
  return text;
}

/** Parse a JSON body (any content type) and validate it. Empty bodies parse as `{}`. */
export async function parseJsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
  options: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const text = await readBodyText(c, options.maxBytes);
  let json: unknown = {};
  if (text.trim() !== "") {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(400, "Invalid JSON body");
    }
  }
  return validate(schema, json);
}

export function validate<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, formatZodError(result.error));
  return result.data;
}

/**
 * Validate the query string. With `strict`, unknown and duplicate parameters are rejected (DataFast
 * does this on several endpoints). `allowPrefixes` lets `filter_*` through a strict schema.
 */
export function parseQuery<S extends z.ZodType>(
  c: Context,
  schema: S,
  options: { strict?: boolean; allow?: readonly string[]; allowPrefixes?: readonly string[] } = {},
): z.output<S> {
  const params = new URL(c.req.url).searchParams;
  const record: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in record && options.strict)
      throw new ApiError(400, `Duplicate query parameter: ${key}`);
    record[key] = value;
  }
  if (options.strict) {
    const known = new Set<string>([
      ...(schema instanceof z.ZodObject ? Object.keys(schema.shape) : []),
      ...(options.allow ?? []),
    ]);
    for (const key of Object.keys(record)) {
      if (!known.has(key) && !(options.allowPrefixes ?? []).some((p) => key.startsWith(p))) {
        throw new ApiError(400, `Unsupported query parameter: ${key}`);
      }
    }
  }
  return validate(schema, record);
}

export interface PaginationParams {
  limit: number;
  offset: number;
}

/** DataFast pagination: `limit` default 100 (max 1000 analytics, 250 visitors), `offset` >= 0. */
export function parsePagination(
  query: Record<string, string | undefined>,
  options: { defaultLimit?: number; max?: number } = {},
): PaginationParams {
  const max = options.max ?? 1000;
  const defaultLimit = options.defaultLimit ?? 100;
  const limit =
    query.limit === undefined || query.limit === "" ? defaultLimit : Number(query.limit);
  const offset = query.offset === undefined || query.offset === "" ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1)
    throw new ApiError(400, "limit must be a positive integer");
  if (limit > max) throw new ApiError(400, `limit must be at most ${max}`);
  if (!Number.isInteger(offset) || offset < 0 || offset > 4294967295) {
    throw new ApiError(400, "offset must be a non-negative integer");
  }
  return { limit, offset };
}

/**
 * Parse DataFast's comma-separated `fields` parameter. Returns `allowed` when omitted.
 * Unknown names fail with 400 "Invalid fields value".
 */
export function parseFields<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  if (raw === undefined || raw.trim() === "") return [...allowed];
  const requested = raw
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  const invalid = requested.filter((f) => !(allowed as readonly string[]).includes(f));
  if (invalid.length) {
    throw new ApiError(
      400,
      `Invalid fields value: ${invalid.join(", ")}. Valid: ${allowed.join(", ")}`,
    );
  }
  return [...new Set(requested)] as T[];
}

// ---------------------------------------------------------------------------
// Reusable schemas
// ---------------------------------------------------------------------------

/** DataFast goal names: lowercase a-z 0-9 _ - :, 1-64 chars, `identify` reserved. */
export const GOAL_NAME_RE = /^[a-z0-9_:-]{1,64}$/;

/** Normalise a goal name the way DataFast does: lowercase, spaces → underscores, trimmed. */
export function normaliseGoalName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

export const zGoalName = z
  .string()
  .transform(normaliseGoalName)
  .refine((v) => GOAL_NAME_RE.test(v), {
    message: "must be 1-64 characters of a-z, 0-9, _, - or :",
  })
  .refine((v) => v !== "identify", { message: "`identify` is a reserved goal name" });

export const zTimezone = z.string().refine(isValidTimeZone, { message: "invalid IANA timezone" });

/** ISO 4217 currency code, normalised to upper case. */
export const zCurrency = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .refine((v) => /^[A-Z]{3}$/.test(v), { message: "must be a 3-letter ISO 4217 code" });

export const zUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");

/** Query-string boolean: `true`/`false`/`1`/`0`. */
export const zQueryBool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

export const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be a valid email address");

/** A bare hostname such as `example.com` (protocol, path and port are stripped first). */
export function normaliseDomain(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v.replace(/:\d+$/, "").replace(/\.$/, "");
  return v;
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)(localhost|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63})$/;

export function isValidHostname(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

export const zDomain = z
  .string()
  .transform(normaliseDomain)
  .refine(isValidHostname, { message: "must be a valid domain such as example.com" });
