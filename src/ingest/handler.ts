/**
 * POST /api/events, in plan §8 order: parse → rate limit → site → hostname → bots → exclusions →
 * GPC/identity → enrich → one db.batch() in waitUntil → 200.
 *
 * Every response carries `Access-Control-Allow-Origin: *`. Bots and excluded hits get a plain
 * 200 so nothing about the filters leaks to the client; the reason is logged at debug level.
 */
import { ApiError, isApiError } from "../lib/errors";
import { errorFields, log } from "../lib/log";
import { errorResponse } from "../lib/response";
import { siteCache } from "../lib/site-cache";
import { parseBody, readBody } from "./body";
import { detectBot } from "./bots";
import { enrichSession, pageInfo } from "./enrich";
import { type ParsedEvent, parseEvent } from "./events";
import { matchExclusion } from "./exclusions";
import { geoFromCf } from "./geo";
import { checkHostname } from "./hostnames";
import { type Identity, isClientSessionId, resolveIdentity } from "./identity";
import { botStatement, buildEventBatch, engagementStatement } from "./write";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export interface IngestContext {
  env: Pick<Cloudflare.Env, "DB" | "INGEST_IP_LIMITER" | "INGEST_SITE_LIMITER">;
  waitUntil(promise: Promise<unknown>): void;
  now?: number;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}

function cfOf(req: Request): Record<string, unknown> | undefined {
  return (req as Request & { cf?: Record<string, unknown> }).cf;
}

function run(ctx: IngestContext, label: string, work: () => Promise<unknown>): void {
  ctx.waitUntil(
    work().catch((err) => log.error("ingest.write_failed", { label, ...errorFields(err) })),
  );
}

async function rateLimited(ctx: IngestContext, websiteId: string, ip: string): Promise<boolean> {
  const [byIp, bySite] = await Promise.all([
    ctx.env.INGEST_IP_LIMITER.limit({ key: `${websiteId}:${ip}` }),
    ctx.env.INGEST_SITE_LIMITER.limit({ key: websiteId }),
  ]);
  return !byIp.success || !bySite.success;
}

/** Handle one tracker event. Never throws: errors become CORS-enabled JSON error responses. */
export async function handleEvent(req: Request, ctx: IngestContext): Promise<Response> {
  try {
    return await process(req, ctx);
  } catch (err) {
    if (isApiError(err))
      return errorResponse(err.status, err.message, { ...CORS_HEADERS, ...err.headers });
    log.error("ingest.failed", errorFields(err));
    return errorResponse(500, "Internal server error", CORS_HEADERS);
  }
}

async function process(req: Request, ctx: IngestContext): Promise<Response> {
  const now = ctx.now ?? Date.now();
  const db = ctx.env.DB;

  // 1. Parse (≤ 8 KB, JSON whatever the content type).
  const body = parseBody(await readBody(req));
  const ip = clientIp(req);
  const ua = req.headers.get("user-agent") ?? "";

  // 2. Rate limit per site + IP and per site (Workers Rate Limiting bindings, no storage writes).
  if (await rateLimited(ctx, body.websiteId, ip)) {
    throw new ApiError(429, "Too many requests", { headers: { "Retry-After": "60" } });
  }

  // 3. Site (isolate cache, 60 s).
  const site = await siteCache.byPublicId(db, body.websiteId);
  if (!site) throw new ApiError(404, "Website not found");

  // 4. Hostname.
  const url = new URL(body.href);
  if (!checkHostname(site, url)) throw new ApiError(403, `Hostname ${url.hostname} is not allowed`);
  const page = pageInfo(url, body.trackHash);

  // 5. Bots.
  const geo = geoFromCf(cfOf(req));
  const bot = detectBot({
    ua,
    secChUa: req.headers.get("sec-ch-ua"),
    acceptLanguage: req.headers.get("accept-language"),
    asn: geo.asn,
    body,
    level: site.botLevel,
  });
  if (bot) {
    log.debug("ingest.bot", { site: site.id, reason: bot });
    run(ctx, "bot", () => botStatement(db, site.id, bot, now).run());
    return json({});
  }

  // 6. Exclusions: nothing stored, nothing counted.
  const excluded = matchExclusion(site, {
    ip: ip || null,
    path: url.pathname,
    hostname: page.hostname,
    country: geo.country,
    ua,
  });
  if (excluded) {
    log.debug("ingest.excluded", { site: site.id, reason: excluded });
    return json({});
  }

  // Validate the event before any identity work so malformed events cost no reads.
  const event = parseEvent(body);

  // Engagement beacons only update the session they belong to: no lookup, one statement.
  if (event.type === "engagement") {
    const sessionId = body.sessionId?.toLowerCase() ?? "";
    if (isClientSessionId(sessionId) && (event.activeMs > 0 || event.maxScroll !== null)) {
      run(ctx, "engagement", () =>
        engagementStatement(db, site.id, sessionId, event.activeMs, event.maxScroll).run(),
      );
    }
    return json({});
  }

  // DataFast compatibility: a browser with DataFast's cookie means the site came from DataFast.
  // Turn the setting on once (one write per website, ever); replies then tell the tracker to
  // also write `datafast_*` cookies, so checkout code reading `datafast_visitor_id` keeps working.
  const datafastCompat = site.datafastCompat || (body.datafastCookie && !site.datafastCompatOptOut);
  if (body.datafastCookie && !site.datafastCompat && !site.datafastCompatOptOut) {
    site.datafastCompat = true;
    run(ctx, "datafast-compat", async () => {
      await db
        .prepare("UPDATE sites SET datafast_compat = 1 WHERE id = ? AND datafast_compat = 0")
        .bind(site.id)
        .run();
      siteCache.invalidate(site);
    });
  }

  // 7–8. GPC and identity.
  const gpc = req.headers.get("sec-gpc") === "1";
  const identity = await resolveIdentity({ db, site, body, gpc, ip, ua, now });
  const accepted = applyPrivacy(event, identity);
  if (accepted) {
    // 9. Enrich, 10. write in one batch after responding.
    const dims = enrichSession(site, body, url, ua, geo);
    run(ctx, event.type, async () => {
      const stmts = await buildEventBatch(db, {
        site,
        identity,
        event: accepted,
        hostname: page.hostname,
        path: page.path,
        dims,
        body,
        now,
        linkIdentity: identity.mode === "cookie",
      });
      await db.batch(stmts);
    });
  }

  // 11. Respond. Cookieless hits learn their server ids (DataFast's cookieless script stores
  // `visitorId`; ours also keeps `sessionId` so consent can continue the same session).
  if (identity.mode === "cookieless") return json(cookielessResponse(identity));
  return json(datafastCompat ? { compat: "datafast" } : {});
}

function cookielessResponse(identity: Identity) {
  return { visitorId: identity.visitorId, sessionId: identity.sessionId };
}

/**
 * Cookieless hits do not link identities (DataFast's cookieless behaviour): `identify` is
 * ignored and a payment email is kept as an event without storing or matching the email.
 */
function applyPrivacy(event: ParsedEvent, identity: Identity): ParsedEvent | null {
  if (identity.mode !== "cookieless") return event;
  if (event.type === "identify") return null;
  return event;
}
