/**
 * Meta Marketing API client (Graph API, `ads_read`):
 * - ad accounts: `GET /me/adaccounts` (https://developers.facebook.com/docs/marketing-api/reference/user/adaccounts/)
 * - campaigns: `GET /act_<id>/campaigns` (https://developers.facebook.com/docs/marketing-api/reference/ad-account/campaigns/)
 * - insights: `GET /act_<id>/insights?level=campaign&time_increment=1`
 *   (https://developers.facebook.com/docs/marketing-api/insights/)
 * Calls carry `appsecret_proof` when META_APP_SECRET is set
 * (https://developers.facebook.com/docs/graph-api/securing-requests/).
 */
import { hmacSha256Hex } from "../../lib/crypto";
import { META_GRAPH } from "../integrations/oauth";
import { type Fetcher, requestJson } from "../shared/http";

const PURCHASE_ACTIONS = new Set([
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
]);

async function graphGet<T>(
  fetcher: Fetcher,
  env: Cloudflare.Env,
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = path.startsWith("https://") ? new URL(path) : new URL(`${META_GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  const secret = env.META_APP_SECRET?.trim();
  if (secret) url.searchParams.set("appsecret_proof", await hmacSha256Hex(secret, token));
  try {
    return await requestJson<T>(fetcher, "Meta", url.toString(), { timeoutMs: 15_000 });
  } catch (err) {
    // Never keep the token (it is in the URL) in a stored error.
    if (err instanceof Error) err.message = err.message.split(token).join("<token>");
    throw err;
  }
}

export interface AdAccount {
  id: string;
  name: string | null;
  currency: string | null;
  accountStatus: number | null;
}

export async function listAdAccounts(
  fetcher: Fetcher,
  env: Cloudflare.Env,
  token: string,
): Promise<AdAccount[]> {
  const res = await graphGet<{
    data?: Array<{ id: string; name?: string; currency?: string; account_status?: number }>;
  }>(fetcher, env, token, "me/adaccounts", {
    fields: "id,name,currency,account_status",
    limit: "100",
  });
  return (res.data ?? []).map((a) => ({
    id: a.id,
    name: a.name ?? null,
    currency: a.currency ?? null,
    accountStatus: a.account_status ?? null,
  }));
}

export interface Campaign {
  id: string;
  name: string | null;
  status: string | null;
}

export async function listCampaigns(
  fetcher: Fetcher,
  env: Cloudflare.Env,
  token: string,
  accountId: string,
): Promise<Campaign[]> {
  const res = await graphGet<{
    data?: Array<{ id: string; name?: string; effective_status?: string; status?: string }>;
  }>(fetcher, env, token, `${accountId}/campaigns`, {
    fields: "id,name,status,effective_status",
    limit: "200",
  });
  return (res.data ?? []).map((c) => ({
    id: c.id,
    name: c.name ?? null,
    status: c.effective_status ?? c.status ?? null,
  }));
}

export interface InsightRow {
  campaignId: string;
  campaignName: string | null;
  day: string;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  purchaseValue: number | null;
}

interface RawInsight {
  campaign_id?: string;
  campaign_name?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  account_currency?: string;
  action_values?: Array<{ action_type?: string; value?: string }>;
}

export async function campaignInsights(
  fetcher: Fetcher,
  env: Cloudflare.Env,
  token: string,
  accountId: string,
  campaignIds: readonly string[],
  since: string,
  until: string,
  maxPages = 3,
): Promise<InsightRow[]> {
  const out: InsightRow[] = [];
  let next: string | null = `${accountId}/insights`;
  let params: Record<string, string> = {
    level: "campaign",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields:
      "campaign_id,campaign_name,spend,impressions,clicks,reach,action_values,account_currency",
    filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: campaignIds }]),
    limit: "500",
  };
  for (let page = 0; next && page < maxPages; page++) {
    const res: { data?: RawInsight[]; paging?: { next?: string } } = await graphGet(
      fetcher,
      env,
      token,
      next,
      params,
    );
    for (const r of res.data ?? []) {
      if (!r.campaign_id || !r.date_start) continue;
      const purchases = (r.action_values ?? []).filter(
        (a) => a.action_type && PURCHASE_ACTIONS.has(a.action_type),
      );
      out.push({
        campaignId: r.campaign_id,
        campaignName: r.campaign_name ?? null,
        day: r.date_start,
        currency: r.account_currency ?? null,
        spend: Number(r.spend ?? 0) || 0,
        impressions: Number(r.impressions ?? 0) || 0,
        clicks: Number(r.clicks ?? 0) || 0,
        reach: Number(r.reach ?? 0) || 0,
        purchaseValue: purchases.length
          ? Math.max(...purchases.map((a) => Number(a.value ?? 0) || 0))
          : null,
      });
    }
    next = res.paging?.next ?? null;
    params = {};
  }
  return out;
}
