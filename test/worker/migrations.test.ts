import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tableNames } from "../helpers/db";

describe("migrations", () => {
  it("creates every table of the data model", async () => {
    const tables = await tableNames();
    for (const t of [
      "instance_settings",
      "sites",
      "users",
      "memberships",
      "auth_sessions",
      "invites",
      "password_resets",
      "api_keys",
      "oauth_clients",
      "oauth_connections",
      "oauth_codes",
      "oauth_tokens",
      "idempotency_keys",
      "visitors",
      "sessions",
      "events",
      "payments",
      "provider_connections",
      "provider_sync_state",
      "provider_customers",
      "payment_hints",
      "webhook_events",
      "fx_rates",
      "funnels",
      "goal_customizations",
      "segments",
      "notes",
      "prediction_models",
      "alerts",
      "alert_history",
      "outbox",
      "cookieless_salts",
      "daily_stats",
      "daily_pages",
      "daily_dimensions",
      "daily_goals",
      "bot_daily",
      "bot_traffic",
      "bot_settings",
      "bot_tokens",
      "integration_connections",
      "mentions",
      "x_links",
      "github_commits",
      "gsc_daily",
      "ad_spend_daily",
      "imports",
      "imported_daily",
      "job_state",
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });

  it("PRAGMA table_info works (pragma_table_info() is not authorized in D1)", async () => {
    const res = await env.DB.prepare("PRAGMA table_info(sessions)").all<{
      name: string;
      pk: number;
    }>();
    const cols = (res.results ?? []).map((r) => r.name);
    expect(cols).toContain("site_id");
  });
});
