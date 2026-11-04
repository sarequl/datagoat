/**
 * Payment integrations under `/api/v1/admin/websites/:websiteId/integrations` (DataFast's
 * integrations API, docs: api/account/integrations*).
 *
 *   GET                       status of every provider (no secrets)          settings:read
 *   POST   …/<provider>       validate credentials, store encrypted, start   settings:write
 *                             backfill, create the webhook when possible
 *   PATCH  …/<provider>       queue a historical re-sync (DataFast: Paddle);  settings:write
 *                             DG: `{webhookSecret}` replaces the signing secret
 *   DELETE …/<provider>       disconnect; stored revenue is kept              settings:write
 *
 * Paths are explicit per provider: W6 owns sibling `/integrations/<growth>` routes.
 */
import { type Context, Hono } from "hono";
import type { IntegrationsStatus } from "../../shared/api-types";
import { getAccess } from "../auth/context";
import { requireSiteAccess } from "../auth/middleware";
import { parseJsonColumn } from "../lib/d1";
import { ApiError } from "../lib/errors";
import { log } from "../lib/log";
import { success } from "../lib/response";
import type { Site } from "../lib/sites";
import { toIsoOrNull } from "../lib/time";
import { readBodyText } from "../lib/validate";
import type { AppEnv } from "../types";
import { ADAPTERS } from "./adapters";
import {
  type ConnectionRow,
  decryptConnection,
  deleteConnection,
  loadConnectionRow,
  type SyncStateRow,
  saveConnection,
  saveWebhookSecret,
  syncStateUpsert,
} from "./connections";
import { budgetedFetch } from "./http";
import { adapterContext } from "./jobs";
import { PROVIDER_IDS, type ProviderId } from "./types";

export const integrationRoutes = new Hono<AppEnv>();

const I = "/api/v1/admin/websites/:websiteId/integrations";
const CONNECT_FETCH_BUDGET = 12;

export function webhookUrl(requestUrl: string, provider: ProviderId, site: Site): string {
  return `${new URL(requestUrl).origin}/webhooks/${provider}/${site.id}`;
}

function isPublicOrigin(requestUrl: string): boolean {
  const host = new URL(requestUrl).hostname;
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host) ||
    host === "[::1]"
  );
}

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const text = await readBodyText(c, 8 * 1024);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, "Invalid JSON body");
}

integrationRoutes.get(I, requireSiteAccess("settings:read", { param: "websiteId" }), async (c) => {
  const { site } = getAccess(c);
  const db = c.env.DB;
  const [connRes, stateRes] = await db.batch([
    db.prepare("SELECT * FROM provider_connections WHERE site_id = ?").bind(site.id),
    db
      .prepare("SELECT * FROM provider_sync_state WHERE site_id = ? AND stream = 'backfill'")
      .bind(site.id),
  ]);
  const rows = (connRes?.results ?? []) as unknown as ConnectionRow[];
  const backfills = new Map(
    ((stateRes?.results ?? []) as unknown as SyncStateRow[]).map((s) => [s.provider, s]),
  );
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const connected = (p: ProviderId) => {
    const r = byProvider.get(p);
    return !!r && r.status !== "disconnected";
  };
  const status: IntegrationsStatus = {
    stripe: { connected: connected("stripe") },
    lemonsqueezy: { connected: connected("lemonsqueezy") },
    polar: { connected: connected("polar") },
    paddle: {
      connected: connected("paddle"),
      keyExpiresAt: toIsoOrNull(byProvider.get("paddle")?.key_expires_at ?? null),
    },
    shopify: { connected: connected("shopify") },
    woocommerce: { connected: connected("woocommerce") },
    currency: site.currency,
    dodo: { connected: connected("dodo") },
    creem: { connected: connected("creem") },
    details: rows.map((r) => {
      const settings = parseJsonColumn<Record<string, unknown>>(r.settings, {});
      return {
        provider: r.provider as ProviderId,
        status: r.status,
        accountName: r.account_name,
        lastSyncedAt: toIsoOrNull(r.last_synced_at),
        lastError: r.last_error ?? backfills.get(r.provider)?.last_error ?? null,
        backfillComplete: !ADAPTERS[r.provider as ProviderId]?.backfill
          ? true
          : backfills.get(r.provider)?.done === 1,
        webhookUrl: webhookUrl(c.req.url, r.provider as ProviderId, site),
        webhookConfigured: r.webhook_secret_enc !== null,
        webhookAutoCreated: settings.webhookAuto === true,
      };
    }),
  };
  return success(c, [status]);
});

