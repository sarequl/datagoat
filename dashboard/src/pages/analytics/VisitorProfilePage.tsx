/**
 * Visitor profile: identity, acquisition, activity, purchase prediction, goals and payments, a
 * GitHub-style activity grid (blue = activity, orange = goal days; click a day to jump to it) and
 * the journey timeline across sessions, grouped by day with each day's source.
 */
import { useParams } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import type { VisitorProfile } from "../../../../shared/api-types";
import { Badge, ErrorState, Skeleton } from "../../analytics/components/primitives";
import { useVisitor } from "../../analytics/hooks";
import { likelihoodColor, likelihoodLabel } from "../../analytics/lib/colors";
import {
  flagEmoji,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatSpan,
  formatTime,
} from "../../analytics/lib/format";
import { initials, visitorName } from "../../analytics/lib/names";
import { addDays, diffDays, formatDay, weekdayOf, ymdInTz } from "../../analytics/lib/tz";
import { SiteAnalytics } from "../../analytics/SiteAnalytics";
import { BackLink, Card, cx } from "../../components/ui";

type TimelineItem =
  | {
      kind: "session";
      ts: number;
      channel: string;
      referrer: string | null;
      entryPath: string;
      pageviews: number;
      keywords?: Array<{ query: string; probability: number }>;
    }
  | { kind: "page"; ts: number; url: string }
  | { kind: "goal"; ts: number; name: string; origin: string }
  | {
      kind: "payment";
      ts: number;
      amount: number;
      currency: string;
      paymentKind: string;
      provider: string;
    };

function timeline(p: VisitorProfile): TimelineItem[] {
  const items: TimelineItem[] = [
    ...(p.sessions ?? []).map((s) => ({
      kind: "session" as const,
      ts: Date.parse(s.startedAt) - 1,
      channel: s.channel,
      referrer: s.referrer,
      entryPath: s.entryPath,
      pageviews: s.pageviews,
      keywords: s.searchKeywords,
    })),
    ...p.activity.visitedPages.map((v) => ({
      kind: "page" as const,
      ts: Date.parse(v.timestamp),
      url: v.url,
    })),
    ...p.activity.completedGoals
      .filter((g) => g.type !== "payment")
      .map((g) => ({
        kind: "goal" as const,
        ts: Date.parse(g.timestamp),
        name: g.name,
        origin: g.origin,
      })),
    ...(p.payments ?? []).map((x) => ({
      kind: "payment" as const,
      ts: Date.parse(x.timestamp),
      amount: x.amount,
      currency: x.currency,
      paymentKind: x.kind,
      provider: x.provider,
    })),
  ];
  return items.sort((a, b) => a.ts - b.ts);
}

