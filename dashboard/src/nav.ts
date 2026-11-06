/**
 * Dashboard navigation: the single list of website pages, their group and owning team.
 * The router (router.tsx) creates one lazy route per entry from `pages/<file>.tsx`. Teams replace
 * the page file; adding a page is one entry here plus the file.
 */
/**
 * Page groups. Analytics and Growth pages open from the Overview (cards, "Open" links) and ⌘K;
 * Integrations, Developers and Settings pages sit inside Settings with its left menu.
 */
export type NavGroup = "Analytics" | "Growth" | "Integrations" | "Developers" | "Settings";

export interface NavItem {
  /** Path under /app/$siteId/ */
  path: string;
  label: string;
  /** Shorter label for menus when it differs from the page's own title. */
  navLabel?: string;
  group: NavGroup;
  owner: "W4" | "W5" | "W6";
  /** Module under pages/ (without extension). */
  page: string;
  /** Not a menu entry of its own (detail pages, settings sub-pages). */
  hidden?: boolean;
}

export const SITE_PAGES: readonly NavItem[] = [
  {
    path: "overview",
    label: "Overview",
    group: "Analytics",
    owner: "W4",
    page: "analytics/OverviewPage",
  },
  {
    path: "realtime",
    label: "Realtime",
    group: "Analytics",
    owner: "W4",
    page: "analytics/RealtimePage",
  },
  {
    path: "visitors",
    label: "Visitors",
    group: "Analytics",
    owner: "W4",
    page: "analytics/VisitorsPage",
  },
  {
    path: "visitors/$visitorId",
    label: "Visitor",
    group: "Analytics",
    owner: "W4",
    page: "analytics/VisitorProfilePage",
    hidden: true,
  },
  {
    path: "revenue",
    label: "Revenue",
    group: "Analytics",
    owner: "W4",
    page: "analytics/RevenuePage",
  },
  { path: "goals", label: "Goals", group: "Analytics", owner: "W4", page: "analytics/GoalsPage" },
  {
    path: "funnels",
    label: "Funnels",
    group: "Analytics",
    owner: "W4",
    page: "analytics/FunnelsPage",
  },
  {
    path: "funnels/$funnelId",
    label: "Funnel",
    group: "Analytics",
    owner: "W4",
    page: "analytics/FunnelDetailPage",
    hidden: true,
  },
  {
    path: "mentions",
    label: "Mentions",
    group: "Growth",
    owner: "W6",
    page: "growth/MentionsPage",
  },
  {
    path: "search-console",
    label: "Search Console",
    group: "Growth",
    owner: "W6",
    page: "growth/SearchConsolePage",
  },
  { path: "ads", label: "Ads & ROAS", group: "Growth", owner: "W6", page: "growth/AdsPage" },
  {
    path: "bot-traffic",
    label: "Bot traffic",
    group: "Growth",
    owner: "W6",
    page: "growth/BotTrafficPage",
  },
  {
    path: "integrations",
    label: "Integrations",
    group: "Integrations",
    owner: "W5",
    page: "settings/IntegrationsPage",
  },
  {
    path: "keys",
    label: "API keys",
    group: "Developers",
    owner: "W5",
    page: "settings/ApiKeysPage",
  },
  {
    path: "mcp",
    label: "AI assistants (MCP)",
    group: "Developers",
    owner: "W5",
    page: "settings/McpPage",
  },
  {
    path: "api-playground",
    label: "API playground",
    group: "Developers",
    owner: "W5",
    page: "settings/ApiPlaygroundPage",
  },
  {
    path: "settings/general",
    label: "Settings",
    navLabel: "General",
    group: "Settings",
    owner: "W5",
    page: "settings/GeneralSettingsPage",
  },
  {
    path: "settings/install",
    label: "Installation",
    group: "Settings",
    owner: "W5",
    page: "settings/InstallPage",
    hidden: true,
  },
  {
    path: "settings/tracking",
    label: "Tracking & privacy",
    group: "Settings",
    owner: "W5",
    page: "settings/TrackingSettingsPage",
    hidden: true,
  },
  {
    path: "settings/exclusions",
    label: "Exclusions",
    group: "Settings",
    owner: "W5",
    page: "settings/ExclusionsSettingsPage",
    hidden: true,
  },
  {
    path: "settings/attribution",
    label: "Attribution & revenue",
    group: "Settings",
    owner: "W5",
    page: "settings/AttributionSettingsPage",
    hidden: true,
  },
  {
    path: "settings/danger",
    label: "Delete website",
    group: "Settings",
    owner: "W5",
    page: "settings/DangerZonePage",
    hidden: true,
  },
  { path: "team", label: "Team", group: "Settings", owner: "W5", page: "settings/TeamPage" },
  { path: "alerts", label: "Alerts", group: "Settings", owner: "W6", page: "growth/AlertsPage" },
  {
    path: "share",
    label: "Share link",
    navLabel: "Sharing",
    group: "Settings",
    owner: "W5",
    page: "settings/SharePage",
  },
  {
    path: "usage",
    label: "Usage & data",
    group: "Settings",
    owner: "W5",
    page: "settings/UsagePage",
  },
  { path: "import", label: "Import", group: "Settings", owner: "W6", page: "growth/ImportPage" },
];

/** Settings sub-navigation shown inside the settings pages. */
export const SETTINGS_TABS = SITE_PAGES.filter((p) => p.path.startsWith("settings/"));

/** Pages shown inside Settings (with its left menu): Integrations, Developers and Settings. */
export const SETTINGS_GROUPS: readonly NavGroup[] = ["Integrations", "Developers", "Settings"];

export const inSettings = (item: NavItem): boolean => SETTINGS_GROUPS.includes(item.group);

/** The Settings left menu, in order. Paths refer to SITE_PAGES. */
export const SETTINGS_MENU: readonly { heading: string; paths: readonly string[] }[] = [
  {
    heading: "Website",
    paths: [
      "settings/general",
      "settings/install",
      "settings/tracking",
      "settings/exclusions",
      "settings/attribution",
    ],
  },
  { heading: "Data", paths: ["integrations", "import", "share", "usage"] },
  { heading: "People", paths: ["team", "alerts"] },
  { heading: "Developers", paths: ["keys", "mcp", "api-playground"] },
  { heading: "", paths: ["settings/danger"] },
];

/** Links in the top bar, in order. Everything else opens from the Overview, Settings or ⌘K. */
export const TOP_LINKS: readonly string[] = [
  "overview",
  "realtime",
  "visitors",
  "settings/general",
];

/** The page at `pathname` (most specific match), if any. */
export function pageAt(pathname: string, siteId: string): NavItem | undefined {
  const rest = pathname.startsWith(`/app/${siteId}/`)
    ? pathname.slice(`/app/${siteId}/`.length)
    : "";
  const parts = rest.split("/").filter(Boolean);
  return SITE_PAGES.find((p) => {
    const want = p.path.split("/");
    return (
      want.length === parts.length && want.every((w, i) => w.startsWith("$") || w === parts[i])
    );
  });
}

export const NAV_GROUPS: readonly NavGroup[] = [
  "Analytics",
  "Growth",
  "Integrations",
  "Developers",
  "Settings",
];
