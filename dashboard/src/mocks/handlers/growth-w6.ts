/**
 * W6 (growth) mock API: alerts, bot traffic + attack mode, mentions and X links, GitHub, Search
 * Console, Meta Ads, growth integrations and imports. Small in-memory state makes create/update/
 * delete flows behave like the Worker during `npm run dev:mock`; `resetGrowthMock()` restores it.
 */
import { http } from "msw";
import type {
  Alert,
  AlertChannels,
  AttackModeState,
  BotTrafficSettings,
  GrowthIntegrationStatus,
  ImportJob,
} from "../../../../shared/api-types";
import { websites } from "../fixtures/core";
import * as g from "../fixtures/growth";
import * as w6 from "../fixtures/growth-w6";
import { fail, list, ok } from "./util";

const W = "/api/v1/admin/websites/:websiteId";
const domainOf = (id: unknown) => websites.find((w) => w._id === id)?.domain ?? "example.com";

interface GrowthMockState {
  alerts: Map<string, Alert[]>;
  integrations: Map<string, GrowthIntegrationStatus>;
  imports: Map<string, ImportJob[]>;
  botSettings: Map<string, BotTrafficSettings>;
  attack: Map<string, AttackModeState>;
  hasToken: Map<string, boolean>;
}

function initial(): GrowthMockState {
  return {
    alerts: new Map(),
    integrations: new Map(),
    imports: new Map(),
    botSettings: new Map(),
    attack: new Map(),
    hasToken: new Map(),
  };
}

let state = initial();
export function resetGrowthMock(): void {
  state = initial();
}

const alertsOf = (site: string) => {
  if (!state.alerts.has(site)) state.alerts.set(site, g.alerts(site));
  return state.alerts.get(site) as Alert[];
};
const integrationOf = (site: string, kind: GrowthIntegrationStatus["kind"]) => {
  const key = `${site}:${kind}`;
  if (!state.integrations.has(key)) state.integrations.set(key, w6.integrationStatus(site, kind));
  return state.integrations.get(key) as GrowthIntegrationStatus;
};
const importsOf = (site: string) => {
  if (!state.imports.has(site)) state.imports.set(site, g.imports(site));
  return state.imports.get(site) as ImportJob[];
};
const settingsOf = (site: string) => state.botSettings.get(site) ?? g.botSettings;
const attackOf = (site: string) => state.attack.get(site) ?? w6.attackMode;

const SLUGS = {
  github: "github",
  gsc: "google-search-console",
  meta_ads: "meta-ads",
  x: "x",
} as const;

// biome-ignore lint/suspicious/noExplicitAny: request bodies are free-form in mocks
type Body = Record<string, any>;

function applyAlert(base: Alert, body: Body): Alert {
  const trigger = body.trigger ? { ...base.trigger, ...body.trigger } : base.trigger;
  if (body.trigger?.goalName && !body.trigger.type) trigger.type = "goal";
  return {
    ...base,
    name: body.name ?? base.name,
    trigger,
    destination: body.destination
      ? {
          type: body.destination.type,
          email: body.destination.email,
          chatId: body.destination.chatId,
          url: body.destination.url,
          hasBotToken: Boolean(body.destination.botToken),
        }
      : base.destination,
    template: body.template
      ? {
          ...base.template,
          ...body.template,
          message: body.template.message ?? base.template.message,
        }
      : base.template,
    isEnabled: body.isEnabled ?? base.isEnabled,
    updatedAt: new Date().toISOString(),
  };
}

