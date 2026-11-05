/**
 * W2 — Public share links (DataFast "Public dashboard"). `GET /share/:token` serves the
 * dashboard shell for a valid token (via env.ASSETS) and 404s otherwise; `/api/share/:token/*`
 * serves read-only, PII-free analytics for the shared website with the same response shapes as
 * /api/v1/analytics/*. Revenue fields appear only when the website enables public data.
 * No visitors, notes, goals metadata or settings are exposed. Requests are rate limited per
 * client IP with the API_LIMITER binding (no KV/D1 writes).
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { ApiError } from "../../../lib/errors";
import { rateLimitBody, success } from "../../../lib/response";
import { loadSiteByShareToken, type Site } from "../../../lib/sites";
import type { AppEnv } from "../../../types";
import { SHARED_ENDPOINTS } from "../analytics/handlers";

export const publicRoutes = new Hono<AppEnv>();

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

async function siteForToken(c: Context<AppEnv>): Promise<Site> {
  const token = c.req.param("token") ?? "";
  const site = TOKEN_RE.test(token) ? await loadSiteByShareToken(c.env.DB, token) : null;
  if (!site) throw new ApiError(404, "Shared dashboard not found");
  return site;
}

async function limitShare(c: Context<AppEnv>): Promise<Response | null> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const outcome = await c.env.API_LIMITER.limit({ key: `share:${ip}` });
  if (outcome.success) return null;
  const reset = Math.floor(Date.now() / 60_000 + 1) * 60;
  return c.json(rateLimitBody(60, 0, reset), 429, { "Retry-After": "60" });
}

/** The dashboard shell for a valid share token; `framable` for embeddable widgets. */
async function shareShell(c: Context<AppEnv>, framable: boolean): Promise<Response> {
  const token = c.req.param("token") ?? "";
  const site = TOKEN_RE.test(token) ? await loadSiteByShareToken(c.env.DB, token) : null;
  if (!site) {
    return c.text("Shared dashboard not found", 404, { "X-Robots-Tag": "noindex" });
  }
  const res = await c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", "noindex");
  out.headers.set("Cache-Control", "no-store");
  if (framable) {
    // Widgets are meant to be embedded on the owner's own pages (DataFast's widgets).
    out.headers.delete("X-Frame-Options");
    out.headers.set("Content-Security-Policy", "frame-ancestors *");
  } else {
    out.headers.set("X-Frame-Options", "DENY");
  }
  return out;
}

publicRoutes.get("/share/:token", (c) => shareShell(c, false));
/** Finisher: embeddable widget (`<iframe src="/share/<token>/widget?type=…">`). */
publicRoutes.get("/share/:token/widget", (c) => shareShell(c, true));

publicRoutes.get("/api/share/:token", async (c) => {
  const limited = await limitShare(c);
  if (limited) return limited;
  const site = await siteForToken(c);
  return success(c, {
    domain: site.domain,
    name: site.name,
    logo: site.logo,
    timezone: site.timezone,
    currency: site.currency,
    showRevenue: site.publicDataEnabled,
  });
});

publicRoutes.get("/api/share/:token/analytics/:endpoint{.+}", async (c) => {
  const limited = await limitShare(c);
  if (limited) return limited;
  const site = await siteForToken(c);
  const handler = SHARED_ENDPOINTS[c.req.param("endpoint")];
  if (!handler) throw new ApiError(404, "This endpoint is not available on shared dashboards");
  return handler(c, site, { publicView: true, showRevenue: site.publicDataEnabled });
});
