/**
 * Website creation, settings updates and DTOs. Used by the admin API and first-run setup.
 */
import { z } from "zod";
import type { Role } from "../../../../shared/permissions";
import { toCountryCode } from "../../../lib/countries";
import { ApiError } from "../../../lib/errors";
import { newId, newTrackingId, randomToken } from "../../../lib/ids";
import { siteCache } from "../../../lib/site-cache";
import {
  ATTRIBUTION_MODELS,
  BOT_LEVELS,
  PRIVACY_MODES,
  rowToSite,
  type Site,
} from "../../../lib/sites";
import {
  GOAL_NAME_RE,
  isValidHostname,
  normaliseDomain,
  zCurrency,
  zDomain,
  zTimezone,
} from "../../../lib/validate";

/** Full website settings (`GET /api/v1/admin/websites/{id}`), DataFast fields + DataGoat extensions. */
export function websiteDto(site: Site, role?: Role) {
  return {
    _id: site.id,
    domain: site.domain,
    name: site.name,
    logo: site.logo,
    trackingId: site.publicId,
    timezone: site.timezone,
    currency: site.currency,
    kpi: site.kpi,
    kpiColorScheme: site.kpiColorScheme,
    revenueMetric: site.revenueMetric,
    isCookieless: site.privacyMode === "cookieless",
    isAttackModeEnabled: site.botLevel === "strict",
    includeRenewalRevenue: site.includeRenewalRevenue,
    allowedHostnames: site.allowedHostnames,
    isAllHostnamesAllowed: site.allHostnamesAllowed,
    excludedIps: site.excludedIps,
    excludedPaths: site.excludedPaths,
    excludedCountries: site.excludedCountries,
    excludedHostnames: site.excludedHostnames,
    sendWeeklyReports: site.sendWeeklyReports,
    sendViralTrafficAlerts: site.sendViralTrafficAlerts,
    isPublicDashboardEnabled: site.shareToken !== null,
    isPublicDataEnabled: site.publicDataEnabled,
    createdAt: new Date(site.createdAt).toISOString(),
    // DataGoat extensions
    privacyMode: site.privacyMode,
    attributionModel: site.attributionModel,
    botLevel: site.botLevel,
    honorGpc: site.honorGpc,
    storeCustomerEmails: site.storeCustomerEmails,
    retentionDays: site.retentionDays,
    shareToken: site.shareToken,
    updatedAt: new Date(site.updatedAt).toISOString(),
    ...(role ? { role } : {}),
  };
}

/** Row of `GET /api/v1/admin/websites`. */
export function websiteSummaryDto(site: Site, role: Role) {
  return {
    _id: site.id,
    domain: site.domain,
    name: site.name,
    logo: site.logo,
    trackingId: site.publicId,
    timezone: site.timezone,
    currency: site.currency,
    role,
    createdAt: new Date(site.createdAt).toISOString(),
  };
}

export const CreateWebsiteBody = z.object({
  domain: zDomain,
  timezone: zTimezone.default("UTC"),
  name: z.string().trim().max(100).nullish(),
  currency: zCurrency.optional(),
});
export type CreateWebsiteInput = z.output<typeof CreateWebsiteBody>;

async function assertDomainAvailable(
  db: D1Database,
  domain: string,
  exceptSiteId?: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT id FROM sites WHERE domain = ? AND deleted_at IS NULL AND id != ? LIMIT 1")
    .bind(domain, exceptSiteId ?? "")
    .first<{ id: string }>();
  if (row) throw new ApiError(409, `A website with domain ${domain} already exists`);
}

