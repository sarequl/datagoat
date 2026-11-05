import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildXQuery,
  normaliseTco,
  resetRedditToken,
} from "../../../src/growth/mentions/providers";
import { syncMentions } from "../../../src/growth/mentions/sync";
import { meterEnv, resetDb } from "../../helpers/db";
import {
  createPayment,
  createSession,
  createSite,
  createUser,
  sessionCookie,
} from "../../helpers/factories";
import { api } from "../../helpers/http";
import { jobCtx, jsonResponse, mockFetch } from "./helpers";

beforeEach(async () => {
  await resetDb();
  resetRedditToken();
});

const NOW = Date.UTC(2026, 10, 4, 12);

const xSearch = {
  data: [
    {
      id: "1001",
      text: "We launched our new website: https://t.co/AbC123",
      created_at: "2026-11-04T10:00:00.000Z",
      author_id: "u1",
      public_metrics: { like_count: 12, reply_count: 2, retweet_count: 1, quote_count: 0 },
      entities: {
        urls: [{ url: "https://t.co/AbC123", expanded_url: "https://example.com/launch" }],
      },
      attachments: { media_keys: ["m1"] },
    },
    {
      id: "1002",
      text: "RT about Example",
      created_at: "2026-11-04T09:00:00.000Z",
      author_id: "u2",
      referenced_tweets: [{ type: "retweeted", id: "999" }],
      entities: { urls: [{ url: "https://t.co/Other1", expanded_url: "https://elsewhere.com/" }] },
    },
  ],
  includes: {
    users: [
      {
        id: "u1",
        name: "Alex",
        username: "alex",
        profile_image_url: "https://pbs.twimg.com/a.jpg",
      },
      { id: "u2", name: "Bo", username: "bo" },
    ],
    media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/m.jpg" }],
  },
  meta: { newest_id: "1001", result_count: 2 },
};

const redditListing = {
  data: {
    children: [
      {
        data: {
          name: "t3_abc",
          title: "Has anyone tried example.com?",
          selftext: "Looking for analytics",
          permalink: "/r/SaaS/comments/abc/x/",
          subreddit: "SaaS",
          author: "redditor",
          created_utc: (NOW - 3_600_000) / 1000,
          score: 42,
          num_comments: 7,
        },
      },
      {
        data: {
          name: "t3_off",
          title: "Unrelated",
          permalink: "/r/x/1",
          created_utc: (NOW - 1000) / 1000,
        },
      },
    ],
  },
};

async function connectX(siteId: string, settings: Record<string, unknown>) {
  await env.DB.prepare(
    "INSERT INTO integration_connections (site_id, kind, status, settings, created_at, updated_at) VALUES (?, 'x', 'active', ?, 0, 0)",
  )
    .bind(siteId, JSON.stringify(settings))
    .run();
}

describe("query builders", () => {
  it("builds the X query with url: and keywords under 512 characters", () => {
    expect(buildXQuery("example.com", ["DataGoat", "@datagoat", "#goat"])).toBe(
      '(url:"example.com" OR "example.com" OR "DataGoat" OR @datagoat OR #goat)',
    );
    expect(
      buildXQuery(
        "example.com",
        Array.from({ length: 100 }, (_, i) => `keyword${i}`),
      ).length,
    ).toBeLessThanOrEqual(512);
    expect(normaliseTco("http://t.co/AbC123/?amp=1")).toBe("https://t.co/AbC123");
    expect(normaliseTco("https://example.com/x")).toBeNull();
  });
});

