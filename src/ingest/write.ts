/**
 * The single `db.batch()` per event (plan §8 step 10). Statement order: session upsert, visitor
 * insert-or-ignore, event insert, then type-specific statements. Rows written (D1 counts the row
 * plus one per index entry), asserted by test/worker/ingest/write-budget.test.ts:
 *
 * | Hit                                         | Rows                                        |
 * | ------------------------------------------- | ------------------------------------------- |
 * | pageview / goal / outbound, known session   | event 2 + session 1 = 3                     |
 * | first event of a session                    | event 2 + session 3 = 5                     |
 * | first event of a new visitor                | 5 + visitor 1 = 6                           |
 * | identify, new user_id                       | 3 + visitor row + `visitors_user` entry = 5 |
 * | identify, only profile fields changed       | 3 + visitor row = 4                         |
 * | identify, nothing changed                   | 3                                           |
 * | email (identify or payment), first time     | + visitor row + `visitors_email` entry      |
 * | email matching an unattributed payment      | + payment row + `payments_visitor` entry    |
 * | payment with a provider reference           | 3 + `payment_hints` row + pending index = 5 |
 * | payment with an email (first time)          | 3 + 2 = 5                                   |
 * | engagement beacon                           | 1 (session row, unindexed columns)          |
 * | bot drop                                    | 1 (`bot_daily` upsert)                      |
 * | excluded hit                                | 0                                           |
 */
import { sha256Hex } from "../lib/crypto";
import type { Site } from "../lib/sites";
import type { BotReason } from "./bots";
import type { SessionDims } from "./enrich";
import type { ParsedEvent } from "./events";
import type { Identity } from "./identity";
import { utcDay } from "./salts";

export interface WriteInput {
  site: Pick<Site, "id" | "storeCustomerEmails">;
  identity: Identity;
  event: ParsedEvent;
  hostname: string;
  path: string;
  dims: SessionDims;
  body: {
    language: string | null;
    timezone: string | null;
    screenWidth: number | null;
    screenHeight: number | null;
    viewport: { width: number; height: number } | null;
  };
  now: number;
  /** False for cookieless hits: no email is stored on the visitor or matched to payments. */
  linkIdentity: boolean;
}

const SESSION_UPSERT = `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, session_number,
  cookieless, hostname, entry_path, exit_path, pageviews, interactions, referrer, referrer_domain, channel, source,
  utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref, source_param, via, ad_click_ids, country, region,
  city, lat, lon, device, browser, browser_version, os, os_version, device_vendor, device_model, language, timezone,
  screen_width, screen_height, viewport_width, viewport_height)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?)
ON CONFLICT (site_id, id) DO UPDATE SET
  last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
  exit_path = CASE WHEN excluded.pageviews > 0 THEN excluded.exit_path ELSE exit_path END,
  pageviews = pageviews + excluded.pageviews,
  interactions = interactions + excluded.interactions`;

const VISITOR_INSERT = `INSERT OR IGNORE INTO visitors (site_id, id, first_seen_at, client_first_seen_at, first_session_id)
VALUES (?, ?, ?, ?, ?)`;

const EVENT_INSERT = `INSERT INTO events (site_id, ts, session_id, visitor_id, type, hostname, path, name, props)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * identify() is split so each statement writes only when its fields change, and only the
 * statement that changes `user_id` touches the `visitors_user` index (SQLite rewrites an index
 * entry whenever an indexed column is in the SET list, even with an equal value).
 */
const IDENTIFY_USER = `UPDATE visitors SET user_id = ?3, identified_at = ?4, name = COALESCE(?5, name),
  image = COALESCE(?6, image), profile = json_patch(COALESCE(profile, '{}'), ?7)
WHERE site_id = ?1 AND id = ?2 AND user_id IS NOT ?3`;

/** Same user id: shallow profile merge (json_patch of flat values), only when something changes. */
const IDENTIFY_PROFILE = `UPDATE visitors SET name = COALESCE(?3, name), image = COALESCE(?4, image),
  profile = json_patch(COALESCE(profile, '{}'), ?5)