for (const provider of PROVIDER_IDS) {
  const adapter = ADAPTERS[provider];
  const path = `${I}/${provider}`;

  integrationRoutes.post(
    path,
    requireSiteAccess("settings:write", { param: "websiteId" }),
    async (c) => {
      const { site } = getAccess(c);
      const body = await readJson(c);
      const now = Date.now();
      const actx = adapterContext(c.env, budgetedFetch(fetch, CONNECT_FETCH_BUDGET), now);
      const result = await adapter.validateCredentials(body, actx);
      if (!result.ok)
        throw new ApiError(400, result.error ?? `Invalid ${adapter.displayName} credentials`);
      const webhookSecret =
        typeof body.webhookSecret === "string" && body.webhookSecret.trim()
          ? body.webhookSecret.trim()
          : null;
      await saveConnection(c.env, {
        siteId: site.id,
        provider,
        credentials: result.credentials ?? {},
        webhookSecret,
        accountId: result.accountId ?? null,
        accountName: result.accountName ?? null,
        currency: result.currency ?? null,
        settings: result.settings ?? {},
        keyExpiresAt: result.keyExpiresAt ?? null,
        now,
        backfill: !!adapter.backfill,
        syncCursor: result.syncCursor === undefined ? undefined : result.syncCursor,
      });
      const url = webhookUrl(c.req.url, provider, site);
      let configured = webhookSecret !== null;
      if (!configured && adapter.setupWebhook && isPublicOrigin(c.req.url)) {
        const row = await loadConnectionRow(c.env.DB, site.id, provider);
        if (row) {
          const conn = await decryptConnection(c.env, row);
          const setup = await adapter.setupWebhook(conn, url, actx).catch(() => null);
          if (setup) {
            await saveWebhookSecret(c.env, site.id, provider, setup.secret, {
              webhookId: setup.webhookId,
              webhookAuto: true,
            });
            configured = true;
          }
        }
      }
      log.info("providers.connected", { provider, siteId: site.id, webhook: configured });
      return success(c, [
        {
          message: `${adapter.displayName} connected successfully`,
          ...(provider === "polar" ? {} : { currency: site.currency }),
          webhookUrl: url,
          webhookConfigured: configured,
        },
      ]);
    },
  );

  integrationRoutes.patch(
    path,
    requireSiteAccess("settings:write", { param: "websiteId" }),
    async (c) => {
      const { site } = getAccess(c);
      const body = await readJson(c);
      const row = await loadConnectionRow(c.env.DB, site.id, provider);
      if (!row || row.status === "disconnected")
        throw new ApiError(400, `${adapter.displayName} is not connected to this website`);
      const now = Date.now();
      if (typeof body.webhookSecret === "string") {
        await saveWebhookSecret(c.env, site.id, provider, body.webhookSecret.trim() || null, {
          webhookAuto: false,
        });
      }
      const db = c.env.DB;
      await db.batch([
        syncStateUpsert(db, site.id, provider, "backfill", null, adapter.backfill ? 0 : 1, now),
        db
          .prepare(
            "UPDATE provider_connections SET status = 'active', last_error = NULL, updated_at = ? WHERE site_id = ? AND provider = ?",
          )
          .bind(now, site.id, provider),
      ]);
      return success(c, [{ message: `${adapter.displayName} payment re-sync queued` }]);
    },
  );

  integrationRoutes.delete(
    path,
    requireSiteAccess("settings:write", { param: "websiteId" }),
    async (c) => {
      const { site } = getAccess(c);
      const row = await loadConnectionRow(c.env.DB, site.id, provider);
      if (row && adapter.removeWebhook) {
        const conn = await decryptConnection(c.env, row).catch(() => null);
        if (conn?.settings.webhookAuto === true) {
          const actx = adapterContext(c.env, budgetedFetch(fetch, 2), Date.now());
          await adapter.removeWebhook(conn, actx).catch(() => undefined);
        }
      }
      await deleteConnection(c.env.DB, site.id, provider);
      return success(c, [{ message: `${adapter.displayName} disconnected successfully` }]);
    },
  );
}
