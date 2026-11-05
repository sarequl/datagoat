/**
 * Mention sources.
 *
 * X API v2 recent search, `GET https://api.x.com/2/tweets/search/recent`
 * (https://docs.x.com/x-api/posts/search-recent-posts), with the `url:` operator for posts linking
 * to the website (https://docs.x.com/x-api/posts/search/integrate/build-a-query). Auth is an
 * app-only bearer token or the connected user's OAuth 2.0 token. User lookup by username
 * (`GET /2/users/by`) gives the profile link for link-in-bio attribution.
 *
 * Reddit search, `GET https://oauth.reddit.com/search` with an app-only token from
 * `POST https://www.reddit.com/api/v1/access_token` (grant_type=client_credentials,
 * https://github.com/reddit-archive/reddit/wiki/OAuth2#application-only-oauth). Without Reddit
 * credentials Reddit is skipped (see `redditConfigured`). Reddit requires a descriptive User-Agent (https://github.com/reddit-archive/reddit/wiki/API).
 */
import { type Fetcher, requestJson } from "../shared/http";

export const X_API = "https://api.x.com/2";
export const REDDIT_UA = "web:datagoat-mentions:1.0 (self-hosted DataGoat analytics)";
const X_QUERY_MAX = 512;

export interface MentionRecord {
  platform: "x" | "reddit";
  externalId: string;
  ts: number;
  text: string;
  url: string;
  authorName: string | null;
  authorUsername: string | null;
  authorImage: string | null;
  engagement: Record<string, number>;
  media: unknown[] | null;
  isRetweet: boolean;
  subreddit: string | null;
}

export interface TcoLink {
  tcoUrl: string;
  tweetId: string | null;
  tweetUrl: string | null;
  authorUsername: string | null;
  text: string | null;
  postedAt: number | null;
}

/** `https://t.co/AbC` (scheme forced to https, no query, no trailing slash). */
export function normaliseTco(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.hostname.toLowerCase() !== "t.co") return null;
    const code = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9]+$/.test(code)) return null;
    return `https://t.co/${code}`;
  } catch {
    return null;
  }
}

export function buildXQuery(domain: string, keywords: readonly string[]): string {
  const terms = [`url:"${domain}"`, `"${domain}"`];
  for (const k of keywords) {
    const term = k.startsWith("@") || k.startsWith("#") ? k : `"${k.replace(/"/g, "")}"`;
    const next = `(${[...terms, term].join(" OR ")})`;
    if (next.length > X_QUERY_MAX) break;
    terms.push(term);
  }
  return `(${terms.join(" OR ")})`;
}

interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    like_count?: number;
    reply_count?: number;
    retweet_count?: number;
    quote_count?: number;
  };
  entities?: { urls?: Array<{ url?: string; expanded_url?: string; unwound_url?: string }> };
  attachments?: { media_keys?: string[] };
  referenced_tweets?: Array<{ type: string; id: string }>;
}

interface XUser {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
  url?: string;
  entities?: { url?: { urls?: Array<{ url?: string; expanded_url?: string }> } };
}

interface XSearchResponse {
  data?: XTweet[];
  includes?: {
    users?: XUser[];
    media?: Array<{ media_key: string; type?: string; url?: string; preview_image_url?: string }>;
  };
  meta?: { newest_id?: string; result_count?: number };
}

export interface XSearchResult {
  mentions: MentionRecord[];
  links: TcoLink[];
  newestId: string | null;
}

