/**
 * Dashboard navigation: the single list of website pages, their sidebar group and owning team.
 * The router (router.tsx) creates one lazy route per entry from `pages/<file>.tsx`. Teams replace
 * the page file; adding a page is one entry here plus the file.
 */
export type NavGroup = "Analytics" | "Growth" | "Website";

export interface NavItem {
  /** Path under /app/$siteId/ */
  path: string;
  label: string;
  group: NavGroup;
  owner: "W4" | "W5" | "W6";
  /** Module under pages/ (without extension). */
  page: string;
  /** Hidden from the sidebar (detail pages). */
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
    path: "revenue",
    label: "Revenue",
    group: "Analytics",
    owner: "W4",
    page: "analytics/RevenuePage",
  },
  {
    path: "bot-traffic",
    label: "Bot traffic",
    group: "Growth",
    owner: "W6",
    page: "growth/BotTrafficPage",
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
    path: "settings/general",
    label: "Settings",
    group: "Website",
    owner: "W5",
    page: "settings/GeneralSettingsPage",
  },
  {
    path: "settings/install",
    label: "Installation",
    group: "Website",
    owner: "W5",
    page: "settings/InstallPage",
    hidden: true,
  },
  {
    path: "settings/tracking",
    label: "Tracking & privacy",
    group: "Website",
    owner: "W5",
    page: "settings/TrackingSettingsPage",
    hidden: true,
  },
  {
    path: "settings/exclusions",
    label: "Exclusions",
    group: "Website",
    owner: "W5",
    page: "settings/ExclusionsSettingsPage",
    hidden: true,
  },
  {
    path: "settings/attribution",
    label: "Attribution & revenue",
    group: "Website",
    owner: "W5",
    page: "settings/AttributionSettingsPage",
    hidden: true,
  },
  {
    path: "settings/danger",
    label: "Delete website",
    group: "Website",
    owner: "W5",
    page: "settings/DangerZonePage",
    hidden: true,
  },
  { path: "team", label: "Team", group: "Website", owner: "W5", page: "settings/TeamPage" },
  { path: "keys", label: "API keys", group: "Website", owner: "W5", page: "settings/ApiKeysPage" },
  {
    path: "integrations",
    label: "Integrations",
    group: "Website",
    owner: "W5",
    page: "settings/IntegrationsPage",
  },
  { path: "alerts", label: "Alerts", group: "Website", owner: "W6", page: "growth/AlertsPage" },
  { path: "share", label: "Share link", group: "Website", owner: "W5", page: "settings/SharePage" },
  {
    path: "usage",
    label: "Usage & data",
    group: "Website",
    owner: "W5",
    page: "settings/UsagePage",
  },
  { path: "import", label: "Import", group: "Website", owner: "W6", page: "growth/ImportPage" },
];

/** Settings sub-navigation shown inside the settings pages. */
export const SETTINGS_TABS = SITE_PAGES.filter((p) => p.path.startsWith("settings/"));

export const NAV_GROUPS: readonly NavGroup[] = ["Analytics", "Growth", "Website"];
