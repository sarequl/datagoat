/**
 * Parsing and validation of the tracker body (plan §3.4). The body is DataFast's exact shape, so
 * DataFast's own unmodified script works against this collector as well as ours. It arrives as
 * `application/json` (DataFast, over XHR) or `text/plain` (our tracker, over sendBeacon/fetch);
 * either way it is parsed as JSON.
 */
import { badRequest, payloadTooLarge } from "../lib/errors";

export const MAX_BODY_BYTES = 8 * 1024;

export const EVENT_TYPES = [
  "pageview",
  "custom",
  "identify",
  "payment",
  "external_link",
  "engagement",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const AD_CLICK_ID_KEYS = [
  "gclid",
  "gclsrc",
  "wbraid",
  "gbraid",
  "li_fat_id",
  "fbclid",
  "msclkid",
  "ttclid",
  "twclid",
] as const;

export interface TrackerBody {
  websiteId: string;
  domain: string | null;
  href: string;
  referrer: string | null;
  viewport: { width: number; height: number } | null;
  visitorId: string | null;
  sessionId: string | null;
  visitorFirstSeenAt: number | null;
  visitorSessionNumber: number | null;
  language: string | null;
  timezone: string | null;
  screenWidth: number | null;
  screenHeight: number | null;
  type: EventType;
  adClickIds: Record<string, string>;
  extraData: Record<string, unknown>;
  trackHash: boolean;
  cookieless: boolean;
  /** DataGoat: the browser already had a `datafast_visitor_id` cookie (site came from DataFast). */
  datafastCookie: boolean;
}

/** Read at most `limit` bytes of the request body; larger bodies are rejected with 413. */
export async function readBody(req: Request, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw payloadTooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw payloadTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function int(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i < min || i > max ? null : i;
}

function timestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? Math.round(v) : null;
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Parse the raw body text into a validated `TrackerBody`; throws 400 for anything malformed. */
export function parseBody(text: string): TrackerBody {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw badRequest("Body must be a JSON object");
  }
  if (!isObject(raw)) throw badRequest("Body must be a JSON object");

  const websiteId = str(raw.websiteId, 100);
  if (!websiteId) throw badRequest("websiteId is required");
  const type = raw.type;
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) {
    throw badRequest(`type must be one of ${EVENT_TYPES.join(", ")}`);
  }
  const href = str(raw.href, 2048);
  if (!href) throw badRequest("href is required");
  try {
    new URL(href);
  } catch {
    throw badRequest("href must be an absolute URL");
  }
  if (raw.extraData !== undefined && raw.extraData !== null && !isObject(raw.extraData)) {
    throw badRequest("extraData must be an object");
  }

  const adClickIds: Record<string, string> = {};
  if (isObject(raw.adClickIds)) {
    for (const key of AD_CLICK_ID_KEYS) {
      const value = str(raw.adClickIds[key], 255);
      if (value) adClickIds[key] = value;
    }
  }
  const viewport = isObject(raw.viewport)
    ? {
        width: int(raw.viewport.width, 0, 100_000) ?? 0,
        height: int(raw.viewport.height, 0, 100_000) ?? 0,
      }
    : null;

  return {
    websiteId,
    domain: str(raw.domain, 253)?.toLowerCase() ?? null,
    href,
    referrer: str(raw.referrer, 2048),
    viewport,
    visitorId: str(raw.visitorId, 100),
    sessionId: str(raw.sessionId, 100),
    visitorFirstSeenAt: timestamp(raw.visitorFirstSeenAt),
    visitorSessionNumber: int(raw.visitorSessionNumber, 1, 1_000_000),
    language: str(raw.language, 35),
    timezone: str(raw.timezone, 64),
    screenWidth: int(raw.screenWidth, 0, 100_000),
    screenHeight: int(raw.screenHeight, 0, 100_000),
    type: type as EventType,
    adClickIds,
    extraData: isObject(raw.extraData) ? raw.extraData : {},
    trackHash: raw.trackHash === true,
    cookieless: raw.cookieless === true,
    datafastCookie: raw.datafastCookie === true,
  };
}
