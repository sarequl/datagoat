/**
 * Bot traffic settings (`bot_settings`) and the optional `dgbot_` request token (`bot_tokens`;
 * tokens made before the rename start with `dfbot_` and keep working).
 * Both are read on every crawler ingest request, so they are cached per isolate for 30 seconds;
 * writers invalidate this isolate's entry (other isolates converge within the TTL).
 */
import type { BotTrafficSettings } from "../../../shared/api-types";
import { sha256Hex } from "../../lib/crypto";
import { parseJsonColumn } from "../../lib/d1";
import { randomBase62 } from "../../lib/ids";
import { COMPANIES, CRAWLERS, CRAWLERS_BY_ID } from "./catalog";

export const DEFAULT_SETTINGS: BotTrafficSettings = {
  hiddenCrawlers: [],
  excludedCrawlerIds: [],
  verifiedOnly: false,
  hideDashboardCard: false,
  groupBy: "crawlers",
  pageFilterIds: [],
  requireAuthToken: false,
};

export function normaliseSettings(raw: Partial<BotTrafficSettings>): BotTrafficSettings {
  const ids = (v: unknown) =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === "string"))].sort()
      : [];
  return {
    hiddenCrawlers: ids(raw.hiddenCrawlers),
    excludedCrawlerIds: ids(raw.excludedCrawlerIds).filter((id) => CRAWLERS_BY_ID.has(id)),
    verifiedOnly: raw.verifiedOnly === true,
    hideDashboardCard: raw.hideDashboardCard === true,
    groupBy: raw.groupBy === "pages" ? "pages" : "crawlers",
    pageFilterIds: Array.isArray(raw.pageFilterIds)
      ? raw.pageFilterIds.filter((x): x is string => typeof x === "string").slice(0, 100)
      : [],
    requireAuthToken: raw.requireAuthToken === true,
  };
}

export interface BotSiteConfig {
  settings: BotTrafficSettings;
  tokenHash: string | null;
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: BotSiteConfig }>();

export function invalidateBotConfig(siteId?: string): void {
  if (siteId) cache.delete(siteId);
  else cache.clear();
}

export async function loadBotConfig(
  db: D1Database,
  siteId: string,
  now = Date.now(),
): Promise<BotSiteConfig> {
  const hit = cache.get(siteId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const row = await db
    .prepare(
      `SELECT (SELECT settings FROM bot_settings WHERE site_id = ?1) AS settings,
              (SELECT token_hash FROM bot_tokens WHERE site_id = ?1) AS token_hash`,
    )
    .bind(siteId)
    .first<{ settings: string | null; token_hash: string | null }>();
  const value: BotSiteConfig = {
    settings: normaliseSettings(parseJsonColumn(row?.settings ?? null, {})),
    tokenHash: row?.token_hash ?? null,
  };
  if (cache.size > 2000) cache.clear();
  cache.set(siteId, { at: now, value });
  return value;
}

export function saveSettingsStatement(
  db: D1Database,
  siteId: string,
  settings: BotTrafficSettings,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO bot_settings (site_id, settings, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (site_id) DO UPDATE SET settings = ?2, updated_at = ?3`,
    )
    .bind(siteId, JSON.stringify(settings), now);
}

/** DataFast's crawlerCatalog: companies with enabled/disabled/partial status and their agents. */
export function crawlerCatalog(settings: BotTrafficSettings) {
  const excluded = new Set(settings.excludedCrawlerIds);
  return COMPANIES.map((company) => {
    const agents = CRAWLERS.filter((c) => c.company === company).map((c) => ({
      id: c.id,
      userAgent: c.userAgent,
      category: c.category,
      description: c.description,
      docs: c.docs,
      ipVerified: Boolean(c.ipSource),
      enabled: !excluded.has(c.id),
    }));
    const enabledAgentCount = agents.filter((a) => a.enabled).length;
    return {
      company,
      status:
        enabledAgentCount === agents.length
          ? "enabled"
          : enabledAgentCount === 0
            ? "disabled"
            : "partial",
      enabledAgentCount,
      totalAgentCount: agents.length,
      agents,
    };
  });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function newBotToken(): string {
  return `dgbot_${randomBase62(32)}`;
}

export function hashBotToken(token: string): Promise<string> {
  return sha256Hex(`dfbot:${token}`);
}

export function displayBotToken(token: string): string {
  return `${token.slice(0, 10)}...${token.slice(-4)}`;
}
