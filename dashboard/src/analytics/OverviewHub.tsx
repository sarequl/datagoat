/**
 * The Overview's hub sections below the breakdowns (signed-in websites only): Conversions
 * (funnel, goals, visitor activity), Live and revenue, and Growth. Each card links to its full
 * page with "Open"; a feature that is not set up shows a setup card in place, which can be
 * hidden (remembered per website in this browser) and brought back from "Add card". Cards load
 * their data only once they scroll into view, to keep requests down.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  BotTrafficSummary,
  FunnelResult,
  GrowthIntegrationStatus,
  Mention,
  RealtimeVisitor,
  SearchConsoleStatus,
  TimeseriesPoint,
} from "../../../shared/api-types";
import { apiGet } from "../api/client";
import { useResolvedTheme } from "../components/ThemeToggle";
import { cx } from "../components/ui";
import { Skeleton } from "./components/primitives";
import { Sparkline, useWidth } from "./components/Sparkline";
import { type MapMarker, MarkerMap } from "./components/WorldMap";
import {
  useAdsSummary,
  useFunnelResult,
  useFunnels,
  useMentions,
  useMrr,
  useRealtimeMap,
  useRevenueSummary,
} from "./hooks";
import {
  countryName,
  flagEmoji,
  formatMoney,
  formatNumber,
  formatPercent,
  timeAgo,
} from "./lib/format";
import { readPref, writePref } from "./lib/storage";

type Range = Record<string, string>;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Renders `children` once the placeholder scrolls near the viewport (always, without IO). */
export function WhenVisible({ children, height = 220 }: { children: ReactNode; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !box.current) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: "300px" },
    );
    io.observe(box.current);
    return () => io.disconnect();
  }, [seen]);
  if (seen) return <>{children}</>;
  return <div ref={box} style={{ minHeight: height }} aria-hidden="true" />;
}

function ArrowOut() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
    >
      <path d="M5 11 11 5M6 5h5v5" />
    </svg>
  );
}