describe("mentions.sync", () => {
  it("stores X and Reddit mentions, t.co attributions and link-in-bio profiles", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id, { domain: "example.com" });
    await connectX(site.id, { keywords: ["Example"], handles: ["@founder"] });
    const fetch = mockFetch()
      .on("https://api.x.com/2/tweets/search/recent", () => xSearch)
      .on("https://api.x.com/2/users/by", () => ({
        data: [
          {
            id: "u9",
            username: "founder",
            url: "https://t.co/Bio999",
            entities: {
              url: {
                urls: [{ url: "https://t.co/Bio999", expanded_url: "https://www.example.com" }],
              },
            },
          },
        ],
      }))
      .on("https://www.reddit.com/api/v1/access_token", () => ({
        access_token: "rd-token",
        expires_in: 3600,
      }))
      .on("https://oauth.reddit.com/search", () => redditListing);
    const e = {
      ...env,
      X_BEARER_TOKEN: "x-app-token-0123456789",
      REDDIT_CLIENT_ID: "id",
      REDDIT_CLIENT_SECRET: "secret",
    } as Cloudflare.Env;
    await syncMentions(jobCtx({ now: NOW, fetch, env: e }));

    const search = new URL(fetch.calls[0]?.url ?? "");
    expect(search.searchParams.get("query")).toBe(
      '(url:"example.com" OR "example.com" OR "Example")',
    );
    expect(fetch.calls[0]?.headers.get("authorization")).toBe("Bearer x-app-token-0123456789");
    expect(fetch.calls.find((c) => c.url.includes("reddit"))?.headers.get("user-agent")).toContain(
      "datagoat",
    );

    const mentions = (
      await env.DB.prepare(
        "SELECT platform, external_id, is_retweet, subreddit FROM mentions ORDER BY external_id",
      ).all()
    ).results;
    expect(mentions).toEqual([
      { platform: "x", external_id: "1001", is_retweet: 0, subreddit: null },
      { platform: "x", external_id: "1002", is_retweet: 1, subreddit: null },
      { platform: "reddit", external_id: "t3_abc", is_retweet: 0, subreddit: "SaaS" },
    ]);
    const links = (
      await env.DB.prepare(
        "SELECT tco_url, tweet_id, author_username FROM x_links ORDER BY tco_url",
      ).all()
    ).results;
    expect(links).toEqual([
      { tco_url: "https://t.co/AbC123", tweet_id: "1001", author_username: "alex" },
      { tco_url: "https://t.co/Bio999", tweet_id: null, author_username: "founder" },
    ]);
    const conn = await env.DB.prepare(
      "SELECT cursor, last_error FROM integration_connections WHERE site_id = ?",
    )
      .bind(site.id)
      .first<{ cursor: string; last_error: string | null }>();
    expect(JSON.parse(conn?.cursor ?? "{}")).toMatchObject({
      xSinceId: "1001",
      handlesCheckedAt: NOW,
    });
    expect(conn?.last_error).toBeNull();

    // The next run asks only for newer posts; already stored mentions cost no writes.
    const m = meterEnv();
    await syncMentions(jobCtx({ now: NOW + 1_800_000, fetch, env: { ...e, DB: m.db }, db: m.db }));
    const again = fetch.calls.filter((c) => c.url.includes("tweets/search")).at(-1);
    expect(new URL(again?.url ?? "").searchParams.get("since_id")).toBe("1001");
    // Only the integration status row changes (row + its unchanged index-free key).
    expect(m.d1.rowsWritten).toBe(1);
  });

  it("uses Reddit app-only OAuth when configured and records provider errors", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id, { domain: "example.com" });
    await connectX(site.id, { keywords: [] });
    const fetch = mockFetch()
      .on("https://www.reddit.com/api/v1/access_token", () => ({
        access_token: "rd-token",
        expires_in: 3600,
      }))
      .on("https://oauth.reddit.com/search", () =>
        jsonResponse({ message: "Too Many Requests" }, 429),
      );
    const e = { ...env, REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "secret" } as Cloudflare.Env;
    await syncMentions(jobCtx({ now: NOW, fetch, env: e }));
    expect(fetch.calls[0]?.headers.get("authorization")).toBe(`Basic ${btoa("id:secret")}`);
    expect(fetch.calls[1]?.headers.get("authorization")).toBe("Bearer rd-token");
    const conn = await env.DB.prepare(
      "SELECT status, last_error FROM integration_connections",
    ).first();
    expect(conn).toMatchObject({ status: "error", last_error: "Reddit: Too Many Requests" });
  });

  it("reports the same X error once when several X calls fail alike", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id, { domain: "example.com" });
    await connectX(site.id, { keywords: [], handles: ["@founder"] });
    const depleted = () =>
      jsonResponse({ title: "CreditsDepleted", detail: "credits depleted" }, 402);
    const fetch = mockFetch()
      .on("https://api.x.com/2/tweets/search/recent", depleted)
      .on("https://api.x.com/2/users/by", depleted);
    const e = { ...env, X_BEARER_TOKEN: "x-app-token-0123456789" } as Cloudflare.Env;
    await syncMentions(jobCtx({ now: NOW, fetch, env: e }));
    const conn = await env.DB.prepare("SELECT last_error FROM integration_connections").first<{
      last_error: string;
    }>();
    expect(conn?.last_error).toBe("X: credits depleted");
  });

  it("skips Reddit without app credentials (Reddit blocks anonymous server requests)", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id, { domain: "example.com" });
    await connectX(site.id, { keywords: [] });
    const fetch = mockFetch().on("https://www.reddit.com/", () =>
      jsonResponse({ never: "called" }),
    );
    await syncMentions(jobCtx({ now: NOW, fetch, env }));
    expect(fetch.calls.filter((c) => c.url.includes("reddit"))).toEqual([]);
    const conn = await env.DB.prepare("SELECT last_error FROM integration_connections").first();
    expect(conn?.last_error ?? null).toBeNull();
  });

  it("reports an HTML block page as one readable line", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id, { domain: "example.com" });
    await connectX(site.id, { keywords: [] });
    const fetch = mockFetch()
      .on("https://www.reddit.com/api/v1/access_token", () => ({ access_token: "rd-token" }))
      .on(
        "https://oauth.reddit.com/search",
        () =>
          new Response("<body class=theme-beta><div><style>.theme-light,:root{--rem360:22.5rem;", {
            status: 403,
            headers: { "content-type": "text/html" },
          }),
      );
    const e = { ...env, REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "secret" } as Cloudflare.Env;
    await syncMentions(jobCtx({ now: NOW, fetch, env: e }));
    const conn = await env.DB.prepare("SELECT last_error FROM integration_connections").first();
    expect(conn?.last_error).toBe(
      "Reddit: HTTP 403 (blocked: the server answered with a web page, not the API)",
    );
  });
});

