import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  AdCampaignRow,
  AdsSummary,
  GrowthIntegrationStatus,
  MetaAdAccount,
} from "../../../../shared/api-types";
import { api, apiGet } from "../../api/client";
import { Button, Card, Input, Notice, Spinner } from "../../components/ui";
import {
  fmtDate,
  fmtMoney,
  fmtNumber,
  PageHeader,
  type RangeKey,
  RangeSelect,
  rangeParams,
  Stat,
  StatGrid,
  Table,
  Toggle,
  useSite,
  useSiteId,
} from "./shared";

function CampaignPicker({ siteId, status }: { siteId: string; status: GrowthIntegrationStatus }) {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ["ads", siteId, "accounts"],
    queryFn: async () => {
      const res = await api.get<MetaAdAccount[]>("/api/v1/ads/accounts", { websiteId: siteId });
      return { accounts: res.data, error: (res.raw.error as string | undefined) ?? null };
    },
  });
  const current = status.settings as { campaignIds?: string[]; adAccountIds?: string[] };
  const [selected, setSelected] = useState<Set<string>>(new Set(current.campaignIds ?? []));
  useEffect(() => setSelected(new Set(current.campaignIds ?? [])), [current.campaignIds]);
  const save = useMutation({
    mutationFn: () => {
      const all = accounts.data?.accounts ?? [];
      const campaignAccounts: Record<string, string> = {};
      for (const a of all)
        for (const c of a.campaigns) if (selected.has(c.id)) campaignAccounts[c.id] = a.id;
      return api.put(`/api/v1/admin/websites/${siteId}/integrations/meta-ads`, {
        adAccountIds: [...new Set(Object.values(campaignAccounts))],
        campaignIds: [...selected],
        campaignAccounts,
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ads", siteId] }),
  });
  if (accounts.isPending) return <Spinner label="Loading ad accounts" />;
  if (accounts.data?.error) return <Notice tone="error">{accounts.data.error}</Notice>;
  const list = accounts.data?.accounts ?? [];
  if (list.length === 0)
    return (
      <p className="text-sm text-muted">No ad accounts found for the connected Facebook user.</p>
    );
  return (
    <div className="space-y-3">
      {save.error ? <Notice tone="error">{save.error.message}</Notice> : null}
      {save.isSuccess ? (
        <Notice tone="success">Saved. Spend is imported within the hour.</Notice>
      ) : null}
      {list.map((a) => (
        <fieldset key={a.id} className="rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium">
            {a.name ?? a.id} <span className="text-muted">({a.currency ?? "?"})</span>
          </legend>
          <div className="grid gap-2 md:grid-cols-2">
            {a.campaigns.map((c) => (
              <Toggle
                key={c.id}
                label={c.name ?? c.id}
                hint={c.status ?? undefined}
                checked={selected.has(c.id)}
                onChange={(on) =>
                  setSelected((s) => {
                    const next = new Set(s);
                    if (on) next.add(c.id);
                    else next.delete(c.id);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </fieldset>
      ))}
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        Save campaigns
      </Button>
    </div>
  );
}

function TokenForm({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/admin/websites/${siteId}/integrations/meta-ads`, {
        accessToken: token.trim(),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ads", siteId] }),
  });
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label htmlFor="meta-token" className="block text-sm font-medium">
        Or paste a Meta access token
      </label>
      {/* Input and button share one row; the hint sits under both so they line up. */}
      <div className="flex flex-wrap gap-2">
        <Input
          id="meta-token"
          type="password"
          autoComplete="off"
          required
          aria-describedby="meta-token-hint"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="min-w-64 flex-1"
        />
        <Button type="submit" variant="secondary" disabled={save.isPending}>
          Save token
        </Button>
      </div>
      <p id="meta-token-hint" className="text-xs text-muted">
        A system user token with ads_read from Business Manager.
      </p>
      {save.error ? <Notice tone="error">{save.error.message}</Notice> : null}
    </form>
  );
}

/** Meta Ads spend joined with attributed revenue: ROAS per campaign. */
export default function AdsPage() {
  const siteId = useSiteId();
  const site = useSite();
  const [range, setRange] = useState<RangeKey>("30d");
  const [editing, setEditing] = useState(false);
  const params = { websiteId: siteId, ...rangeParams(range) };
  const status = useQuery({
    queryKey: ["ads", siteId, "status"],
    queryFn: () =>
      apiGet<GrowthIntegrationStatus>(`/api/v1/admin/websites/${siteId}/integrations/meta-ads`),
  });
  const connected = Boolean(status.data?.hasCredentials || status.data?.connected);
  const summary = useQuery({
    queryKey: ["ads", siteId, "summary", params],
    queryFn: () => apiGet<AdsSummary>("/api/v1/ads/summary", params),
    enabled: connected,
  });
  const campaigns = useQuery({
    queryKey: ["ads", siteId, "campaigns", params],
    queryFn: () => apiGet<AdCampaignRow[]>("/api/v1/ads/campaigns", params),
    enabled: connected,
  });
  const s = summary.data;
  const currency = s?.currency ?? site?.currency ?? "USD";
  const selected =
    (status.data?.settings as { campaignIds?: string[] } | undefined)?.campaignIds ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Ads & ROAS"
        description="Meta (Facebook and Instagram) ad spend per campaign next to the visitors, payments and revenue DataGoat attributes to it."
        actions={connected ? <RangeSelect value={range} onChange={setRange} /> : null}
      />
      {status.isPending ? <Spinner /> : null}
      {status.data && !connected ? (
        <Card title="Connect Meta Ads">
          <p className="mb-3 text-sm text-muted">
            Add <code>utm_source=meta&utm_medium=paid-social&utm_campaign={"{{campaign.id}}"}</code>{" "}
            to your ads so visits match their campaign.
          </p>
          {status.data.connectUrl ? (
            <a
              className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg hover:opacity-90"
              href={`${status.data.connectUrl}&returnTo=ads`}
            >
              Connect Meta Ads
            </a>
          ) : (
            <Notice>
              Facebook login is not configured on this server (META_APP_ID, META_APP_SECRET).
            </Notice>
          )}
          <TokenForm siteId={siteId} />
        </Card>
      ) : null}
      {connected && status.data ? (
        <>
          {status.data.lastError ? (
            <Notice tone="error">Last sync: {status.data.lastError}</Notice>
          ) : null}
          {s ? (
            <StatGrid>
              <Stat label="Spend" value={fmtMoney(s.spend, currency)} />
              <Stat label="Revenue" value={fmtMoney(s.revenue, currency)} tone="revenue" />
              <Stat label="ROAS" value={s.roas === null ? "–" : `${s.roas}x`} tone="primary" />
              <Stat
                label="Visitors"
                value={fmtNumber(s.visitors)}
                tone="visitors"
                hint={`${fmtNumber(s.payments)} payments`}
              />
            </StatGrid>
          ) : null}
          {s && !s.currencyConverted ? (
            <Notice>
              Some ad accounts use another currency and no exchange rate is available yet; their
              spend is shown unconverted.
            </Notice>
          ) : null}
          <Card
            title={
              <span className="flex items-center justify-between gap-2">
                <span>Campaigns</span>
                <Button
                  variant="secondary"
                  onClick={() => setEditing((v) => !v)}
                  aria-expanded={editing}
                >
                  {editing ? "Done" : "Choose campaigns"}
                </Button>
              </span>
            }
          >
            {editing || selected.length === 0 ? (
              <div className="mb-4">
                <CampaignPicker siteId={siteId} status={status.data} />
              </div>
            ) : null}
            {campaigns.isPending ? (
              <Spinner />
            ) : (
              <Table
                caption="Campaigns"
                rows={campaigns.data ?? []}
                rowKey={(r) => `${r.accountId}:${r.campaignId}`}
                empty="No campaigns selected yet."
                columns={[
                  {
                    key: "name",
                    header: "Campaign",
                    render: (r) => (
                      <div>
                        <div className="font-medium">{r.campaignName ?? r.campaignId}</div>
                        <div className="text-xs text-muted">{r.campaignId}</div>
                      </div>
                    ),
                  },
                  {
                    key: "spend",
                    header: "Spend",
                    align: "right",
                    render: (r) => fmtMoney(r.spend, currency),
                  },
                  {
                    key: "clicks",
                    header: "Clicks",
                    align: "right",
                    render: (r) => fmtNumber(r.clicks),
                  },
                  {
                    key: "visitors",
                    header: "Visitors",
                    align: "right",
                    render: (r) => fmtNumber(r.visitors),
                  },
                  {
                    key: "payments",
                    header: "Payments",
                    align: "right",
                    render: (r) => fmtNumber(r.payments),
                  },
                  {
                    key: "revenue",
                    header: "Revenue",
                    align: "right",
                    render: (r) => fmtMoney(r.revenue, currency),
                  },
                  {
                    key: "roas",
                    header: "ROAS",
                    align: "right",
                    render: (r) => (r.roas === null ? "–" : `${r.roas}x`),
                  },
                ]}
              />
            )}
            <p className="mt-2 text-xs text-muted">
              Last sync {fmtDate(status.data.lastSyncedAt, true)}.
            </p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
