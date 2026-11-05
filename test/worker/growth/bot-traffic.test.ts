import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CRAWLERS, classifyUserAgent } from "../../../src/growth/bots/catalog";
import { writeStatements } from "../../../src/growth/bots/ingest";
import {
  extractPrefixes,
  ipInRanges,
  parseCidr,
  refreshIpRanges,
  resetIpRangeCache,
} from "../../../src/growth/bots/ip-ranges";
import { invalidateBotConfig } from "../../../src/growth/bots/settings";
import { resetUsageCounters } from "../../../src/growth/bots/usage";
import { meterEnv, resetDb } from "../../helpers/db";
import { createApiKey, createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { apiWith, HOUR, jobCtx, jsonResponse, mockFetch } from "./helpers";

beforeEach(async () => {
  await resetDb();
  resetIpRangeCache();
  invalidateBotConfig();
  resetUsageCounters();
});

const CHATGPT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const GPTBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15";

async function setupSite() {
  const owner = await createUser();
  const site = await createSite(owner.id, { domain: "example.com" });
  return { owner, site, cookie: await sessionCookie(owner.id) };
}

function crawl(
  websiteId: string,
  ua: string,
  href = "https://example.com/docs/get-started",
  extra = {},
) {
  return {
    websiteId,
    domain: "example.com",
    href,
    ai: { userAgent: ua, source: "server_middleware", ...extra },
  };
}

async function rows() {
  return (
    (await env.DB.prepare("SELECT * FROM bot_traffic ORDER BY crawler_id, path").all()).results ??
    []
  );
}

describe("crawler classification", () => {
  it("classifies documented user agents into DataFast's categories", () => {
    expect(classifyUserAgent(CHATGPT)?.id).toBe("OpenAI::ChatGPT-User::answer_fetch");
    expect(classifyUserAgent(GPTBOT)?.id).toBe("OpenAI::GPTBot::training");
    expect(
      classifyUserAgent(
        "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
      )?.category,
    ).toBe("search_index");
    expect(
      classifyUserAgent("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)")?.id,
    ).toBe("Anthropic::ClaudeBot::training");
    expect(classifyUserAgent("Claude-User/1.0")?.category).toBe("answer_fetch");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; PerplexityBot/1.0)")?.category).toBe(
      "search_index",
    );
    expect(classifyUserAgent("Perplexity-User/1.0")?.category).toBe("answer_fetch");
    expect(classifyUserAgent(GOOGLEBOT)?.id).toBe("Google::Googlebot::search_index");
    expect(classifyUserAgent("GoogleOther")?.category).toBe("training");
    expect(classifyUserAgent("Google-CloudVertexBot")?.category).toBe("training");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; Applebot/0.1)")?.category).toBe("training");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; bingbot/2.0)")?.company).toBe("Microsoft");
    expect(classifyUserAgent("meta-externalagent/1.1")?.category).toBe("training");
    expect(classifyUserAgent("CCBot/2.0 (https://commoncrawl.org/faq/)")?.company).toBe(
      "Common Crawl",
    );
    expect(
      classifyUserAgent(
        "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider)",
      )?.company,
    ).toBe("ByteDance");
    expect(classifyUserAgent(HUMAN)).toBeNull();
    expect(classifyUserAgent("")).toBeNull();
  });

  it("has unique ids and a documentation link for every crawler", () => {
    expect(new Set(CRAWLERS.map((c) => c.id)).size).toBe(CRAWLERS.length);
    for (const c of CRAWLERS) expect(c.docs).toMatch(/^https:\/\//);
  });
});

