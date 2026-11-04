/**
 * Public dashboard at /share/:token (no sign-in): the website overview read-only, from the share
 * API. Revenue shows only when the owner enabled public revenue; no visitors, notes or segments.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type { SharedWebsite } from "../../../../shared/api-types";
import { OverviewDashboard } from "../../analytics/OverviewDashboard";
import { AnalyticsSourceProvider } from "../../analytics/source";
import { apiGet } from "../../api/client";
import { ThemeToggle } from "../../components/ThemeToggle";
import { Spinner } from "../../components/ui";

export default function SharedDashboardPage() {
  const { token } = useParams({ strict: false }) as { token: string };
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
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-fg">
              D
            </span>
            Public dashboard
          </span>
          <ThemeToggle />
        </header>
        <main className="mx-auto max-w-6xl p-4 md:p-6">
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
          <footer className="mt-8 text-center text-xs text-muted">
            {w.domain} analytics, shared publicly · Powered by DataGoat
          </footer>
        </main>
      </div>
    </AnalyticsSourceProvider>
  );
}
