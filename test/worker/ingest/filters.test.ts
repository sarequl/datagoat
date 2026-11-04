/**
 * Ingest filters in pipeline order: rate limits, hostname policy, bots, exclusions.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { utcDay } from "../../../src/ingest/salts";
import { siteCache } from "../../../src/lib/site-cache";
import { eventBody, freshIp, ingestSite, postEvent, resetIngest, rows } from "./helpers";

async function setSite(siteId: string, assignments: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(assignments);
  await env.DB.prepare(`UPDATE sites SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => assignments[c]), siteId)
    .run();
  siteCache.clear();
}

const count = async (siteId: string) =>
  (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE site_id = ?", siteId))[0]?.n;

describe("rate limits", () => {
  beforeEach(resetIngest);

  it("answers 429 once a client IP exceeds 60 events a minute for a site", async () => {
    const site = await ingestSite({ domain: "example.com" });
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) {
      const res = await postEvent(
        eventBody({ websiteId: site.publicId, type: "custom", extraData: { eventName: `g${i}` } }),
        { ip },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 50).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
    // Another visitor of the same site is not affected.
    const other = await postEvent(eventBody({ websiteId: site.publicId }), { ip: freshIp() });
    expect(other.status).toBe(200);
  });
});

describe("hostname policy", () => {
  beforeEach(resetIngest);

  it.each([
    ["the site domain", "https://example.com/", 200],
    ["www. of the domain", "https://www.example.com/", 200],
    ["a subdomain", "https://app.example.com/dashboard", 200],
    ["a deep subdomain", "https://a.b.example.com/", 200],
    ["another domain", "https://evil.com/", 403],
    ["a lookalike suffix", "https://notexample.com/", 403],
    ["localhost (data-allow-localhost)", "http://localhost:3000/", 200],
    ["127.0.0.1", "http://127.0.0.1:8080/", 200],
    ["a .local host", "http://mac.local/", 200],
    ["a file: page (data-allow-file-protocol)", "file:///Users/me/site/index.html", 200],
    ["a mobile app screen", "datafast://ios/HomeScreen", 200],
    ["a ftp URL", "ftp://example.com/", 403],
  ])("%s → %i", async (_label, href, status) => {
    const site = await ingestSite({ domain: "example.com" });
    const res = await postEvent(eventBody({ websiteId: site.publicId, href }), { ip: freshIp() });
    expect(res.status).toBe(status);
    expect(await count(site.id)).toBe(status === 200 ? 1 : 0);
  });

  it("accepts allowed hostnames and their subdomains (cross-domain tracking)", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await setSite(site.id, { allowed_hostnames: JSON.stringify(["myapp.io"]) });
    for (const href of ["https://myapp.io/", "https://eu.myapp.io/x"]) {
      expect(
        (await postEvent(eventBody({ websiteId: site.publicId, href }), { ip: freshIp() })).status,
      ).toBe(200);
    }
    expect(
      (await postEvent(eventBody({ websiteId: site.publicId, href: "https://other.io/" }))).status,
    ).toBe(403);
  });

  it("accepts any host when all hostnames are allowed", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await setSite(site.id, { all_hostnames_allowed: 1 });
    expect(
      (await postEvent(eventBody({ websiteId: site.publicId, href: "https://anything.dev/" })))
        .status,
    ).toBe(200);
  });

  it("stores app screens with the platform as hostname", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await postEvent(eventBody({ websiteId: site.publicId, href: "datafast://ios/HomeScreen" }));
    const [event] = await rows("SELECT hostname, path FROM events WHERE site_id = ?", site.id);
    expect(event).toEqual({ hostname: "ios", path: "/HomeScreen" });
  });
});

describe("bot filtering", () => {
  beforeEach(resetIngest);

  const botDaily = (siteId: string) =>
    rows("SELECT day, reason, hits FROM bot_daily WHERE site_id = ? ORDER BY reason", siteId);

  it("drops crawler user agents with a 200 and counts them once per day and reason", async () => {
    const site = await ingestSite({ domain: "example.com" });
    const ua = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
    for (let i = 0; i < 3; i++) {
      const res = await postEvent(eventBody({ websiteId: site.publicId }), { ua, ip: freshIp() });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    }
    expect(await count(site.id)).toBe(0);
    expect(await botDaily(site.id)).toEqual([{ day: utcDay(Date.now()), reason: "ua", hits: 3 }]);
  });

  it.each([
    ["an empty UA", "", "ua"],
    ["a 4-character UA", "Mozi", "ua"],
    ["curl", "curl/8.4.0", "ua"],
    ["python-requests", "python-requests/2.31.0", "ua"],
    [
      "Puppeteer's HeadlessChrome UA",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
      "ua",
    ],
    [
      "a link preview fetcher",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "ua",
    ],
  ])("drops %s", async (_label, ua, reason) => {
    const site = await ingestSite({ domain: "example.com" });
    await postEvent(eventBody({ websiteId: site.publicId }), { ua, ip: freshIp() });
    expect(await count(site.id)).toBe(0);
    expect((await botDaily(site.id))[0]).toMatchObject({ reason, hits: 1 });
  });

  it("drops headless Chrome that fakes a desktop UA but keeps its Client Hints brand", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await postEvent(eventBody({ websiteId: site.publicId }), {
      headers: { "sec-ch-ua": '"Not:A-Brand";v="8", "Chromium";v="156", "HeadlessChrome";v="156"' },
    });
    expect(await count(site.id)).toBe(0);
    expect((await botDaily(site.id))[0]).toMatchObject({ reason: "headless" });
  });

  it("drops bodies from a zero-sized screen", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await postEvent(
      eventBody({
        websiteId: site.publicId,
        screenWidth: 0,
        screenHeight: 0,
        viewport: { width: 0, height: 0 },
      }),
    );
    expect((await botDaily(site.id))[0]).toMatchObject({ reason: "automation" });
  });

  it("keeps a phone brand that contains 'bot' (Cubot)", async () => {
    const site = await ingestSite({ domain: "example.com" });
    const ua =
      "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    await postEvent(eventBody({ websiteId: site.publicId }), { ua });
    expect(await count(site.id)).toBe(1);
  });

  it("strict level (attack mode) also drops datacenter ASNs and requests without Accept-Language", async () => {
    const site = await ingestSite({ domain: "example.com" });
    const aws = { country: "US", asn: 16509 };
    // Standard level: a human on a cloud VPN is kept.
    await postEvent(eventBody({ websiteId: site.publicId }), { cf: aws, ip: freshIp() });
    expect(await count(site.id)).toBe(1);

    await setSite(site.id, { bot_level: "strict" });
    await postEvent(
      eventBody({ websiteId: site.publicId, sessionId: "s33333333-3333-4333-8333-333333333333" }),
      {
        cf: aws,
        ip: freshIp(),
      },
    );
    await postEvent(eventBody({ websiteId: site.publicId }), {
      headers: { "accept-language": "" },
      ip: freshIp(),
    });
    expect(await count(site.id)).toBe(1);
    expect(await botDaily(site.id)).toEqual([
      { day: utcDay(Date.now()), reason: "strict", hits: 2 },
    ]);
    // A residential ASN with a language still passes at the strict level.
    await postEvent(eventBody({ websiteId: site.publicId }), {
      cf: { country: "DE", asn: 3320 },
      ip: freshIp(),
    });
    expect(await count(site.id)).toBe(2);
  });

  it("bot level off keeps everything", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await setSite(site.id, { bot_level: "off" });
    await postEvent(eventBody({ websiteId: site.publicId }), { ua: "curl/8.4.0" });
    expect(await count(site.id)).toBe(1);
    expect(await botDaily(site.id)).toEqual([]);
  });
});

describe("exclusions", () => {
  beforeEach(resetIngest);

  async function expectExcluded(
    assignments: Record<string, unknown>,
    hit: { href?: string; ip?: string; country?: string; ua?: string },
    excluded: boolean,
  ) {
    const site = await ingestSite({ domain: "example.com" });
    await setSite(site.id, assignments);
    const res = await postEvent(eventBody({ websiteId: site.publicId, href: hit.href }), {
      ip: hit.ip ?? freshIp(),
      cf: { country: hit.country ?? "US" },
      ua: hit.ua,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(await count(site.id)).toBe(excluded ? 0 : 1);
    // Excluded hits are not counted anywhere.
    expect(await rows("SELECT * FROM bot_daily WHERE site_id = ?", site.id)).toEqual([]);
    expect(await rows("SELECT * FROM sessions WHERE site_id = ?", site.id)).toHaveLength(
      excluded ? 0 : 1,
    );
  }

  const ips = (list: string[]) => ({ excluded_ips: JSON.stringify(list) });
  const paths = (list: string[]) => ({ excluded_paths: JSON.stringify(list) });

  it.each([
    ["an exact IPv4", ["192.0.2.10"], "192.0.2.10", true],
    ["another IPv4", ["192.0.2.10"], "192.0.2.11", false],
    ["an IPv4 CIDR", ["192.0.2.0/24"], "192.0.2.200", true],
    ["outside the CIDR", ["192.0.2.0/24"], "192.0.3.1", false],
    ["an IPv6 address", ["2001:db8::1"], "2001:db8:0:0:0:0:0:1", true],
    ["an IPv6 CIDR", ["2001:db8::/32"], "2001:db8:abcd::42", true],
    ["outside the IPv6 CIDR", ["2001:db8::/32"], "2001:db9::1", false],
    ["an IPv4-mapped IPv6 client", ["192.0.2.0/24"], "::ffff:192.0.2.5", true],
  ])("IP: %s", async (_label, list, ip, excluded) => {
    await expectExcluded(ips(list), { ip }, excluded);
  });

  it.each([
    ["the exact path", ["/admin"], "https://example.com/admin", true],
    ["the exact path with a trailing slash", ["/admin"], "https://example.com/admin/", true],
    ["a child of an exact path", ["/admin"], "https://example.com/admin/users", false],
    ["a wildcard child", ["/admin/*"], "https://example.com/admin/settings/general", true],
    ["the wildcard parent itself", ["/admin/*"], "https://example.com/admin", false],
    ["a mid-path wildcard", ["/blog/*/edit"], "https://example.com/blog/post-1/edit", true],
    ["a query string does not matter", ["/test"], "https://example.com/test?x=1", true],
  ])("path: %s", async (_label, list, href, excluded) => {
    await expectExcluded(paths(list), { href }, excluded);
  });

  it("countries", async () => {
    await expectExcluded(
      { excluded_countries: JSON.stringify(["RU", "CN"]) },
      { country: "CN" },
      true,
    );
    await resetIngest();
    await expectExcluded({ excluded_countries: JSON.stringify(["RU"]) }, { country: "DE" }, false);
  });

  it("hostnames are exact", async () => {
    const h = { excluded_hostnames: JSON.stringify(["staging.example.com"]) };
    await expectExcluded(h, { href: "https://staging.example.com/" }, true);
    await resetIngest();
    await expectExcluded(h, { href: "https://example.com/" }, false);
    await resetIngest();
    await expectExcluded(
      { excluded_hostnames: JSON.stringify(["example.com"]) },
      { href: "https://app.example.com/" },
      false,
    );
  });

  it("user agents: substrings and globs, case-insensitive", async () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InternalQA/3.1 Chrome/130.0.0.0 Safari/537.36";
    await expectExcluded({ excluded_user_agents: JSON.stringify(["internalqa"]) }, { ua }, true);
    await resetIngest();
    await expectExcluded(
      { excluded_user_agents: JSON.stringify(["*Windows NT*Chrome/130*"]) },
      { ua },
      true,
    );
    await resetIngest();
    await expectExcluded({ excluded_user_agents: JSON.stringify(["Firefox"]) }, { ua }, false);
  });
});
