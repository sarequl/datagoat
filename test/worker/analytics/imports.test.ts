/** Imported history (W6 Plausible imports, `imported_daily`) merged into analytics. */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createApiKey, createSite, createUser } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { seedFixture } from "./fixture";

beforeEach(() => resetDb());

type Row = [string, string, string, number, number, number, number, number];

async function importRows(siteId: string, importId: string, status: string, rows: Row[]) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO imports (id, site_id, source, status, created_at) VALUES (?, ?, 'plausible', ?, ?)",
  )
    .bind(importId, siteId, status, now)
    .run();
  await env.DB.batch(
    rows.map(([day, dimension, value, visitors, visits, pageviews, bounces, duration]) =>
      env.DB.prepare(
        `INSERT INTO imported_daily (site_id, import_id, day, dimension, value, visitors, visits, pageviews,
           bounces, duration_sum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        siteId,
        importId,
        day,
        dimension,
        value,
        visitors,
        visits,
        pageviews,
        bounces,
        duration,
      ),
    ),
  );
}

// The fixture's first native session is on 2026-03-10, so only 03-08 and 03-09 count.
const COMPLETED: Row[] = [
  ["2026-03-08", "", "", 10, 12, 30, 6, 120_000],
  ["2026-03-09", "", "", 5, 5, 10, 1, 50_000],
  ["2026-03-10", "", "", 100, 100, 100, 0, 0],
  ["2026-03-08", "referrer", "Google", 7, 8, 20, 4, 0],
  ["2026-03-08", "referrer", "Direct / None", 3, 4, 10, 2, 0],
  ["2026-03-09", "referrer", "Google", 5, 5, 10, 1, 0],
  ["2026-03-10", "referrer", "Google", 100, 100, 100, 0, 0],
  ["2026-03-08", "country", "US", 10, 12, 30, 6, 0],
  ["2026-03-09", "country", "FR", 5, 5, 10, 1, 0],
  ["2026-03-08", "region", "US-CA", 10, 12, 30, 6, 0],
  ["2026-03-08", "page", "/", 8, 8, 20, 0, 0],
  ["2026-03-09", "page", "/pricing", 5, 5, 10, 0, 0],
  ["2026-03-08", "entry_page", "/", 8, 8, 20, 0, 0],
];

async function setup() {
  const f = await seedFixture();
  await importRows(f.site.id, "i".repeat(24), "completed", COMPLETED);
  await importRows(f.site.id, "j".repeat(24), "processing", [
    ["2026-03-08", "", "", 1000, 1000, 1000, 0, 0],
  ]);
  return f;
}

const R = "startAt=2026-03-08&endAt=2026-03-11";

describe("imported history", () => {
  it("adds completed imports before the first native session to the overview", async () => {
    const f = await setup();
    const res = await api(`/api/v1/analytics/overview?${R}`, { token: f.key });
    expect(res.body.data[0]).toMatchObject({
      visitors: 18,
      sessions: 21,
      pageviews: 47,
      new_visitors: 3, // imports have no new/returning split
      revenue: 59.99,
      payments: 2,
    });
    expect(res.body.approximate).toBe(true);
    // 1 native + 7 imported bounces over 21 sessions; (1020 + 170) s over 21 sessions.
    expect(res.body.data[0].bounce_rate).toBe(38.1);
    expect(res.body.data[0].avg_session_duration).toBe(57);
    const all = await api("/api/v1/analytics/overview?fields=visitors", { token: f.key });
    expect(all.body.data[0].visitors).toBe(18);
  });

  it("never merges filtered, other-timezone or post-cutoff requests", async () => {
    const f = await setup();
    const filtered = await api(`/api/v1/analytics/overview?${R}&filter_country=US`, {
      token: f.key,
    });
    expect(filtered.body.data[0].visitors).toBe(1);
    expect(filtered.body.approximate).toBeUndefined();
    const tokyo = await api(`/api/v1/analytics/overview?${R}&timezone=Asia/Tokyo`, {
      token: f.key,
    });
    expect(tokyo.body.data[0].visitors).toBe(3);
    const native = await api("/api/v1/analytics/overview?startAt=2026-03-10&endAt=2026-03-11", {
      token: f.key,
    });
    expect(native.body.data[0].visitors).toBe(3);
    expect(native.body.approximate).toBeUndefined();
    const partial = await api(
      "/api/v1/analytics/overview?startAt=2026-03-08T12:00:00Z&endAt=2026-03-11T23:59:59Z",
      { token: f.key },
    );
    expect(partial.body.data[0].visitors).toBe(3);
  });

  it("adds imported days to day, week and month buckets but not to hours", async () => {
    const f = await setup();
    const day = await api(
      `/api/v1/analytics/timeseries?interval=day&fields=visitors,sessions&${R}`,
      {
        token: f.key,
      },
    );
    expect(day.body.data.map((p: { visitors: number }) => p.visitors)).toEqual([10, 5, 2, 2]);
    expect(day.body.data[0].sessions).toBe(12);
    expect(day.body.totals.visitors).toBe(18);
    expect(day.body.approximate).toBe(true);
    const week = await api(`/api/v1/analytics/timeseries?interval=week&fields=visitors&${R}`, {
      token: f.key,
    });
    // 03-08 is a Sunday (week of 03-02); 03-09..03-11 are in the week of 03-09.
    expect(week.body.data.map((p: { visitors: number }) => p.visitors)).toEqual([10, 8]);
    const hour = await api(
      "/api/v1/analytics/timeseries?interval=day&fields=visitors&startAt=2026-03-08&endAt=2026-03-08",
      { token: f.key },
    );
    expect(hour.body.interval).toBe("hour");
    expect(hour.body.totals.visitors).toBe(0);
  });

  it("merges referrers, countries, pages and entry pages; regions are not merged", async () => {
    const f = await setup();
    const refs = await api(`/api/v1/analytics/referrers?${R}`, { token: f.key });
    expect(refs.body.data).toEqual([
      { referrer: "Google", visitors: 13, revenue: 49.99, payments: 1 },
      { referrer: "Direct / None", visitors: 5, revenue: 10, payments: 1 },
      { referrer: "X", visitors: 1, revenue: 0, payments: 0 },
    ]);
    expect(refs.body.approximate).toBe(true);
    const countries = await api(`/api/v1/analytics/countries?${R}&fields=country,visitors`, {
      token: f.key,
    });
    expect(countries.body.data).toEqual([
      { country: "United States", visitors: 11, code: "US" },
      { country: "France", visitors: 6, code: "FR" },
      { country: "Germany", visitors: 1, code: "DE" },
    ]);
    const regions = await api(`/api/v1/analytics/regions?${R}`, { token: f.key });
    expect(regions.body.data.map((r: { region: string }) => r.region)).toEqual(["California"]);
    const pages = await api(
      `/api/v1/analytics/pages?${R}&fields=hostname,path,visitors,pageviews`,
      {
        token: f.key,
      },
    );
    expect(pages.body.data.slice(0, 2)).toEqual([
      { hostname: "example.com", path: "/", visitors: 10, pageviews: 22 },
      { hostname: "example.com", path: "/pricing", visitors: 8, pageviews: 13 },
    ]);
    expect(pages.body.approximate).toBe(true);
    const entry = await api(`/api/v1/analytics/entry-pages?${R}`, { token: f.key });
    expect(entry.body.data[0]).toMatchObject({ path: "/", visitors: 10 });
  });

  it("uses every imported day when nothing has been tracked natively yet", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id, { domain: "imported.example" });
    const key = (await createApiKey({ userId: owner.id, siteId: site.id })).secret;
    await importRows(site.id, "k".repeat(24), "completed", COMPLETED);
    const res = await api(`/api/v1/analytics/overview?${R}&fields=visitors,sessions`, {
      token: key,
    });
    expect(res.body.data[0]).toEqual({ visitors: 115, sessions: 117 });
    const pages = await api(`/api/v1/analytics/pages?${R}`, { token: key });
    expect(pages.body.data[0]).toMatchObject({
      hostname: "imported.example",
      path: "/",
      visitors: 8,
    });
  });
});