describe("IP ranges", () => {
  it("parses published files and matches IPv4 and IPv6", () => {
    const prefixes = extractPrefixes({
      creationTime: "2026-01-01",
      prefixes: [
        { ipv4Prefix: "20.171.206.0/24" },
        { ipv6Prefix: "2001:4860:4801:10::/64" },
        { ipv4Prefix: "bad" },
      ],
    });
    expect(prefixes).toEqual(["20.171.206.0/24", "2001:4860:4801:10::/64"]);
    const ranges = prefixes.map(parseCidr).filter((x) => x !== null);
    expect(ipInRanges("20.171.206.7", ranges)).toBe(true);
    expect(ipInRanges("20.171.207.7", ranges)).toBe(false);
    expect(ipInRanges("2001:4860:4801:10::abcd", ranges)).toBe(true);
    expect(ipInRanges("2001:4860:4801:11::1", ranges)).toBe(false);
    expect(ipInRanges("::ffff:20.171.206.9", ranges)).toBe(true);
    expect(ipInRanges("not-an-ip", ranges)).toBe(false);
  });

  it("refreshes daily, writing only changed sources", async () => {
    const fetch = mockFetch()
      .on("https://openai.com/chatgpt-user.json", () => ({
        prefixes: [{ ipv4Prefix: "23.98.142.176/28" }],
      }))
      .on(/./, () => jsonResponse({ error: "down" }, 503));
    const first = await refreshIpRanges(jobCtx({ now: 1000, fetch }));
    expect(first.ok).toBe(1);
    const m = meterEnv();
    await refreshIpRanges(jobCtx({ now: 2000, fetch, db: m.db }));
    // Nothing changed: same list, same errors.
    expect(m.d1.rowsWritten).toBe(0);
    const stored = await env.DB.prepare(
      "SELECT * FROM crawler_ip_ranges WHERE source = 'openai-chatgpt-user'",
    ).first();
    expect(stored).toMatchObject({ prefixes: '["23.98.142.176/28"]', last_error: null });
  });
});