describe("GET /api/v1/mentions", () => {
  it("lists, searches and filters mentions with DataFast's meta", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    const insert = (id: string, platform: string, ts: number, text: string, extra = "{}") =>
      env.DB.prepare(
        `INSERT INTO mentions (id, site_id, platform, external_id, ts, text, url, author_name, author_username, engagement, media, is_retweet, subreddit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Alex', 'alex', ?, '[]', 0, ?, 0)`,
      ).bind(
        id,
        site.id,
        platform,
        id,
        ts,
        text,
        `https://x.com/alex/status/${id}`,
        extra,
        platform === "reddit" ? "SaaS" : null,
      );
    const day = Date.UTC(2026, 9, 15, 12);
    await env.DB.batch([
      insert("m1", "x", day, "Launch day for DataGoat", '{"likes":3}'),
      insert("m2", "reddit", day + 1000, "Analytics question"),
      insert("m3", "x", Date.UTC(2026, 5, 1), "Old"),
    ]);
    const base = `/api/v1/mentions?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31`;
    const res = await api(base, { cookie });
    expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(["m2", "m1"]);
    expect(res.body.data[1]).toMatchObject({
      websiteId: site.id,
      platform: "x",
      timestamp: "2026-10-15T12:00:00.000Z",
      author: { name: "Alex", username: "alex", image: null },
      engagement: { likes: 3 },
      media: [],
      isRetweet: false,
    });
    expect(res.body.data[0].subreddit).toBe("SaaS");
    expect(res.body.meta).toEqual({
      totalMentions: 2,
      sampled: false,
      mentionLimit: null,
      timezone: "UTC",
      startAt: "2026-10-01T00:00:00.000Z",
      endAt: "2026-10-31T23:59:59.999Z",
    });
    expect((await api(`${base}&q=datagoat`, { cookie })).body.data).toHaveLength(1);
    expect((await api(`${base}&platform=reddit`, { cookie })).body.pagination).toMatchObject({
      total: 1,
      hasMore: false,
    });
    expect((await api(`${base}&order=asc&limit=1`, { cookie })).body.data[0].id).toBe("m1");
    expect((await api(`${base}&nope=1`, { cookie })).status).toBe(400);
    expect((await api(`${base}&limit=1001`, { cookie })).status).toBe(400);
  });
});

describe("GET /api/v1/x/links", () => {
  it("attributes t.co visitors and revenue to the posts that linked to the site", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const cookie = await sessionCookie(owner.id);
    await env.DB.prepare(
      "INSERT INTO x_links (site_id, tco_url, tweet_id, tweet_url, author_username, text) VALUES (?, 'https://t.co/AbC123', '1001', 'https://x.com/alex/status/1001', 'alex', 'Launch')",
    )
      .bind(site.id)
      .run();
    const t = Date.UTC(2026, 9, 10);
    const a = await createSession({ siteId: site.id, startedAt: t, referrerDomain: "t.co" });
    await env.DB.prepare("UPDATE sessions SET referrer = 'http://t.co/AbC123' WHERE id = ?")
      .bind(a.id)
      .run();
    const b = await createSession({ siteId: site.id, startedAt: t + 1, referrerDomain: "t.co" });
    await env.DB.prepare("UPDATE sessions SET referrer = 'https://t.co/AbC123' WHERE id = ?")
      .bind(b.id)
      .run();
    const c = await createSession({ siteId: site.id, startedAt: t + 2, referrerDomain: "t.co" });
    await env.DB.prepare("UPDATE sessions SET referrer = 'https://t.co/Unknown' WHERE id = ?")
      .bind(c.id)
      .run();
    await createSession({ siteId: site.id, startedAt: t + 3, referrerDomain: "google.com" });
    await createPayment({
      siteId: site.id,
      amountMinor: 5000,
      occurredAt: t + 10,
      visitorId: a.visitorId,
      firstSessionId: a.id,
    });

    const res = await api(
      `/api/v1/x/links?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31`,
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        tweetId: "1001",
        tweetUrl: "https://x.com/alex/status/1001",
        authorUsername: "alex",
        text: "Launch",
        visitors: 2,
        revenue: 50,
        payments: 1,
      },
      {
        tweetId: null,
        tweetUrl: null,
        authorUsername: null,
        text: null,
        visitors: 1,
        revenue: 0,
        payments: 0,
      },
    ]);
    expect(res.body.pagination.total).toBe(2);
    const filtered = await api(
      `/api/v1/x/links?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31&filter_country=US`,
      { cookie },
    );
    expect(filtered.body.data).toEqual([]);
  });
});
