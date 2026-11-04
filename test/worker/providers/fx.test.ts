import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteCache } from "../../../src/lib/site-cache";
import { providerJobs } from "../../../src/providers";
import {
  convertMinor,
  ECB_90D_URL,
  ECB_DAILY_URL,
  parseEcbXml,
  RateTable,
  toPerUsd,
} from "../../../src/providers/fx";
import { meterEnv, resetDb } from "../../helpers/db";
import { createPayment } from "../../helpers/factories";
import { HOUR, mockProviders, ownerWithSite, paymentRows, runJobs } from "./helpers";

let mock: ReturnType<typeof mockProviders> | null = null;
beforeEach(() => resetDb());
afterEach(() => {
  mock?.restore();
  mock = null;
});

const fx = providerJobs.filter((j) => j.name === "providers.fx");

function ecb(days: Array<[string, Record<string, number>]>) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
${days
  .map(
    ([day, rates]) =>
      `    <Cube time='${day}'>\n${Object.entries(rates)
        .map(([c, r]) => `      <Cube currency='${c}' rate='${r}'/>`)
        .join("\n")}\n    </Cube>`,
  )
  .join("\n")}
  </Cube>
</gesmes:Envelope>`;
}

describe("ECB parsing and conversion", () => {
  it("parses eurofxref XML and rebases on USD", () => {
    const [day] = parseEcbXml(ecb([["2026-11-03", { USD: 1.25, JPY: 150, GBP: 0.8 }]]));
    expect(day?.day).toBe("2026-11-03");
    const perUsd = toPerUsd(day ?? { day: "", perEur: {} });
    expect(perUsd).toEqual({ EUR: 0.8, USD: 1, JPY: 120, GBP: 0.64 });
  });

  it("picks the latest rate on or before the day, the earliest for older days", () => {
    const t = new RateTable();
    t.add("EUR", "2026-10-01", 0.9);
    t.add("EUR", "2026-10-10", 0.8);
    t.finish();
    expect(t.perUsd("EUR", "2026-10-05")).toBe(0.9);
    expect(t.perUsd("EUR", "2026-10-11")).toBe(0.8);
    expect(t.perUsd("EUR", "2025-01-01")).toBe(0.9);
    expect(t.perUsd("CHF", "2026-10-11")).toBeNull();
    expect(t.rate("EUR", "EUR", "2026-10-11")).toBe(1);
  });

  it("respects currency exponents and signs", () => {
    expect(convertMinor(1000, "USD", "JPY", 150)).toBe(1500); // $10 → ¥1500
    expect(convertMinor(1500, "JPY", "USD", 1 / 150)).toBe(1000);
    expect(convertMinor(-1000, "EUR", "KWD", 0.33)).toBe(-3300);
  });
});

describe("providers.fx job", () => {
  const AT = Date.UTC(2026, 10, 4, 16, 23);

  it("seeds 90 days on first run, then fetches the daily file only when stale", async () => {
    mock = mockProviders({
      [`GET ${ECB_90D_URL}`]: () =>
        new Response(
          ecb([
            ["2026-11-02", { USD: 1.1, GBP: 0.85 }],
            ["2026-11-03", { USD: 1.2, GBP: 0.9 }],
          ]),
        ),
      [`GET ${ECB_DAILY_URL}`]: () => new Response(ecb([["2026-11-04", { USD: 1.25, GBP: 0.9 }]])),
    });
    await runJobs(fx, AT);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM fx_rates").first<number>("n");
    expect(n).toBe(6); // 2 days × (USD, EUR, GBP)
    expect(mock.calls.map((c) => c.url)).toEqual([ECB_90D_URL]);
    // Next hour: still stale (no 11-04 rate) but tried < 3 h ago → no request.
    await runJobs(fx, AT + HOUR);
    expect(mock.calls).toHaveLength(1);
    await runJobs(fx, AT + 3 * HOUR);
    expect(mock.calls.map((c) => c.url)).toEqual([ECB_90D_URL, ECB_DAILY_URL]);
    const gbp = await env.DB.prepare(
      "SELECT per_usd FROM fx_rates WHERE day = '2026-11-04' AND currency = 'GBP'",
    ).first<number>("per_usd");
    expect(gbp).toBeCloseTo(0.72, 10);
    // Up to date: the next runs neither fetch nor write.
    const m = meterEnv();
    await runJobs(fx, AT + 6 * HOUR, m.env);
    expect(mock.calls).toHaveLength(2);
    // Only the scheduler's own job_state bookkeeping (claim + record) for an hourly job.
    expect(m.d1.rowsWritten).toBe(2);
  });

  it("re-converts payments stored without a rate and after a currency change", async () => {
    const { site } = await ownerWithSite({ currency: "USD" });
    await createPayment({
      siteId: site.id,
      amountMinor: 1000,
      currency: "USD",
      occurredAt: Date.UTC(2026, 10, 3),
    });
    await env.DB.prepare(
      `INSERT INTO payments (site_id, id, provider, provider_txn_id, kind, amount_minor, currency, reporting_minor,
         reporting_currency, fx_rate, attributed_via, source, occurred_at, created_at, updated_at)
       VALUES (?, 'p_gbp', 'api', 'gbp', 'payment', 900, 'GBP', 900, 'USD', NULL, 'none', 'api', ?, 0, 0)`,
    )
      .bind(site.id, Date.UTC(2026, 10, 3))
      .run();
    mock = mockProviders({
      [`GET ${ECB_90D_URL}`]: () => new Response(ecb([["2026-11-03", { USD: 1.2, GBP: 0.9 }]])),
    });
    await runJobs(fx, Date.UTC(2026, 10, 3, 16, 23));
    let rows = await paymentRows(site.id);
    expect(rows.find((r) => r.provider_txn_id === "gbp")).toMatchObject({
      reporting_minor: 1200,
      reporting_currency: "USD",
    });
    // The website switches to EUR: every payment is re-based on the next run.
    await env.DB.prepare("UPDATE sites SET currency = 'EUR' WHERE id = ?").bind(site.id).run();
    siteCache.clear();
    await runJobs(fx, Date.UTC(2026, 10, 3, 17, 23));
    rows = await paymentRows(site.id);
    expect(
      Object.fromEntries(rows.map((r) => [r.currency, [r.reporting_currency, r.reporting_minor]])),
    ).toEqual({
      USD: ["EUR", 833], // $10 at 0.8333 EUR/USD
      GBP: ["EUR", 1000], // £9 at 1.111 EUR/GBP
    });
  });
});