describe("POST /api/ai-crawls", () => {
  it("accepts DataFast's body, classifies on the server and writes one row per request", async () => {
    const { site } = await setupSite();
    const m = meterEnv();
    const res = await apiWith({ DB: m.db }, "/api/ai-crawls", {
      body: crawl(site.publicId, CHATGPT, "https://example.com/docs/get-started?utm=x", {
        statusCode: 200,
        provider: "ignored",
        category: "training",
      }),
      origin: null,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, tracked: 1 });
    // site + settings/token lookups are reads; the only write is the bot_traffic upsert.
    expect(m.d1.rowsWritten).toBe(1);
    const second = meterEnv();
    await apiWith({ DB: second.db }, "/api/ai-crawls", {
      body: crawl(site.publicId, CHATGPT, "https://example.com/docs/get-started", {
        statusCode: 200,
      }),
      origin: null,
    });
    expect(second.d1.rowsWritten).toBe(1);
    expect(second.d1.queries).toBeLessThanOrEqual(2);
    const [row] = await rows();
    expect(row).toMatchObject({
      site_id: site.id,
      crawler_id: "OpenAI::ChatGPT-User::answer_fetch",
      hostname: "example.com",
      path: "/docs/get-started",
      status_code: 200,
      verified: 0,
      requests: 2,
    });
    expect(Number(row?.hour) % HOUR).toBe(0);
  });

  it("ignores humans, unknown websites and wrong hostnames without writing", async () => {
    const { site } = await setupSite();
    const m = meterEnv();
    const human = await apiWith({ DB: m.db }, "/api/ai-crawls", {
      body: crawl(site.publicId, HUMAN),
      origin: null,
    });
    expect(human.body).toMatchObject({ success: true, tracked: 0, ignored: 1 });
    expect(m.d1.rowsWritten).toBe(0);
    expect(
      (await api("/api/ai-crawls", { body: crawl("dfid_nope", CHATGPT), origin: null })).status,
    ).toBe(404);
    const other = await api("/api/ai-crawls", {
      body: crawl(site.publicId, CHATGPT, "https://evil.example.net/"),
      origin: null,
    });
    expect(other.status).toBe(400);
    const sub = await api("/api/ai-crawls", {
      body: crawl(site.publicId, CHATGPT, "https://docs.example.com/llms.txt"),
      origin: null,
    });
    expect(sub.body.tracked).toBe(1);
    expect((await api("/api/ai-crawls", { body: "{nope", origin: null })).status).toBe(400);
    expect(
      (await api("/api/ai-crawls", { body: { websiteId: site.publicId }, origin: null })).status,
    ).toBe(400);
    const big = { ...crawl(site.publicId, CHATGPT), pad: "x".repeat(17 * 1024) };
    expect((await api("/api/ai-crawls", { body: big, origin: null })).status).toBe(413);
  });

  it("batches several events into one D1 batch and merges identical ones", async () => {
    const { site } = await setupSite();
    const m = meterEnv();
    const res = await apiWith({ DB: m.db }, "/api/ai-crawls", {
      body: {
        events: [
          crawl(site.publicId, GPTBOT, "https://example.com/robots.txt"),
          crawl(site.publicId, GPTBOT, "https://example.com/robots.txt"),
          crawl(site.publicId, GOOGLEBOT, "https://example.com/llms.txt"),
          crawl(site.publicId, HUMAN, "https://example.com/"),
        ],
      },
      origin: null,
    });
    expect(res.body).toMatchObject({ tracked: 3, ignored: 1 });
    expect(m.d1.rowsWritten).toBe(2);
    const data = await rows();
    expect(data.map((r) => [r.path, r.requests])).toEqual([
      ["/llms.txt", 1],
      ["/robots.txt", 2],
    ]);
    expect(writeStatements(env.DB, [])).toEqual([]);
  });

  it("verifies crawler IPs against published ranges and honours verifiedOnly and exclusions", async () => {
    const { site, cookie } = await setupSite();
    await env.DB.prepare(
      "INSERT INTO crawler_ip_ranges (source, prefixes, fetched_at, updated_at) VALUES ('openai-chatgpt-user', ?, 0, 0)",
    )
      .bind(JSON.stringify(["23.98.142.176/28"]))
      .run();
    await api("/api/ai-crawls", {
      body: crawl(site.publicId, CHATGPT, undefined, { ip: "23.98.142.180" }),
      origin: null,
    });
    await api("/api/ai-crawls", {
      body: crawl(site.publicId, CHATGPT, undefined, { ip: "1.2.3.4" }),
      origin: null,
    });
    expect((await rows()).map((r) => r.verified).sort()).toEqual([0, 1]);

    const settings = `/api/v1/admin/websites/${site.id}/bot-traffic/settings`;
    await api(settings, {
      cookie,
      method: "PATCH",
      body: { verifiedOnly: true, disableCompanies: ["Google"] },
    });
    const spoofed = await api("/api/ai-crawls", {
      body: crawl(site.publicId, CHATGPT, undefined, { ip: "1.2.3.4" }),
      origin: null,
    });
    expect(spoofed.body.tracked).toBe(0);
    const google = await api("/api/ai-crawls", {
      body: crawl(site.publicId, GOOGLEBOT),
      origin: null,
    });
    expect(google.body.tracked).toBe(0);
  });

  it("requires the dgbot_ token only once enforcement is on", async () => {
    const { site, cookie } = await setupSite();
    const tokenPath = `/api/v1/admin/websites/${site.id}/bot-traffic/token`;
    const settings = `/api/v1/admin/websites/${site.id}/bot-traffic/settings`;
    expect(
      (await api(settings, { cookie, method: "PATCH", body: { requireAuthToken: true } })).status,
    ).toBe(400);
    const created = await api(tokenPath, { cookie, method: "POST" });
    const secret = created.body.data[0].requestAuthToken as string;
    expect(secret).toMatch(/^dgbot_[0-9A-Za-z]{32}$/);
    expect((await api(tokenPath, { cookie, method: "POST" })).status).toBe(409);
    // Not enforced yet: requests without the token still count.
    expect(
      (await api("/api/ai-crawls", { body: crawl(site.publicId, GPTBOT), origin: null })).body
        .tracked,
    ).toBe(1);
    await api(settings, { cookie, method: "PATCH", body: { requireAuthToken: true } });
    expect(
      (await api("/api/ai-crawls", { body: crawl(site.publicId, GPTBOT), origin: null })).status,
    ).toBe(401);
    const ok = await api("/api/ai-crawls", {
      body: crawl(site.publicId, GPTBOT),
      origin: null,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(ok.body.tracked).toBe(1);
    // Rotation kills the old token at once.
    const rotated = await api(tokenPath, { cookie, method: "PUT" });
    expect(rotated.body.data[0].requestAuthToken).not.toBe(secret);
    expect(
      (
        await api("/api/ai-crawls", {
          body: crawl(site.publicId, GPTBOT),
          origin: null,
          headers: { authorization: `Bearer ${secret}` },
        })
      ).status,
    ).toBe(401);
    // Deleting the token turns enforcement off.
    const deleted = await api(tokenPath, { cookie, method: "DELETE" });
    expect(deleted.body.data[0]).toMatchObject({
      hasToken: false,
      displayToken: null,
      requireAuthToken: false,
    });
    expect(
      (await api("/api/ai-crawls", { body: crawl(site.publicId, GPTBOT), origin: null })).body
        .tracked,
    ).toBe(1);
    expect((await api(tokenPath, { cookie, method: "PUT" })).status).toBe(404);
  });

  it("stops accepting when the configured allowance is used up and counts drops", async () => {
    const { site, owner } = await setupSite();
    const cap = { BOT_TRAFFIC_ALLOWANCE: "2" };
    for (let i = 0; i < 3; i++) {
      await apiWith(cap, "/api/ai-crawls", {
        body: crawl(site.publicId, GPTBOT, `https://example.com/p${i}`),
        origin: null,
      });
    }
    expect((await rows()).length).toBe(2);
    // Usage = flushed counter + this isolate's unflushed counts.
    const token = await createApiKey({ userId: owner.id });
    const usage = await apiWith(cap, "/api/v1/admin/bot-traffic/usage", { token: token.secret });
    expect(usage.body.data[0].usage).toMatchObject({
      usage: 2,
      dropped: 1,
      allowance: 2,
      remaining: 0,
      percentUsed: 100,
      isCounting: true,
    });
  });
});

describe("bot traffic API", () => {
  async function seed(siteId: string) {
    const hour = Date.UTC(2026, 9, 10, 14);
    const insert = (
      crawler: string,
      path: string,
      status: number,
      verified: number,
      n: number,
      h = hour,
    ) =>
      env.DB.prepare(
        "INSERT INTO bot_traffic (site_id, hour, crawler_id, hostname, path, status_code, verified, requests) VALUES (?, ?, ?, 'example.com', ?, ?, ?, ?)",
      ).bind(siteId, h, crawler, path, status, verified, n);
    await env.DB.batch([
      insert("OpenAI::ChatGPT-User::answer_fetch", "/pricing", 200, 1, 30),
      insert("OpenAI::ChatGPT-User::answer_fetch", "/llms.txt", 200, 1, 10),
      insert("OpenAI::GPTBot::training", "/blog/post-1", 200, 0, 15),
      insert("Google::Googlebot::search_index", "/blog/post-2", 404, 1, 5, hour + 24 * HOUR),
    ]);
  }

  it("summarises by company, crawler, category, verification and time", async () => {
    const { site, cookie } = await setupSite();
    await seed(site.id);
    const res = await api(
      `/api/v1/analytics/bot-traffic?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31`,
      { cookie },
    );
    expect(res.status).toBe(200);
    const s = res.body.data[0];
    expect(s).toMatchObject({
      websiteId: site.id,
      domain: "example.com",
      range: {
        startAt: "2026-10-01T00:00:00.000Z",
        endAt: "2026-10-31T23:59:59.999Z",
        timezone: "UTC",
        interval: "day",
      },
      filters: { category: "all", verification: "all", company: "all", crawlerId: null },
      totalRequests: 60,
      aiAnswerRequests: 40,
      indexingRequests: 5,
      trainingRequests: 15,
      otherCrawlerRequests: 0,
      ipVerifiedRequests: 45,
      userAgentOnlyRequests: 15,
    });
    expect(s.companies[0]).toEqual({
      company: "OpenAI",
      requestCount: 55,
      aiAnswerRequests: 40,
      ipVerifiedRequests: 40,
      percentage: 91.67,
    });
    expect(s.crawlers[0]).toMatchObject({
      id: "OpenAI::ChatGPT-User::answer_fetch",
      userAgent: "ChatGPT-User",
      requestCount: 40,
      percentage: 66.67,
    });
    expect(s.timeseries).toHaveLength(31);
    expect(s.timeseries[9]).toEqual({
      date: "2026-10-10",
      requestCount: 55,
      aiAnswerRequests: 40,
      ipVerifiedRequests: 40,
    });

    const filtered = await api(
      `/api/v1/analytics/bot-traffic?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31&category=answer_fetch&verification=ip_verified`,
      { cookie },
    );
    expect(filtered.body.data[0].totalRequests).toBe(40);
    const byCrawler = await api(
      `/api/v1/analytics/bot-traffic?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31&crawlerId=${encodeURIComponent("OpenAI::GPTBot::training")}`,
      { cookie },
    );
    expect(byCrawler.body.data[0].totalRequests).toBe(15);
    expect(
      (await api(`/api/v1/analytics/bot-traffic?websiteId=${site.id}&category=nope`, { cookie }))
        .status,
    ).toBe(400);
    expect(
      (await api(`/api/v1/analytics/bot-traffic?websiteId=${site.id}&company=Nope`, { cookie }))
        .status,
    ).toBe(400);
    expect(
      (await api(`/api/v1/analytics/bot-traffic?websiteId=${site.id}&foo=1`, { cookie })).status,
    ).toBe(400);
    const hourly = await api(
      `/api/v1/analytics/bot-traffic?websiteId=${site.id}&startAt=2026-10-10&endAt=2026-10-10`,
      { cookie },
    );
    expect(hourly.body.data[0].range.interval).toBe("hour");
    expect(hourly.body.data[0].timeseries[14]).toMatchObject({
      date: "2026-10-10T14:00:00.000Z",
      requestCount: 55,
    });
  });

  it("lists requested pages with statuses, crawlers, wildcard search and pagination", async () => {
    const { site, cookie } = await setupSite();
    await seed(site.id);
    const base = `/api/v1/analytics/bot-traffic/pages?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31`;
    const all = await api(`${base}&limit=2`, { cookie });
    expect(all.body.data.map((p: { path: string }) => p.path)).toEqual([
      "/pricing",
      "/blog/post-1",
    ]);
    expect(all.body.pagination).toEqual({ limit: 2, offset: 0, hasMore: true, nextOffset: 2 });
    expect(all.body.data[0]).toMatchObject({
      id: "example.com::/pricing",
      requestCount: 30,
      ipVerifiedRequests: 30,
      statusCodes: [{ statusCode: 200, requestCount: 30 }],
      crawlers: [{ id: "OpenAI::ChatGPT-User::answer_fetch", requestCount: 30 }],
    });
    expect(all.body.context).toMatchObject({ websiteId: site.id, domain: "example.com" });
    const llms = await api(`${base}&pageSearch=llms.txt`, { cookie });
    expect(llms.body.data.map((p: { path: string }) => p.path)).toEqual(["/llms.txt"]);
    const blog = await api(`${base}&pageSearch=${encodeURIComponent("/blog/*")}`, { cookie });
    expect(blog.body.data.map((p: { path: string }) => p.path)).toEqual([
      "/blog/post-1",
      "/blog/post-2",
    ]);
    expect(blog.body.data[1].statusCodes).toEqual([{ statusCode: 404, requestCount: 5 }]);
    expect((await api(`${base}&limit=101`, { cookie })).status).toBe(400);
  });

  it("reads and patches settings with the crawler catalog (owner only, no df_ keys)", async () => {
    const { site, owner, cookie } = await setupSite();
    const path = `/api/v1/admin/websites/${site.id}/bot-traffic/settings`;
    const res = await api(path, { cookie });
    expect(res.body.data[0].settings).toEqual({
      hiddenCrawlers: [],
      excludedCrawlerIds: [],
      verifiedOnly: false,
      hideDashboardCard: false,
      groupBy: "crawlers",
      pageFilterIds: [],
      requireAuthToken: false,
    });
    const openai = res.body.data[0].crawlerCatalog.find(
      (c: { company: string }) => c.company === "OpenAI",
    );
    expect(openai).toMatchObject({ status: "enabled", enabledAgentCount: 3, totalAgentCount: 3 });

    const patched = await api(path, {
      cookie,
      method: "PATCH",
      body: {
        disableCompanies: ["Meta"],
        enableCrawlerIds: ["Meta::meta-externalfetcher::answer_fetch"],
        groupBy: "pages",
      },
    });
    const s = patched.body.data[0].settings;
    expect(s.groupBy).toBe("pages");
    expect(s.excludedCrawlerIds).toEqual([
      "Meta::facebookexternalhit::ai_crawler",
      "Meta::meta-externalagent::training",
      "Meta::meta-webindexer::search_index",
    ]);
    const meta = patched.body.data[0].crawlerCatalog.find(
      (c: { company: string }) => c.company === "Meta",
    );
    expect(meta.status).toBe("partial");
    const conflict = await api(path, {
      cookie,
      method: "PATCH",
      body: { excludedCrawlerIds: [], disableCompanies: ["Meta"] },
    });
    expect(conflict.status).toBe(400);
    expect((await api(path, { cookie, method: "PATCH", body: { unknown: 1 } })).status).toBe(400);
    expect(
      (await api(path, { cookie, method: "PATCH", body: { disableCrawlerIds: ["x::y::z"] } }))
        .status,
    ).toBe(400);
    expect((await api(path, { cookie, method: "PATCH", body: "x".repeat(9000) })).status).toBe(413);

    const key = await createApiKey({ userId: owner.id, siteId: site.id });
    expect((await api(path, { token: key.secret })).status).toBe(403);
    const member = await createUser();
    const { addMember } = await import("../../helpers/factories");
    await addMember(site.id, member.id, "member");
    expect((await api(path, { cookie: await sessionCookie(member.id) })).status).toBe(403);
  });

  it("reports account usage per owned website (not counting without an allowance)", async () => {
    const { site, owner, cookie } = await setupSite();
    await env.DB.prepare(
      "INSERT INTO bot_traffic (site_id, hour, crawler_id, hostname, path, status_code, verified, requests) VALUES (?, ?, 'OpenAI::GPTBot::training', 'example.com', '/', 0, 0, 12)",
    )
      .bind(site.id, Math.floor(Date.now() / HOUR) * HOUR)
      .run();
    const res = await api("/api/v1/admin/bot-traffic/usage", { cookie });
    expect(res.body.data[0].usage).toMatchObject({ usage: 12, allowance: null, isCounting: false });
    expect(res.body.data[0].websiteStats).toEqual([
      { websiteId: site.id, domain: "example.com", logo: null, requestCount: 12 },
    ]);
    const scoped = await createApiKey({ userId: owner.id, websiteIds: [site.id] });
    expect((await api("/api/v1/admin/bot-traffic/usage", { token: scoped.secret })).status).toBe(
      403,
    );
    const key = await createApiKey({ userId: owner.id, siteId: site.id });
    expect((await api("/api/v1/admin/bot-traffic/usage", { token: key.secret })).status).toBe(403);
  });
});
