/**
 * Visitor and session identity for the three privacy modes (plan §8 step 8, §11).
 *
 * | Site mode    | Hit                                        | Identity                       |
 * | ------------ | ------------------------------------------ | ------------------------------ |
 * | `cookie`     | valid `visitorId` + `sessionId`            | the tracker's cookies          |
 * | `cookie`     | `cookieless: true` (DataFast cookieless)   | server hash                    |
 * | `cookieless` | anything                                   | server hash (client ids unused)|
 * | `consent`    | `cookieless: true` (no consent yet)        | server hash                    |
 * | `consent`    | valid ids (after `datafast("consent", true)`) | the tracker's cookies       |
 * | any          | `Sec-GPC: 1` and the site honours GPC      | server hash                    |
 *
 * Server hash: `HMAC-SHA256(daily salt, site_id | ip | user_agent)`, shaped as a UUID v4 so every
 * consumer (Stripe metadata, the API) can treat it like a cookie id. Yesterday's salt is also
 * tried, so a session spanning midnight UTC continues. The session is the visitor's latest one
 * if it was active in the last 30 minutes, else a new `s` + UUID. IP and UA are never stored.
 *
 * A valid cookie visitor id without a session id (server SDKs, custom clients) gets the same
 * server-side 30-minute sessionisation.
 */
import { hmacSha256 } from "../lib/crypto";
import { toHex } from "../lib/encoding";
import { isUuid, uuidv4 } from "../lib/ids";
import type { Site } from "../lib/sites";
import type { TrackerBody } from "./body";
import { getSalts } from "./salts";

export const SESSION_TIMEOUT_MS = 30 * 60_000;
const SESSION_ID_RE = /^s[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type IdentityMode = "cookie" | "cookieless";

export interface Identity {
  mode: IdentityMode;
  visitorId: string;
  sessionId: string;
  /** visitorSessionNumber; null when cookieless. */
  sessionNumber: number | null;
  clientFirstSeenAt: number | null;
}

export function isClientSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** Which identity mode applies to this hit. */
export function identityMode(
  site: Pick<Site, "privacyMode" | "honorGpc">,
  body: Pick<TrackerBody, "cookieless">,
  gpc: boolean,
): IdentityMode {
  if (site.privacyMode === "cookieless") return "cookieless";
  if (gpc && site.honorGpc) return "cookieless";
  if (body.cookieless) return "cookieless";
  return "cookie";
}

/** 128 bits of an HMAC, formatted as a UUID v4 (version and variant bits set). */
export function uuidFromBytes(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function cookielessVisitorId(
  salt: string,
  siteId: string,
  ip: string,
  ua: string,
): Promise<string> {
  const mac = await hmacSha256(salt, `${siteId}|${ip}|${ua}`);
  return uuidFromBytes(new Uint8Array(mac));
}

interface Recent {
  sessionId: string;
  visitorId: string;
  lastSeen: number;
}

/** Per-isolate memo of active server-side sessions: saves the lookup query on busy visitors. */
const recent = new Map<string, Recent>();
const MAX_RECENT = 5000;

export function clearIdentityCache(): void {
  recent.clear();
}

function remember(siteId: string, keys: string[], value: Recent): void {
  if (recent.size >= MAX_RECENT) recent.clear();
  for (const k of keys) recent.set(`${siteId}:${k}`, value);
}

/**
 * The visitor's active session (last event < 30 minutes ago) among `visitorIds`, or a new one.
 * Costs at most one indexed read (`sessions_visitor`), none when this isolate saw the visitor.
 */
export async function serverSession(
  db: D1Database,
  siteId: string,
  visitorIds: string[],
  now: number,
): Promise<{ visitorId: string; sessionId: string }> {
  for (const id of visitorIds) {
    const hit = recent.get(`${siteId}:${id}`);
    if (hit && now - hit.lastSeen < SESSION_TIMEOUT_MS) {
      hit.lastSeen = now;
      return { visitorId: hit.visitorId, sessionId: hit.sessionId };
    }
  }
  const marks = visitorIds.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT id, visitor_id, last_seen_at FROM sessions
       WHERE site_id = ? AND visitor_id IN (${marks}) AND started_at >= ?
       ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .bind(siteId, ...visitorIds, now - 86_400_000)
    .first<{ id: string; visitor_id: string; last_seen_at: number }>();
  const active = row && now - row.last_seen_at < SESSION_TIMEOUT_MS;
  const result = active
    ? { visitorId: row.visitor_id, sessionId: row.id }
    : { visitorId: visitorIds[0] as string, sessionId: `s${uuidv4()}` };
  remember(siteId, visitorIds, { ...result, lastSeen: now });
  return result;
}

export interface IdentityInput {
  db: D1Database;
  site: Pick<Site, "id" | "privacyMode" | "honorGpc">;
  body: TrackerBody;
  gpc: boolean;
  ip: string;
  ua: string;
  now: number;
}

export async function resolveIdentity(input: IdentityInput): Promise<Identity> {
  const { db, site, body, now } = input;
  const mode = identityMode(site, body, input.gpc);
  const visitorId = body.visitorId?.toLowerCase() ?? "";
  if (mode === "cookie" && isUuid(visitorId)) {
    const sessionId = body.sessionId?.toLowerCase() ?? "";
    const session = isClientSessionId(sessionId)
      ? { sessionId }
      : await serverSession(db, site.id, [visitorId], now);
    return {
      mode,
      visitorId,
      sessionId: session.sessionId,
      sessionNumber: body.visitorSessionNumber,
      clientFirstSeenAt: body.visitorFirstSeenAt,
    };
  }
  // Cookieless (or cookie mode without a usable visitor id).
  const salts = await getSalts(db, now);
  const ids = [await cookielessVisitorId(salts.today, site.id, input.ip, input.ua)];
  if (salts.yesterday) {
    ids.push(await cookielessVisitorId(salts.yesterday, site.id, input.ip, input.ua));
  }
  const session = await serverSession(db, site.id, ids, now);
  return {
    mode: "cookieless",
    visitorId: session.visitorId,
    sessionId: session.sessionId,
    sessionNumber: null,
    clientFirstSeenAt: null,
  };
}
