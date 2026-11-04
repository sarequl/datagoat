import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  SearchConsoleOverview,
  SearchConsoleRow,
  SearchConsoleStatus,
} from "../../../../shared/api-types";
import { api, apiGet } from "../../api/client";
import { Card, Input, Notice, Spinner } from "../../components/ui";
import {
  BarChart,
  fmtDate,
  fmtMoney,
  fmtNumber,
  fmtPercent,
  PageHeader,
  type RangeKey,
  RangeSelect,
  rangeParams,
  Select,
  Stat,
  StatGrid,
  Table,
  Tabs,
  useSite,
  useSiteId,
} from "./shared";

function change(cur: number, prev: number): string | undefined {
  if (!prev) return undefined;
  const pct = ((cur - prev) / prev) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}% vs previous period`;
}

function Connection({ siteId, status }: { siteId: string; status: SearchConsoleStatus }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (property: string) =>
      api.put(`/api/v1/admin/websites/${siteId}/integrations/google-search-console`, { property }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["search-console", siteId] }),
  });
  if (!status.connected) {
    return (
      <Card title="Connect Google Search Console">
        <p className="mb-3 text-sm text-muted">
          See which search terms bring visitors and an estimate of the revenue each keyword drives.
          Your website must be verified in Search Console.
        </p>
        {status.connectUrl ? (
          <a
            className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg hover:opacity-90"
            href={status.connectUrl}
          >
            Connect with Google
          </a>
        ) : (
          <Notice>
            Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID and
            GOOGLE_CLIENT_SECRET (see docs/growth/search-console.md).
          </Notice>
        )}
      </Card>
    );
  }
  return (
    <Card title="Connection">
      {status.lastError ? <Notice tone="error">Last sync: {status.lastError}</Notice> : null}
      {save.error ? <Notice tone="error">{save.error.message}</Notice> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {status.properties?.length ? (
          <Select
            label="Property"
            value={status.property ?? ""}
            onChange={(v) => save.mutate(v)}
            options={[
              ...(status.property ? [] : [{ value: "", label: "Choose a property" }]),
              ...status.properties.map((p) => ({ value: p.siteUrl, label: p.siteUrl })),
            ]}
          />
        ) : (
          <p className="text-sm">Property: {status.property ?? "none selected"}</p>
        )}
        <p className="text-sm text-muted">
          Data{" "}
          {status.oldestDay
            ? `from ${status.oldestDay} to ${status.newestDay}`
            : "is being imported"}
          {status.backfillComplete ? "" : " (history still importing)"}. Last sync{" "}
          {fmtDate(status.lastSyncedAt, true)}.
        </p>
      </div>
    </Card>
  );
}

/** Google Search Console keywords and pages with estimated revenue. */
export default function SearchConsolePage() {
  const siteId = useSiteId();
  const site = useSite();
  const [range, setRange] = useState<RangeKey>("30d");
  const [groupBy, setGroupBy] = useState<"query" | "page">("query");
  const [page, setPage] = useState("");
  const params = {
    websiteId: siteId,
    ...rangeParams(range),
    filter_page: page.trim() ? `contains:${page.trim()}` : undefined,
  };
  const status = useQuery({
    queryKey: ["search-console", siteId, "status"],
    queryFn: () =>
      apiGet<SearchConsoleStatus>("/api/v1/search-console/status", { websiteId: siteId }),
  });
  const connected = Boolean(status.data?.connected);
  const overview = useQuery({
    queryKey: ["search-console", siteId, "overview", params],
    queryFn: () => apiGet<SearchConsoleOverview>("/api/v1/search-console/overview", params),
    enabled: connected,
  });
  const rows = useQuery({
    queryKey: ["search-console", siteId, "rows", params, groupBy],
    queryFn: () =>
      apiGet<SearchConsoleRow[]>("/api/v1/search-console", { ...params, groupBy, limit: 100 }),
    enabled: connected,
  });
  const o = overview.data;
  const currency = o?.currency ?? site?.currency ?? "USD";
  return (
    <div className="space-y-6">
      <PageHeader
        title="Search Console"
        description="Google search keywords and landing pages with clicks, impressions, position and estimated revenue."
        actions={connected ? <RangeSelect value={range} onChange={setRange} /> : null}
      />
      {status.isPending ? (
        <Spinner />
      ) : status.data ? (
        <Connection siteId={siteId} status={status.data} />
      ) : null}
      {status.error ? <Notice tone="error">{status.error.message}</Notice> : null}
      {connected ? (
        <>
          {o ? (
            <>
              <StatGrid>
                <Stat
                  label="Clicks"
                  value={fmtNumber(o.clicks)}
                  tone="visitors"
                  hint={change(o.clicks, o.previous.clicks)}
                />
                <Stat
                  label="Impressions"
                  value={fmtNumber(o.impressions)}
                  hint={change(o.impressions, o.previous.impressions)}
                />
                <Stat
                  label="CTR · Position"
                  value={`${fmtPercent(o.ctr)} · ${o.position || "–"}`}
                />
                <Stat
                  label="Est. revenue"
                  value={fmtMoney(o.estimatedRevenue, currency)}
                  tone="revenue"
                />
              </StatGrid>
              <Card>
                <BarChart
                  label="Clicks per day"
                  data={o.timeseries.map((p) => ({ label: p.date, value: p.clicks }))}
                />
              </Card>
            </>
          ) : overview.isPending ? (
            <Spinner />
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Tabs
              label="Group by"
              value={groupBy}
              onChange={setGroupBy}
              items={[
                { key: "query", label: "Keywords" },
                { key: "page", label: "Pages" },
              ]}
            />
            <Input
              aria-label="Filter by page"
              className="max-w-xs"
              placeholder="Page contains, e.g. /blog"
              value={page}
              onChange={(e) => setPage(e.target.value)}
            />
          </div>
          <Card>
            {rows.isPending ? (
              <Spinner />
            ) : rows.error ? (
              <Notice tone="error">{rows.error.message}</Notice>
            ) : (
              <Table
                caption={groupBy === "query" ? "Keywords" : "Pages"}
                rows={rows.data ?? []}
                rowKey={(r) => r.query ?? r.page ?? ""}
                empty="No search data for this period yet. Search Console data can take 2-3 days to appear."
                columns={[
                  {
                    key: "k",
                    header: groupBy === "query" ? "Keyword" : "Page",
                    render: (r) => <span className="break-all">{r.query ?? r.page}</span>,
                  },
                  {
                    key: "c",
                    header: "Clicks",
                    align: "right",
                    render: (r) => fmtNumber(r.clicks),
                  },
                  {
                    key: "i",
                    header: "Impressions",
                    align: "right",
                    render: (r) => fmtNumber(r.impressions),
                  },
                  { key: "ctr", header: "CTR", align: "right", render: (r) => fmtPercent(r.ctr) },
                  { key: "p", header: "Position", align: "right", render: (r) => r.position },
                  {
                    key: "rev",
                    header: "Est. revenue",
                    align: "right",
                    render: (r) => fmtMoney(r.estimatedRevenue, currency),
                  },
                ]}
              />
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
