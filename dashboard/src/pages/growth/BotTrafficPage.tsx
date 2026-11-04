import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  AttackModeState,
  BotTrafficPage as BotPage,
  BotTokenStatus,
  BotTrafficSettings,
  BotTrafficSummary,
} from "../../../../shared/api-types";
import { api, apiGet } from "../../api/client";
import { Button, Card, Field, Input, Notice, Spinner } from "../../components/ui";
import {
  BarChart,
  Code,
  fmtDate,
  fmtNumber,
  fmtPercent,
  PageHeader,
  type RangeKey,
  RangeSelect,
  rangeParams,
  Stat,
  StatGrid,
  Table,
  Tabs,
  Toggle,
  useSite,
  useSiteId,
} from "./shared";

type Category = "all" | "answer_fetch" | "search_index" | "training" | "ai_crawler";
type Verification = "all" | "ip_verified" | "user_agent_only";

const CATEGORY_TABS: Array<{ key: Category; label: string }> = [
  { key: "all", label: "All" },
  { key: "answer_fetch", label: "AI answers" },
  { key: "search_index", label: "Indexing" },
  { key: "training", label: "Training" },
  { key: "ai_crawler", label: "Other" },
];
const CATEGORY_LABEL: Record<string, string> = {
  answer_fetch: "AI answer",
  search_index: "Indexing",
  training: "Training",
  ai_crawler: "Other",
};

interface CatalogCompany {
  company: string;
  status: "enabled" | "disabled" | "partial";
  enabledAgentCount: number;
  totalAgentCount: number;
  agents: Array<{
    id: string;
    userAgent: string;
    category: string;
    description: string;
    enabled: boolean;
  }>;
}
interface SettingsResponse {
  websiteId: string;
  domain: string;
  settings: BotTrafficSettings;
  crawlerCatalog: CatalogCompany[];
}
type AttackMode = AttackModeState;

