/**
 * Google Search Console API client (Search Console API v3, read-only scope
 * `webmasters.readonly`):
 * - sites.list: `GET https://www.googleapis.com/webmasters/v3/sites`
 *   (https://developers.google.com/webmaster-tools/v1/sites/list)
 * - searchanalytics.query: `POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`
 *   (https://developers.google.com/webmaster-tools/v1/searchanalytics/query). Rows come sorted by
 *   clicks, at most 25,000 per request; data is final after about 2-3 days.
 */
import { type Fetcher, requestJson } from "../shared/http";

const API = "https://www.googleapis.com/webmasters/v3";

export interface GscProperty {
  siteUrl: string;
  permissionLevel: string;
}

export async function listProperties(fetcher: Fetcher, token: string): Promise<GscProperty[]> {
  const res = await requestJson<{ siteEntry?: GscProperty[] }>(
    fetcher,
    "Google Search Console",
    `${API}/sites`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  return (res.siteEntry ?? []).filter((p) => p.permissionLevel !== "siteUnverifiedUser");
}

/** Prefer the Domain property, then URL-prefix properties for the domain (https first, www next). */
export function pickProperty(properties: readonly GscProperty[], domain: string): string | null {
  const root = domain.toLowerCase().replace(/^www\./, "");
  const candidates = [
    `sc-domain:${root}`,
    `https://${root}/`,
    `https://www.${root}/`,
    `http://${root}/`,
    `http://www.${root}/`,
  ];
  const urls = new Set(properties.map((p) => p.siteUrl.toLowerCase()));
  return candidates.find((c) => urls.has(c)) ?? null;
}

export async function autoSelectProperty(
  fetcher: Fetcher,
  token: string,
  domain: string,
): Promise<string | null> {
  return pickProperty(await listProperties(fetcher, token), domain);
}

export interface GscRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export async function querySearchAnalytics(
  fetcher: Fetcher,
  token: string,
  property: string,
  body: {
    startDate: string;
    endDate: string;
    dimensions: Array<"date" | "query" | "page" | "country" | "device">;
    rowLimit: number;
    startRow?: number;
  },
): Promise<GscRow[]> {
  const res = await requestJson<{ rows?: GscRow[] }>(
    fetcher,
    "Google Search Console",
    `${API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      json: { ...body, type: "web", dataState: "all" },
      timeoutMs: 15_000,
    },
  );
  return res.rows ?? [];
}
