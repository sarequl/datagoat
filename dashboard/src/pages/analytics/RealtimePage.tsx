/**
 * Realtime (DataFast's "Visitors now" map): live count, active visitors, event log and recent
 * payments; a 2D map or a lazily loaded 3D globe in the dashboard theme, with auto-rotation,
 * country/device/browser filters, purchase-likelihood colours and an 8-hour replay in
 * 15-minute steps.
 */
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { RealtimeMap, RealtimeVisitor } from "../../../../shared/api-types";
import {
  Badge,
  EmptyState,
  ErrorState,
  Segmented,
  Skeleton,
  Tabs,
} from "../../analytics/components/primitives";
import type { MapMarker } from "../../analytics/components/WorldMap";
import { useRealtimeMap, useRealtimeReplay } from "../../analytics/hooks";
import { likelihoodColor, likelihoodLabel } from "../../analytics/lib/colors";
import {
  countryName,
  flagEmoji,
  formatMoney,
  formatNumber,
  formatSpan,
  formatTime,
  timeAgo,
} from "../../analytics/lib/format";
import { MAP_STYLES, type MapStyle } from "../../analytics/lib/mapStyles";
import { initials, visitorName } from "../../analytics/lib/names";
import { readPref, writePref } from "../../analytics/lib/storage";
import { SiteAnalytics } from "../../analytics/SiteAnalytics";
import { useResolvedTheme } from "../../components/ThemeToggle";
import { cx } from "../../components/ui";

const MarkerMap = lazy(() =>
  import("../../analytics/components/WorldMap").then((m) => ({ default: m.MarkerMap })),
);
const Globe = lazy(() => import("../../analytics/components/Globe"));

type View = "globe" | "map";
type LiveFilter = { key: "country" | "device" | "browser"; value: string };

function vName(v: RealtimeVisitor) {
  return (
    v.customerName || visitorName(v.visitorId, v.profileData.displayName, v.profileData.userId)
  );
}

function score(v: RealtimeVisitor, predictions: boolean): number | null {
  if (v.isCustomer) return 100;
  if (!predictions) return null;
  return v.conversionLikelihood?.score ?? null;
}

function matches(v: RealtimeVisitor, f: LiveFilter): boolean {
  if (f.key === "country") return v.location.countryCode === f.value;
  if (f.key === "device") return v.system.device?.type === f.value;
  return v.system.browser?.name === f.value;
}

function top(values: Array<string | null | undefined>, n = 5): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function Avatar({ v, predictions }: { v: RealtimeVisitor; predictions: boolean }) {
  const s = score(v, predictions);
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-[#171717]"
      style={{ background: likelihoodColor(s) }}
    >
      {initials(vName(v))}
    </span>
  );
}

