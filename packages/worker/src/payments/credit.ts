import type { Env } from '../env';

export interface CreditSet {
  channel: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  at: number | null;
}

export interface CreditResult {
  firstTouch: CreditSet;
  lastTouch: CreditSet;
  lastNonDirect: CreditSet;
  /** 1 when the non-direct lookup fell back to a direct touch (§3.4). */
  lastNonDirectFallback: number;
  /** Eligible touches inside the window. */
  touchCount: number;
  attributed: number;
}

interface TouchRow {
  ts: number;
  channel: string | null;
  channel_name: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

function toSet(row: TouchRow): CreditSet {
  return {
    channel: row.channel,
    source: row.utm_source ?? row.channel_name,
    medium: row.utm_medium,
    campaign: row.utm_campaign,
    at: row.ts,
  };
}

function emptySet(): CreditSet {
  return { channel: null, source: null, medium: null, campaign: null, at: null };
}

export function emptyCredit(): CreditResult {
  return {
    firstTouch: emptySet(),
    lastTouch: emptySet(),
    lastNonDirect: emptySet(),
    lastNonDirectFallback: 0,
    touchCount: 0,
    attributed: 0,
  };
}

/**
 * Computes all three credit sets for one payment (§3). The touch stream is the
 * visitor's non-bot event history, read once in `ts ASC, id ASC` order.
 *
 * - first-touch: the earliest touch, lifetime, no window (§3.2).
 * - last-touch: the most recent eligible touch, direct included (§3.3).
 * - last-non-direct: the most recent eligible non-direct touch; falls back to
 *   the latest direct touch with `lastNonDirectFallback = 1` (§3.4).
 *
 * Tie-breaking (§3.5): comparisons use provider event time and a touch must be
 * strictly before the payment — a touch in the same second does not count.
 */
export async function computeCredit(
  env: Env,
  websiteId: string,
  visitorId: string,
  occurredAt: number,
  windowDays: number,
): Promise<CreditResult> {
  const result = await env.DB.prepare(
    `SELECT ts, channel, channel_name, utm_source, utm_medium, utm_campaign
     FROM events
     WHERE website_id = ? AND visitor_id = ? AND is_bot = 0 AND ts < ?
     ORDER BY ts ASC, id ASC`,
  )
    .bind(websiteId, visitorId, occurredAt)
    .all<TouchRow>();

  const touches = result.results;
  const windowSeconds = windowDays * 86400;
  const eligible = touches.filter((touch) => occurredAt - touch.ts <= windowSeconds);

  const first = touches[0] ?? null;
  const last = eligible[eligible.length - 1] ?? null;
  let lastNonDirect: TouchRow | null = null;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const touch = eligible[i];
    if (touch.channel && touch.channel !== 'direct') {
      lastNonDirect = touch;
      break;
    }
  }
  const fallback = lastNonDirect ? null : last;

  return {
    firstTouch: first ? toSet(first) : emptySet(),
    lastTouch: last ? toSet(last) : emptySet(),
    lastNonDirect: lastNonDirect ? toSet(lastNonDirect) : fallback ? toSet(fallback) : emptySet(),
    lastNonDirectFallback: lastNonDirect ? 0 : fallback ? 1 : 0,
    touchCount: eligible.length,
    attributed: first || last || lastNonDirect || fallback ? 1 : 0,
  };
}