/** Search recent posts; `matchesSite(host)` decides which linked URLs belong to the website. */
export async function searchX(
  fetcher: Fetcher,
  token: string,
  query: string,
  sinceId: string | null,
  matchesSite: (host: string) => boolean,
): Promise<XSearchResult> {
  const url = new URL(`${X_API}/tweets/search/recent`);
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", "100");
  url.searchParams.set(
    "tweet.fields",
    "created_at,public_metrics,entities,attachments,referenced_tweets,author_id",
  );
  url.searchParams.set("expansions", "author_id,attachments.media_keys");
  url.searchParams.set("user.fields", "name,username,profile_image_url");
  url.searchParams.set("media.fields", "type,url,preview_image_url");
  if (sinceId) url.searchParams.set("since_id", sinceId);
  const res = await requestJson<XSearchResponse>(fetcher, "X", url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  const users = new Map((res.includes?.users ?? []).map((u) => [u.id, u]));
  const media = new Map((res.includes?.media ?? []).map((m) => [m.media_key, m]));
  const mentions: MentionRecord[] = [];
  const links: TcoLink[] = [];
  for (const t of res.data ?? []) {
    const author = t.author_id ? users.get(t.author_id) : undefined;
    const ts = t.created_at ? Date.parse(t.created_at) : Date.now();
    const tweetUrl = `https://x.com/${author?.username ?? "i/web"}/status/${t.id}`;
    const m = t.public_metrics ?? {};
    mentions.push({
      platform: "x",
      externalId: t.id,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      text: t.text,
      url: tweetUrl,
      authorName: author?.name ?? null,
      authorUsername: author?.username ?? null,
      authorImage: author?.profile_image_url ?? null,
      engagement: {
        likes: m.like_count ?? 0,
        replies: m.reply_count ?? 0,
        reposts: m.retweet_count ?? 0,
        quotes: m.quote_count ?? 0,
      },
      media: (t.attachments?.media_keys ?? [])
        .map((k) => media.get(k))
        .filter(Boolean)
        .map((x) => ({ type: x?.type ?? null, url: x?.url ?? x?.preview_image_url ?? null })),
      isRetweet: (t.referenced_tweets ?? []).some((r) => r.type === "retweeted"),
      subreddit: null,
    });
    for (const link of t.entities?.urls ?? []) {
      const tco = link.url ? normaliseTco(link.url) : null;
      const target = link.unwound_url ?? link.expanded_url;
      if (!tco || !target) continue;
      let host = "";
      try {
        host = new URL(target).hostname;
      } catch {
        continue;
      }
      if (!matchesSite(host)) continue;
      links.push({
        tcoUrl: tco,
        tweetId: t.id,
        tweetUrl,
        authorUsername: author?.username ?? null,
        text: t.text.slice(0, 500),
        postedAt: Number.isFinite(ts) ? ts : null,
      });
    }
  }
  return { mentions, links, newestId: res.meta?.newest_id ?? null };
}

/** Link-in-bio attribution: the t.co link each profile shows, when it points to the website. */
export async function profileLinks(
  fetcher: Fetcher,
  token: string,
  handles: readonly string[],
  matchesSite: (host: string) => boolean,
): Promise<TcoLink[]> {
  const names = handles
    .map((h) => h.replace(/^@/, ""))
    .filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h));
  if (names.length === 0) return [];
  const url = new URL(`${X_API}/users/by`);
  url.searchParams.set("usernames", names.slice(0, 100).join(","));
  url.searchParams.set("user.fields", "url,entities,name,profile_image_url");
  const res = await requestJson<{ data?: XUser[] }>(fetcher, "X", url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });
  const out: TcoLink[] = [];
  for (const u of res.data ?? []) {
    for (const link of u.entities?.url?.urls ?? []) {
      const tco = link.url ? normaliseTco(link.url) : null;
      if (!tco || !link.expanded_url) continue;
      try {
        if (!matchesSite(new URL(link.expanded_url).hostname)) continue;
      } catch {
        continue;
      }
      out.push({
        tcoUrl: tco,
        tweetId: null,
        tweetUrl: `https://x.com/${u.username ?? ""}`,
        authorUsername: u.username ?? null,
        text: `Link in bio of @${u.username ?? ""}`,
        postedAt: null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

let redditToken: { token: string; expiresAt: number } | null = null;

export function resetRedditToken(): void {
  redditToken = null;
}

/**
 * Reddit answers only registered apps: anonymous `search.json` requests from servers (Cloudflare
 * included) get an HTML 403 page. So Reddit is searched only when the Worker has Reddit app
 * credentials.
 */
export function redditConfigured(env: Cloudflare.Env): boolean {
  return Boolean(env.REDDIT_CLIENT_ID?.trim() && env.REDDIT_CLIENT_SECRET?.trim());
}

async function redditAuth(
  fetcher: Fetcher,
  env: Cloudflare.Env,
  now: number,
): Promise<string | null> {
  const id = env.REDDIT_CLIENT_ID?.trim();
  const secret = env.REDDIT_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  if (redditToken && redditToken.expiresAt - 60_000 > now) return redditToken.token;
  const res = await requestJson<{ access_token?: string; expires_in?: number }>(
    fetcher,
    "Reddit",
    "https://www.reddit.com/api/v1/access_token",
    {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": REDDIT_UA,
      },
      body: "grant_type=client_credentials",
    },
  );
  if (!res.access_token) return null;
  redditToken = { token: res.access_token, expiresAt: now + (res.expires_in ?? 3600) * 1000 };
  return redditToken.token;
}

interface RedditListing {
  data?: {
    children?: Array<{
      data?: {
        name?: string;
        title?: string;
        selftext?: string;
        permalink?: string;
        url?: string;
        subreddit?: string;
        author?: string;
        created_utc?: number;
        score?: number;
        num_comments?: number;
      };
    }>;
  };
}

export function buildRedditQuery(domain: string, keywords: readonly string[]): string {
  return [
    `url:${domain}`,
    `"${domain}"`,
    ...keywords.map((k) => `"${k.replace(/^[@#]/, "")}"`),
  ].join(" OR ");
}

export async function searchReddit(
  fetcher: Fetcher,
  env: Cloudflare.Env,
  domain: string,
  keywords: readonly string[],
  since: number,
  now: number,
): Promise<MentionRecord[]> {
  const token = await redditAuth(fetcher, env, now);
  if (!token) return [];
  const url = new URL("https://oauth.reddit.com/search");
  url.searchParams.set("q", buildRedditQuery(domain, keywords));
  url.searchParams.set("sort", "new");
  url.searchParams.set("limit", "100");
  url.searchParams.set("t", "week");
  url.searchParams.set("raw_json", "1");
  const headers: Record<string, string> = {
    "user-agent": REDDIT_UA,
    authorization: `Bearer ${token}`,
  };
  const res = await requestJson<RedditListing>(fetcher, "Reddit", url.toString(), { headers });
  const needles = [domain, ...keywords.map((k) => k.replace(/^[@#]/, ""))].map((n) =>
    n.toLowerCase(),
  );
  const out: MentionRecord[] = [];
  for (const child of res.data?.children ?? []) {
    const d = child.data;
    if (!d?.name || !d.permalink) continue;
    const ts = Math.round((d.created_utc ?? 0) * 1000);
    if (ts <= since) continue;
    const body = (d.selftext ?? "").slice(0, 300);
    const text = body ? `${d.title ?? ""}\n\n${body}` : (d.title ?? "");
    const haystack = `${text} ${d.url ?? ""}`.toLowerCase();
    // Reddit search is fuzzy: keep only posts that really mention the domain or a keyword.
    if (!needles.some((n) => haystack.includes(n))) continue;
    out.push({
      platform: "reddit",
      externalId: d.name,
      ts,
      text,
      url: `https://www.reddit.com${d.permalink}`,
      authorName: d.author ?? null,
      authorUsername: d.author ?? null,
      authorImage: null,
      engagement: { score: d.score ?? 0, comments: d.num_comments ?? 0 },
      media: null,
      isRetweet: false,
      subreddit: d.subreddit ?? null,
    });
  }
  return out;
}
