/** GET /api/v1/analytics/revenue/mrr: current MRR of live provider subscriptions. */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { utcDay } from "../../../src/providers/fx";
import { resetDb } from "../../helpers/db";
import { createApiKey } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { ownerWithSite } from "./helpers";

beforeEach(() => resetDb());

async function subscription(
  siteId: string,
  provider: string,
  id: string,
  status: string,
  mrrMinor: number | null,
  currency: string,
) {
  await env.DB.prepare(
    `INSERT INTO provider_subscriptions (site_id, provider, subscription_id, status, mrr_minor, currency, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(siteId, provider, id, status, mrrMinor, currency, Date.now())
    .run();
}

describe("MRR", () => {
  it("sums active and past-due subscriptions in the website currency", async () => {
    const { user, site, cookie } = await ownerWithSite({ currency: "USD" });
    await subscription(site.id, "stripe", "sub_1", "active", 2900, "USD");
    await subscription(site.id, "stripe", "sub_2", "past_due", 1000, "USD");
    await subscription(site.id, "stripe", "sub_trial", "trialing", 2900, "USD");
    await subscription(site.id, "stripe", "sub_gone", "ended", 9900, "USD");
    await subscription(site.id, "stripe", "sub_unknown", "active", null, "USD");
    // 18 EUR a month at 0.9 EUR per USD = 20 USD.
    await subscription(site.id, "polar", "sub_eur", "active", 1800, "EUR");
    await env.DB.prepare("INSERT INTO fx_rates (day, currency, per_usd) VALUES (?, 'EUR', 0.9)")
      .bind(utcDay(Date.now()))
      .run();

    const res = await api(`/api/v1/analytics/revenue/mrr?websiteId=${site.id}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      currency: "USD",
      mrr: 59,
      activeSubscriptions: 3,
      byProvider: [
        { provider: "stripe", mrr: 39, subscriptions: 2 },
        { provider: "polar", mrr: 20, subscriptions: 1 },
      ],
      revenueMetric: "revenue",
      unconverted: false,
    });

    // The headline metric follows the website setting; read-only tokens may call it.
    await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      cookie,
      body: { revenueMetric: "mrr" },
    });
    const token = await createApiKey({ userId: user.id, permissions: ["analytics:read"] });
    const again = await api(`/api/v1/analytics/revenue/mrr?websiteId=${site.id}`, {
      token: token.secret,
    });
    expect(again.body.data).toMatchObject({ mrr: 59, revenueMetric: "mrr" });
  });

  it("is zero without subscriptions and flags currencies without a rate", async () => {
    const { site, cookie } = await ownerWithSite({ currency: "USD" });
    const empty = await api(`/api/v1/analytics/revenue/mrr?websiteId=${site.id}`, { cookie });
    expect(empty.body.data).toMatchObject({ mrr: 0, activeSubscriptions: 0, byProvider: [] });
    await subscription(site.id, "paddle", "sub_gbp", "active", 1500, "GBP");
    const noRate = await api(`/api/v1/analytics/revenue/mrr?websiteId=${site.id}`, { cookie });
    expect(noRate.body.data).toMatchObject({ mrr: 15, unconverted: true });
  });
});
