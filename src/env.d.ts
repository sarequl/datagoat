/**
 * Secrets and optional variables not declared in wrangler.jsonc (so `wrangler types` cannot see
 * them). Bindings declared in wrangler.jsonc are generated into worker-configuration.d.ts by
 * `npm run cf-typegen`.
 */
declare namespace Cloudflare {
  interface Env {
    /** One-time first-run setup token (secret). */
    SETUP_TOKEN: string;
    /** HMAC key for dashboard session cookies (secret, >= 32 chars). */
    SESSION_SECRET: string;
    /** AES-GCM key material for credentials at rest (secret, >= 32 chars). */
    ENCRYPTION_KEY: string;
    /** Optional: email provider API key (Resend), used by alerts/digests/invites (W6). */
    RESEND_API_KEY?: string;
    /** Optional: sender address for outgoing email, e.g. "DataGoat <alerts@example.com>". */
    EMAIL_FROM?: string;
    /** Optional: max rows the website purge job deletes per hourly run (default 1000). */
    PURGE_ROWS_PER_RUN?: string;
    /** Optional: max D1 queries the cron multiplexer may use per run (default 40 on Free). */
    CRON_QUERY_BUDGET?: string;
  }
}
