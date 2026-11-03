export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  INSTALL_SECRET: string;
  SECRET_VERSION: string;
  /** Signs the `dg_session` JWT (api.md §2.5). */
  SESSION_SECRET: string;
  /** Static dashboard assets (packages/dashboard/dist). */
  ASSETS: Fetcher;
  ENV?: string;
  /** Attribution window in days (§4). Defaults to 30. */
  ATTRIBUTION_WINDOW_DAYS?: string;
  /** How long a join can be back-filled (§9.2). Defaults to 90. */
  REATTRIBUTION_DAYS?: string;
  /** Fallback webhook secrets for single-site installs (§7.2). */
  WEBHOOK_SECRET_STRIPE?: string;
  WEBHOOK_SECRET_POLAR?: string;
  WEBHOOK_SECRET_DODO?: string;
  WEBHOOK_SECRET_CREEM?: string;
}

export interface Website {
  id: string;
  site_token: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  owner_user_id: string | null;
  privacy_mode: string;
  allow_cookieless: number;
  allowed_hosts: string;
  excluded_ips: string;
  excluded_paths: string;
  excluded_ua: string;
  hash_paths: number;
  attribution_model: string;
  retention_days: number;
  bot_filter_level: string;
  created_at: number;
  updated_at: number;
}

export type BotFilterLevel = 'off' | 'standard' | 'strict';

export const SESSION_GAP_S = 30 * 60;
export const COOKIE_VID = '_dg_vid';
export const COOKIE_SES = '_dg_ses';
export const HONEYPOT_VISITOR = 'dg_bot_trap';

/** Default per-IP and per-site ingest rate limits (requests / minute). */
export const RATE_LIMIT_IP_PER_MIN = 60;
export const RATE_LIMIT_SITE_PER_MIN = 600;
