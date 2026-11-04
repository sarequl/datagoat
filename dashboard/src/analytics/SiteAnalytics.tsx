/** Provides the signed-in website as the analytics source for `/app/:siteId/*` pages. */
import { useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { WebsiteSummary } from "../../../shared/api-types";
import { useMe } from "../api/hooks";
import { Spinner } from "../components/ui";
import { ymdInTz } from "./lib/tz";
import { type AnalyticsSource, AnalyticsSourceProvider } from "./source";

export function useSite(): WebsiteSummary | undefined {
  const { siteId } = useParams({ strict: false }) as { siteId?: string };
  const me = useMe();
  return me.data?.websites.find((w) => w._id === siteId);
}

export function siteSource(site: WebsiteSummary): AnalyticsSource {
  let siteStart: string | undefined;
  try {
    siteStart = ymdInTz(Date.parse(site.createdAt), site.timezone);
  } catch {
    siteStart = undefined;
  }
  return {
    kind: "site",
    websiteId: site._id,
    timezone: site.timezone,
    currency: site.currency,
    siteStart,
    canWrite: site.role !== "viewer",
  };
}

export function SiteAnalytics({
  children,
}: {
  children: (site: WebsiteSummary, source: AnalyticsSource) => ReactNode;
}) {
  const site = useSite();
  if (!site) return <Spinner />;
  const source = siteSource(site);
  return (
    <AnalyticsSourceProvider source={source}>{children(site, source)}</AnalyticsSourceProvider>
  );
}
