/**
 * The site (website) model shared by every module. Rows are parsed once into `Site` objects:
 * JSON columns become arrays, integer flags become booleans. Use `siteCache` (site-cache.ts) on
 * hot paths instead of calling the loaders directly.
 */
import { bool, parseJsonColumn } from "./d1";

export type PrivacyMode = "cookie" | "cookieless" | "consent";
export type AttributionModel = "first_touch" | "last_touch" | "last_non_direct";
export type BotLevel = "off" | "standard" | "strict";

export const PRIVACY_MODES: readonly PrivacyMode[] = ["cookie", "cookieless", "consent"];
export const ATTRIBUTION_MODELS: readonly AttributionModel[] = [
  "first_touch",
  "last_touch",
  "last_non_direct",
];
export const BOT_LEVELS: readonly BotLevel[] = ["off", "standard", "strict"];

export interface Site {
  id: string;
  publicId: string;
  domain: string;
  name: string | null;
  logo: string | null;
  timezone: string;
  currency: string;
  privacyMode: PrivacyMode;
  attributionModel: AttributionModel;
  botLevel: BotLevel;
  honorGpc: boolean;
  allowedHostnames: string[];
  allHostnamesAllowed: boolean;
  excludedIps: string[];
  excludedPaths: string[];
  excludedCountries: string[];
  excludedHostnames: string[];
  /** W1 (migration 0100): case-insensitive User-Agent substrings dropped at ingest. */
  excludedUserAgents: string[];
  kpi: string | null;
  kpiColorScheme: string | null;
  revenueMetric: string;
  includeRenewalRevenue: boolean;
  storeCustomerEmails: boolean;
  retentionDays: number | null;
  sendWeeklyReports: boolean;
  sendViralTrafficAlerts: boolean;
  shareToken: string | null;
  publicDataEnabled: boolean;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type SiteRow = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" ? v : v === null ? null : Number(v);

export function rowToSite(row: SiteRow): Site {
  return {
    id: String(row.id),
    publicId: String(row.public_id),
    domain: String(row.domain),
    name: str(row.name),
    logo: str(row.logo),
    timezone: String(row.timezone ?? "UTC"),
    currency: String(row.currency ?? "USD"),
    privacyMode: (row.privacy_mode as PrivacyMode) ?? "cookie",
    attributionModel: (row.attribution_model as AttributionModel) ?? "first_touch",
    botLevel: (row.bot_level as BotLevel) ?? "standard",
    honorGpc: bool(row.honor_gpc),
    allowedHostnames: parseJsonColumn<string[]>(row.allowed_hostnames, []),
    allHostnamesAllowed: bool(row.all_hostnames_allowed),
    excludedIps: parseJsonColumn<string[]>(row.excluded_ips, []),
    excludedPaths: parseJsonColumn<string[]>(row.excluded_paths, []),
    excludedCountries: parseJsonColumn<string[]>(row.excluded_countries, []),
    excludedHostnames: parseJsonColumn<string[]>(row.excluded_hostnames, []),
    excludedUserAgents: parseJsonColumn<string[]>(row.excluded_user_agents, []),
    kpi: str(row.kpi),
    kpiColorScheme: str(row.kpi_color_scheme),
    revenueMetric: String(row.revenue_metric ?? "revenue"),
    includeRenewalRevenue: bool(row.include_renewal_revenue),
    storeCustomerEmails: bool(row.store_customer_emails),
    retentionDays: num(row.retention_days),
    sendWeeklyReports: bool(row.send_weekly_reports),
    sendViralTrafficAlerts: bool(row.send_viral_traffic_alerts),
    shareToken: str(row.share_token),
    publicDataEnabled: bool(row.public_data_enabled),
    createdBy: str(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: num(row.deleted_at),
  };
}

/** Load a live (not deleted) site by internal id. */
export async function loadSiteById(db: D1Database, id: string): Promise<Site | null> {
  const row = await db
    .prepare("SELECT * FROM sites WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<SiteRow>();
  return row ? rowToSite(row) : null;
}

/** Load a live site by its public tracking id (`data-website-id`). */
export async function loadSiteByPublicId(db: D1Database, publicId: string): Promise<Site | null> {
  const row = await db
    .prepare("SELECT * FROM sites WHERE public_id = ? AND deleted_at IS NULL")
    .bind(publicId)
    .first<SiteRow>();
  return row ? rowToSite(row) : null;
}

/** Load a live site by share token (public dashboard links). */
export async function loadSiteByShareToken(db: D1Database, token: string): Promise<Site | null> {
  const row = await db
    .prepare("SELECT * FROM sites WHERE share_token = ? AND deleted_at IS NULL")
    .bind(token)
    .first<SiteRow>();
  return row ? rowToSite(row) : null;
}
