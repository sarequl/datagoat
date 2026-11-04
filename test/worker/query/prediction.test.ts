import { describe, expect, it } from "vitest";
import { buildModel } from "../../../src/query/jobs/predictions";
import { type StoredModel, scoreVisitor } from "../../../src/query/prediction";

const model: StoredModel = {
  model: {
    version: 1,
    baseline: { visitors: 10_000, conversions: 100, revenue: 5000 },
    dims: {
      channel: { "Organic Search": [2000, 60, 3600], Direct: [5000, 20, 800] },
      country: { US: [3000, 45, 2700], IN: [1000, 2, 40] },
      device: { desktop: [6000, 80, 4200], mobile: [20, 5, 50] },
    },
  },
  baselineConversionRate: 0.01,
  baselineAverageValue: 50,
  sampleVisitors: 10_000,
  trainedAt: 0,
};

describe("purchase-likelihood scoring", () => {
  it("scores the baseline at 50 and marks it as baseline", () => {
    const p = scoreVisitor(model, {});
    expect(p.score).toBe(50);
    expect(p.conversionRate).toBeCloseTo(0.01, 4);
    expect(p.isBaseline).toBe(true);
    expect(p.confidence).toBe(0);
    expect(p.expectedValue).toBe(0.5);
  });

  it("raises hot profiles, lowers cold ones and ignores small samples", () => {
    const hot = scoreVisitor(model, {
      channel: "Organic Search",
      country: "US",
      device: "desktop",
    });
    const cold = scoreVisitor(model, { channel: "Direct", country: "IN" });
    const tiny = scoreVisitor(model, { device: "mobile" }); // 20 visitors < 30: ignored
    expect(hot.score).toBeGreaterThan(70);
    expect(cold.score).toBeLessThan(40);
    expect(hot.conversionRate).toBeGreaterThan(0.01);
    expect(hot.dimensionMatches.map((m) => m.dimension)).toEqual(["channel", "country", "device"]);
    expect(hot.expectedValue).toBeCloseTo(hot.conversionRate * hot.averageValue, 1);
    expect(hot.confidence).toBeGreaterThan(cold.confidence);
    expect(hot.confidence).toBeLessThanOrEqual(1);
    expect(tiny.isBaseline).toBe(true);
    for (const p of [hot, cold, tiny]) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
    }
  });

  it("builds a stable model from training rows", () => {
    const rows = [
      { dim: "", value: "", n: 1200, c: 30, r: 150_000 },
      { dim: "channel", value: "Organic Search", n: 300, c: 30, r: 150_000 },
      { dim: "channel", value: "Direct", n: 300, c: 0, r: 0 },
    ];
    const a = buildModel(rows, "USD");
    const b = buildModel([...rows].reverse(), "USD");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a?.baseline).toEqual({ visitors: 1200, conversions: 30, revenue: 1500 });
    expect(a?.dims.channel).toEqual({ Direct: [300, 0, 0], "Organic Search": [300, 30, 1500] });
    expect(buildModel([], "USD")).toBeNull();
  });
});
