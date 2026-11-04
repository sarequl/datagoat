import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import type { GrowthIntegrationStatus, Mention, XLinkRow } from "../../../../shared/api-types";
import { api, apiGet } from "../../api/client";
import { Button, Card, Field, Input, Notice, Spinner } from "../../components/ui";
import {
  fmtDate,
  fmtMoney,
  fmtNumber,
  PageHeader,
  type RangeKey,
  RangeSelect,
  rangeParams,
  splitList,
  Table,
  Tabs,
  Toggle,
  useSite,
  useSiteId,
} from "./shared";

function engagementText(m: Mention): string {
  const e = m.engagement;
  return m.platform === "x"
    ? `${fmtNumber(e.likes ?? 0)} likes · ${fmtNumber(e.reposts ?? 0)} reposts · ${fmtNumber(e.replies ?? 0)} replies`
    : `${fmtNumber(e.score ?? 0)} points · ${fmtNumber(e.comments ?? 0)} comments`;
}

function XSettings({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const key = ["integrations", siteId, "x"];
  const status = useQuery({
    queryKey: key,
    queryFn: () =>
      apiGet<GrowthIntegrationStatus>(`/api/v1/admin/websites/${siteId}/integrations/x`),
  });
  const [keywords, setKeywords] = useState("");
  const [handles, setHandles] = useState("");
  const [token, setToken] = useState("");
  const [reddit, setReddit] = useState(true);
  useEffect(() => {
    const s = status.data?.settings as
      | { keywords?: string[]; handles?: string[]; redditEnabled?: boolean }
      | undefined;
    if (!s) return;
    setKeywords((s.keywords ?? []).join(", "));
    setHandles((s.handles ?? []).map((h) => `@${h}`).join(", "));
    setReddit(s.redditEnabled !== false);
  }, [status.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put<GrowthIntegrationStatus>(`/api/v1/admin/websites/${siteId}/integrations/x`, {
        keywords: splitList(keywords),
        handles: splitList(handles),
        redditEnabled: reddit,
        ...(token.trim() ? { bearerToken: token.trim() } : {}),
      }),
    onSuccess: (res) => {
      qc.setQueryData(key, res.data);
      setToken("");
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const st = status.data;
  const usesServer = Boolean(
    (st?.settings as { usesServerToken?: boolean } | undefined)?.usesServerToken,
  );
  return (
    <form className="space-y-4" onSubmit={submit} aria-label="Mention tracking settings">
      {save.error ? <Notice tone="error">{save.error.message}</Notice> : null}
      {save.isSuccess ? (
        <Notice tone="success">Saved. New mentions appear within 30 minutes.</Notice>
      ) : null}
      {st?.lastError ? <Notice tone="error">Last sync: {st.lastError}</Notice> : null}
      <Field
        label="Keywords"
        hint="4–15 characters each, comma separated, e.g. DataGoat, @datagoat, #launch. Your domain is always tracked on X and Reddit."
      >
        <Input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="YourBrand, @yourhandle"
        />
      </Field>
      <Field
        label="Link-in-bio handles"
        hint="Accounts whose profile links to your site, for X link attribution."
      >
        <Input
          value={handles}
          onChange={(e) => setHandles(e.target.value)}
          placeholder="@you, @yourcompany"
        />
      </Field>
      <Toggle label="Also search Reddit" checked={reddit} onChange={setReddit} />
      <Field
        label="X API bearer token"
        hint={
          st?.hasCredentials
            ? "Stored. Leave empty to keep it."
            : usesServer
              ? "Optional: the server's X_BEARER_TOKEN is used."
              : "Needed for X search (recent search, X API v2). Reddit works without it."
        }
      >
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
        {st?.connectUrl ? (
          <a
            className="inline-flex items-center rounded-md border border-line px-3 py-2 text-sm hover:bg-surface-2"
            href={`${st.connectUrl}&returnTo=mentions`}
          >
            Connect with X
          </a>
        ) : null}
      </div>
      {st?.lastSyncedAt ? (
        <p className="text-xs text-muted">Last checked {fmtDate(st.lastSyncedAt, true)}</p>
      ) : null}
    </form>
  );
}

/** Mentions of the brand on X and Reddit, and the X posts that send traffic and revenue. */
export default function MentionsPage() {
  const siteId = useSiteId();
  const site = useSite();
  const [range, setRange] = useState<RangeKey>("30d");
  const [platform, setPlatform] = useState<"all" | "x" | "reddit">("all");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"mentions" | "links" | "settings">("mentions");
  const params = { websiteId: siteId, ...rangeParams(range) };
  const mentions = useQuery({
    queryKey: ["mentions", siteId, params, platform, q],
    queryFn: async () => {
      const res = await api.get<Mention[]>("/api/v1/mentions", {
        ...params,
        platform: platform === "all" ? undefined : platform,
        q: q.trim() || undefined,
        limit: 100,
      });
      return {
        rows: res.data,
        total:
          (res.raw.meta as { totalMentions?: number } | undefined)?.totalMentions ??
          res.data.length,
      };
    },
    enabled: tab === "mentions",
  });
  const links = useQuery({
    queryKey: ["x-links", siteId, params],
    queryFn: () => apiGet<XLinkRow[]>("/api/v1/x/links", params),
    enabled: tab === "links",
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Mentions"
        description="Posts on X and Reddit that mention your brand or domain, and the X posts and profiles that send you visitors and revenue."
        actions={<RangeSelect value={range} onChange={setRange} />}
      />
      <Tabs
        label="Mentions view"
        value={tab}
        onChange={setTab}
        items={[
          { key: "mentions", label: "Mentions" },
          { key: "links", label: "X link attribution" },
          { key: "settings", label: "Settings" },
        ]}
      />
      {tab === "mentions" ? (
        <Card>
          <div className="mb-3 flex flex-wrap gap-2">
            <Tabs
              label="Platform"
              value={platform}
              onChange={setPlatform}
              items={[
                { key: "all", label: "All" },
                { key: "x", label: "X" },
                { key: "reddit", label: "Reddit" },
              ]}
            />
            <Input
              aria-label="Search mentions"
              className="max-w-xs"
              placeholder="Search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {mentions.isPending ? (
            <Spinner />
          ) : mentions.error ? (
            <Notice tone="error">{mentions.error.message}</Notice>
          ) : mentions.data.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              No mentions in this period. Add keywords in Settings; {site?.domain ?? "your domain"}{" "}
              is tracked automatically.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {mentions.data.rows.map((m) => (
                <li key={m.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 font-medium text-text">
                      {m.platform === "x" ? "X" : `r/${m.subreddit ?? "reddit"}`}
                    </span>
                    <span>{m.author.name ?? m.author.username}</span>
                    {m.author.username ? <span>@{m.author.username}</span> : null}
                    <span>{fmtDate(m.timestamp, true)}</span>
                    {m.isRetweet ? <span>Repost</span> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm">{m.text}</p>
                  <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
                    <span>{engagementText(m)}</span>
                    <a
                      className="text-primary-text hover:underline"
                      href={m.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
      {tab === "links" ? (
        <Card title="Posts sending traffic (t.co)">
          {links.isPending ? (
            <Spinner />
          ) : (
            <Table
              caption="X link attribution"
              rows={links.data ?? []}
              rowKey={(r, i) => r.tweetId ?? r.tweetUrl ?? `unresolved-${i}`}
              empty="No visitors from X in this period."
              columns={[
                {
                  key: "post",
                  header: "Post",
                  render: (r) =>
                    r.tweetUrl ? (
                      <a
                        className="text-primary-text hover:underline"
                        href={r.tweetUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.authorUsername ? `@${r.authorUsername}` : "Post"}
                        {r.text ? `: ${r.text.slice(0, 80)}` : ""}
                      </a>
                    ) : (
                      <span className="text-muted">Not matched to a post yet</span>
                    ),
                },
                {
                  key: "v",
                  header: "Visitors",
                  align: "right",
                  render: (r) => fmtNumber(r.visitors),
                },
                {
                  key: "rev",
                  header: "Revenue",
                  align: "right",
                  render: (r) => fmtMoney(r.revenue, site?.currency),
                },
                {
                  key: "pay",
                  header: "Payments",
                  align: "right",
                  render: (r) => fmtNumber(r.payments),
                },
              ]}
            />
          )}
        </Card>
      ) : null}
      {tab === "settings" ? (
        <Card title="X and Reddit">
          <XSettings siteId={siteId} />
        </Card>
      ) : null}
    </div>
  );
}
