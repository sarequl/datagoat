/** Breakdown card definitions for the overview (DataFast's Source, Pages, Location, System). */
import type { BreakdownTab, Row } from "./components/BreakdownCard";
import { countryName, flagEmoji } from "./lib/format";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const campaignValue = (r: Row, dim: string) =>
  str((r.campaign as Record<string, unknown> | undefined)?.[dim]);

function favicon(domain: string) {
  const letter = domain.replace(/^https?:\/\//, "")[0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden="true"
      className="flex size-4 items-center justify-center rounded-sm bg-surface-2 text-[9px] font-semibold text-muted"
    >
      {letter}
    </span>
  );
}

const CHANNEL_ICONS: Record<string, string> = {
  "Organic Search": "🔎",
  "Paid Search": "💲",
  "Organic Social": "💬",
  "Paid Social": "📣",
  Referral: "🔗",
  Email: "✉️",
  Newsletter: "📰",
  Affiliate: "🤝",
  AI: "✨",
  Display: "🖼️",
  Direct: "➡️",
};

const DEVICE_ICONS: Record<string, string> = { desktop: "🖥️", mobile: "📱", tablet: "📟" };

export const CAMPAIGN_DIMENSIONS = [
  { id: "utm_source", label: "UTM source" },
  { id: "utm_medium", label: "UTM medium" },
  { id: "utm_campaign", label: "UTM campaign" },
  { id: "utm_term", label: "UTM term" },
  { id: "utm_content", label: "UTM content" },
  { id: "ref", label: "ref" },
  { id: "source", label: "source" },
  { id: "via", label: "via" },
] as const;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/** Google Search Console keywords (DataFast's Keyword tab): clicks and estimated revenue. */
export const keywordTab: BreakdownTab = {
  id: "keyword",
  label: "Keyword",
  endpoint: "search-console",
  path: "/api/v1/search-console",
  pageFilter: true,
  extraParams: () => ({ groupBy: "query" }),
  value: (r) => str(r.query),
  mapRow: (r) => ({
    ...r,
    visitors: num(r.clicks),
    revenue: num(r.estimatedRevenue),
    payments: num(r.impressions),
  }),
  labels: { visitors: "Clicks", revenue: "Est. revenue", payments: "Impr." },
  icon: () => <span aria-hidden="true">🔎</span>,
};

/** Meta Ads campaigns (DataFast's campaign-level ad spend in the Source card). */
export function adsTab(currencyLabel: (n: number) => string): BreakdownTab {
  return {
    id: "ads",
    label: "Ads",
    endpoint: "ads-campaigns",
    path: "/api/v1/ads/campaigns",
    // Visits match campaigns through utm_campaign={{campaign.id}}.
    filterKey: "utm_campaign",
    value: (r) => str(r.campaignId),
    rowLabel: (r) => str(r.campaignName) || str(r.campaignId),
    note: (r) =>
      `${currencyLabel(num(r.spend))} spend${
        r.roas === null || r.roas === undefined ? "" : ` · ${num(r.roas).toFixed(2)}x ROAS`
      }`,
    icon: () => <span aria-hidden="true">📣</span>,
  };
}

export function sourceTabs(
  growth: { keywords?: boolean; ads?: BreakdownTab | null } = {},
): BreakdownTab[] {
  return [
    {
      id: "channel",
      label: "Channel",
      endpoint: "channels",
      filterKey: "channel",
      value: (r) => str(r.channel),
      icon: (r) => <span aria-hidden="true">{CHANNEL_ICONS[str(r.channel)] ?? "•"}</span>,
      donut: true,
      drillTo: "referrer",
    },
    {
      id: "referrer",
      label: "Referrer",
      endpoint: "referrers",
      filterKey: "referrer",
      value: (r) => str(r.referrer),
      icon: (r) => favicon(str(r.referrer)),
    },
    {
      id: "campaign",
      label: "Campaign",
      endpoint: "campaigns",
      filterKey: (v) => v,
      value: (r, v) => campaignValue(r, v),
      variants: CAMPAIGN_DIMENSIONS,
      extraParams: (v) => ({ fields: `${v},visitors,revenue,payments` }),
      group: true,
    },
    ...(growth.keywords ? [keywordTab] : []),
    ...(growth.ads ? [growth.ads] : []),
  ];
}

export function pageTabs(siteDomain?: string): BreakdownTab[] {
  const pageHref = (r: Row) => {
    const host = str(r.hostname) || siteDomain;
    return host ? `https://${host}${str(r.path)}` : null;
  };
  return [
    {
      id: "page",
      label: "Page",
      endpoint: "pages",
      filterKey: "page",
      value: (r) => str(r.path),
      href: pageHref,
    },
    {
      id: "entry",
      label: "Entry page",
      endpoint: "entry-pages",
      filterKey: "entry_page",
      value: (r) => str(r.path),
      href: pageHref,
    },
    {
      id: "exit",
      label: "Exit page",
      endpoint: "exit-pages",
      filterKey: "page",
      value: (r) => str(r.path),
      href: pageHref,
    },
    {
      id: "exit-link",
      label: "Exit link",
      endpoint: "exit-clicks",
      value: (r) => str(r.url),
      href: (r) => str(r.url) || null,
      clicks: true,
    },
    {
      id: "hostname",
      label: "Hostname",
      endpoint: "hostnames",
      filterKey: "hostname",
      value: (r) => str(r.hostname),
      icon: (r) => favicon(str(r.hostname)),
    },
  ];
}

export function locationTabs(withMap = true): BreakdownTab[] {
  const country: BreakdownTab = {
    id: "country",
    label: "Country",
    endpoint: "countries",
    filterKey: "country",
    value: (r) => str(r.country) || countryName(str(r.code)),
    icon: (r) => <span aria-hidden="true">{str(r.image) || flagEmoji(str(r.code))}</span>,
  };
  return [
    ...(withMap ? [{ ...country, id: "map", label: "Map", map: true }] : []),
    country,
    {
      id: "region",
      label: "Region",
      endpoint: "regions",
      filterKey: "region",
      value: (r) => str(r.region),
    },
    { id: "city", label: "City", endpoint: "cities", filterKey: "city", value: (r) => str(r.city) },
  ];
}

export function systemTabs(): BreakdownTab[] {
  return [
    {
      id: "browser",
      label: "Browser",
      endpoint: "browsers",
      filterKey: "browser",
      value: (r) => str(r.browser),
    },
    {
      id: "os",
      label: "OS",
      endpoint: "operating-systems",
      filterKey: "os",
      value: (r) => str(r.operating_system),
    },
    {
      id: "device",
      label: "Device",
      endpoint: "devices",
      filterKey: "device",
      value: (r) => str(r.device),
      icon: (r) => <span aria-hidden="true">{DEVICE_ICONS[str(r.device)] ?? "•"}</span>,
    },
  ];
}
