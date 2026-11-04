/**
 * Where analytics come from: a signed-in website (`/api/v1/analytics/*?websiteId=`) or a public
 * share link (`/api/share/:token/analytics/*`). The overview components read the source from
 * context, so the public dashboard reuses them unchanged.
 */
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { api, type Envelope, type Query } from "../api/client";

export type AnalyticsSource =
  | {
      kind: "site";
      websiteId: string;
      timezone: string;
      currency: string;
      /** Website creation day (YYYY-MM-DD) bounds "All time". */
      siteStart?: string;
      canWrite: boolean;
    }
  | {
      kind: "share";
      token: string;
      timezone: string;
      currency: string;
      showRevenue: boolean;
    };

const SourceContext = createContext<AnalyticsSource | null>(null);

export function AnalyticsSourceProvider({
  source,
  children,
}: {
  source: AnalyticsSource;
  children: ReactNode;
}) {
  return <SourceContext.Provider value={source}>{children}</SourceContext.Provider>;
}

export function useSource(): AnalyticsSource {
  const s = useContext(SourceContext);
  if (!s) throw new Error("useSource() outside <AnalyticsSourceProvider>");
  return s;
}

export function sourceKey(s: AnalyticsSource): string {
  return s.kind === "site" ? `site:${s.websiteId}` : `share:${s.token}`;
}

export function showRevenue(s: AnalyticsSource): boolean {
  return s.kind === "site" || s.showRevenue;
}

export function analyticsRequest<T>(
  s: AnalyticsSource,
  endpoint: string,
  params: Query = {},
): Promise<Envelope<T>> {
  if (s.kind === "share") {
    return api.get<T>(`/api/share/${encodeURIComponent(s.token)}/analytics/${endpoint}`, params);
  }
  return api.get<T>(`/api/v1/analytics/${endpoint}`, { websiteId: s.websiteId, ...params });
}

/** Endpoints the public share API serves (docs/api/contract.md §9). */
export const SHARE_ENDPOINTS = new Set([
  "overview",
  "timeseries",
  "pages",
  "entry-pages",
  "referrers",
  "channels",
  "campaigns",
  "countries",
  "regions",
  "cities",
  "devices",
  "browsers",
  "operating-systems",
  "hostnames",
  "goals",
]);

export function supports(s: AnalyticsSource, endpoint: string): boolean {
  return s.kind === "site" || SHARE_ENDPOINTS.has(endpoint);
}

export function useAnalytics<T>(
  endpoint: string,
  params: Query,
  opts: { enabled?: boolean; refetchInterval?: number | false; keepPrevious?: boolean } = {},
) {
  const source = useSource();
  const enabled = (opts.enabled ?? true) && supports(source, endpoint);
  return useQuery({
    queryKey: ["analytics", sourceKey(source), endpoint, params],
    queryFn: () => analyticsRequest<T>(source, endpoint, params),
    enabled,
    refetchInterval: opts.refetchInterval,
    placeholderData:
      opts.keepPrevious === false ? undefined : (prev: Envelope<T> | undefined) => prev,
  });
}
