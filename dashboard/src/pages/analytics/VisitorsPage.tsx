/**
 * Visitors: searchable list (user id, name, email or visitor id), period and dashboard filters,
 * customers-only and completed-goal shortcuts, paginated. Rows open the visitor profile.
 */
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Badge, EmptyState, ErrorState, Skeleton } from "../../analytics/components/primitives";
import { useTrackedGoals, useVisitors } from "../../analytics/hooks";
import { describeFilter, visitorListParams } from "../../analytics/lib/filters";
import { countryName, flagEmoji, formatMoney, timeAgo } from "../../analytics/lib/format";
import { visitorName } from "../../analytics/lib/names";
import { AnalyticsHeader } from "../../analytics/OverviewDashboard";
import { SiteAnalytics } from "../../analytics/SiteAnalytics";
import { useDashboardState } from "../../analytics/state";
import { cx } from "../../components/ui";

const PAGE = 50;

function Visitors({ siteId, currency }: { siteId: string; currency: string }) {
  const state = useDashboardState();
  const q = typeof state.search.q === "string" ? state.search.q : "";
  const goal = typeof state.search.goal === "string" ? state.search.goal : "";
  const customers = state.search.customers === true;
  const [text, setText] = useState(q);
  const [offset, setOffset] = useState(0);
  const goals = useTrackedGoals(siteId);
  const { params, unsupported } = visitorListParams(state.filters);
  const { update } = state;
  useEffect(() => {
    const id = setTimeout(() => {
      if (text !== q) {
        update({ q: text || undefined });
        setOffset(0);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [text, q, update]);
  const query = useVisitors(siteId, {
    ...state.rangeParams,
    ...params,
    ...(q ? { q } : {}),
    ...(goal && !customers ? { completedGoal: goal } : {}),
    ...(customers ? { isCustomer: "true" } : {}),
    limit: PAGE,
    offset,
  });
  const rows = query.data?.data ?? [];
  const total = query.data?.pagination?.total;
  return (
    <div className="space-y-4">
      <AnalyticsHeader title="Visitors" state={state} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search visitors"
          placeholder="Search by name, email, user id or visitor id"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm sm:max-w-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={customers}
            onChange={(e) => {
              update({ customers: e.target.checked ? true : undefined, goal: undefined });
              setOffset(0);
            }}
          />
          Customers only
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Completed goal</span>
          <select
            value={goal}
            disabled={customers}
            onChange={(e) => {
              update({ goal: e.target.value || undefined });
              setOffset(0);
            }}
            className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
          >
            <option value="">Any</option>
            {(goals.data ?? []).map((g) => (
              <option key={g.name} value={g.name}>
                {g.displayName || g.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {unsupported.length ? (
        <p className="text-xs text-muted" role="note">
          The visitor list matches exact values only, so these filters are not applied here:{" "}
          {unsupported.map(describeFilter).join(", ")}.
        </p>
      ) : null}
      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        {query.isPending ? (
          <Skeleton className="m-4 h-64" />
        ) : query.error ? (
          <div className="p-4">
            <ErrorState error={query.error} />
          </div>
        ) : !rows.length ? (
          <EmptyState>No visitors match.</EmptyState>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="sr-only">
                Visitors{total !== undefined ? `, ${total} total` : ""}
              </caption>
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Visitor
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Location
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Source
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Device
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Visits
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Revenue
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Last seen
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.visitorId}
                    className="border-b border-line last:border-0 hover:bg-surface-2"
                  >
                    <td className="px-4 py-2">
                      <Link
                        to="/app/$siteId/visitors/$visitorId"
                        params={{ siteId, visitorId: r.visitorId }}
                        className="font-medium hover:text-primary-text hover:underline"
                      >
                        {visitorName(r.visitorId, r.displayName, r.userId)}
                      </Link>
                      <div className="flex items-center gap-1 text-xs text-muted">
                        {r.userId ? (
                          <span className="truncate">{r.userId}</span>
                        ) : (
                          <span className="font-mono">{r.visitorId.slice(0, 8)}</span>
                        )}
                        {r.visitorType ? (
                          <Badge tone={r.visitorType === "new" ? "info" : "neutral"}>
                            {r.visitorType}
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      {flagEmoji(r.identity.country)}{" "}
                      {r.identity.city ?? countryName(r.identity.country)}
                    </td>
                    <td className="max-w-40 truncate px-2 py-2">
                      {r.acquisition.utm_source ?? r.acquisition.referrer ?? "Direct / None"}
                    </td>
                    <td className="px-2 py-2 text-muted">
                      {[r.identity.device, r.identity.browser].filter(Boolean).join(" · ")}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {r.visitorSessionNumber ?? "–"}
                    </td>
                    <td
                      className={cx(
                        "px-2 py-2 text-right tabular-nums",
                        (r.revenue ?? 0) > 0 && "text-primary-text",
                      )}
                    >
                      {(r.revenue ?? 0) > 0 ? formatMoney(r.revenue ?? 0, currency) : "–"}
                    </td>
                    <td className="px-4 py-2 text-right text-muted">{timeAgo(r.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <nav aria-label="Pagination" className="flex items-center justify-between text-sm">
        <span className="text-muted">
          {rows.length
            ? `${offset + 1}–${offset + rows.length}${total !== undefined ? ` of ${total}` : ""}`
            : ""}
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
            className="rounded-md border border-line px-3 py-1.5 hover:bg-surface-2 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!query.data?.pagination?.hasMore}
            onClick={() => setOffset((o) => o + PAGE)}
            className="rounded-md border border-line px-3 py-1.5 hover:bg-surface-2 disabled:opacity-40"
          >
            Next
          </button>
        </span>
      </nav>
    </div>
  );
}

export default function VisitorsPage() {
  return (
    <SiteAnalytics>
      {(site) => <Visitors siteId={site._id} currency={site.currency} />}
    </SiteAnalytics>
  );
}
