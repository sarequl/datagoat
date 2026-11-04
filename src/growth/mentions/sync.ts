/**
 * `mentions.sync` (every 30 minutes): X and Reddit mentions plus X link attribution for websites
 * with the X integration configured (keywords and handles live in its settings; the website domain
 * is always tracked). DataFast: docs/twitter-mentions, docs/twitter-link-attribution.
 *
 * Per run it serves the SITES_PER_RUN websites synced longest ago (≤ 3 subrequests each). Writes:
 * new mentions only (`INSERT OR IGNORE` on (site, platform, external id)), t.co → post mappings
 * only when new or changed, and one status row per website.
 */
import type { JobContext } from "../../jobs/registry";
import { newId } from "../../lib/ids";
import { errorFields, log } from "../../lib/log";
import { loadSiteById } from "../../lib/sites";
import { refreshIfNeeded } from "../integrations/oauth";
import {
  type Connection,
  decryptCredentials,
  encryptCredentials,
  listActiveConnections,
  type OAuthCredentials,
  syncResultStatement,
} from "../shared/connections";
import { errorMessage, type Fetcher } from "../shared/http";
import { hostBelongsToSite } from "../shared/site-info";
import {
  buildXQuery,
  type MentionRecord,
  profileLinks,
  searchReddit,
  searchX,
  type TcoLink,
} from "./providers";

export const SITES_PER_RUN = 3;
const HANDLES_EVERY_MS = 24 * 3_600_000;
const REDDIT_LOOKBACK_MS = 7 * 86_400_000;

export interface XSettings {
  keywords?: string[];
  handles?: string[];
  redditEnabled?: boolean;
}

export interface XCursor {
  xSinceId?: string | null;
  redditSince?: number;
  handlesCheckedAt?: number;
}

export type XCredentials = OAuthCredentials & { bearerToken?: string };

export function mentionInsert(db: D1Database, siteId: string, m: MentionRecord, now: number) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO mentions (id, site_id, platform, external_id, ts, text, url, author_name, author_username,
         author_image, engagement, media, is_retweet, subreddit, relevant, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      newId(now),
      siteId,
      m.platform,
      m.externalId,
      m.ts,
      m.text.slice(0, 4000),
      m.url,
      m.authorName,
      m.authorUsername,
      m.authorImage,
      JSON.stringify(m.engagement),
      m.media ? JSON.stringify(m.media) : null,
      m.isRetweet ? 1 : 0,
      m.subreddit,
      now,
    );
}

export function xLinkUpsert(db: D1Database, siteId: string, l: TcoLink, now: number) {
  return db
    .prepare(
      `INSERT INTO x_links (site_id, tco_url, tweet_id, tweet_url, author_username, text, posted_at, resolved_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (site_id, tco_url) DO UPDATE SET tweet_id = ?3, tweet_url = ?4, author_username = ?5,
         text = ?6, posted_at = ?7, resolved_at = ?8
       WHERE x_links.tweet_id IS NOT ?3 OR x_links.tweet_url IS NOT ?4`,
    )
    .bind(siteId, l.tcoUrl, l.tweetId, l.tweetUrl, l.authorUsername, l.text, l.postedAt, now);
}

async function xToken(
  env: Cloudflare.Env,
  fetcher: Fetcher,
  conn: Connection<XSettings, XCursor>,
  now: number,
): Promise<{ token: string | null; credentialsEnc?: string }> {
  const creds = await decryptCredentials<XCredentials>(env, conn).catch(() => null);
  if (creds?.bearerToken) return { token: creds.bearerToken };
  if (creds?.accessToken) {
    const refreshed = await refreshIfNeeded(fetcher, env, "x", creds, now);
    if (refreshed) {
      return {
        token: refreshed.accessToken,
        credentialsEnc: await encryptCredentials(env, "x", conn.siteId, refreshed),
      };
    }
    return { token: creds.accessToken };
  }
  return { token: env.X_BEARER_TOKEN?.trim() || null };
}

