import { PagePlaceholder } from "../../components/PagePlaceholder";

/** Placeholder: W4 replaces this page. */
export default function OverviewPage() {
  return (
    <PagePlaceholder
      title="Overview"
      description="KPIs with previous-period comparison, time series with notes, and breakdown cards (channels, referrers, campaigns, pages, entry pages, exit clicks, hostnames, countries, regions, cities, devices, browsers, OS, goals). Every row shows visitors, revenue and payments and filters on click."
    />
  );
}
