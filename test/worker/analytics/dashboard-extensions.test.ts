/** DataGoat extensions used by the dashboard: timeseries trend fields, minute buckets, replay. */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createEvent, createPayment, createSession } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { RANGE, seedFixture, V1 } from "./fixture";

beforeEach(() => resetDb());

describe("timeseries extensions", () => {
  it("bounce_rate, avg_session_duration and goals per bucket", async () => {
    const f = await seedFixture();
    const res = await api(
      `/api/v1/analytics/timeseries?interval=day&fields=sessions,bounce_rate,avg_session_duration,goals&${RANGE}`,
      { token: f.key },
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        timestamp: "2026-03-10T00:00:00.000Z",
        sessions: 2,
        bounce_rate: 50,
        avg_session_duration: 150,
        goals: { signup: 1 },
      },
      {
        timestamp: "2026-03-11T00:00:00.000Z",
        sessions: 2,
        bounce_rate: 0,
        avg_session_duration: 360,
        goals: { checkout_started: 1 },
      },
    ]);
    expect(res.body.totals).toEqual({
      sessions: 4,
      bounce_rate: 25,
      avg_session_duration: 255,
      goals: { signup: 1, checkout_started: 1 },
    });
    const filtered = await api(
      `/api/v1/analytics/timeseries?interval=day&fields=goals&${RANGE}&filter_country=DE`,
      { token: f.key },
    );
    expect(filtered.body.totals.goals).toEqual({ checkout_started: 1 });
  });

  it("omitted fields return DataFast's fields only", async () => {
    const f = await seedFixture();
    const res = await api(`/api/v1/analytics/timeseries?interval=day&${RANGE}`, { token: f.key });
    expect(res.body.fields).not.toContain("goals");
    expect(res.body.data[0]).not.toHaveProperty("bounce_rate");
  });

  it("interval=minute serves ranges up to 6 hours (default: last 30 minutes)", async () => {
    const f = await seedFixture();
    const res = await api(
      "/api/v1/analytics/timeseries?interval=minute&fields=name,visitors,pageviews&startAt=2026-03-10T10:00:00Z&endAt=2026-03-10T10:09:59Z",
      { token: f.key },
    );
    expect(res.status).toBe(200);
    expect(res.body.interval).toBe("minute");
    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0]).toEqual({
      timestamp: "2026-03-10T10:00:00.000Z",
      name: "Mar 10, 10:00",
      visitors: 1,
      pageviews: 3,
    });
    const now = await api("/api/v1/analytics/timeseries?interval=minute&fields=visitors", {
      token: f.key,
    });
    expect(now.body.data).toHaveLength(30);
    const tooLong = await api(
      "/api/v1/analytics/timeseries?interval=minute&startAt=2026-03-10T00:00:00Z&endAt=2026-03-10T07:00:00Z",
      { token: f.key },
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.message).toContain("6 hours");
  });
});

describe("GET /api/v1/analytics/realtime/replay", () => {
  it("returns 32 frames of 15 minutes over the last 8 hours", async () => {
    const f = await seedFixture();
    const now = Date.now();
    const frameOf = (ms: number) => {
      const end = Math.floor(now / 900_000) * 900_000 + 900_000;
      return Math.floor((ms - (end - 32 * 900_000)) / 900_000);
    };
    const s = await createSession({
      siteId: f.site.id,
      visitorId: V1,
      startedAt: now - 2 * 3_600_000,
      country: "US",
      city: "Austin",
    });
    await env.DB.prepare(
      "UPDATE sessions SET lat = 30.27, lon = -97.74 WHERE site_id = ? AND id = ?",
    )
      .bind(f.site.id, s.id)
      .run();
    const at = now - 2 * 3_600_000 + 1000;
    await createEvent({ siteId: f.site.id, session: s, ts: at, path: "/" });
    await createEvent({ siteId: f.site.id, session: s, ts: at + 1000, path: "/pricing" });
    await createEvent({
      siteId: f.site.id,
      session: s,
      ts: at + 2000,
      type: "custom",
      name: "signup",
    });
    const old = await createSession({ siteId: f.site.id, startedAt: now - 9 * 3_600_000 });
    await createEvent({ siteId: f.site.id, session: old, ts: now - 9 * 3_600_000 });
    await createPayment({
      siteId: f.site.id,
      amountMinor: 100,
      occurredAt: at + 3000,
      visitorId: V1,
      firstSessionId: s.id,
    });

    const res = await api("/api/v1/analytics/realtime/replay", { token: f.key });
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r.stepMinutes).toBe(15);
    expect(r.frames).toHaveLength(32);
    expect(Date.parse(r.endAt) - Date.parse(r.startAt)).toBe(8 * 3_600_000);
    const frame = r.frames[frameOf(at)];
    expect(frame).toMatchObject({ pageviews: 2, goals: 1, payments: 1 });
    expect(frame.visitors).toEqual([
      {
        visitorId: V1,
        latitude: 30.27,
        longitude: -97.74,
        countryCode: "US",
        city: "Austin",
        isCustomer: true,
        conversionScore: null,
      },
    ]);
    const total = r.frames.reduce((n: number, fr: { pageviews: number }) => n + fr.pageviews, 0);
    expect(total).toBe(2);

    // Shared dashboards get the replay too, without payments unless public data is on.
    const share = await api(`/api/v1/admin/websites/${f.site.id}/share`, {
      token: f.key,
      body: {},
    });
    const pub = await api(`/api/share/${share.body.data.token}/analytics/realtime/replay`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.frames[frameOf(at)].payments).toBe(0);
  });

  it("needs analytics:read", async () => {
    await seedFixture();
    expect((await api("/api/v1/analytics/realtime/replay")).status).toBe(401);
  });
});
