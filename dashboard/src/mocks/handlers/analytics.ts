/** W2 endpoints: analytics, visitors, server-side events, website admin resources, share links. */
import { HttpResponse, http } from "msw";
import * as f from "../fixtures/analytics";
import { websites } from "../fixtures/core";
import { list, ok } from "./util";

const A = "/api/v1/analytics";
const W = "/api/v1/admin/websites/:websiteId";

const breakdowns: Record<string, unknown[]> = {
  pages: f.pages,
  "entry-pages": f.entryPages,
  "exit-pages": f.exitPages,
  referrers: f.referrers,
  channels: f.channels,
  campaigns: f.campaigns,
  countries: f.countries,
  regions: f.regions,
  cities: f.cities,
  devices: f.devices,
  browsers: f.browsers,
  "operating-systems": f.operatingSystems,
  hostnames: f.hostnames,
  "exit-clicks": f.exitClicks,
  goals: f.goals,
};

export const analyticsHandlers = [
  http.get(`${A}/overview`, () => ok([f.overview])),
  http.get(`${A}/timeseries`, ({ request }) => {
    const url = new URL(request.url);
    const data = f.timeseries();
    const sum = (k: "visitors" | "pageviews" | "sessions" | "revenue" | "payments") =>
      data.reduce((s, p) => s + (p[k] ?? 0), 0);
    return ok(
      data,
      {
        fields: (
          url.searchParams.get("fields") ?? "visitors,pageviews,sessions,revenue,payments"
        ).split(","),
        interval: url.searchParams.get("interval") ?? "day",
        timezone: url.searchParams.get("timezone") ?? "America/New_York",
        currency: "USD",
        totals: {
          visitors: sum("visitors"),
          pageviews: sum("pageviews"),
          sessions: sum("sessions"),
          revenue: sum("revenue"),
          payments: sum("payments"),
          revenueBreakdown: {
            new: sum("revenue") * 0.8,
            renewal: sum("revenue") * 0.22,
            refunds: -sum("revenue") * 0.02,
          },
        },
      },
      { limit: 100, offset: 0, total: data.length },
    );
  }),
  http.get(`${A}/metadata`, () => ok([f.metadata])),
  http.get(`${A}/realtime`, () => ok([{ visitors: 2 }])),
  http.get(`${A}/realtime/map`, () => ok(f.realtimeMap())),
  http.get(`${A}/goals/properties`, ({ request }) => {
    const url = new URL(request.url);
    const property = url.searchParams.get("propertyName");
    return HttpResponse.json({
      status: "success",
      data: property ? f.goalPropertyValues : f.goalProperties,
      pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
      meta: {
        eventName: url.searchParams.get("eventName"),
        propertyName: property,
        timezone: "UTC",
        startAt: null,
        endAt: null,
      },
    });
  }),
  http.get(`${A}/funnels/:funnelId`, ({ params }) =>
    ok([
      f.funnelResult(
        f.funnels.find((x) => x.id === params.funnelId) ??
          (f.funnels[0] as (typeof f.funnels)[number]),
      ),
    ]),
  ),
  http.get(`${A}/:breakdown`, ({ params, request }) => {
    const rows = breakdowns[String(params.breakdown)];
    return rows ? list(rows, new URL(request.url)) : undefined;
  }),

  http.get("/api/v1/visitors", ({ request }) =>
    list(f.visitorsList(40), new URL(request.url), 250),
  ),
  http.get("/api/v1/visitors/:visitorId", ({ params }) =>
    ok(f.visitorProfile(String(params.visitorId))),
  ),
  http.post("/api/v1/goals", () =>
    ok([{ message: "Custom event created successfully", eventId: "evt_mock" }]),
  ),
  http.delete("/api/v1/goals", () => ok([{ message: "Goal events deleted successfully" }])),
  http.post("/api/v1/identify", () =>
    ok({ message: "User profile created successfully", profileId: "prof_mock", action: "created" }),
  ),

  http.get(`${W}/goals`, () => ok(f.trackedGoals)),
  http.get(`${W}/goals/customizations`, () => ok(f.goalCustomizations, { colors: f.goalColors })),
  http.patch(`${W}/goals/customizations`, async ({ request }) =>
    ok(
      [
        {
          hidden: false,
          description: null,
          displayName: null,
          color: null,
          ...((await request.json()) as object),
          updatedAt: new Date().toISOString(),
        },
      ],
      { colors: f.goalColors },
    ),
  ),
  http.delete(`${W}/goals/customizations`, ({ request }) =>
    ok([{ deleted: true, goalName: new URL(request.url).searchParams.get("goalName") }]),
  ),
  http.get(`${W}/funnels`, () => ok(f.funnels)),
  http.post(`${W}/funnels`, async ({ request }) =>
    ok([{ ...f.funnels[0], ...((await request.json()) as object), id: `fun_${Date.now()}` }]),
  ),
  http.put(`${W}/funnels/:funnelId`, async ({ request }) =>
    ok([{ ...f.funnels[0], ...((await request.json()) as object) }]),
  ),
  http.delete(`${W}/funnels/:funnelId`, () => ok([{ message: "Funnel deleted successfully" }])),
  http.get(`${W}/notes`, ({ params, request }) =>
    list(f.notes(String(params.websiteId)), new URL(request.url)),
  ),
  http.post(`${W}/notes`, async ({ params, request }) =>
    ok([
      {
        ...f.notes(String(params.websiteId))[0],
        ...((await request.json()) as object),
        id: `note_${Date.now()}`,
      },
    ]),
  ),
  http.put(`${W}/notes/:noteId`, async ({ params, request }) =>
    ok([{ ...f.notes(String(params.websiteId))[0], ...((await request.json()) as object) }]),
  ),
  http.delete(`${W}/notes/:noteId`, ({ params }) => ok([{ id: params.noteId, deleted: true }])),
  http.get(`${W}/segments`, ({ params }) => ok(f.segments(String(params.websiteId)))),
  http.post(`${W}/segments`, async ({ params, request }) =>
    ok([
      {
        ...f.segments(String(params.websiteId))[0],
        ...((await request.json()) as object),
        id: `seg_${Date.now()}`,
      },
    ]),
  ),
  http.put(`${W}/segments/:segmentId`, async ({ params, request }) =>
    ok([{ ...f.segments(String(params.websiteId))[0], ...((await request.json()) as object) }]),
  ),
  http.delete(`${W}/segments/:segmentId`, () => ok([{ deleted: true }])),
  http.get(`${W}/share`, ({ params }) =>
    ok(f.shareLink(websites.find((w) => w._id === params.websiteId)?.shareToken ?? null)),
  ),
  http.post(`${W}/share`, () => ok(f.shareLink("share_rotated_token_0000"))),
  http.delete(`${W}/share`, () => ok(f.shareLink(null))),
  http.get(`${W}/usage`, () => ok(f.usage)),

  http.get("/api/share/:token", () =>
    ok({
      domain: "example.com",
      name: "Example SaaS",
      logo: null,
      timezone: "America/New_York",
      currency: "USD",
      showRevenue: false,
    }),
  ),
  http.get("/api/share/:token/analytics/:endpoint", ({ params, request }) => {
    const endpoint = String(params.endpoint);
    if (endpoint === "overview") return ok([f.overview]);
    if (endpoint === "timeseries")
      return ok(f.timeseries(), {
        interval: "day",
        fields: ["visitors"],
        timezone: "UTC",
        currency: "USD",
        totals: {},
      });
    const rows = breakdowns[endpoint];
    return rows ? list(rows, new URL(request.url)) : undefined;
  }),
];