function SettingsPanel({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const settingsKey = ["bot-traffic", siteId, "settings"];
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: async () =>
      (
        await apiGet<SettingsResponse[]>(`/api/v1/admin/websites/${siteId}/bot-traffic/settings`)
      )[0],
    retry: false,
  });
  const token = useQuery({
    queryKey: ["bot-traffic", siteId, "token"],
    queryFn: async () =>
      (await apiGet<BotTokenStatus[]>(`/api/v1/admin/websites/${siteId}/bot-traffic/token`))[0],
    retry: false,
  });
  const [secret, setSecret] = useState<string | null>(null);
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<SettingsResponse[]>(`/api/v1/admin/websites/${siteId}/bot-traffic/settings`, body),
    onSuccess: (res) => {
      qc.setQueryData(settingsKey, res.data[0]);
      void qc.invalidateQueries({ queryKey: ["bot-traffic", siteId, "token"] });
    },
  });
  const tokenAction = useMutation({
    mutationFn: (method: "post" | "put" | "delete") =>
      api[method]<BotTokenStatus[]>(`/api/v1/admin/websites/${siteId}/bot-traffic/token`),
    onSuccess: (res) => {
      setSecret(res.data[0]?.requestAuthToken ?? null);
      void qc.invalidateQueries({ queryKey: ["bot-traffic", siteId] });
    },
  });
  if (settings.isPending) return <Spinner />;
  if (settings.error) return <Notice>Only website owners can change bot traffic settings.</Notice>;
  const s = settings.data?.settings;
  const t = token.data;
  return (
    <div className="space-y-5">
      {patch.error ? <Notice tone="error">{patch.error.message}</Notice> : null}
      <div className="space-y-3">
        <Toggle
          label="Accept only IP-verified crawlers"
          hint="Requests whose IP is not in the crawler's published ranges are dropped before storage."
          checked={s?.verifiedOnly ?? false}
          onChange={(v) => patch.mutate({ verifiedOnly: v })}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Request token</h3>
        {secret ? (
          <Notice tone="success">
            Copy this token now, it is shown once:{" "}
            <code className="font-mono break-all">{secret}</code>
          </Notice>
        ) : null}
        <p className="text-sm text-muted">
          {t?.hasToken
            ? `Token ${t.displayToken} created ${fmtDate(t.createdAt)}.`
            : "No token yet. Tracking works without one."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {t?.hasToken ? (
            <>
              <Button variant="secondary" onClick={() => tokenAction.mutate("put")}>
                Rotate token
              </Button>
              <Button variant="secondary" onClick={() => tokenAction.mutate("delete")}>
                Delete token
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => tokenAction.mutate("post")}>
              Create token
            </Button>
          )}
        </div>
        <div className="mt-3">
          <Toggle
            label="Reject unauthenticated requests"
            hint="Turn on after the token is deployed in your middleware."
            disabled={!t?.hasToken}
            checked={s?.requireAuthToken ?? false}
            onChange={(v) => patch.mutate({ requireAuthToken: v })}
          />
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Crawler ingestion</h3>
        <p className="mb-2 text-xs text-muted">
          Turned-off crawlers are skipped before storage and cannot be recovered later.
        </p>
        <ul className="grid gap-2 md:grid-cols-2">
          {(settings.data?.crawlerCatalog ?? []).map((c) => (
            <li key={c.company} className="rounded-md border border-line p-2">
              <Toggle
                label={`${c.company} (${c.enabledAgentCount}/${c.totalAgentCount})`}
                checked={c.status !== "disabled"}
                onChange={(on) =>
                  patch.mutate(
                    on ? { enableCompanies: [c.company] } : { disableCompanies: [c.company] },
                  )
                }
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AttackModeCard({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const key = ["bot-traffic", siteId, "attack-mode"];
  const q = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await apiGet<AttackMode[]>(`/api/v1/admin/websites/${siteId}/bot-traffic/attack-mode`))[0],
    retry: false,
  });
  const save = useMutation({
    mutationFn: (body: Partial<AttackMode>) =>
      api.put<AttackMode[]>(`/api/v1/admin/websites/${siteId}/bot-traffic/attack-mode`, body),
    onSuccess: (res) => qc.setQueryData(key, res.data[0]),
  });
  const a = q.data;
  if (!a) return null;
  return (
    <Card title="Attack mode">
      <p className="mb-3 text-sm text-muted">
        Attack mode applies the strictest bot filter to human analytics, to keep spam out while a
        site is under attack.
      </p>
      {save.error ? <Notice tone="error">{save.error.message}</Notice> : null}
      <div className="space-y-3">
        <Toggle
          label={a.enabled ? "Attack mode is on" : "Attack mode is off"}
          hint={
            a.autoActiveUntil
              ? `Switched on automatically until ${fmtDate(a.autoActiveUntil, true)}`
              : undefined
          }
          checked={a.enabled}
          onChange={(v) => save.mutate({ enabled: v })}
        />
        <Toggle
          label="Auto-enable on abnormal bot traffic"
          hint={`Switches on for ${a.durationMinutes} minutes when blocked bot hits or bot-like sessions reach ${a.multiplier}x the usual rate, and notifies the owners.`}
          checked={a.autoEnable}
          onChange={(v) => save.mutate({ autoEnable: v })}
        />
      </div>
      {a.events.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {a.events.slice(0, 5).map((e) => (
            <li key={e.id}>
              {fmtDate(e.startedAt, true)} – {e.endedAt ? fmtDate(e.endedAt, true) : "now"}:{" "}
              {e.source === "auto" ? e.reason.replaceAll("_", " ") : "turned on manually"}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** Bot traffic: AI answer fetches, indexing and training crawlers, by company or page. */
export default function BotTrafficPage() {
  const siteId = useSiteId();
  const site = useSite();
  const [range, setRange] = useState<RangeKey>("30d");
  const [category, setCategory] = useState<Category>("all");
  const [verification, setVerification] = useState<Verification>("all");
  const [view, setView] = useState<"crawlers" | "pages">("crawlers");
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const params = { websiteId: siteId, ...rangeParams(range), category, verification };
  const summary = useQuery({
    queryKey: ["bot-traffic", siteId, "summary", params],
    queryFn: async () =>
      (await apiGet<BotTrafficSummary[]>("/api/v1/analytics/bot-traffic", params))[0],
  });
  const pages = useQuery({
    queryKey: ["bot-traffic", siteId, "pages", params, search],
    queryFn: () =>
      apiGet<BotPage[]>("/api/v1/analytics/bot-traffic/pages", {
        ...params,
        pageSearch: search,
        limit: 50,
      }),
    enabled: view === "pages",
  });
  const s = summary.data;
  const origin =
    typeof window === "undefined" ? "https://analytics.example.com" : window.location.origin;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bot traffic"
        description="Which pages AI assistants, search engines and training crawlers request on your site, reported server-side by the @datagoat/ai-crawl middleware."
        actions={
          <>
            <RangeSelect value={range} onChange={setRange} />
            <Button
              variant="secondary"
              onClick={() => setShowSettings((v) => !v)}
              aria-expanded={showSettings}
            >
              Settings
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          label="Crawler category"
          value={category}
          onChange={setCategory}
          items={CATEGORY_TABS}
        />
        <select
          aria-label="Verification"
          className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
          value={verification}
          onChange={(e) => setVerification(e.target.value as Verification)}
        >
          <option value="all">All requests</option>
          <option value="ip_verified">IP verified</option>
          <option value="user_agent_only">User agent only</option>
        </select>
      </div>
      {showSettings ? (
        <Card title="Bot traffic settings">
          <SettingsPanel siteId={siteId} />
        </Card>
      ) : null}
      {summary.error ? <Notice tone="error">{summary.error.message}</Notice> : null}
      {summary.isPending ? (
        <Spinner />
      ) : s ? (
        <>
          <StatGrid>
            <Stat label="Requests" value={fmtNumber(s.totalRequests)} tone="visitors" />
            <Stat label="AI answers" value={fmtNumber(s.aiAnswerRequests)} tone="primary" />
            <Stat label="Indexing" value={fmtNumber(s.indexingRequests)} />
            <Stat label="Training" value={fmtNumber(s.trainingRequests)} />
          </StatGrid>
          <p className="text-xs text-muted">
            {fmtPercent(s.totalRequests ? (s.ipVerifiedRequests / s.totalRequests) * 100 : 0)} IP
            verified · {fmtNumber(s.userAgentOnlyRequests)} matched by user agent only
          </p>
          <Card>
            <BarChart
              label="Requests (AI answers overlaid)"
              secondaryLabel="AI answers"
              data={s.timeseries.map((p) => ({
                label: p.date.slice(0, 10),
                value: p.requestCount,
                secondary: p.aiAnswerRequests,
              }))}
            />
          </Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs
              label="Group by"
              value={view}
              onChange={setView}
              items={[
                { key: "crawlers", label: "Crawlers" },
                { key: "pages", label: "Pages" },
              ]}
            />
            {view === "pages" ? (
              <Input
                aria-label="Search pages"
                className="max-w-xs"
                placeholder="/llms.txt or /blog/*"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            ) : null}
          </div>
          <Card>
            {view === "crawlers" ? (
              <Table
                caption="Crawlers"
                rows={s.crawlers}
                rowKey={(c) => c.id}
                empty="No crawler requests yet. Install the middleware below and deploy."
                columns={[
                  {
                    key: "crawler",
                    header: "Crawler",
                    render: (c) => (
                      <div>
                        <div className="font-medium">{c.userAgent}</div>
                        <div className="text-xs text-muted">{c.company}</div>
                      </div>
                    ),
                  },
                  {
                    key: "cat",
                    header: "Type",
                    render: (c) => CATEGORY_LABEL[c.category] ?? c.category,
                  },
                  {
                    key: "n",
                    header: "Requests",
                    align: "right",
                    render: (c) => fmtNumber(c.requestCount),
                  },
                  {
                    key: "v",
                    header: "IP verified",
                    align: "right",
                    render: (c) => fmtNumber(c.ipVerifiedRequests ?? 0),
                  },
                  {
                    key: "p",
                    header: "Share",
                    align: "right",
                    render: (c) => fmtPercent(c.percentage ?? 0),
                  },
                ]}
              />
            ) : pages.isPending ? (
              <Spinner />
            ) : (
              <Table
                caption="Requested pages"
                rows={pages.data ?? []}
                rowKey={(p) => p.id}
                empty="No pages match."
                columns={[
                  {
                    key: "path",
                    header: "Page",
                    render: (p) => (
                      <div>
                        <div className="font-medium break-all">{p.path}</div>
                        <div className="text-xs text-muted">{p.hostname}</div>
                      </div>
                    ),
                  },
                  {
                    key: "crawlers",
                    header: "Crawlers",
                    render: (p) =>
                      p.crawlers
                        .slice(0, 3)
                        .map((c) => c.userAgent)
                        .join(", "),
                  },
                  {
                    key: "status",
                    header: "Status",
                    render: (p) => p.statusCodes.map((x) => x.statusCode || "?").join(", "),
                  },
                  {
                    key: "n",
                    header: "Requests",
                    align: "right",
                    render: (p) => fmtNumber(p.requestCount),
                  },
                ]}
              />
            )}
          </Card>
        </>
      ) : null}
      <AttackModeCard siteId={siteId} />
      <Card title="Set up server-side tracking">
        <p className="mb-2 text-sm text-muted">
          Crawlers rarely run JavaScript, so bot traffic is reported from your server. Install{" "}
          <code>@datagoat/ai-crawl</code> and wrap your handler:
        </p>
        <Code>{`import { withAICrawlerTracking } from "@datagoat/ai-crawl";

export default {
  fetch: withAICrawlerTracking(handler, {
    websiteId: "${site?.trackingId ?? "<your tracking id>"}",
    apiUrl: "${origin}",
  }),
};`}</Code>
        <Field
          label="Any other backend"
          hint="POST this JSON from your server (no Node.js needed)."
        >
          <Code>{`POST ${origin}/api/ai-crawls
{"websiteId": "${site?.trackingId ?? "<tracking id>"}", "domain": "${site?.domain ?? "example.com"}", "href": "https://${site?.domain ?? "example.com"}/docs",
 "ai": {"userAgent": "<User-Agent>", "ip": "<client IP>", "statusCode": 200, "source": "server_middleware"}}`}</Code>
        </Field>
      </Card>
    </div>
  );
}
