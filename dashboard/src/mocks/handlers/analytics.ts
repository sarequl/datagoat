/**
 * W2 endpoints: analytics, visitors, server-side events, website admin resources, share links.
 * Numbers come from the deterministic traffic model in fixtures/model.ts; notes, segments,
 * funnels and goal customizations are kept in the mock state so the UI can create and edit them.
 */
import { HttpResponse, http } from "msw";
import type {
  Funnel,
  GoalCustomization,
  Note,
  Segment,
  TimeseriesPoint,
} from "../../../../shared/api-types";
import * as f from "../fixtures/analytics";
import {
  funnelResultFor,
  funnelsSeed,
  goalCustomizationsSeed,
  goalPropertiesFor,
  notesSeed,
  segmentsSeed,
  trackedGoalsFor,
  visitorProfileFor,
  visitorsFor,
} from "../fixtures/dashboard";
import {
  breakdownFor,
  overviewFor,
  realtimeMapFor,
  replayFor,
  timeseriesFor,
} from "../fixtures/model";
import { state } from "../state";
import { fail, list, ok } from "./util";

const A = "/api/v1/analytics";
const W = "/api/v1/admin/websites/:websiteId";

function bucket<T>(store: Record<string, T[]>, id: string, seed: () => T[]): T[] {
  store[id] ??= seed();
  return store[id] as T[];
}
const notesOf = (id: string) => bucket<Note>(state.analytics.notes, id, () => notesSeed(id));
const segmentsOf = (id: string) =>
  bucket<Segment>(state.analytics.segments, id, () => segmentsSeed(id));
const funnelsOf = (id: string) =>
  bucket<Funnel>(state.analytics.funnels, id, () => funnelsSeed(id));
const customizationsOf = (id: string) =>
  bucket<GoalCustomization>(state.analytics.goalCustomizations, id, () => goalCustomizationsSeed());
const newId = () =>
  Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function timeseriesResponse(url: URL) {
  const data = timeseriesFor(url);
  const sum = (k: keyof TimeseriesPoint) =>
    data.reduce((s, p) => s + (typeof p[k] === "number" ? (p[k] as number) : 0), 0);
  const revenue = Math.round(sum("revenue") * 100) / 100;
  return ok(
    data,
    {
      fields: (url.searchParams.get("fields") ?? "visitors,revenue").split(","),
      interval: url.searchParams.get("interval") ?? "day",
      timezone: url.searchParams.get("timezone") ?? "America/New_York",
      currency: "USD",
      totals: {
        visitors: sum("visitors"),
        pageviews: sum("pageviews"),
        sessions: sum("sessions"),
        revenue,
        payments: sum("payments"),
        revenueBreakdown: {
          new: Math.round(revenue * 0.75 * 100) / 100,
          renewal: Math.round(revenue * 0.27 * 100) / 100,
          refunds: -Math.round(revenue * 0.02 * 100) / 100,
        },
      },
    },
    { limit: 1000, offset: 0, total: data.length },
  );
}

function inRange(ts: string, url: URL): boolean {
  const s = url.searchParams.get("startAt");
  const e = url.searchParams.get("endAt");
  if (!s || !e) return true;
  const t = Date.parse(ts);
  return (
    t >= Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s) - 86_400_000 &&
    t <= Date.parse(e.length === 10 ? `${e}T23:59:59Z` : e) + 86_400_000
  );
}

