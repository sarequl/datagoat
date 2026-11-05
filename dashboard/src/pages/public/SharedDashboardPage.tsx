/**
 * Public dashboard at /share/:token (no sign-in): the website overview read-only, from the share
 * API, and (like DataFast's public dashboard) the real-time visitor map. Revenue and payments show
 * only when the owner enabled public revenue; no visitor names, journeys, notes or segments.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import type { SharedWebsite } from "../../../../shared/api-types";
import { OverviewDashboard } from "../../analytics/OverviewDashboard";
import { AnalyticsSourceProvider } from "../../analytics/source";
import { apiGet } from "../../api/client";
import { LogoMark } from "../../components/Logo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { cx, Spinner } from "../../components/ui";

const LiveView = lazy(() =>
  import("../analytics/RealtimePage").then((m) => ({ default: m.RealtimeView })),
);

export default function SharedDashboardPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const [view, setView] = useState<"overview" | "live">(() =>
    new URLSearchParams(window.location.search).get("view") === "live" ? "live" : "overview",
  );
  const site = useQuery({
    queryKey: ["share", token],
    queryFn: () => apiGet<SharedWebsite>(`/api/share/${encodeURIComponent(token)}`),
    retry: false,
  });
  if (site.isPending) return <Spinner />;
  if (site.error || !site.data) {
    return (
      <main className="mx-auto max-w-lg p-8 text-center">
        <h1 className="text-xl font-semibold">Dashboard not available</h1>
        <p className="mt-2 text-sm text-muted">
          This share link is invalid or has been turned off by the website owner.
        </p>
      </main>
    );
  }
  const w = site.data;
  return (
    <AnalyticsSourceProvider
      source={{
        kind: "share",
        token,
        timezone: w.timezone,
        currency: w.currency,
        showRevenue: w.showRevenue,
      }}
    >
      <div className="min-h-screen">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
          <span className="flex min-w-0 items-center gap-2 text-sm text-muted">
            <LogoMark size={24} />
            Public dashboard
          </span>
          <div className="flex items-center gap-2">
            {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons */}
            <div
              role="group"
              aria-label="View"
              className="flex rounded-md border border-line p-0.5"
            >
              {(
                [
                  ["overview", "Overview"],
                  ["live", "Live map"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={view === key}
                  onClick={() => setView(key)}
                  className={cx(
                    "rounded px-2.5 py-1 text-sm",
                    view === key ? "bg-surface-2 font-medium text-primary-text" : "text-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto max-w-6xl p-4 md:p-6">
          {view === "live" ? (
            <Suspense fallback={<Spinner />}>
              <LiveView
                siteId={null}
                timezone={w.timezone}
                currency={w.currency}
                share={{ token, showRevenue: w.showRevenue }}
              />
            </Suspense>
          ) : (
            <OverviewDashboard
              title={w.name ?? w.domain}
              domain={w.domain}
              logo={
                w.logo ? (
                  <img src={w.logo} alt="" className="size-7 rounded" />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-7 items-center justify-center rounded bg-surface-2 text-sm"
                  >
                    {w.domain[0]?.toUpperCase()}
                  </span>
                )
              }
            />
          )}
          <footer className="mt-8 text-center text-xs text-muted">
            {w.domain} analytics, shared publicly · Powered by DataGoat
          </footer>
        </main>
      </div>
    </AnalyticsSourceProvider>
  );
}