export const w6Handlers = [
  // Growth integrations
  ...(Object.entries(SLUGS) as Array<[GrowthIntegrationStatus["kind"], string]>).flatMap(
    ([kind, slug]) => [
      http.get(`${W}/integrations/${slug}`, ({ params }) =>
        ok(integrationOf(String(params.websiteId), kind)),
      ),
      http.put(`${W}/integrations/${slug}`, async ({ params, request }) => {
        const site = String(params.websiteId);
        const { accessToken, bearerToken, ...settings } = (await request.json()) as Body;
        const current = integrationOf(site, kind);
        const next: GrowthIntegrationStatus = {
          ...current,
          connected: true,
          status: "active",
          hasCredentials: current.hasCredentials || Boolean(accessToken ?? bearerToken),
          settings: { ...current.settings, ...settings },
        };
        state.integrations.set(`${site}:${kind}`, next);
        return ok(next);
      }),
      http.delete(`${W}/integrations/${slug}`, ({ params }) => {
        const site = String(params.websiteId);
        const next = {
          ...w6.integrationStatus(site, kind),
          connected: false,
          status: null,
          hasCredentials: false,
        };
        state.integrations.set(`${site}:${kind}`, next);
        return ok(next);
      }),
    ],
  ),

  // Alerts
  http.get(`${W}/alerts/channels`, () => ok<AlertChannels>(w6.alertChannels)),
  http.get(`${W}/alerts/history`, () =>
    ok(w6.alertHistory, { counts: { sent: 2, failed: 1, total: 3 } }),
  ),
  http.get(`${W}/alerts`, ({ params }) => ok(alertsOf(String(params.websiteId)))),
  http.post(`${W}/alerts`, async ({ params, request }) => {
    const site = String(params.websiteId);
    const body = (await request.json()) as Body;
    if (!body.name) return fail(400, "name: must be 1-100 characters");
    const base = {
      ...g.alerts(site)[0],
      id: `alert_${Date.now()}`,
      triggerCount: 0,
      dailyCount: 0,
      monthlyCount: 0,
      recentLogs: [],
      lastTriggeredAt: null,
    } as Alert;
    const created = applyAlert(base, body);
    if (created.destination.type === "webhook")
      created.destination.signingSecret = "whsec_mock_shown_once";
    alertsOf(site).push({
      ...created,
      destination: { ...created.destination, signingSecret: undefined },
    });
    return ok([created]);
  }),
  http.put(`${W}/alerts/:alertId`, async ({ params, request }) => {
    const list = alertsOf(String(params.websiteId));
    const i = list.findIndex((a) => a.id === params.alertId);
    if (i < 0) return fail(404, "Alert not found");
    const next = applyAlert(list[i] as Alert, (await request.json()) as Body);
    list[i] = next;
    return ok([next]);
  }),
  http.delete(`${W}/alerts/:alertId`, ({ params }) => {
    const site = String(params.websiteId);
    state.alerts.set(
      site,
      alertsOf(site).filter((a) => a.id !== params.alertId),
    );
    return ok([{ message: "Alert deleted successfully" }]);
  }),
  http.post(`${W}/alerts/:alertId/test`, () => ok([{ message: "Test alert sent" }])),

  // Bot traffic
  http.get("/api/v1/analytics/bot-traffic", ({ request }) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("websiteId") ?? websites[0]?._id;
    return ok([w6.botSummary(String(id), domainOf(id), url.searchParams.get("category") ?? "all")]);
  }),
  http.get("/api/v1/analytics/bot-traffic/pages", ({ request }) => {
    const url = new URL(request.url);
    const search = (url.searchParams.get("pageSearch") ?? "").toLowerCase().replace(/\*/g, "");
    const rows = w6.botPages.filter((p) => !search || p.path.toLowerCase().includes(search));
    return ok(
      rows,
      { context: { websiteId: url.searchParams.get("websiteId"), domain: "example.com" } },
      {
        limit: 50,
        offset: 0,
        total: rows.length,
        hasMore: false,
        nextOffset: null,
      },
    );
  }),
  http.get("/api/v1/admin/bot-traffic/usage", () =>
    ok([
      {
        usage: {
          usage: 12840,
          dropped: 0,
          allowance: null,
          remaining: null,
          percentUsed: 0,
          periodStartAt: null,
          resetAt: null,
          isCounting: false,
        },
        websiteStats: [],
      },
    ]),
  ),
  http.get(`${W}/bot-traffic/settings`, ({ params }) =>
    ok([
      {
        websiteId: params.websiteId,
        domain: domainOf(params.websiteId),
        settings: settingsOf(String(params.websiteId)),
        crawlerCatalog: w6.catalog(settingsOf(String(params.websiteId))),
      },
    ]),
  ),
  http.patch(`${W}/bot-traffic/settings`, async ({ params, request }) => {
    const site = String(params.websiteId);
    const body = (await request.json()) as Body;
    const current = settingsOf(site);
    if (body.requireAuthToken === true && !state.hasToken.get(site))
      return fail(400, "Create a bot traffic token before requiring it");
    let excluded = new Set(current.excludedCrawlerIds);
    for (const c of body.disableCompanies ?? []) for (const id of w6.agentIds(c)) excluded.add(id);
    for (const c of body.enableCompanies ?? [])
      for (const id of w6.agentIds(c)) excluded.delete(id);
    if (body.excludedCrawlerIds) excluded = new Set(body.excludedCrawlerIds);
    const next: BotTrafficSettings = {
      ...current,
      ...Object.fromEntries(Object.entries(body).filter(([k]) => k in current)),
      excludedCrawlerIds: [...excluded].sort(),
    };
    state.botSettings.set(site, next);
    return ok([
      { websiteId: site, domain: domainOf(site), settings: next, crawlerCatalog: w6.catalog(next) },
    ]);
  }),
  http.get(`${W}/bot-traffic/token`, ({ params }) => {
    const site = String(params.websiteId);
    const has = Boolean(state.hasToken.get(site));
    return ok([
      {
        ...g.botToken(site, domainOf(site)),
        hasToken: has,
        displayToken: has ? "dfbot_abcd...wxyz" : null,
        createdAt: has ? new Date().toISOString() : null,
        requireAuthToken: has && settingsOf(site).requireAuthToken,
      },
    ]);
  }),
  http.post(`${W}/bot-traffic/token`, ({ params }) => {
    const site = String(params.websiteId);
    if (state.hasToken.get(site)) return fail(409, "A token already exists; rotate it instead");
    state.hasToken.set(site, true);
    return ok([
      {
        ...g.botToken(site, domainOf(site)),
        hasToken: true,
        displayToken: "dfbot_abcd...wxyz",
        requestAuthToken: "dgbot_mockShownOnce",
      },
    ]);
  }),
  http.put(`${W}/bot-traffic/token`, ({ params }) =>
    ok([
      {
        ...g.botToken(String(params.websiteId), domainOf(params.websiteId)),
        hasToken: true,
        displayToken: "dfbot_efgh...wxyz",
        requestAuthToken: "dgbot_mockRotated",
      },
    ]),
  ),
  http.delete(`${W}/bot-traffic/token`, ({ params }) => {
    const site = String(params.websiteId);
    state.hasToken.set(site, false);
    state.botSettings.set(site, { ...settingsOf(site), requireAuthToken: false });
    return ok([g.botToken(site, domainOf(site))]);
  }),
  http.get(`${W}/bot-traffic/attack-mode`, ({ params }) =>
    ok([attackOf(String(params.websiteId))]),
  ),
  http.put(`${W}/bot-traffic/attack-mode`, async ({ params, request }) => {
    const site = String(params.websiteId);
    const next = { ...attackOf(site), ...((await request.json()) as Body) } as AttackModeState;
    state.attack.set(site, next);
    return ok([next]);
  }),

  // Mentions, X links, GitHub
  http.get("/api/v1/mentions", ({ request }) => {
    const url = new URL(request.url);
    const platform = url.searchParams.get("platform");
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const rows = g
      .mentions(url.searchParams.get("websiteId") ?? String(websites[0]?._id))
      .filter(
        (m) => (!platform || m.platform === platform) && (!q || m.text.toLowerCase().includes(q)),
      );
    return ok(
      rows,
      {
        meta: {
          totalMentions: rows.length,
          sampled: false,
          mentionLimit: null,
          timezone: "UTC",
          startAt: null,
          endAt: null,
        },
      },
      { limit: 100, offset: 0, total: rows.length, hasMore: false },
    );
  }),
  http.get("/api/v1/x/links", ({ request }) => list(g.xLinks, new URL(request.url))),
  http.get("/api/v1/github/commits", ({ request }) => {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return list(
      q ? g.commits.filter((c) => c.message.toLowerCase().startsWith(q)) : g.commits,
      url,
    );
  }),
  http.get("/api/v1/github/repos", () =>
    ok([{ fullName: "example/app", private: false, defaultBranch: "main", pushedAt: null }]),
  ),

  // Search Console
  http.get("/api/v1/search-console/status", ({ request }) => {
    const site = new URL(request.url).searchParams.get("websiteId") ?? "";
    const conn = integrationOf(site, "gsc");
    return ok(
      w6.searchConsoleStatus(
        site,
        conn.connected,
        (conn.settings.property as string | undefined) ?? null,
      ),
    );
  }),
  http.get("/api/v1/search-console/overview", () => ok(w6.searchConsoleOverview)),
  http.get("/api/v1/search-console", ({ request }) => {
    const url = new URL(request.url);
    const rows =
      url.searchParams.get("groupBy") === "page" ? w6.searchConsolePages : g.searchConsole;
    return list(rows, url);
  }),

  // Meta Ads
  http.get("/api/v1/ads/accounts", () => ok(w6.adAccounts)),
  http.get("/api/v1/ads/campaigns", ({ request }) => list(g.adCampaigns, new URL(request.url))),
  http.get("/api/v1/ads/summary", () => ok(w6.adsSummary)),

  // Imports
  http.get(`${W}/imports`, ({ params }) => ok(importsOf(String(params.websiteId)))),
  http.post(`${W}/imports`, async ({ params, request }) => {
    const site = String(params.websiteId);
    const body = (await request.json()) as Body;
    const job: ImportJob = {
      ...(g.imports(site)[0] as ImportJob),
      id: `imp_${Date.now()}`,
      status: "pending",
      fileName: body.fileName ?? null,
      rowsImported: 0,
      rowsTotal: null,
      rangeStart: null,
      rangeEnd: null,
      finishedAt: null,
      createdAt: new Date().toISOString(),
    };
    importsOf(site).unshift(job);
    return ok([job]);
  }),
  http.get(`${W}/imports/:importId`, ({ params }) => {
    const job = importsOf(String(params.websiteId)).find((j) => j.id === params.importId);
    return job ? ok([job]) : fail(404, "Import not found");
  }),
  http.delete(`${W}/imports/:importId`, ({ params }) => {
    const job = importsOf(String(params.websiteId)).find((j) => j.id === params.importId);
    if (!job) return fail(404, "Import not found");
    Object.assign(job, { status: "cancelled", rowsImported: 0 });
    return ok([job]);
  }),
  http.post(`${W}/imports/:importId/rows`, async ({ params, request }) => {
    const job = importsOf(String(params.websiteId)).find((j) => j.id === params.importId);
    if (!job) return fail(404, "Import not found");
    const { rows } = (await request.json()) as { rows: Array<{ day: string }> };
    const days = rows.map((r) => r.day).sort();
    Object.assign(job, {
      status: "processing",
      rowsImported: job.rowsImported + rows.length,
      rangeStart: job.rangeStart && job.rangeStart < (days[0] ?? "") ? job.rangeStart : days[0],
      rangeEnd: job.rangeEnd && job.rangeEnd > (days.at(-1) ?? "") ? job.rangeEnd : days.at(-1),
    });
    return ok([{ accepted: rows.length }]);
  }),
  http.post(`${W}/imports/:importId/complete`, ({ params }) => {
    const job = importsOf(String(params.websiteId)).find((j) => j.id === params.importId);
    if (!job) return fail(404, "Import not found");
    Object.assign(job, {
      status: "completed",
      rowsTotal: job.rowsImported,
      finishedAt: new Date().toISOString(),
    });
    return ok([job]);
  }),
];