export const analyticsHandlers = [
  http.get(`${A}/overview`, ({ request }) => ok([overviewFor(new URL(request.url))])),
  http.get(`${A}/timeseries`, ({ request }) => timeseriesResponse(new URL(request.url))),
  http.get(`${A}/metadata`, ({ request }) => {
    const id = new URL(request.url).searchParams.get("websiteId");
    const w = state.websites.find((x) => x._id === id || x.trackingId === id);
    return ok([
      {
        ...f.metadata,
        ...(w
          ? {
              domain: w.domain,
              name: w.name ?? w.domain,
              timezone: w.timezone,
              currency: w.currency,
              kpi: w.kpi,
              kpiColorScheme: w.kpiColorScheme ?? "orange",
            }
          : {}),
      },
    ]);
  }),
  http.get(`${A}/realtime`, () => ok([{ visitors: realtimeMapFor().count }])),
  http.get(`${A}/realtime/map`, () => ok(realtimeMapFor())),
  http.get(`${A}/realtime/replay`, () => ok(replayFor())),
  http.get(`${A}/goals/properties`, ({ request }) => {
    const url = new URL(request.url);
    const property = url.searchParams.get("propertyName");
    const rows = goalPropertiesFor(url);
    return HttpResponse.json({
      status: "success",
      data: rows,
      pagination: { limit: 100, offset: 0, total: rows.length, hasMore: false },
      meta: {
        eventName: url.searchParams.get("eventName"),
        propertyName: property,
        timezone: url.searchParams.get("timezone") ?? "UTC",
        startAt: url.searchParams.get("startAt"),
        endAt: url.searchParams.get("endAt"),
      },
    });
  }),
  http.get(`${A}/funnels/:funnelId`, ({ params, request }) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("websiteId") ?? "";
    const funnel = funnelsOf(id).find((x) => x.id === params.funnelId);
    return funnel ? ok([funnelResultFor(funnel, url)]) : fail(404, "Funnel not found");
  }),
  http.get(`${A}/:breakdown`, ({ params, request }) => {
    const url = new URL(request.url);
    const rows = breakdownFor(String(params.breakdown), url);
    return rows ? list(rows, url) : undefined;
  }),

  http.get("/api/v1/visitors", ({ request }) => {
    const url = new URL(request.url);
    return list(visitorsFor(url), url, 250);
  }),
  http.get("/api/v1/visitors/:visitorId", ({ params }) =>
    ok(visitorProfileFor(String(params.visitorId))),
  ),
  http.post("/api/v1/goals", () =>
    ok([{ message: "Custom event created successfully", eventId: "evt_mock" }]),
  ),
  http.delete("/api/v1/goals", () => ok([{ message: "Goal events deleted successfully" }])),
  http.post("/api/v1/identify", () =>
    ok({ message: "User profile created successfully", profileId: "prof_mock", action: "created" }),
  ),

  http.get(`${W}/goals`, ({ params }) =>
    ok(trackedGoalsFor(customizationsOf(String(params.websiteId)))),
  ),
  http.get(`${W}/goals/customizations`, ({ params, request }) => {
    const name = new URL(request.url).searchParams.get("goalName");
    const items = customizationsOf(String(params.websiteId));
    return ok(name ? items.filter((c) => c.goalName === name) : items, { colors: f.goalColors });
  }),
  http.patch(`${W}/goals/customizations`, async ({ params, request }) => {
    const body = (await request.json()) as Partial<GoalCustomization> & { goalName: string };
    const items = customizationsOf(String(params.websiteId));
    let item = items.find((c) => c.goalName === body.goalName);
    if (!item) {
      item = {
        goalName: body.goalName,
        displayName: null,
        color: null,
        description: null,
        hidden: false,
        updatedAt: null,
      };
      items.push(item);
    }
    Object.assign(item, body, { updatedAt: new Date().toISOString() });
    return ok([item], { colors: f.goalColors });
  }),
  http.delete(`${W}/goals/customizations`, ({ params, request }) => {
    const name = new URL(request.url).searchParams.get("goalName");
    const id = String(params.websiteId);
    state.analytics.goalCustomizations[id] = customizationsOf(id).filter(
      (c) => c.goalName !== name,
    );
    return ok([{ deleted: true, goalName: name }]);
  }),
  http.get(`${W}/funnels`, ({ params }) =>
    ok(funnelsOf(String(params.websiteId)).filter((x) => x.isActive)),
  ),
  http.post(`${W}/funnels`, async ({ params, request }) => {
    const id = String(params.websiteId);
    const body = (await request.json()) as Pick<Funnel, "name" | "steps">;
    if (funnelsOf(id).some((x) => x.isActive && x.name === body.name)) {
      return fail(409, "A funnel with this name already exists");
    }
    const now = new Date().toISOString();
    const funnel: Funnel = {
      id: newId(),
      websiteId: id,
      name: body.name,
      slug: body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      steps: body.steps.map((s, i) => ({ ...s, id: s.id ?? `step${i + 1}` })),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    funnelsOf(id).push(funnel);
    return ok([funnel]);
  }),
  http.put(`${W}/funnels/:funnelId`, async ({ params, request }) => {
    const funnel = funnelsOf(String(params.websiteId)).find((x) => x.id === params.funnelId);
    if (!funnel) return fail(404, "Funnel not found");
    const body = (await request.json()) as Partial<Funnel>;
    Object.assign(funnel, body, {
      steps: (body.steps ?? funnel.steps).map((s, i) => ({ ...s, id: s.id ?? `step${i + 1}` })),
      updatedAt: new Date().toISOString(),
    });
    return ok([funnel]);
  }),
  http.delete(`${W}/funnels/:funnelId`, ({ params }) => {
    const funnel = funnelsOf(String(params.websiteId)).find((x) => x.id === params.funnelId);
    if (funnel) funnel.isActive = false;
    return ok([{ message: "Funnel deleted successfully" }]);
  }),
  http.get(`${W}/notes`, ({ params, request }) => {
    const url = new URL(request.url);
    const rows = notesOf(String(params.websiteId))
      .filter((n) => inRange(n.timestamp, url))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return list(rows, url);
  }),
  http.post(`${W}/notes`, async ({ params, request }) => {
    const body = (await request.json()) as { text: string; timestamp: string };
    if (!body.text?.trim() || body.text.length > 500)
      return fail(400, "text must be 1-500 characters");
    const now = new Date().toISOString();
    const note: Note = {
      id: newId(),
      websiteId: String(params.websiteId),
      text: body.text,
      timestamp: body.timestamp,
      author: { id: state.user.id, name: state.user.name, image: null },
      createdAt: now,
      updatedAt: now,
    };
    notesOf(String(params.websiteId)).push(note);
    return HttpResponse.json({ status: "success", data: [note] }, { status: 201 });
  }),
  http.put(`${W}/notes/:noteId`, async ({ params, request }) => {
    const note = notesOf(String(params.websiteId)).find((n) => n.id === params.noteId);
    if (!note) return fail(404, "Note not found");
    Object.assign(note, (await request.json()) as object, { updatedAt: new Date().toISOString() });
    return ok([note]);
  }),
  http.delete(`${W}/notes/:noteId`, ({ params }) => {
    const id = String(params.websiteId);
    state.analytics.notes[id] = notesOf(id).filter((n) => n.id !== params.noteId);
    return ok([{ id: params.noteId, deleted: true }]);
  }),
  http.get(`${W}/segments`, ({ params }) => ok(segmentsOf(String(params.websiteId)))),
  http.post(`${W}/segments`, async ({ params, request }) => {
    const body = (await request.json()) as Pick<Segment, "name" | "filters">;
    const now = new Date().toISOString();
    const seg: Segment = {
      id: newId(),
      websiteId: String(params.websiteId),
      name: body.name,
      filters: body.filters,
      createdAt: now,
      updatedAt: now,
    };
    segmentsOf(String(params.websiteId)).push(seg);
    return ok([seg]);
  }),
  http.put(`${W}/segments/:segmentId`, async ({ params, request }) => {
    const seg = segmentsOf(String(params.websiteId)).find((s) => s.id === params.segmentId);
    if (!seg) return fail(404, "Segment not found");
    Object.assign(seg, (await request.json()) as object, { updatedAt: new Date().toISOString() });
    return ok([seg]);
  }),
  http.delete(`${W}/segments/:segmentId`, ({ params }) => {
    const id = String(params.websiteId);
    state.analytics.segments[id] = segmentsOf(id).filter((s) => s.id !== params.segmentId);
    return ok([{ deleted: true }]);
  }),
  http.get(`${W}/share`, ({ params }) =>
    ok(f.shareLink(state.websites.find((w) => w._id === params.websiteId)?.shareToken ?? null)),
  ),
  http.post(`${W}/share`, () => ok(f.shareLink("share_rotated_token_0000"))),
  http.delete(`${W}/share`, () => ok(f.shareLink(null))),
  http.get(`${W}/usage`, () => ok(f.usage)),

  http.get("/api/share/:token", ({ params }) => {
    const w = state.websites.find((x) => x.shareToken === params.token);
    if (!w) return fail(404, "Share link not found");
    return ok({
      domain: w.domain,
      name: w.name,
      logo: w.logo,
      timezone: w.timezone,
      currency: w.currency,
      showRevenue: w.isPublicDataEnabled,
    });
  }),
  // Share API realtime (contract §9): no PII, payments only with public revenue.
  http.get("/api/share/:token/analytics/realtime/map", ({ params }) => {
    const w = state.websites.find((x) => x.shareToken === params.token);
    if (!w) return fail(404, "Share link not found");
    const map = realtimeMapFor();
    return ok({
      ...map,
      visitors: map.visitors.map((v) => ({
        ...v,
        customerName: null,
        customerEmail: null,
        profileData: { ...v.profileData, displayName: null, email: null },
      })),
      recentPayments: w.isPublicDataEnabled ? map.recentPayments : [],
    });
  }),
  http.get("/api/share/:token/analytics/realtime", ({ params }) =>
    state.websites.some((x) => x.shareToken === params.token)
      ? ok([{ visitors: realtimeMapFor().count }])
      : fail(404, "Share link not found"),
  ),
  http.get("/api/share/:token/analytics/realtime/replay", ({ params }) =>
    state.websites.some((x) => x.shareToken === params.token)
      ? ok(replayFor())
      : fail(404, "Share link not found"),
  ),
  http.get("/api/share/:token/analytics/:endpoint", ({ params, request }) => {
    const url = new URL(request.url);
    const w = state.websites.find((x) => x.shareToken === params.token);
    if (!w) return fail(404, "Share link not found");
    const endpoint = String(params.endpoint);
    if (endpoint === "overview") return ok([overviewFor(url)]);
    if (endpoint === "timeseries") return timeseriesResponse(url);
    const rows = breakdownFor(endpoint, url);
    return rows ? list(rows, url) : fail(404, `No route for GET ${url.pathname}`);
  }),
];
