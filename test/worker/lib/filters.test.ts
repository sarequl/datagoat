import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../../../src/lib/errors";
import {
  compileFilters,
  filtersToParams,
  hasVisitorLevelFilters,
  type ParsedFilter,
  parseFilters,
  parseFilterValue,
} from "../../../src/lib/filters";
import { prepare, sql } from "../../../src/lib/sql";
import { resetDb } from "../../helpers/db";
import { createEvent, createSession, createSite } from "../../helpers/factories";

describe("parseFilters", () => {
  it("parses DataFast's operator syntax", () => {
    expect(parseFilterValue("country", "US,Canada")).toEqual({
      key: "country",
      operator: "is",
      values: ["US", "CA"],
    });
    expect(parseFilterValue("country", "is_not:France")).toEqual({
      key: "country",
      operator: "is_not",
      values: ["FR"],
    });
    expect(parseFilterValue("page", "contains:/docs")).toEqual({
      key: "page",
      operator: "contains",
      values: ["/docs"],
    });
    expect(parseFilterValue("visit_count", "gte:2")).toEqual({
      key: "visit_count",
      operator: "gte",
      values: ["2"],
    });
    expect(parseFilterValue("goal", "checkout:started")).toEqual({
      key: "goal",
      operator: "is",
      values: ["checkout:started"],
    });
    expect(parseFilterValue("referrer", "is:Direct / None").values).toEqual(["Direct / None"]);
  });

  it("collects filter_* parameters and ignores others", () => {
    const params = new URLSearchParams(
      "startAt=2026-01-01&filter_device=mobile&filter_utm_source=google&limit=5",
    );
    expect(parseFilters(params)).toEqual([
      { key: "device", operator: "is", values: ["mobile"] },
      { key: "utm_source", operator: "is", values: ["google"] },
    ]);
    expect(parseFilters({ filter_country: "is:US", other: "x" })).toHaveLength(1);
  });

  it("rejects unknown keys, bad operators, empty and invalid values", () => {
    const bad = [
      "filter_planet=mars",
      "filter_country=Atlantis",
      "filter_device=contains:mob",
      "filter_visit_count=gte:two",
      "filter_visit_count=gte:1,2",
      "filter_page=",
      "filter_device=is:mobile&filter_device=is:tablet",
    ];
    for (const q of bad) expect(() => parseFilters(new URLSearchParams(q)), q).toThrow(ApiError);
    expect(() =>
      parseFilterValue("city", Array.from({ length: 51 }, (_, i) => `c${i}`).join(",")),
    ).toThrow("50");
  });

  it("restricts keys per endpoint", () => {
    expect(() =>
      parseFilters({ filter_entry_page: "/" }, { allowed: ["page", "country"] }),
    ).toThrow("not supported");
  });

  it("serialises back to parameters", () => {
    const filters = parseFilters({ filter_country: "US,DE", filter_page: "contains:/blog" });
    expect(filtersToParams(filters)).toEqual({
      filter_country: "is:US,DE",
      filter_page: "contains:/blog",
    });
    expect(parseFilters(filtersToParams(filters))).toEqual(filters);
    expect(hasVisitorLevelFilters(filters)).toBe(true);
  });
});

