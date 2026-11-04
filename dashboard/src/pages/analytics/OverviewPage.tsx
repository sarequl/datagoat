import { useMetadata } from "../../analytics/hooks";
import { OverviewDashboard } from "../../analytics/OverviewDashboard";
import { SiteAnalytics } from "../../analytics/SiteAnalytics";

function Overview({ siteId }: { siteId: string }) {
  const meta = useMetadata(siteId);
  return (
    <OverviewDashboard
      title="Overview"
      siteId={siteId}
      domain={meta.data?.domain}
      kpi={meta.data?.kpi}
      kpiColorScheme={meta.data?.kpiColorScheme}
    />
  );
}

/** Website overview: KPIs, main chart, breakdowns (DataFast's dashboard). */
export default function OverviewPage() {
  return <SiteAnalytics>{(site) => <Overview siteId={site._id} />}</SiteAnalytics>;
}
