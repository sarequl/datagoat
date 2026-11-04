/**
 * Optional secrets and variables used by the growth features (W6). All are optional: a feature
 * whose provider is not configured is reported as "not configured" by its status endpoint.
 * Setup for each lives in docs/growth/.
 */
declare namespace Cloudflare {
  interface Env {
    /** Email via Postmark (alternative to RESEND_API_KEY). */
    POSTMARK_SERVER_TOKEN?: string;
    /** Default Telegram bot token for alerts that do not bring their own. */
    TELEGRAM_BOT_TOKEN?: string;
    /** Max notifications one alert may send per UTC day (default 100). */
    ALERT_DAILY_LIMIT?: string;
    /** GitHub OAuth app / GitHub App client credentials for the commit markers integration. */
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    /** Google OAuth client for Search Console. */
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /** Max Search Console query/page rows stored per day (default 500). */
    GSC_ROWS_PER_DAY?: string;
    /** Meta app for Meta Ads (Marketing API, ads_read). */
    META_APP_ID?: string;
    META_APP_SECRET?: string;
    /** X OAuth 2.0 client, and/or an app-only bearer token for recent search. */
    X_CLIENT_ID?: string;
    X_CLIENT_SECRET?: string;
    X_BEARER_TOKEN?: string;
    /** Reddit "script"/web app credentials (app-only OAuth). Without them the public JSON is used. */
    REDDIT_CLIENT_ID?: string;
    REDDIT_CLIENT_SECRET?: string;
    /** Accepted bot traffic requests per UTC calendar month for the whole install. Unset = unlimited. */
    BOT_TRAFFIC_ALLOWANCE?: string;
  }
}
