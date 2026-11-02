import type { Env } from './env';
import { SESSION_GAP_S } from './env';
import { ulid } from './util/ids';

interface SessionCache {
  sid: string;
  lastTs: number;
}

/**
 * Assigns the session id for an event. The Worker is authoritative for the
 * 30-minute inactivity window (design/worker.md §5.1); the client `sid` is only
 * a hint and is ignored. A KV entry per (site, visitor) avoids a D1 read on the
 * hot path once the visitor is warm.
 */
export async function assignSessionId(
  env: Env,
  websiteId: string,
  visitorId: string,
  ts: number,
): Promise<string> {
  const key = `sess:${websiteId}:${visitorId}`;

  try {
    const cached = await env.KV.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as SessionCache;
      if (
        parsed.sid &&
        typeof parsed.lastTs === 'number' &&
        ts >= parsed.lastTs - 60 &&
        ts - parsed.lastTs <= SESSION_GAP_S
      ) {
        await env.KV.put(key, JSON.stringify({ sid: parsed.sid, lastTs: ts }), {
          expirationTtl: SESSION_GAP_S * 2,
        });
        return parsed.sid;
      }
    }
  } catch {
    // KV is an optimization; ignore failures and consult D1.
  }

  const row = await env.DB.prepare(
    `SELECT session_id, ts FROM events
     WHERE website_id = ? AND visitor_id = ? AND session_id IS NOT NULL
     ORDER BY ts DESC LIMIT 1`,
  )
    .bind(websiteId, visitorId)
    .first<{ session_id: string; ts: number }>();

  let sid: string;
  if (
    row?.session_id &&
    typeof row.ts === 'number' &&
    ts >= row.ts - 60 &&
    ts - row.ts <= SESSION_GAP_S
  ) {
    sid = row.session_id;
  } else {
    sid = `sess_${ulid()}`;
  }

  try {
    await env.KV.put(key, JSON.stringify({ sid, lastTs: ts }), {
      expirationTtl: SESSION_GAP_S * 2,
    });
  } catch {
    // Best effort.
  }

  return sid;
}