describe("compileFilters against D1", () => {
  let siteId = "";
  const day = Date.UTC(2026, 4, 10, 12);
  const range = { startMs: Date.UTC(2026, 4, 1), endMs: Date.UTC(2026, 5, 1) };

  beforeAll(async () => {
    await resetDb();
    siteId = (await createSite(null)).id;
    const a = await createSession({
      siteId,
      visitorId: "va",
      startedAt: day,
      country: "US",
      device: "mobile",
      browser: "Mobile Safari",
      os: "iOS",
      channel: "Organic Search",
      source: "Google",
      referrerDomain: "google.com",
      entryPath: "/pricing",
      sessionNumber: 1,
      utm: { utm_source: "google" },
      region: "California",
      city: "San Francisco",
    });
    const b = await createSession({
      siteId,
      visitorId: "vb",
      startedAt: day + 1000,
      country: "FR",
      device: "desktop",
      browser: "Chrome",
      os: "Mac OS",
      channel: "Direct",
      entryPath: "/",
      sessionNumber: 3,
      ref: "producthunt",
      via: "partner",
    });
    const c = await createSession({
      siteId,
      visitorId: "vc",
      startedAt: day + 2000,
      country: null,
      device: "desktop",
      browser: "Safari",
      os: "Mac OS",
      channel: "Referral",
      source: "Hacker News",
      referrerDomain: "news.ycombinator.com",
      entryPath: "/blog/launch",
      sessionNumber: null,
      sourceParam: "newsletter",
      hostname: "blog.example.com",
    });
    await createEvent({ siteId, session: a, path: "/pricing" });
    await createEvent({ siteId, session: a, type: "custom", name: "signup", ts: day + 10 });
    await createEvent({ siteId, session: b, path: "/docs/start" });
    await createEvent({ siteId, session: c, path: "/blog/launch" });
    // A visit outside the range must not satisfy visitor-level filters.
    await createEvent({ siteId, session: b, path: "/pricing", ts: Date.UTC(2026, 3, 1) });
  });

  async function visitors(
    query: string,
    opts: { range?: typeof range | null } = {},
  ): Promise<string[]> {
    const filters: ParsedFilter[] = parseFilters(new URLSearchParams(query));
    const where = compileFilters(filters, {
      siteId,
      range: opts.range === undefined ? range : opts.range,
    });
    const res = await prepare(
      env.DB,
      sql`SELECT s.visitor_id AS v FROM sessions s WHERE s.site_id = ${siteId} AND ${where} ORDER BY 1`,
    ).all<{ v: string }>();
    return (res.results ?? []).map((r) => r.v);
  }

  it("applies session-level equality, case-insensitively, and is_not keeps unknowns", async () => {
    expect(await visitors("filter_country=united states")).toEqual(["va"]);
    expect(await visitors("filter_country=is_not:US")).toEqual(["vb", "vc"]);
    expect(await visitors("filter_device=DESKTOP")).toEqual(["vb", "vc"]);
    expect(await visitors("filter_os=iOS,Mac OS")).toEqual(["va", "vb", "vc"]);
    expect(await visitors("filter_region=california&filter_city=San Francisco")).toEqual(["va"]);
    expect(await visitors("filter_channel=Direct")).toEqual(["vb"]);
  });

  it("merges Mobile Safari into Safari", async () => {
    expect(await visitors("filter_browser=Safari")).toEqual(["va", "vc"]);
    expect(await visitors("filter_browser=is_not:Safari")).toEqual(["vb"]);
  });

  it("matches referrers by display name, domain, or Direct / None", async () => {
    expect(await visitors("filter_referrer=Google")).toEqual(["va"]);
    expect(await visitors("filter_referrer=news.ycombinator.com")).toEqual(["vc"]);
    expect(await visitors("filter_referrer=Direct / None")).toEqual(["vb"]);
    expect(await visitors("filter_referrer=is_not:Direct/None")).toEqual(["va", "vc"]);
    expect(await visitors("filter_referrer=contains:hacker")).toEqual(["vc"]);
  });

  it("filters entry pages with all text operators", async () => {
    expect(await visitors("filter_entry_page=/pricing")).toEqual(["va"]);
    expect(await visitors("filter_entry_page=contains:/blog")).toEqual(["vc"]);
    expect(await visitors("filter_entry_page=does_not_contain:/blog")).toEqual(["va", "vb"]);
    expect(await visitors("filter_hostname=blog.example.com")).toEqual(["vc"]);
  });

  it("filters visit count and treats cookieless (NULL) sessions as unknown", async () => {
    expect(await visitors("filter_visit_count=gte:2")).toEqual(["vb"]);
    expect(await visitors("filter_visit_count=lte:1")).toEqual(["va"]);
    expect(await visitors("filter_visit_count=1,3")).toEqual(["va", "vb"]);
    expect(await visitors("filter_visit_count=is_not:1")).toEqual(["vb"]);
  });

  it("filters campaign parameters", async () => {
    expect(await visitors("filter_utm_source=Google")).toEqual(["va"]);
    expect(await visitors("filter_ref=producthunt&filter_via=partner")).toEqual(["vb"]);
    expect(await visitors("filter_source=newsletter")).toEqual(["vc"]);
  });

  it("selects visitors who viewed a page within the range", async () => {
    expect(await visitors("filter_page=/pricing")).toEqual(["va"]);
    expect(await visitors("filter_page=/pricing", { range: null })).toEqual(["va", "vb"]);
    expect(await visitors("filter_page=contains:/docs")).toEqual(["vb"]);
    expect(await visitors("filter_page=is_not:/pricing")).toEqual(["vb", "vc"]);
    expect(await visitors("filter_page=does_not_contain:/blog")).toEqual(["va", "vb"]);
  });

  it("selects visitors who completed a goal", async () => {
    expect(await visitors("filter_goal=Signup")).toEqual(["va"]);
    expect(await visitors("filter_goal=is_not:signup")).toEqual(["vb", "vc"]);
  });

  it("combines filters with AND and survives multi-value OR inside one filter", async () => {
    expect(await visitors("filter_device=desktop&filter_page=contains:/docs,/blog")).toEqual([
      "vb",
      "vc",
    ]);
    expect(await visitors("filter_device=mobile&filter_entry_page=contains:/blog,/doc")).toEqual(
      [],
    );
  });

  it("filters event rows directly with eventAlias", async () => {
    const where = compileFilters(parseFilters({ filter_page: "contains:/blog" }), {
      siteId,
      range,
      eventAlias: "e",
    });
    const res = await prepare(
      env.DB,
      sql`SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id WHERE e.site_id = ${siteId} AND ${where}`,
    ).first<{ n: number }>();
    expect(res?.n).toBe(1);
  });

  it("caps the number of bound parameters", () => {
    const many = (k: string) =>
      `filter_${k}=${Array.from({ length: 40 }, (_, i) => `v${i}`).join(",")}`;
    const filters = parseFilters(new URLSearchParams(`${many("city")}&${many("region")}`));
    expect(() => compileFilters(filters, { siteId, range })).toThrow("Too many filter values");
  });

  it("returns a neutral predicate without filters", () => {
    expect(compileFilters([], { siteId, range }).sql).toBe("1=1");
  });
});