function Legend({ predictions }: { predictions: boolean }) {
  if (!predictions) {
    return (
      <p className="text-xs text-muted">
        Purchase predictions unlock after 1,000 visitors and 10 attributed payments.
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span>Cold</span>
      <span
        aria-hidden="true"
        className="h-2 w-24 rounded-full"
        style={{
          background: `linear-gradient(90deg, ${likelihoodColor(0)}, ${likelihoodColor(50)}, ${likelihoodColor(100)})`,
        }}
      />
      <span>Likely to buy</span>
    </div>
  );
}

function VisitorDetail({
  v,
  siteId,
  predictions,
  timezone,
  currency,
  onClose,
}: {
  v: RealtimeVisitor;
  /** Null on a public share link: no journeys there. */
  siteId: string | null;
  predictions: boolean;
  timezone: string;
  currency: string;
  onClose: () => void;
}) {
  const s = score(v, predictions);
  const params = Object.entries(v.params).filter(([, val]) => val);
  return (
    <section
      aria-label={`Visitor ${vName(v)}`}
      className="space-y-3 rounded-lg border border-line bg-surface p-4 text-sm"
      data-testid="visitor-detail"
    >
      <div className="flex items-start gap-3">
        <Avatar v={v} predictions={predictions} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {vName(v)}
            {v.isCustomer ? <Badge tone="success">Customer</Badge> : null}
          </div>
          <div className="text-xs text-muted">
            {flagEmoji(v.location.countryCode)}{" "}
            {[v.location.city, v.location.region, countryName(v.location.countryCode)]
              .filter(Boolean)
              .join(", ")}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close visitor details"
          className="rounded p-1 text-muted hover:bg-surface-2"
        >
          ✕
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted">Current page</dt>
        <dd className="truncate">{v.currentUrl ?? "–"}</dd>
        <dt className="text-muted">Referrer</dt>
        <dd>{v.referrer ?? "Direct / None"}</dd>
        <dt className="text-muted">Device</dt>
        <dd>
          {[v.system.device?.type, v.system.browser?.name, v.system.os?.name]
            .filter(Boolean)
            .join(" · ")}
        </dd>
        <dt className="text-muted">Session</dt>
        <dd>
          {v.sessionStartTime ? formatSpan(Date.now() - Date.parse(v.sessionStartTime)) : "–"}{" "}
          (since {v.sessionStartTime ? formatTime(v.sessionStartTime, timezone) : "–"})
        </dd>
        <dt className="text-muted">Visit</dt>
        <dd>#{v.visitCount}</dd>
        {v.customerEmail ? (
          <>
            <dt className="text-muted">Email</dt>
            <dd className="truncate">{v.customerEmail}</dd>
          </>
        ) : null}
        {params.map(([k, val]) => (
          <span key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="truncate">{val}</dd>
          </span>
        ))}
      </dl>
      {s !== null ? (
        <div className="rounded-md border border-line p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">Purchase likelihood</span>
            <span className="font-medium" style={{ color: likelihoodColor(s) }}>
              {s}/100 · {v.isCustomer ? "Customer" : likelihoodLabel(s)}
            </span>
          </div>
          {v.conversionLikelihood?.raw ? (
            <p className="mt-1 text-xs text-muted">
              {(v.conversionLikelihood.raw.conversionRate * 100).toFixed(1)}% conversion · expected
              value{" "}
              {formatMoney(v.conversionLikelihood.raw.expectedValue, currency, { cents: true })}
              {v.conversionLikelihood.confidence
                ? ` · ${Math.round(v.conversionLikelihood.confidence * 100)}% confidence`
                : ""}
            </p>
          ) : null}
          {v.conversionLikelihood?.dimensionMatches?.length ? (
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {v.conversionLikelihood.dimensionMatches.map((d) => (
                <li key={`${d.dimension}${d.value}`}>
                  {d.dimension}: {d.value} converts at {(d.conversionRate * 100).toFixed(1)}%
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {siteId ? (
        <Link
          to="/app/$siteId/visitors/$visitorId"
          params={{ siteId, visitorId: v.visitorId }}
          className="inline-block text-sm text-primary-text hover:underline"
        >
          Open visitor journey →
        </Link>
      ) : null}
    </section>
  );
}

function EventLog({
  data,
  selected,
  timezone,
  currency,
  onSelect,
}: {
  data: RealtimeMap;
  selected: string | null;
  timezone: string;
  currency: string;
  onSelect: (id: string) => void;
}) {
  const events = data.recentEvents.filter((e) => !selected || e.visitorId === selected);
  if (!events.length) return <EmptyState>No events yet.</EmptyState>;
  return (
    <ol className="space-y-1" aria-label="Recent events">
      {events.map((e) => {
        const goal = typeof e.extraData.eventName === "string" ? e.extraData.eventName : null;
        const who = e.displayName || e.customerName || visitorName(e.visitorId);
        return (
          <li key={e._id}>
            <button
              type="button"
              onClick={() => onSelect(e.visitorId)}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
            >
              <span aria-hidden="true">{e.type === "payment" ? "💰" : goal ? "🎯" : "👀"}</span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{who}</span>{" "}
                <span className="text-muted">
                  {goal
                    ? `completed ${goal}`
                    : e.amount
                      ? `paid ${formatMoney(e.amount, currency)}`
                      : "viewed"}
                </span>{" "}
                <span className="break-all">{e.path}</span>
                <span className="block text-xs text-muted">
                  {flagEmoji(e.countryCode)} {formatTime(e.timestamp, timezone)}
                  {e.referrer ? ` · from ${e.referrer}` : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The live view. Signed in it reads `/api/v1/analytics/realtime/*`; on a public share link
 * (`share`) it reads `/api/share/:token/analytics/realtime/*` (no PII, no journeys, payments only
 * when the owner shares revenue).
 */
export function RealtimeView({
  siteId,
  timezone,
  currency,
  share,
}: {
  siteId: string | null;
  timezone: string;
  currency: string;
  share?: { token: string; showRevenue: boolean };
}) {
  const map = useRealtimeMap(siteId ?? "", 15_000, share?.token);
  const [view, setView] = useState<View>(() => readPref<View>("realtime:view", "globe"));
  // The map and globe follow the dashboard's light or dark theme.
  const style: MapStyle = useResolvedTheme();
  const [autoRotate, setAutoRotate] = useState(true);
  const [replay, setReplay] = useState(false);
  const [frame, setFrame] = useState(31);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<LiveFilter[]>([]);
  const [tab, setTab] = useState("visitors");
  const replayQ = useRealtimeReplay(siteId ?? "", replay, share?.token);
  const frames = replayQ.data?.frames ?? [];

  useEffect(() => writePref("realtime:view", view), [view]);
  useEffect(() => {
    if (!playing || !frames.length) return;
    const id = setInterval(() => {
      setFrame((f) => {
        if (f >= frames.length - 1) {
          setPlaying(false);
          return f;
        }
        return f + 1;
      });
    }, 700);
    return () => clearInterval(id);
  }, [playing, frames.length]);

  const data = map.data;
  const predictions = Boolean(data?.hasConversionPredictions);
  const visitors = useMemo(
    () => (data?.visitors ?? []).filter((v) => filters.every((f) => matches(v, f))),
    [data, filters],
  );
  const selectedVisitor = visitors.find((v) => v.visitorId === selected) ?? null;
  const markers: MapMarker[] = useMemo(() => {
    if (replay) {
      const fr = frames[Math.min(frame, frames.length - 1)];
      return (fr?.visitors ?? [])
        .filter((v) => v.latitude !== null && v.longitude !== null)
        .map((v) => ({
          id: v.visitorId,
          lat: v.latitude as number,
          lng: v.longitude as number,
          color: likelihoodColor(v.isCustomer ? 100 : predictions ? v.conversionScore : null),
          label: `${v.city ?? countryName(v.countryCode)} visitor`,
        }));
    }
    return visitors
      .filter((v) => v.latitude !== null && v.longitude !== null)
      .map((v) => ({
        id: v.visitorId,
        lat: v.latitude as number,
        lng: v.longitude as number,
        color: likelihoodColor(score(v, predictions)),
        label: `${vName(v)} in ${v.location.city ?? countryName(v.location.countryCode)}, on ${v.currentUrl ?? "/"}`,
        size: v.isCustomer ? 1.3 : 1,
      }));
  }, [replay, frames, frame, visitors, predictions]);

  const focus =
    selectedVisitor?.latitude != null && selectedVisitor.longitude != null
      ? { lat: selectedVisitor.latitude, lng: selectedVisitor.longitude }
      : null;

  const toggleFilter = (f: LiveFilter) =>
    setFilters((prev) =>
      prev.some((x) => x.key === f.key && x.value === f.value)
        ? prev.filter((x) => !(x.key === f.key && x.value === f.value))
        : [...prev.filter((x) => x.key !== f.key), f],
    );

  const summary = data
    ? {
        referrers: top(data.visitors.map((v) => v.referrer ?? "Direct / None")),
        countries: top(data.visitors.map((v) => v.location.countryCode)),
        devices: top(data.visitors.map((v) => v.system.device?.type)),
        browsers: top(data.visitors.map((v) => v.system.browser?.name)),
      }
    : null;

  const currentFrame = frames[Math.min(frame, frames.length - 1)];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-3 text-xl font-semibold">
          Realtime
          <span
            className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-sm font-medium"
            role="status"
            aria-live="polite"
            data-testid="live-count"
          >
            <span className="size-2 animate-pulse rounded-full bg-success" aria-hidden="true" />
            {data
              ? `${formatNumber(data.count)} ${data.count === 1 ? "visitor" : "visitors"} online`
              : "Connecting…"}
          </span>
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<View>
            label="Map view"
            value={view}
            onChange={setView}
            options={[
              { value: "globe", label: "3D globe" },
              { value: "map", label: "2D map" },
            ]}
          />
          {view === "globe" ? (
            <button
              type="button"
              aria-pressed={autoRotate}
              onClick={() => setAutoRotate((v) => !v)}
              className={cx(
                "rounded-md border px-2 py-1 text-xs",
                autoRotate ? "border-primary text-primary-text" : "border-line text-muted",
              )}
            >
              Auto-rotate
            </button>
          ) : null}
          <button
            type="button"
            aria-pressed={replay}
            onClick={() => {
              setReplay((r) => !r);
              setPlaying(false);
              setFrame(0);
            }}
            className={cx(
              "rounded-md border px-2 py-1 text-xs",
              replay
                ? "border-primary text-primary-text"
                : "border-line text-muted hover:text-text",
            )}
          >
            Replay
          </button>
        </div>
      </div>

      {map.error ? <ErrorState error={map.error} /> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div
          data-theme={MAP_STYLES[style].dark ? "dark" : "light"}
          className="relative min-w-0 overflow-hidden rounded-lg border border-line p-3 text-text"
          style={{ background: MAP_STYLES[style].ocean }}
        >
          {summary ? (
            // A strip above the globe or map, never over it: a floating panel would hide part of
            // the globe and the visitors under it.
            <div
              data-testid="realtime-summary"
              className="relative z-10 mb-3 flex flex-wrap gap-x-6 gap-y-2 rounded-md bg-surface p-2 text-xs"
            >
              {(
                [
                  ["Countries", "country", summary.countries],
                  ["Devices", "device", summary.devices],
                  ["Browsers", "browser", summary.browsers],
                ] as const
              ).map(([label, key, items]) => (
                <div key={key} className="min-w-0">
                  <div className="mb-0.5 font-medium text-muted">{label}</div>
                  <div className="flex flex-wrap gap-1">
                    {items.map(([value, n]) => {
                      const on = filters.some((f) => f.key === key && f.value === value);
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleFilter({ key, value })}
                          className={cx(
                            "rounded-full border px-2 py-0.5",
                            on
                              ? "border-primary text-primary-text"
                              : "border-line text-text hover:bg-surface-2",
                          )}
                        >
                          {key === "country" ? `${flagEmoji(value)} ${value}` : value} {n}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="min-w-0">
                <div className="mb-0.5 font-medium text-muted">Top referrers</div>
                <ul className="flex flex-wrap gap-1">
                  {summary.referrers.map(([r, n]) => (
                    <li key={r} className="rounded-full border border-line px-2 py-0.5">
                      {r} <span className="tabular-nums text-muted">{n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          <Suspense fallback={<Skeleton className="h-80" />}>
            {view === "globe" ? (
              <Globe
                markers={markers}
                style={style}
                autoRotate={autoRotate && !selected}
                focus={focus}
                selectedId={selected}
                onSelect={setSelected}
              />
            ) : (
              <MarkerMap
                markers={markers}
                style={style}
                selectedId={selected}
                onSelect={setSelected}
              />
            )}
          </Suspense>
          {replay ? (
            <div className="relative z-10 mt-3 rounded-md bg-surface/95 p-3 text-sm">
              {replayQ.isPending ? (
                <span className="text-muted">Loading the last 8 hours…</span>
              ) : replayQ.error ? (
                <ErrorState error={replayQ.error} />
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (frame >= frames.length - 1) setFrame(0);
                      setPlaying((p) => !p);
                    }}
                    className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-fg"
                  >
                    {playing ? "Pause" : "Play"}
                  </button>
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="sr-only">Replay time</span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, frames.length - 1)}
                      value={Math.min(frame, frames.length - 1)}
                      onChange={(e) => {
                        setPlaying(false);
                        setFrame(Number(e.target.value));
                      }}
                      aria-valuetext={
                        currentFrame ? formatTime(currentFrame.at, timezone) : undefined
                      }
                      className="min-w-0 flex-1 accent-[var(--dg-primary)]"
                    />
                  </label>
                  <span className="text-xs tabular-nums" data-testid="replay-time">
                    {currentFrame
                      ? `${formatTime(currentFrame.at, timezone)} · ${currentFrame.visitors.length} visitors · ${currentFrame.pageviews} pageviews${currentFrame.payments ? ` · ${currentFrame.payments} payment` : ""}`
                      : ""}
                  </span>
                </div>
              )}
            </div>
          ) : null}
          <div className="relative z-10 mt-2 flex justify-end">
            <div className="rounded-md bg-surface/90 px-2 py-1">
              <Legend predictions={predictions} />
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          {filters.length ? (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              {filters.map((f) => (
                <button
                  key={`${f.key}${f.value}`}
                  type="button"
                  onClick={() => toggleFilter(f)}
                  className="rounded-full border border-primary/40 px-2 py-0.5"
                >
                  {f.key} is {f.value} ✕
                </button>
              ))}
            </div>
          ) : null}
          {selectedVisitor ? (
            <VisitorDetail
              v={selectedVisitor}
              siteId={siteId}
              predictions={predictions}
              timezone={timezone}
              currency={currency}
              onClose={() => setSelected(null)}
            />
          ) : null}
          <section className="rounded-lg border border-line bg-surface p-3">
            <Tabs
              tabs={[
                { id: "visitors", label: `Visitors (${visitors.length})` },
                { id: "events", label: selected ? "Events (visitor)" : "Events" },
                ...(share && !share.showRevenue ? [] : [{ id: "payments", label: "Payments" }]),
              ]}
              value={tab}
              onChange={setTab}
              label="Live activity"
              idPrefix="live"
            />
            <div
              id="live-panel"
              role="tabpanel"
              aria-labelledby={`live-tab-${tab}`}
              className="mt-2 max-h-[34rem] overflow-y-auto"
            >
              {!data ? (
                <Skeleton className="h-60" />
              ) : tab === "visitors" ? (
                visitors.length ? (
                  <ul className="space-y-1" aria-label="Active visitors">
                    {visitors.map((v) => (
                      <li key={v.visitorId}>
                        <button
                          type="button"
                          aria-pressed={v.visitorId === selected}
                          onClick={() => setSelected(v.visitorId === selected ? null : v.visitorId)}
                          className={cx(
                            "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-surface-2",
                            v.visitorId === selected && "bg-surface-2",
                          )}
                        >
                          <Avatar v={v} predictions={predictions} />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5 font-medium">
                              <span className="truncate">{vName(v)}</span>
                              {v.isCustomer ? <Badge tone="success">Customer</Badge> : null}
                            </span>
                            <span className="block truncate text-xs text-muted">
                              {flagEmoji(v.location.countryCode)}{" "}
                              {v.location.city ?? countryName(v.location.countryCode)} ·{" "}
                              {v.currentUrl}
                            </span>
                            <span className="block truncate text-xs text-muted">
                              {v.referrer ?? "Direct / None"} · {v.system.device?.type} ·{" "}
                              {v.system.browser?.name} · visit #{v.visitCount}
                            </span>
                          </span>
                          {score(v, predictions) !== null && !v.isCustomer ? (
                            <span
                              className="text-xs font-medium tabular-nums"
                              style={{ color: likelihoodColor(score(v, predictions)) }}
                            >
                              {score(v, predictions)}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState>No one is on the site right now.</EmptyState>
                )
              ) : tab === "events" ? (
                <EventLog
                  data={data}
                  selected={selected}
                  timezone={timezone}
                  currency={currency}
                  onSelect={setSelected}
                />
              ) : data.recentPayments.length ? (
                <ul className="space-y-1" aria-label="Recent payments">
                  {data.recentPayments.map((p) => (
                    <li
                      key={p._id}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {p.name ?? p.email ?? "Anonymous customer"}
                        </span>
                        <span className="text-xs text-muted">
                          {timeAgo(p.timestamp)}
                          {p.renewal ? " · renewal" : p.isNew ? " · new customer" : ""}
                        </span>
                      </span>
                      <span className="font-medium tabular-nums text-success-text">
                        +{formatMoney(p.amount, p.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState>No payments in the last 24 hours.</EmptyState>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function RealtimePage() {
  return (
    <SiteAnalytics>
      {(site) => (
        <RealtimeView siteId={site._id} timezone={site.timezone} currency={site.currency} />
      )}
    </SiteAnalytics>
  );
}
