export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  INSTALL_SECRET: string;
  SECRET_VERSION: string;
  ENV?: string;
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