/** A hub card: title row (icon, title, "Open" link) and a body. */
export function HubCard({
  id,
  title,
  icon,
  open,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  icon?: ReactNode;
  open?: { to: string; siteId: string; label?: string; hash?: string };
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`hub-${id}-title`}
      data-testid={`hub-${id}`}
      className={cx("flex min-w-0 flex-col rounded-lg border border-line bg-surface", className)}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        {icon ? <span className="text-muted">{icon}</span> : null}
        <h3 id={`hub-${id}-title`} className="min-w-0 flex-1 truncate text-sm font-semibold">
          {title}
        </h3>
        {open ? (
          <Link
            to={open.to}
            params={{ siteId: open.siteId }}
            hash={open.hash}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
          >
            {open.label ?? "Open"}
            <ArrowOut />
          </Link>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4">{children}</div>
    </section>
  );
}

/** A setup card's body: what the feature does, the action, and "Hide this card". */
function SetupBody({
  heading,
  text,
  action,
  onHide,
}: {
  heading: string;
  text: string;
  action: ReactNode;
  onHide: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-4 text-center">
      <p className="text-sm font-semibold">{heading}</p>
      <p className="max-w-sm text-[13px] text-muted">{text}</p>
      <div className="mt-2">{action}</div>
      <button
        type="button"
        onClick={onHide}
        className="mt-1 rounded px-1.5 text-xs text-muted hover:text-text"
      >
        Hide this card
      </button>
    </div>
  );
}

const ACTION =
  "inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-fg hover:brightness-110";

function ActionLink({
  to,
  siteId,
  hash,
  children,
}: {
  to: string;
  siteId: string;
  hash?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} params={{ siteId }} hash={hash} className={ACTION}>
      <span aria-hidden="true">+</span>
      {children}
    </Link>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-4">
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">{children}</h2>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="truncate text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hidden cards
// ---------------------------------------------------------------------------

export const HIDEABLE = {
  funnel: "Funnel",
  revenue: "Revenue",
  mentions: "Mentions",
  keywords: "Search keywords",
  crawlers: "AI crawlers and bots",
  ads: "Meta Ads",
} as const;
export type HideableCard = keyof typeof HIDEABLE;

function useHidden(siteId: string) {
  const key = `hub-hidden:${siteId}`;
  const [hidden, setHidden] = useState<HideableCard[]>(() => readPref<HideableCard[]>(key, []));
  const save = (next: HideableCard[]) => {
    setHidden(next);
    writePref(key, next);
  };
  return {
    hidden,
    hide: (c: HideableCard) => save([...new Set([...hidden, c])]),
    show: (c: HideableCard) => save(hidden.filter((h) => h !== c)),
  };
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

function FunnelBars({ result }: { result: FunnelResult }) {
  const first = Math.max(1, result.data[0]?.value ?? 0);
  return (
    <ol
      className="grid flex-1 gap-2"
      style={{ gridTemplateColumns: `repeat(${Math.max(1, result.data.length)}, minmax(0, 1fr))` }}
    >
      {result.data.map((s, i) => (
        <li key={s.id} className="flex min-w-0 flex-col">
          <div className="relative h-32 rounded-md bg-surface-2">
            <div
              className="absolute inset-x-0 bottom-0 rounded-md bg-[color-mix(in_srgb,var(--dg-secondary)_55%,transparent)]"
              style={{ height: `${Math.max(3, (s.value / first) * 100)}%` }}
            />
            {i > 0 ? (
              <div className="absolute inset-x-0 top-1 text-center text-[11px] text-muted">
                {formatPercent(s.conversionRate)}
              </div>
            ) : null}
          </div>
          <div className="mt-1.5 text-sm font-semibold tabular-nums">{formatNumber(s.value)}</div>
          <div className="truncate text-xs text-muted" title={s.label}>
            {s.label}
          </div>
        </li>
      ))}
    </ol>
  );
}

function FunnelCard({
  siteId,
  range,
  onHide,
}: {
  siteId: string;
  range: Range;
  onHide: () => void;
}) {
  const funnels = useFunnels(siteId);
  const list = funnels.data ?? [];
  const [chosen, setChosen] = useState(() => readPref<string>(`hub-funnel:${siteId}`, ""));
  const funnel = list.find((f) => f.id === chosen) ?? list[0];
  const result = useFunnelResult(siteId, funnel?.id ?? "", range);
  if (funnels.isPending)
    return (
      <HubCard id="funnel" title="Funnel">
        <Skeleton className="h-40" />
      </HubCard>
    );
  if (!funnel)
    return (
      <HubCard id="funnel" title="Funnel">
        <SetupBody
          heading="See where visitors drop off"
          text="Build a funnel from page visits and goals, such as pricing → signup → payment."
          action={
            <ActionLink to="/app/$siteId/funnels" siteId={siteId}>
              Build a funnel
            </ActionLink>
          }
          onHide={onHide}
        />
      </HubCard>
    );
  return (
    <HubCard
      id="funnel"
      title={
        list.length > 1 ? (
          <select
            aria-label="Funnel"
            value={funnel.id}
            onChange={(e) => {
              setChosen(e.target.value);
              writePref(`hub-funnel:${siteId}`, e.target.value);
            }}
            className="max-w-full rounded-md border border-line bg-surface px-1.5 py-0.5 text-sm font-semibold"
          >
            {list.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          `Funnel · ${funnel.name}`
        )
      }
      open={{ to: `/app/$siteId/funnels/${funnel.id}`, siteId }}
    >
      {result.data && result.data.funnel.id === funnel.id ? (
        <FunnelBars result={result.data} />
      ) : (
        <Skeleton className="h-40" />
      )}
    </HubCard>
  );
}

// ---------------------------------------------------------------------------
// Live and revenue
// ---------------------------------------------------------------------------

function WideSpark({ values, color }: { values: Array<number | null>; color: string }) {
  const { ref, width } = useWidth<HTMLDivElement>(480);
  return (
    <div ref={ref} className="mt-3 w-full">
      <Sparkline values={values} color={color} width={Math.max(120, width)} height={96} />
    </div>
  );
}

function RevenueCard({
  siteId,
  range,
  points,
  revenueColor,
  onHide,
}: {
  siteId: string;
  range: Range;
  points: TimeseriesPoint[];
  revenueColor: string;
  onHide: () => void;
}) {
  const mrr = useMrr(siteId);
  const summary = useRevenueSummary(siteId, range);
  const ads = useAdsSummary(siteId, range);
  const s = summary.data;
  if (summary.isPending)
    return (
      <HubCard id="revenue" title="Revenue" className="lg:col-span-2">
        <Skeleton className="h-40" />
      </HubCard>
    );
  const hasMrr = Boolean(mrr.data && mrr.data.activeSubscriptions > 0);
  const empty = !s || (s.payments === 0 && s.revenue === 0 && !hasMrr);
  if (empty)
    return (
      <HubCard id="revenue" title="Revenue" className="lg:col-span-2">
        <SetupBody
          heading="Know which channels bring paying customers"
          text="Connect Stripe, Polar, Lemon Squeezy, Paddle, Creem or Shopify. Payments are matched to visitors automatically."
          action={
            <ActionLink to="/app/$siteId/integrations" siteId={siteId}>
              Connect payments
            </ActionLink>
          }
          onHide={onHide}
        />
      </HubCard>
    );
  const a = ads.data && ads.data.campaigns > 0 ? ads.data : null;
  return (
    <HubCard
      id="revenue"
      title="Revenue"
      className="lg:col-span-2"
      open={{ to: "/app/$siteId/revenue", siteId }}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Revenue"
          value={formatMoney(s.revenue, s.currency)}
          sub={`${formatNumber(s.payments)} payments`}
        />
        {hasMrr && mrr.data ? (
          <Stat
            label="MRR"
            value={formatMoney(mrr.data.mrr, mrr.data.currency)}
            sub={`${formatNumber(mrr.data.activeSubscriptions)} subscriptions`}
          />
        ) : (
          <Stat
            label="New revenue"
            value={formatMoney(s.newRevenue, s.currency)}
            sub={`${formatMoney(s.renewalRevenue, s.currency)} renewals`}
          />
        )}
        <Stat
          label="Customers"
          value={formatNumber(s.customers)}
          sub={`${formatPercent(s.attribution.coveragePercentage, 0)} attributed`}
        />
        {a ? (
          <Stat
            label="Ad spend return"
            value={a.roas === null ? "–" : `${a.roas.toFixed(2)}×`}
            sub={`${formatMoney(a.spend, a.currency)} → ${formatMoney(a.revenue, a.currency)}`}
          />
        ) : (
          <Stat label="Refunds" value={formatMoney(s.refunds, s.currency)} sub="in this period" />
        )}
      </div>
      <p className="mt-4 text-xs text-muted">Revenue over the period</p>
      <WideSpark values={points.map((p) => p.revenue ?? null)} color={revenueColor} />
    </HubCard>
  );
}

function visitorName(v: RealtimeVisitor): string {
  return v.profileData.displayName ?? v.customerName ?? "Visitor";
}

function visitorPath(v: RealtimeVisitor): string {
  if (!v.currentUrl) return "";
  try {
    return new URL(v.currentUrl).pathname;
  } catch {
    return v.currentUrl;
  }
}

function RealtimeCard({ siteId, wide }: { siteId: string; wide?: boolean }) {
  const live = useRealtimeMap(siteId, 30_000);
  const theme = useResolvedTheme();
  const visitors = live.data?.visitors ?? [];
  const markers: MapMarker[] = visitors
    .filter((v) => v.latitude !== null && v.longitude !== null)
    .map((v) => ({
      id: v.visitorId,
      lat: v.latitude as number,
      lng: v.longitude as number,
      color: v.isCustomer ? "var(--dg-success)" : "var(--dg-primary)",
      label: `${visitorName(v)}, ${countryName(v.location.countryCode)}`,
    }));
  return (
    <HubCard
      id="realtime"
      icon={
        <span
          aria-hidden="true"
          className={cx("block size-2 rounded-full", live.data?.count ? "bg-success" : "bg-muted")}
        />
      }
      title={live.data ? `Realtime · ${formatNumber(live.data.count)} online` : "Realtime"}
      open={{ to: "/app/$siteId/realtime", siteId, label: "Open live map" }}
      className={wide ? "lg:col-span-3" : undefined}
    >
      {live.isPending ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="overflow-hidden rounded-lg" data-theme={theme}>
            <MarkerMap markers={markers} style={theme} />
          </div>
          {visitors.length ? (
            <ul className="mt-3 divide-y divide-line text-[13px]">
              {visitors.slice(0, 3).map((v) => (
                <li key={v.visitorId} className="flex items-center gap-2 py-1.5">
                  <span aria-hidden="true">{flagEmoji(v.location.countryCode)}</span>
                  <Link
                    to="/app/$siteId/visitors/$visitorId"
                    params={{ siteId, visitorId: v.visitorId }}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {visitorName(v)}
                    {v.location.city ? (
                      <span className="text-muted"> · {v.location.city}</span>
                    ) : null}
                  </Link>
                  <span className="max-w-[40%] truncate text-muted">{visitorPath(v)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-muted">No one is on the site right now.</p>
          )}
        </>
      )}
    </HubCard>
  );
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

function XIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5" fill="currentColor">
      <path d="M18.9 2H22l-7.6 8.7L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8.1-9.3L1 2h7l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.4 3.9h-2L17.7 20Z" />
    </svg>
  );
}

function MentionsCard({ siteId, onHide }: { siteId: string; onHide: () => void }) {
  const status = useQuery({
    queryKey: ["integrations", siteId, "x"],
    queryFn: () =>
      apiGet<GrowthIntegrationStatus>(`/api/v1/admin/websites/${siteId}/integrations/x`),
    retry: false,
  });
  const set = status.data?.settings as { keywords?: string[]; handles?: string[] } | undefined;
  const configured = Boolean(
    status.data &&
      (status.data.connected ||
        status.data.hasCredentials ||
        (set?.keywords?.length ?? 0) + (set?.handles?.length ?? 0) > 0),
  );
  const mentions = useMentions(siteId, { limit: "3" }, configured);
  if (status.isPending)
    return (
      <HubCard id="mentions" title="Mentions" icon={<XIcon />}>
        <Skeleton className="h-32" />
      </HubCard>
    );
  if (!configured)
    return (
      <HubCard id="mentions" title="Mentions" icon={<XIcon />}>
        <SetupBody
          heading="See who talks about you on X and Reddit"
          text="Add your brand keywords and handles. Mentions show on the chart next to the traffic they bring."
          action={
            <ActionLink to="/app/$siteId/mentions" siteId={siteId}>
              Set up mentions
            </ActionLink>
          }
          onHide={onHide}
        />
      </HubCard>
    );
  const items: Mention[] = mentions.data ?? [];
  return (
    <HubCard
      id="mentions"
      title="Mentions · X and Reddit"
      icon={<XIcon />}
      open={{ to: "/app/$siteId/mentions", siteId }}
    >
      {mentions.isPending ? (
        <Skeleton className="h-32" />
      ) : items.length ? (
        <ul className="-my-1 divide-y divide-line">
          {items.slice(0, 3).map((m) => (
            <li key={m.id} className="py-2">
              <a
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="line-clamp-2 text-[13px] hover:underline"
              >
                <span className="font-semibold">
                  {m.platform === "reddit"
                    ? `r/${m.subreddit ?? "reddit"}`
                    : `@${m.author.username ?? m.author.name ?? "someone"}`}
                </span>{" "}
                {m.text}
              </a>
              <div className="mt-0.5 text-xs text-muted">
                {m.platform === "x" ? "X" : "Reddit"} · {timeAgo(m.timestamp)}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">No mentions yet. New ones appear after each sync.</p>
      )}
    </HubCard>
  );
}

function KeywordsCard({
  siteId,
  range,
  currency,
  onHide,
}: {
  siteId: string;
  range: Range;
  currency: string;
  onHide: () => void;
}) {
  const status = useQuery({
    queryKey: ["gsc-status", siteId],
    queryFn: () =>
      apiGet<SearchConsoleStatus>("/api/v1/search-console/status", {
        websiteId: siteId,
        properties: 0,
      }),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const connected = status.data?.connected === true;
  const rows = useQuery({
    queryKey: ["hub-keywords", siteId, range],
    queryFn: () =>
      apiGet<Array<Record<string, unknown>>>("/api/v1/search-console", {
        websiteId: siteId,
        ...range,
        groupBy: "query",
        limit: 5,
      }),
    enabled: connected,
    retry: false,
  });
  const icon = (
    <span aria-hidden="true" className="grid size-3.5 place-items-center rounded-sm bg-[#4285F4]" />
  );
  if (status.isPending)
    return (
      <HubCard id="keywords" title="Search keywords" icon={icon}>
        <Skeleton className="h-32" />
      </HubCard>
    );
  if (!connected) {
    const url = status.data?.connectUrl;
    return (
      <HubCard id="keywords" title="Search keywords" icon={icon}>
        <SetupBody
          heading="See which searches bring paying customers"
          text="Connect Google Search Console to see keywords, clicks and the revenue each one brings."
          action={
            url ? (
              <a href={url} className={ACTION}>
                <span aria-hidden="true">+</span>Connect Search Console
              </a>
            ) : (
              <ActionLink to="/app/$siteId/search-console" siteId={siteId}>
                Set up Search Console
              </ActionLink>
            )
          }
          onHide={onHide}
        />
      </HubCard>
    );
  }
  const list = rows.data ?? [];
  return (
    <HubCard
      id="keywords"
      title="Search keywords"
      icon={icon}
      open={{ to: "/app/$siteId/search-console", siteId }}
    >
      {rows.isPending ? (
        <Skeleton className="h-32" />
      ) : list.length ? (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-1 font-normal">Keyword</th>
              <th className="pb-1 text-right font-normal">Clicks</th>
              <th className="pb-1 text-right font-normal">Est. revenue</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={String(r.query)}>
                <td className="max-w-0 truncate py-1 pr-2">{String(r.query)}</td>
                <td className="py-1 text-right tabular-nums">
                  {formatNumber(Number(r.clicks ?? 0))}
                </td>
                <td className="py-1 text-right tabular-nums text-primary-text">
                  {formatMoney(Number(r.estimatedRevenue ?? 0), currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-[13px] text-muted">No search data for this period yet.</p>
      )}
    </HubCard>
  );
}

function CrawlersCard({
  siteId,
  range,
  onHide,
}: {
  siteId: string;
  range: Range;
  onHide: () => void;
}) {
  const params = { websiteId: siteId, ...range };
  const summary = useQuery({
    queryKey: ["bot-traffic", siteId, "summary", params],
    queryFn: async () =>
      (await apiGet<BotTrafficSummary[]>("/api/v1/analytics/bot-traffic", params))[0],
    retry: false,
  });
  const icon = (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 2v3M6 9h.01M10 9h.01" />
    </svg>
  );
  if (summary.isPending)
    return (
      <HubCard id="crawlers" title="AI crawlers and bots" icon={icon}>
        <Skeleton className="h-32" />
      </HubCard>
    );
  const s = summary.data;
  if (!s || s.totalRequests === 0)
    return (
      <HubCard id="crawlers" title="AI crawlers and bots" icon={icon}>
        <SetupBody
          heading="Track ChatGPT, Claude and Perplexity reading your site"
          text="Add a small server snippet to count AI answer, search and training crawlers. Browsers never see it."
          action={
            <ActionLink to="/app/$siteId/bot-traffic" siteId={siteId}>
              Set up bot tracking
            </ActionLink>
          }
          onHide={onHide}
        />
      </HubCard>
    );
  return (
    <HubCard
      id="crawlers"
      title="AI crawlers and bots"
      icon={icon}
      open={{ to: "/app/$siteId/bot-traffic", siteId }}
    >
      <div className="grid grid-cols-3 gap-3">
        <Stat label="AI answers" value={formatNumber(s.aiAnswerRequests)} />
        <Stat label="Indexing" value={formatNumber(s.indexingRequests)} />
        <Stat label="Training" value={formatNumber(s.trainingRequests)} />
      </div>
      <ul className="mt-3 divide-y divide-line text-[13px]">
        {s.companies.slice(0, 3).map((c) => (
          <li key={c.company} className="flex justify-between py-1.5">
            <span className="truncate">{c.company}</span>
            <span className="tabular-nums text-muted">{formatNumber(c.requestCount)}</span>
          </li>
        ))}
      </ul>
    </HubCard>
  );
}

function AdsCard({ siteId, range, onHide }: { siteId: string; range: Range; onHide: () => void }) {
  const ads = useAdsSummary(siteId, range);
  const icon = (
    <span aria-hidden="true" className="grid size-3.5 place-items-center rounded-sm bg-[#0866FF]" />
  );
  if (ads.isPending)
    return (
      <HubCard id="ads" title="Meta Ads" icon={icon}>
        <Skeleton className="h-32" />
      </HubCard>
    );
  const a = ads.data && ads.data.campaigns > 0 ? ads.data : null;
  if (!a)
    return (
      <HubCard id="ads" title="Meta Ads" icon={icon}>
        <SetupBody
          heading="See what your ads really return"
          text="Connect Meta Ads to compare spend with the revenue each campaign brings."
          action={
            <ActionLink to="/app/$siteId/integrations" siteId={siteId} hash="integration-meta_ads">
              Connect Meta Ads
            </ActionLink>
          }
          onHide={onHide}
        />
      </HubCard>
    );
  return (
    <HubCard id="ads" title="Meta Ads" icon={icon} open={{ to: "/app/$siteId/ads", siteId }}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Spend" value={formatMoney(a.spend, a.currency)} />
        <Stat label="Revenue" value={formatMoney(a.revenue, a.currency)} />
        <Stat label="Return" value={a.roas === null ? "–" : `${a.roas.toFixed(2)}×`} />
        <Stat
          label="Clicks"
          value={formatNumber(a.clicks)}
          sub={`${formatNumber(a.campaigns)} ${a.campaigns === 1 ? "campaign" : "campaigns"}`}
        />
      </div>
    </HubCard>
  );
}

function AddCard({
  hidden,
  onShow,
}: {
  hidden: HideableCard[];
  onShow: (c: HideableCard) => void;
}) {
  return (
    <section
      aria-label="Add card"
      data-testid="hub-add"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong p-6 text-center"
    >
      <p className="text-sm font-semibold">Add a card</p>
      <p className="text-[13px] text-muted">Bring back a card you hid.</p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {hidden.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onShow(c)}
            className="rounded-lg border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-surface-2"
          >
            + {HIDEABLE[c]}
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

export function OverviewHub({
  siteId,
  range,
  money,
  currency,
  points,
  revenueColor,
  goals,
  heatmap,
}: {
  siteId: string;
  range: Range;
  money: boolean;
  currency: string;
  points: TimeseriesPoint[];
  revenueColor: string;
  goals: ReactNode;
  heatmap: ReactNode;
}) {
  const { hidden, hide, show } = useHidden(siteId);
  const on = (c: HideableCard) => !hidden.includes(c);
  const growth: Array<[HideableCard, ReactNode]> = [
    ["mentions", <MentionsCard key="m" siteId={siteId} onHide={() => hide("mentions")} />],
    [
      "keywords",
      <KeywordsCard
        key="k"
        siteId={siteId}
        range={range}
        currency={currency}
        onHide={() => hide("keywords")}
      />,
    ],
    [
      "crawlers",
      <CrawlersCard key="c" siteId={siteId} range={range} onHide={() => hide("crawlers")} />,
    ],
    ...(money
      ? ([
          ["ads", <AdsCard key="a" siteId={siteId} range={range} onHide={() => hide("ads")} />],
        ] as Array<[HideableCard, ReactNode]>)
      : []),
  ];
  const shown = growth.filter(([c]) => on(c));
  return (
    <div className="space-y-4">
      <SectionTitle>Conversions</SectionTitle>
      <div className="grid gap-4 lg:grid-cols-2">
        {on("funnel") ? (
          <WhenVisible>
            <FunnelCard siteId={siteId} range={range} onHide={() => hide("funnel")} />
          </WhenVisible>
        ) : null}
        <div className={cx("min-w-0", on("funnel") ? "" : "lg:col-span-2")}>{goals}</div>
      </div>
      {heatmap}

      <SectionTitle>{money ? "Live and revenue" : "Live"}</SectionTitle>
      <div className="grid gap-4 lg:grid-cols-3">
        {money && on("revenue") ? (
          <WhenVisible>
            <RevenueCard
              siteId={siteId}
              range={range}
              points={points}
              revenueColor={revenueColor}
              onHide={() => hide("revenue")}
            />
          </WhenVisible>
        ) : null}
        <WhenVisible>
          <RealtimeCard siteId={siteId} wide={!(money && on("revenue"))} />
        </WhenVisible>
      </div>

      <SectionTitle>Growth</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        {shown.map(([c, node]) => (
          <WhenVisible key={c}>{node}</WhenVisible>
        ))}
        {hidden.length ? <AddCard hidden={hidden} onShow={show} /> : null}
      </div>
    </div>
  );
}