/** Statements that create a website owned by `userId` (run them in one batch). */
export async function prepareCreateWebsite(
  db: D1Database,
  input: CreateWebsiteInput,
  userId: string,
  now = Date.now(),
): Promise<{ id: string; publicId: string; statements: D1PreparedStatement[] }> {
  await assertDomainAvailable(db, input.domain);
  const id = newId(now);
  const publicId = newTrackingId();
  return {
    id,
    publicId,
    statements: [
      db
        .prepare(
          `INSERT INTO sites (id, public_id, domain, name, timezone, currency, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          publicId,
          input.domain,
          input.name ?? null,
          input.timezone,
          input.currency ?? "USD",
          userId,
          now,
          now,
        ),
      db
        .prepare(
          "INSERT INTO memberships (site_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        )
        .bind(id, userId, now),
    ],
  };
}

// ---------------------------------------------------------------------------
// Settings update
// ---------------------------------------------------------------------------

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IPv4/IPv6 address with optional CIDR prefix. */
export function isIpOrCidr(value: string): boolean {
  const [addr, prefix, ...rest] = value.split("/");
  if (rest.length || !addr) return false;
  if (IPV4.test(addr))
    return prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32);
  const isV6 =
    addr.includes(":") && /^[0-9a-fA-F:.]+$/.test(addr) && (addr.match(/::/g)?.length ?? 0) <= 1;
  if (!isV6) return false;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128);
}

const hostnameList = z
  .array(z.string())
  .max(100)
  .transform((list) => [...new Set(list.map(normaliseDomain).filter(Boolean))])
  .refine((list) => list.every(isValidHostname), {
    message: "every entry must be a valid hostname",
  });

const pathList = z
  .array(z.string().trim().min(1).max(300))
  .max(100)
  .transform((list) => [...new Set(list)])
  .refine((list) => list.every((p) => p.startsWith("/")), {
    message: "every path must start with /",
  });

const ipList = z
  .array(z.string().trim())
  .max(200)
  .transform((list) => [...new Set(list)])
  .refine((list) => list.every(isIpOrCidr), {
    message: "every entry must be an IP address or CIDR range",
  });

const countryList = z
  .array(z.string())
  .max(250)
  .transform((list, ctx) => {
    const codes: string[] = [];
    for (const v of list) {
      const code = toCountryCode(v);
      if (!code) {
        ctx.addIssue({ code: "custom", message: `unknown country: ${v}` });
        return z.NEVER;
      }
      codes.push(code);
    }
    return [...new Set(codes)];
  });

export const UpdateWebsiteBody = z
  .object({
    domain: zDomain,
    name: z.string().trim().max(100).nullable(),
    logo: z.string().trim().url().max(500).nullable(),
    timezone: zTimezone,
    currency: zCurrency,
    kpi: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => v === "revenue" || GOAL_NAME_RE.test(v), {
        message: "must be a goal name or 'revenue'",
      })
      .nullable(),
    kpiColorScheme: z.string().trim().max(32).nullable(),
    revenueMetric: z.enum(["revenue", "mrr"]),
    sendWeeklyReports: z.boolean(),
    sendViralTrafficAlerts: z.boolean(),
    isPublicDashboardEnabled: z.boolean(),
    isPublicDataEnabled: z.boolean(),
    isCookieless: z.boolean(),
    isAttackModeEnabled: z.boolean(),
    includeRenewalRevenue: z.boolean(),
    allowedHostnames: hostnameList,
    isAllHostnamesAllowed: z.boolean(),
    excludedIps: ipList,
    excludedPaths: pathList,
    excludedCountries: countryList,
    excludedHostnames: hostnameList,
    // DataGoat extensions
    privacyMode: z.enum(PRIVACY_MODES as [string, ...string[]]),
    attributionModel: z.enum(ATTRIBUTION_MODELS as [string, ...string[]]),
    botLevel: z.enum(BOT_LEVELS as [string, ...string[]]),
    honorGpc: z.boolean(),
    storeCustomerEmails: z.boolean(),
    retentionDays: z.number().int().min(30).max(36500).nullable(),
  })
  .partial()
  .strict();
export type UpdateWebsiteInput = z.output<typeof UpdateWebsiteBody>;

/** Column assignments for an update. Returns an empty list when nothing changes. */
export function settingsAssignments(
  site: Site,
  input: UpdateWebsiteInput,
): Array<[string, unknown]> {
  const set: Array<[string, unknown]> = [];
  const json = (v: unknown) => JSON.stringify(v);
  const flag = (v: boolean) => (v ? 1 : 0);
  if (input.domain !== undefined) set.push(["domain", input.domain]);
  if (input.name !== undefined) set.push(["name", input.name]);
  if (input.logo !== undefined) set.push(["logo", input.logo]);
  if (input.timezone !== undefined) set.push(["timezone", input.timezone]);
  if (input.currency !== undefined) set.push(["currency", input.currency]);
  if (input.kpi !== undefined) set.push(["kpi", input.kpi === "revenue" ? null : input.kpi]);
  if (input.kpiColorScheme !== undefined) set.push(["kpi_color_scheme", input.kpiColorScheme]);
  if (input.revenueMetric !== undefined) set.push(["revenue_metric", input.revenueMetric]);
  if (input.sendWeeklyReports !== undefined)
    set.push(["send_weekly_reports", flag(input.sendWeeklyReports)]);
  if (input.sendViralTrafficAlerts !== undefined) {
    set.push(["send_viral_traffic_alerts", flag(input.sendViralTrafficAlerts)]);
  }
  if (input.isPublicDashboardEnabled !== undefined) {
    if (input.isPublicDashboardEnabled && !site.shareToken)
      set.push(["share_token", randomToken(18)]);
    if (!input.isPublicDashboardEnabled) set.push(["share_token", null]);
  }
  if (input.isPublicDataEnabled !== undefined)
    set.push(["public_data_enabled", flag(input.isPublicDataEnabled)]);
  let privacy = input.privacyMode;
  if (privacy === undefined && input.isCookieless !== undefined) {
    privacy = input.isCookieless
      ? "cookieless"
      : site.privacyMode === "cookieless"
        ? "cookie"
        : site.privacyMode;
  }
  if (privacy !== undefined) set.push(["privacy_mode", privacy]);
  let botLevel = input.botLevel;
  if (botLevel === undefined && input.isAttackModeEnabled !== undefined) {
    botLevel = input.isAttackModeEnabled
      ? "strict"
      : site.botLevel === "strict"
        ? "standard"
        : site.botLevel;
  }
  if (botLevel !== undefined) set.push(["bot_level", botLevel]);
  if (input.includeRenewalRevenue !== undefined) {
    set.push(["include_renewal_revenue", flag(input.includeRenewalRevenue)]);
  }
  if (input.allowedHostnames !== undefined)
    set.push(["allowed_hostnames", json(input.allowedHostnames)]);
  if (input.isAllHostnamesAllowed !== undefined) {
    set.push(["all_hostnames_allowed", flag(input.isAllHostnamesAllowed)]);
  }
  if (input.excludedIps !== undefined) set.push(["excluded_ips", json(input.excludedIps)]);
  if (input.excludedPaths !== undefined) set.push(["excluded_paths", json(input.excludedPaths)]);
  if (input.excludedCountries !== undefined)
    set.push(["excluded_countries", json(input.excludedCountries)]);
  if (input.excludedHostnames !== undefined)
    set.push(["excluded_hostnames", json(input.excludedHostnames)]);
  if (input.attributionModel !== undefined) set.push(["attribution_model", input.attributionModel]);
  if (input.honorGpc !== undefined) set.push(["honor_gpc", flag(input.honorGpc)]);
  if (input.storeCustomerEmails !== undefined)
    set.push(["store_customer_emails", flag(input.storeCustomerEmails)]);
  if (input.retentionDays !== undefined) set.push(["retention_days", input.retentionDays]);
  return set;
}

/** Apply a settings update and return the fresh site. */
export async function updateWebsite(
  db: D1Database,
  site: Site,
  input: UpdateWebsiteInput,
  now = Date.now(),
): Promise<Site> {
  const set = settingsAssignments(site, input);
  if (set.length === 0) throw new ApiError(400, "No valid fields in body");
  if (input.domain !== undefined && input.domain !== site.domain) {
    await assertDomainAvailable(db, input.domain, site.id);
  }
  set.push(["updated_at", now]);
  const row = await db
    .prepare(
      `UPDATE sites SET ${set.map(([col]) => `${col} = ?`).join(", ")} WHERE id = ? RETURNING *`,
    )
    .bind(...set.map(([, v]) => v), site.id)
    .first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "Website not found");
  siteCache.invalidate(site);
  return rowToSite(row);
}