WHERE site_id = ?1 AND id = ?2 AND ((?3 IS NOT NULL AND name IS NOT ?3) OR (?4 IS NOT NULL AND image IS NOT ?4)
  OR profile IS NULL OR profile IS NOT json_patch(profile, ?5))`;

const EMAIL_UPDATE = `UPDATE visitors SET email_hash = ?3, email = CASE WHEN ?4 IS NOT NULL THEN ?4 ELSE email END
WHERE site_id = ?1 AND id = ?2 AND (email_hash IS NOT ?3 OR (?4 IS NOT NULL AND email IS NOT ?4))`;

/**
 * Attribute payments that arrived before the visitor gave their email (plan §8 step 12, §10.1
 * rule 4): unattributed payments with this email hash get the visitor and the three attribution
 * sessions (first session; latest session started before the payment; latest non-direct one).
 * Uses the partial index `payments_unattributed_email`; writes nothing when no payment matches.
 */
const PAYMENTS_EMAIL_MATCH = `UPDATE payments SET
  visitor_id = ?3,
  first_session_id = COALESCE((SELECT first_session_id FROM visitors WHERE site_id = ?1 AND id = ?3), ?4),
  last_session_id = COALESCE((SELECT s.id FROM sessions s WHERE s.site_id = ?1 AND s.visitor_id = ?3
    AND s.started_at <= payments.occurred_at ORDER BY s.started_at DESC LIMIT 1), ?4),
  last_non_direct_session_id = (SELECT s.id FROM sessions s WHERE s.site_id = ?1 AND s.visitor_id = ?3
    AND s.started_at <= payments.occurred_at AND s.channel <> 'Direct' ORDER BY s.started_at DESC LIMIT 1),
  attributed_via = 'email',
  updated_at = ?5
WHERE site_id = ?1 AND visitor_id IS NULL AND email_hash = ?2`;

const HINT_INSERT = `INSERT OR IGNORE INTO payment_hints (site_id, provider, ref, visitor_id, session_id, created_at)
VALUES (?, ?, ?, ?, ?, ?)`;

const ENGAGEMENT_UPDATE = `UPDATE sessions SET engaged_ms = COALESCE(engaged_ms, 0) + ?3,
  max_scroll = CASE WHEN ?4 IS NULL THEN max_scroll ELSE MAX(COALESCE(max_scroll, 0), ?4) END