function ActivityGrid({
  items,
  timezone,
  onPick,
}: {
  items: TimelineItem[];
  timezone: string;
  onPick: (day: string) => void;
}) {
  const today = ymdInTz(Date.now(), timezone);
  const counts = new Map<string, { n: number; goal: boolean }>();
  for (const it of items) {
    const d = ymdInTz(it.ts, timezone);
    const c = counts.get(d) ?? { n: 0, goal: false };
    c.n += it.kind === "session" ? 0 : 1;
    if (it.kind === "goal" || it.kind === "payment") c.goal = true;
    counts.set(d, c);
  }
  const first = items.length ? ymdInTz(items[0]?.ts ?? Date.now(), timezone) : today;
  const span = Math.min(26 * 7, Math.max(8 * 7, diffDays(first, today) + 1));
  let start = addDays(today, -(span - 1));
  start = addDays(start, -weekdayOf(start));
  const weeks: string[][] = [];
  for (let d = start; d <= today; d = addDays(d, 1)) {
    if (weekdayOf(d) === 0) weeks.push([]);
    weeks[weeks.length - 1]?.push(d);
  }
  const max = Math.max(1, ...[...counts.values()].map((c) => c.n));
  return (
    <div className="relative overflow-x-auto">
      {/* biome-ignore lint/a11y/useSemanticElements: a grid of day cells, not a form group */}
      <div className="flex gap-[3px]" role="group" aria-label="Activity by day">
        {weeks.map((w) => (
          <div key={w[0]} className="flex flex-col gap-[3px]">
            {w.map((d) => {
              const c = counts.get(d);
              const label = `${formatDay(d, true)}: ${c ? `${c.n} events${c.goal ? ", goal completed" : ""}` : "no activity"}`;
              const bg = !c
                ? "var(--dg-surface-2)"
                : c.goal
                  ? "var(--dg-primary)"
                  : `color-mix(in srgb, var(--dg-secondary) ${Math.round(30 + (c.n / max) * 70)}%, var(--dg-surface-2))`;
              return c ? (
                <button
                  key={d}
                  type="button"
                  title={label}
                  aria-label={`Jump to ${label}`}
                  onClick={() => onPick(d)}
                  className="size-3 rounded-[2px]"
                  style={{ background: bg }}
                />
              ) : (
                <span
                  key={d}
                  title={label}
                  className="size-3 rounded-[2px]"
                  style={{ background: bg }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs text-muted" aria-hidden="true">
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-[2px] bg-visitors" /> activity
        </span>
        <span className="flex items-center gap-1">
          <span className="size-3 rounded-[2px] bg-primary" /> goal or payment
        </span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  payment: "Payment",
  renewal: "Renewal",
  refund: "Refund",
  free_trial: "Free trial",
};

function Profile({
  siteId,
  visitorId,
  timezone,
}: {
  siteId: string;
  visitorId: string;
  timezone: string;
}) {
  const q = useVisitor(siteId, visitorId);
  const p = q.data;
  const items = useMemo(() => (p ? timeline(p) : []), [p]);
  const days = useMemo(() => {
    const groups: Array<{ day: string; items: TimelineItem[] }> = [];
    for (const it of items) {
      const day = ymdInTz(it.ts, timezone);
      const last = groups.at(-1);
      if (last?.day === day) last.items.push(it);
      else groups.push({ day, items: [it] });
    }
    return groups.reverse();
  }, [items, timezone]);

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.error || !p) return <ErrorState error={q.error ?? new Error("Visitor not found")} />;

  const name = visitorName(
    p.visitorId,
    (p.profile?.metadata.name as string | undefined) ?? null,
    p.profile?.userId,
  );
  const revenue = (p.payments ?? []).reduce((s, x) => s + x.amount, 0);
  const customer = (p.payments ?? []).some((x) => x.kind === "payment" || x.kind === "renewal");
  const firstDay = days.length ? (days.at(-1)?.day as string) : null;
  const params = Object.entries(p.identity.params).filter(([, v]) => v);
  const metadata = Object.entries(p.profile?.metadata ?? {});
  const currency = p.payments?.[0]?.currency ?? "USD";

  return (
    <div className="space-y-4">
      <BackLink to="/app/$siteId/visitors" params={{ siteId }}>
        Visitors
      </BackLink>
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full text-sm font-semibold text-[#171717]"
          style={{ background: likelihoodColor(customer ? 100 : (p.prediction?.score ?? null)) }}
        >
          {initials(name)}
        </span>
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {name}
            {customer ? (
              <Badge tone="success">Customer · {formatMoney(revenue, currency)}</Badge>
            ) : null}
            {p.activity.visitorType ? <Badge>{p.activity.visitorType}</Badge> : null}
          </h1>
          <p className="truncate font-mono text-xs text-muted">
            {p.profile?.userId ? `${p.profile.userId} · ` : ""}
            {p.visitorId}
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Identity">
          <dl>
            <Row label="Location">
              {flagEmoji(p.identity.countryCode)}{" "}
              {[p.identity.city, p.identity.region, p.identity.country].filter(Boolean).join(", ")}
            </Row>
            <Row label="Device">
              {[p.identity.device.type, p.identity.device.vendor, p.identity.device.model]
                .filter(Boolean)
                .join(" · ") || "–"}
            </Row>
            <Row label="Browser">
              {[p.identity.browser.name, p.identity.browser.version].filter(Boolean).join(" ")}
            </Row>
            <Row label="OS">
              {[p.identity.os.name, p.identity.os.version].filter(Boolean).join(" ")}
            </Row>
            {p.identity.viewport.width ? (
              <Row label="Viewport">
                {p.identity.viewport.width}×{p.identity.viewport.height}
              </Row>
            ) : null}
            {params.map(([k, v]) => (
              <Row key={k} label={k}>
                {v}
              </Row>
            ))}
            {Object.entries(p.identity.adClickIds).map(([k, v]) => (
              <Row key={k} label={k}>
                {v}
              </Row>
            ))}
          </dl>
        </Card>
        <Card title="Activity">
          <dl>
            <Row label="Visits">{formatNumber(p.activity.visitCount)}</Row>
            <Row label="Pageviews">{formatNumber(p.activity.pageViewCount)}</Row>
            <Row label="First seen">
              {p.activity.firstVisitAt ? formatDateTime(p.activity.firstVisitAt, timezone) : "–"}
            </Row>
            <Row label="Last seen">
              {p.activity.lastVisitAt ? formatDateTime(p.activity.lastVisitAt, timezone) : "–"}
            </Row>
            <Row label="Since first visit">{formatSpan(p.activity.timeSinceFirstVisit)}</Row>
            <Row label="Current page">{p.activity.currentUrl ?? "–"}</Row>
            <Row label="Goals completed">{formatNumber(p.activity.completedGoals.length)}</Row>
          </dl>
        </Card>
        <Card title={p.prediction ? "Purchase prediction" : "Customer"}>
          {p.prediction ? (
            <div className="space-y-2" data-testid="prediction">
              <div className="flex items-baseline gap-2">
                <span
                  className="text-3xl font-semibold tabular-nums"
                  style={{ color: likelihoodColor(p.prediction.score) }}
                >
                  {p.prediction.score}
                </span>
                <span className="text-sm text-muted">
                  / 100 · {likelihoodLabel(p.prediction.score)}
                </span>
              </div>
              <dl>
                <Row label="Conversion rate">{(p.prediction.conversionRate * 100).toFixed(1)}%</Row>
                <Row label="Expected value">
                  {formatMoney(p.prediction.expectedValue, currency, { cents: true })}
                </Row>
                <Row label="Confidence">{Math.round(p.prediction.confidence * 100)}%</Row>
              </dl>
            </div>
          ) : (
            <dl>
              <Row label="Lifetime revenue">{formatMoney(revenue, currency)}</Row>
              <Row label="Payments">{formatNumber((p.payments ?? []).length)}</Row>
              {p.profile ? (
                <Row label="Identified">{formatDate(p.profile.identifiedAt, timezone)}</Row>
              ) : null}
              {metadata.map(([k, v]) => (
                <Row key={k} label={k}>
                  {String(v)}
                </Row>
              ))}
              {!customer && !metadata.length ? (
                <p className="text-sm text-muted">
                  No prediction yet: predictions need 1,000 visitors and 10 attributed payments.
                </p>
              ) : null}
            </dl>
          )}
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Goals">
          {p.activity.completedGoals.length ? (
            <ul className="space-y-1 text-sm">
              {p.activity.completedGoals.map((g) => (
                <li key={`${g.name}${g.timestamp}`} className="flex justify-between gap-2">
                  <span>
                    🎯 {g.name}
                    {g.origin === "payment_provider" ? (
                      <span className="ml-1 text-xs text-muted">(payment provider)</span>
                    ) : null}
                  </span>
                  <span className="text-muted">{formatDateTime(g.timestamp, timezone)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No goals completed.</p>
          )}
        </Card>
        <Card title="Payments">
          {(p.payments ?? []).length ? (
            <ul className="space-y-1 text-sm">
              {(p.payments ?? []).map((x) => (
                <li key={x.id} className="flex justify-between gap-2">
                  <span>
                    {KIND_LABEL[x.kind] ?? x.kind}{" "}
                    <span className="text-xs text-muted">via {x.provider}</span>
                  </span>
                  <span
                    className={cx(
                      "tabular-nums",
                      x.amount < 0 ? "text-error-text" : "text-success-text",
                    )}
                  >
                    {formatMoney(x.amount, x.currency)} ·{" "}
                    <span className="text-muted">{formatDate(x.timestamp, timezone)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No payments.</p>
          )}
        </Card>
      </div>

      <Card title="Activity grid">
        <ActivityGrid
          items={items}
          timezone={timezone}
          onPick={(day) => {
            const el = document.getElementById(`journey-${day}`);
            el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
            el?.focus();
          }}
        />
      </Card>

      <Card title="Journey">
        <ol className="space-y-5" aria-label="Journey timeline">
          {days.map((d) => {
            const dayNo = firstDay ? diffDays(firstDay, d.day) + 1 : 1;
            const session = d.items.find((i) => i.kind === "session");
            return (
              <li key={d.day}>
                <h3
                  id={`journey-${d.day}`}
                  tabIndex={-1}
                  className="mb-2 flex flex-wrap items-baseline gap-2 text-sm font-semibold"
                >
                  Day {dayNo} · {formatDay(d.day, true)}
                  {session && session.kind === "session" ? (
                    <span className="text-xs font-normal text-muted">
                      via {session.referrer ?? session.channel}
                    </span>
                  ) : null}
                </h3>
                <ol className="space-y-1 border-l border-line pl-4">
                  {d.items.map((it, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: events can share timestamps
                    <li key={`${it.kind}${it.ts}${i}`} className="relative text-sm">
                      <span
                        aria-hidden="true"
                        className={cx(
                          "absolute -left-[21px] top-1.5 size-2.5 rounded-full",
                          it.kind === "goal"
                            ? "bg-primary"
                            : it.kind === "payment"
                              ? "bg-success"
                              : it.kind === "session"
                                ? "bg-accent"
                                : "bg-visitors",
                        )}
                      />
                      <span className="mr-2 text-xs tabular-nums text-muted">
                        {formatTime(it.ts, timezone)}
                      </span>
                      {it.kind === "session" ? (
                        <span>
                          New session from <strong>{it.referrer ?? "Direct / None"}</strong>{" "}
                          <span className="text-muted">
                            ({it.channel}, {it.pageviews} pages)
                          </span>
                          {it.keywords?.length ? (
                            <span
                              className="block text-xs text-muted"
                              data-testid="search-keywords"
                            >
                              Likely searched:{" "}
                              {it.keywords.map((k, i) => (
                                <span key={k.query}>
                                  {i ? ", " : ""}
                                  <span className="text-text">“{k.query}”</span> {k.probability}%
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </span>
                      ) : it.kind === "page" ? (
                        <span>
                          Viewed <span className="break-all">{it.url}</span>
                        </span>
                      ) : it.kind === "goal" ? (
                        <span className="font-medium text-primary-text">Completed {it.name}</span>
                      ) : (
                        <span className="font-medium text-success-text">
                          {KIND_LABEL[it.paymentKind] ?? it.paymentKind}{" "}
                          {formatMoney(it.amount, it.currency)} via {it.provider}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}

export default function VisitorProfilePage() {
  const { visitorId } = useParams({ strict: false }) as { visitorId: string };
  return (
    <SiteAnalytics>
      {(site) => <Profile siteId={site._id} visitorId={visitorId} timezone={site.timezone} />}
    </SiteAnalytics>
  );
}