export async function syncMentionsForSite(
  ctx: Pick<JobContext, "db" | "env" | "now" | "fetch">,
  conn: Connection<XSettings, XCursor>,
) {
  const { db, env, now } = ctx;
  const site = await loadSiteById(db, conn.siteId);
  if (!site) return { mentions: 0, links: 0, errors: [] as string[] };
  const keywords = (conn.settings.keywords ?? []).slice(0, 20);
  const handles = (conn.settings.handles ?? []).slice(0, 20);
  const cursor: XCursor = { ...conn.cursor };
  const matches = (host: string) => hostBelongsToSite(host, site);
  const mentions: MentionRecord[] = [];
  const links: TcoLink[] = [];
  const errors: string[] = [];

  const auth = await xToken(env, ctx.fetch, conn, now).catch((err) => {
    errors.push(errorMessage(err));
    return { token: null as string | null, credentialsEnc: undefined };
  });
  const credentialsEnc = auth.credentialsEnc;
  if (auth.token) {
    try {
      const res = await searchX(
        ctx.fetch,
        auth.token,
        buildXQuery(site.domain, keywords),
        cursor.xSinceId ?? null,
        matches,
      );
      mentions.push(...res.mentions);
      links.push(...res.links);
      if (res.newestId) cursor.xSinceId = res.newestId;
    } catch (err) {
      errors.push(errorMessage(err));
    }
    if (handles.length && now - (cursor.handlesCheckedAt ?? 0) >= HANDLES_EVERY_MS) {
      try {
        links.push(...(await profileLinks(ctx.fetch, auth.token, handles, matches)));
        cursor.handlesCheckedAt = now;
      } catch (err) {
        errors.push(errorMessage(err));
      }
    }
  }
  if (conn.settings.redditEnabled !== false) {
    try {
      const since = cursor.redditSince ?? now - REDDIT_LOOKBACK_MS;
      const posts = await searchReddit(ctx.fetch, env, site.domain, keywords, since, now);
      mentions.push(...posts);
      const newest = posts.reduce((m, p) => Math.max(m, p.ts), since);
      cursor.redditSince = newest;
    } catch (err) {
      errors.push(errorMessage(err));
    }
  }
  const stmts = [
    ...mentions.map((m) => mentionInsert(db, site.id, m, now)),
    ...dedupeLinks(links).map((l) => xLinkUpsert(db, site.id, l, now)),
    syncResultStatement(db, site.id, "x", {
      now,
      error: errors.length ? errors.join("; ").slice(0, 500) : null,
      cursor,
      credentialsEnc,
    }),
  ];
  const results = await db.batch(stmts);
  const inserted = results.slice(0, mentions.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  if (errors.length) log.warn("mentions.sync_errors", { siteId: site.id, errors: errors.length });
  return { mentions: inserted, links: links.length, errors };
}

function dedupeLinks(links: TcoLink[]): TcoLink[] {
  const map = new Map<string, TcoLink>();
  for (const l of links) if (!map.has(l.tcoUrl) || l.tweetId) map.set(l.tcoUrl, l);
  return [...map.values()];
}

export async function syncMentions(
  ctx: Pick<JobContext, "db" | "env" | "now" | "fetch" | "remainingQueries">,
) {
  const conns = await listActiveConnections<XSettings, XCursor>(ctx.db, "x", SITES_PER_RUN);
  let total = 0;
  for (const conn of conns) {
    if (ctx.remainingQueries() < 4) break;
    try {
      total += (await syncMentionsForSite(ctx, conn)).mentions;
    } catch (err) {
      log.error("mentions.sync_failed", { siteId: conn.siteId, ...errorFields(err) });
      await syncResultStatement(ctx.db, conn.siteId, "x", {
        now: ctx.now,
        error: errorMessage(err),
      }).run();
    }
  }
  return { sites: conns.length, mentions: total };
}
