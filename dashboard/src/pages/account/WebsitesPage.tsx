/**
 * All websites (DataFast's main dashboard): every website with its visitors, revenue, live
 * visitors and a trend for the last 24 hours, 7 days or 30 days, in the user's own order.
 * Reorder by dragging a card or with its Move buttons (`PUT /api/v1/admin/account/website-order`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type {
  Me,
  Overview,
  TimeseriesPoint,
  WebsiteOrderRequest,
  WebsiteSummary,
} from "../../../../shared/api-types";
import { Sparkline } from "../../analytics/components/Sparkline";
import { formatMoney, formatNumber } from "../../analytics/lib/format";
import { readPref, writePref } from "../../analytics/lib/storage";
import { api, apiGet } from "../../api/client";
import { queryKeys, useMe } from "../../api/hooks";
import { Button, cx, Notice } from "../../components/ui";

type Period = "24h" | "7d" | "30d";
const PERIODS: Array<[Period, string]> = [
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
];
const HOUR = 3_600_000;

function rangeOf(period: Period, now: number) {
  const hours = period === "24h" ? 24 : period === "7d" ? 7 * 24 : 30 * 24;
  // Whole hours, so cached responses are reused for a while.
  const end = Math.ceil(now / HOUR) * HOUR;
  return {
    startAt: new Date(end - hours * HOUR).toISOString(),
    endAt: new Date(end).toISOString(),
    interval: period === "24h" ? "hour" : "day",
  };
}

function SiteCard({
  site,
  period,
  index,
  count,
  onMove,
  dragging,
  onDragStart,
  onDropOn,
}: {
  site: WebsiteSummary;
  period: Period;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  dragging: boolean;
  onDragStart: () => void;
  onDropOn: () => void;
}) {
  const range = rangeOf(period, Date.now());
  const base = { websiteId: site._id, startAt: range.startAt, endAt: range.endAt };
  const overview = useQuery({
    queryKey: ["websites-dashboard", site._id, period, "overview"],
    queryFn: () => apiGet<Overview[]>("/api/v1/analytics/overview", base),
    staleTime: 60_000,
  });
  const series = useQuery({
    queryKey: ["websites-dashboard", site._id, period, "series"],
    queryFn: () =>
      apiGet<TimeseriesPoint[]>("/api/v1/analytics/timeseries", {
        ...base,
        fields: "visitors,revenue",
        interval: range.interval,
      }),
    staleTime: 60_000,
  });
  const live = useQuery({
    queryKey: ["websites-dashboard", site._id, "live"],
    queryFn: () =>
      apiGet<Array<{ visitors: number }>>("/api/v1/analytics/realtime", {
        websiteId: site._id,
      }),
    refetchInterval: 60_000,
  });
  const o = overview.data?.[0];
  const label = site.name ?? site.domain;
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropOn();
      }}
      className={cx(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4",
        dragging && "opacity-50",
      )}
      data-testid={`website-${site.domain}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to="/app/$siteId/overview"
            params={{ siteId: site._id }}
            className="block truncate font-semibold hover:underline"
          >
            {label}
          </Link>
          {site.name ? <div className="truncate text-xs text-muted">{site.domain}</div> : null}
        </div>
        <span className="shrink-0 cursor-grab select-none text-muted" aria-hidden="true">
          ⠿
        </span>
      </div>
      {overview.error ? (
        <Notice tone="error">{overview.error.message}</Notice>
      ) : (
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-xs text-muted">Visitors</dt>
            <dd className="font-semibold tabular-nums">{o ? formatNumber(o.visitors) : "…"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Revenue</dt>
            <dd className="font-semibold tabular-nums text-primary-text">
              {o ? formatMoney(o.revenue ?? 0, o.currency ?? site.currency) : "…"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Now</dt>
            <dd className="font-semibold tabular-nums">
              {live.data ? formatNumber(live.data[0]?.visitors ?? 0) : "…"}
            </dd>
          </div>
        </dl>
      )}
      <div className="text-visitors">
        <Sparkline
          values={(series.data ?? []).map((p) => p.visitors ?? 0)}
          color="var(--dg-secondary)"
          width={240}
          height={36}
        />
      </div>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          className="px-2 py-1 text-xs"
          disabled={index === 0}
          aria-label={`Move ${label} up`}
          onClick={() => onMove(index, index - 1)}
        >
          ↑ Move up
        </Button>
        <Button
          variant="ghost"
          className="px-2 py-1 text-xs"
          disabled={index === count - 1}
          aria-label={`Move ${label} down`}
          onClick={() => onMove(index, index + 1)}
        >
          ↓ Move down
        </Button>
      </div>
    </li>
  );
}

export default function WebsitesPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [period, setPeriodState] = useState<Period>(() =>
    readPref<Period>("websites-period", "24h"),
  );
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: async (ids: string[]) =>
      (
        await api.put<WebsiteSummary[]>("/api/v1/admin/account/website-order", {
          websiteIds: ids,
        } satisfies WebsiteOrderRequest)
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.websites });
    },
  });
  const websites = me.data?.websites ?? [];
  const setPeriod = (p: Period) => {
    setPeriodState(p);
    writePref("websites-period", p);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= websites.length || from === to) return;
    const next = [...websites];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    // Optimistic: the switcher and this page reorder at once.
    qc.setQueryData<Me | null>(queryKeys.me, (old) => (old ? { ...old, websites: next } : old));
    save.mutate(next.map((w) => w._id));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Websites</h1>
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="flex rounded-md border border-line p-0.5" aria-label="Period">
            {PERIODS.map(([key, text]) => (
              <button
                key={key}
                type="button"
                aria-pressed={period === key}
                onClick={() => setPeriod(key)}
                className={cx(
                  "rounded px-2.5 py-1 text-sm",
                  period === key ? "bg-selected font-medium text-text" : "text-muted",
                )}
              >
                {text}
              </button>
            ))}
          </fieldset>
          <Link
            to="/app/new-site"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg"
          >
            Add website
          </Link>
        </div>
      </div>
      {save.error ? <Notice tone="error">{save.error.message}</Notice> : null}
      {websites.length ? (
        <ul aria-label="Websites" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {websites.map((site, i) => (
            <SiteCard
              key={site._id}
              site={site}
              period={period}
              index={i}
              count={websites.length}
              onMove={move}
              dragging={dragFrom === i}
              onDragStart={() => setDragFrom(i)}
              onDropOn={() => {
                if (dragFrom !== null) move(dragFrom, i);
                setDragFrom(null);
              }}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No websites yet.</p>
      )}
      <p className="text-xs text-muted">
        Drag a card, or use its Move buttons, to change the order. The order is saved to your
        account and used by the website switcher too.
      </p>
    </div>
  );
}
