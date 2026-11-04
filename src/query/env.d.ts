/** Optional variables read by the query layer (W2). None is required. */
declare namespace Cloudflare {
  interface Env {
    /**
     * Breakdowns switch from raw tables to the daily rollups when the range holds at least this
     * many sessions (default 5000). Below it raw queries are cheap and exact.
     */
    ROLLUP_MIN_SESSIONS?: string;
    /** Max events the retention job deletes per hourly run (default 2000). */
    RETENTION_ROWS_PER_RUN?: string;
    /** "free" (default) or "paid": D1 plan, for the usage page's size and write limits. */
    D1_PLAN?: string;
    /** "off" disables the Workers Cache API for analytics responses. */
    ANALYTICS_CACHE?: string;
  }
}