WHERE site_id = ?1 AND id = ?2 AND (?3 > 0 OR (?4 IS NOT NULL AND COALESCE(max_scroll, -1) < ?4))`;

const BOT_UPSERT = `INSERT INTO bot_daily (site_id, day, reason, hits) VALUES (?, ?, ?, 1)
ON CONFLICT (site_id, day, reason) DO UPDATE SET hits = hits + 1`;

export function emailHash(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

function eventNameAndProps(event: ParsedEvent): [string | null, string | null] {
  switch (event.type) {
    case "custom":
      return [event.name, Object.keys(event.props).length ? JSON.stringify(event.props) : null];
    case "identify":
      return [null, JSON.stringify({ user_id: event.userId })];
    case "payment":
      if (event.provider === "email") return ["email", null];
      return [event.provider, JSON.stringify({ [refKey(event.provider)]: event.ref })];
    case "external_link":
      return [null, JSON.stringify({ url: event.url, text: event.text })];
    default:
      return [null, null];
  }
}

function refKey(provider: "stripe" | "polar" | "lemonsqueezy" | "paddle"): string {
  switch (provider) {
    case "stripe":
      return "stripe_session_id";
    case "polar":
      return "polar_checkout_id";
    case "lemonsqueezy":
      return "lemonsqueezy_order_id";
    case "paddle":
      return "paddle_transaction_id";
  }
}

/** Statements for one accepted event (everything except engagement beacons). */
export async function buildEventBatch(
  db: D1Database,
  w: WriteInput,
): Promise<D1PreparedStatement[]> {
  const { site, identity: id, event, dims, body, now } = w;
  const isPageview = event.type === "pageview";
  const isInteraction = event.type === "custom" || event.type === "external_link";
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(SESSION_UPSERT)
      .bind(
        site.id,
        id.sessionId,
        id.visitorId,
        now,
        now,
        id.sessionNumber,
        id.mode === "cookieless" ? 1 : 0,
        w.hostname,
        w.path,
        w.path,
        isPageview ? 1 : 0,
        isInteraction ? 1 : 0,
        dims.referrer,
        dims.referrerDomain,
        dims.channel,
        dims.source,
        dims.utmSource,
        dims.utmMedium,
        dims.utmCampaign,
        dims.utmTerm,
        dims.utmContent,
        dims.ref,
        dims.sourceParam,
        dims.via,
        Object.keys(dims.adClickIds).length ? JSON.stringify(dims.adClickIds) : null,
        dims.geo.country,
        dims.geo.region,
        dims.geo.city,
        dims.geo.lat,
        dims.geo.lon,
        dims.ua.device,
        dims.ua.browser,
        dims.ua.browserVersion,
        dims.ua.os,
        dims.ua.osVersion,
        dims.ua.deviceVendor,
        dims.ua.deviceModel,
        body.language,
        body.timezone,
        body.screenWidth,
        body.screenHeight,
        body.viewport?.width ?? null,
        body.viewport?.height ?? null,
      ),
    db.prepare(VISITOR_INSERT).bind(site.id, id.visitorId, now, id.clientFirstSeenAt, id.sessionId),
  ];
  const [name, props] = eventNameAndProps(event);
  stmts.push(
    db
      .prepare(EVENT_INSERT)
      .bind(site.id, now, id.sessionId, id.visitorId, event.type, w.hostname, w.path, name, props),
  );

  if (event.type === "identify") {
    stmts.push(
      db
        .prepare(IDENTIFY_USER)
        .bind(
          site.id,
          id.visitorId,
          event.userId,
          now,
          event.name,
          event.image,
          JSON.stringify(event.profile),
        ),
      db
        .prepare(IDENTIFY_PROFILE)
        .bind(site.id, id.visitorId, event.name, event.image, JSON.stringify(event.profile)),
    );
    if (event.email) {
      const hash = await emailHash(event.email);
      stmts.push(
        db
          .prepare(EMAIL_UPDATE)
          .bind(site.id, id.visitorId, hash, site.storeCustomerEmails ? event.email : null),
        db.prepare(PAYMENTS_EMAIL_MATCH).bind(site.id, hash, id.visitorId, id.sessionId, now),
      );
    }
  } else if (event.type === "payment") {
    if (event.provider === "email") {
      if (!w.linkIdentity) return stmts;
      const hash = await emailHash(event.email);
      stmts.push(
        db
          .prepare(EMAIL_UPDATE)
          .bind(site.id, id.visitorId, hash, site.storeCustomerEmails ? event.email : null),
        db.prepare(PAYMENTS_EMAIL_MATCH).bind(site.id, hash, id.visitorId, id.sessionId, now),
      );
    } else {
      stmts.push(
        db
          .prepare(HINT_INSERT)
          .bind(site.id, event.provider, event.ref, id.visitorId, id.sessionId, now),
      );
    }
  }
  return stmts;
}

export function engagementStatement(
  db: D1Database,
  siteId: string,
  sessionId: string,
  activeMs: number,
  maxScroll: number | null,
): D1PreparedStatement {
  return db.prepare(ENGAGEMENT_UPDATE).bind(siteId, sessionId, activeMs, maxScroll);
}

export function botStatement(
  db: D1Database,
  siteId: string,
  reason: BotReason,
  now: number,
): D1PreparedStatement {
  return db.prepare(BOT_UPSERT).bind(siteId, utcDay(now), reason);
}
