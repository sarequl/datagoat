/**
 * Growth integration settings (DG): `GET/PUT/DELETE /api/v1/admin/websites/:id/integrations/<slug>`
 * for github, google-search-console, meta-ads and x, and the OAuth connect flow
 * `GET /api/connect/<slug>/start?websiteId=…` → provider → `GET /api/connect/<slug>/callback`.
 *
 * Every integration can also be set up without OAuth by pasting a token in PUT (GitHub fine-grained
 * token, Meta system-user token, X bearer token), which suits single-operator installs.
 */
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { GrowthIntegrationStatus } from "../../../shared/api-types";
import { roleAllows } from "../../../shared/permissions";
import { getAccess, getAuth } from "../../auth/context";
import { getRole } from "../../auth/memberships";
import { authenticate, requireSession, resolveSiteAccess } from "../../auth/middleware";
import { hmacSha256Hex } from "../../lib/crypto";
import { ApiError } from "../../lib/errors";
import { randomToken } from "../../lib/ids";
import { errorFields, log } from "../../lib/log";
import { success } from "../../lib/response";
import { siteCache } from "../../lib/site-cache";
import { toIsoOrNull } from "../../lib/time";
import { parseJsonBody } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { autoSelectProperty } from "../gsc/client";
import {
  type Connection,
  encryptCredentials,
  getConnection,
  type IntegrationKind,
  KIND_SLUGS,
  upsertConnectionStatement,
} from "../shared/connections";
import { errorMessage } from "../shared/http";
import {
  authorizeUrl,
  clientCredentials,
  exchangeCode,
  newVerifier,
  oauthConfigured,
  PROVIDERS,
  pkceChallenge,
  RETURN_PAGES,
  STATE_COOKIE,
  STATE_TTL_MS,
  signState,
  verifyState,
} from "./oauth";

export const integrationRoutes = new Hono<AppEnv>();
const W = "/api/v1/admin/websites/:websiteId";

/** The per-site GitHub webhook secret (derived, so it needs no storage). */
export async function githubWebhookSecret(env: Cloudflare.Env, siteId: string): Promise<string> {
  return (await hmacSha256Hex(env.ENCRYPTION_KEY, `github-webhook:${siteId}`)).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Settings validation per kind
// ---------------------------------------------------------------------------

const zKeyword = z
  .string()
  .trim()
  .min(4, "keywords must be 4-15 characters")
  .max(15, "keywords must be 4-15 characters")
  .regex(/^[^"\\]+$/, "keywords cannot contain quotes or backslashes");
const zHandle = z
  .string()
  .trim()
  .transform((h) => h.replace(/^@/, ""))
  .refine((h) => /^[A-Za-z0-9_]{1,15}$/.test(h), {
    message: "must be an X handle such as @example",
  });

const Bodies = {
  github: z
    .object({
      repo: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/repository")
        .optional(),
      branch: z.string().trim().max(200).nullable().optional(),
      accessToken: z.string().trim().min(10).max(400).optional(),
    })
    .strict(),
  gsc: z
    .object({
      property: z
        .string()
        .trim()
        .max(300)
        .regex(
          /^(sc-domain:[a-z0-9.-]+|https?:\/\/\S+)$/i,
          "must be sc-domain:example.com or a URL-prefix property",
        )
        .optional(),
    })
    .strict(),
  meta_ads: z
    .object({
      adAccountIds: z
        .array(
          z
            .string()
            .trim()
            .regex(/^(act_)?\d{1,30}$/, "must be an ad account id"),
        )
        .max(20)
        .optional(),
      campaignIds: z
        .array(
          z
            .string()
            .trim()
            .regex(/^\d{1,30}$/, "must be a campaign id"),
        )
        .max(200)
        .optional(),
      campaignAccounts: z
        .record(z.string().regex(/^\d{1,30}$/), z.string().regex(/^act_\d{1,30}$/))
        .optional(),
      accessToken: z.string().trim().min(20).max(1000).optional(),
    })
    .strict(),
  x: z
    .object({
      keywords: z.array(zKeyword).max(20).optional(),
      handles: z.array(zHandle).max(20).optional(),
      redditEnabled: z.boolean().optional(),
      bearerToken: z.string().trim().min(20).max(1000).optional(),
    })
    .strict(),
} as const;

function missingSettings(kind: IntegrationKind, settings: Record<string, unknown>): boolean {
  switch (kind) {
    case "github":
      return !settings.repo;
    case "gsc":
      return !settings.property;
    case "meta_ads":
      return !Array.isArray(settings.campaignIds) || settings.campaignIds.length === 0;
    case "x":
      return false;
  }
}

async function statusDto(
  c: Context<AppEnv>,
  kind: IntegrationKind,
  conn: Connection | null,
  siteId: string,
  canWrite: boolean,
): Promise<GrowthIntegrationStatus> {
  const settings: Record<string, unknown> = { ...(conn?.settings ?? {}) };
  const origin = new URL(c.req.url).origin;
  if (kind === "github") {
    settings.webhookUrl = `${origin}/webhooks/github/${siteId}`;
    if (canWrite) settings.webhookSecret = await githubWebhookSecret(c.env, siteId);
  }
  if (kind === "x") {
    settings.keywords ??= [];
    settings.handles ??= [];
    settings.redditEnabled ??= true;
    settings.usesServerToken = !conn?.hasCredentials && Boolean(c.env.X_BEARER_TOKEN?.trim());
  }
  const configured = oauthConfigured(c.env, kind);
  const connected =
    conn !== null &&
    conn.status !== "disconnected" &&
    (conn.hasCredentials || kind === "x" || (kind === "github" && Boolean(conn.settings.repo)));
  return {
    kind,
    connected,
    status: conn?.status ?? null,
    settings,
    lastSyncedAt: toIsoOrNull(conn?.lastSyncedAt ?? null),
    lastError: conn?.lastError ?? null,
    oauthConfigured: configured,
    connectUrl: configured ? `/api/connect/${KIND_SLUGS[kind]}/start?websiteId=${siteId}` : null,
    hasCredentials: conn?.hasCredentials ?? false,
  };
}

for (const kind of Object.keys(KIND_SLUGS) as IntegrationKind[]) {
  const path = `${W}/integrations/${KIND_SLUGS[kind]}`;

  integrationRoutes.get(path, async (c) => {
    const { site, role } = await resolveSiteAccess(c, "settings:read", { param: "websiteId" });
    const conn = await getConnection(c.env.DB, site.id, kind);
    return success(c, await statusDto(c, kind, conn, site.id, roleAllows(role, "settings:write")));
  });

  integrationRoutes.put(path, async (c) => {
    const { site } = await resolveSiteAccess(c, "settings:write", { param: "websiteId" });
    const body = (await parseJsonBody(c, Bodies[kind], { maxBytes: 16 * 1024 })) as Record<
      string,
      unknown
    >;
    const current = await getConnection(c.env.DB, site.id, kind);
    const now = Date.now();
    const { accessToken, bearerToken, ...rest } = body as {
      accessToken?: string;
      bearerToken?: string;
    } & Record<string, unknown>;
    const settings: Record<string, unknown> = { ...(current?.settings ?? {}), ...rest };
    if (kind === "github" && rest.repo && rest.repo !== current?.settings.repo) {
      // A new repository starts a fresh backfill.
      await c.env.DB.prepare(
        "UPDATE integration_connections SET cursor = NULL WHERE site_id = ? AND kind = ?",
      )
        .bind(site.id, kind)
        .run();
    }
    if (kind === "meta_ads" && Array.isArray(settings.adAccountIds)) {
      settings.adAccountIds = (settings.adAccountIds as string[]).map((a) =>
        a.startsWith("act_") ? a : `act_${a}`,
      );
    }
    let credentialsEnc: string | undefined;
    const token = accessToken ?? bearerToken;
    if (token) {
      credentialsEnc = await encryptCredentials(
        c.env,
        kind,
        site.id,
        kind === "x"
          ? { bearerToken: token, accessToken: "", via: "token" }
          : { accessToken: token, via: "token" },
      );
    }
    const hasCreds = Boolean(credentialsEnc) || Boolean(current?.hasCredentials);
    // X runs on the server token / Reddit and GitHub can read public repositories without a token.
    const needsCreds = kind === "gsc" || kind === "meta_ads";
    const status =
      missingSettings(kind, settings) || (needsCreds && !hasCreds) ? "pending" : "active";
    await upsertConnectionStatement(c.env.DB, {
      siteId: site.id,
      kind,
      status,
      settings,
      credentialsEnc,
      now,
    }).run();
    const conn = await getConnection(c.env.DB, site.id, kind);
    return success(c, await statusDto(c, kind, conn, site.id, true));
  });

  integrationRoutes.delete(path, async (c) => {
    const { site } = await resolveSiteAccess(c, "settings:write", { param: "websiteId" });
    await c.env.DB.prepare("DELETE FROM integration_connections WHERE site_id = ? AND kind = ?")
      .bind(site.id, kind)
      .run();
    return success(c, await statusDto(c, kind, null, site.id, true));
  });
}

// ---------------------------------------------------------------------------
// OAuth connect
// ---------------------------------------------------------------------------

function redirectUri(c: Context<AppEnv>, kind: IntegrationKind): string {
  return `${new URL(c.req.url).origin}/api/connect/${KIND_SLUGS[kind]}/callback`;
}

function backTo(siteId: string, page: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `/app/${siteId}/${page}${qs ? `?${qs}` : ""}`;
}

for (const kind of Object.keys(KIND_SLUGS) as IntegrationKind[]) {
  const slug = KIND_SLUGS[kind];

  integrationRoutes.get(`/api/connect/${slug}/start`, authenticate, requireSession, async (c) => {
    const { site } = await resolveSiteAccess(c, "settings:write");
    const client = clientCredentials(c.env, kind);
    if (!client) {
      throw new ApiError(
        503,
        `${PROVIDERS[kind].label} OAuth is not configured: set ${PROVIDERS[kind].envId} and ${PROVIDERS[kind].envSecret} (see docs/growth/)`,
      );
    }
    const returnTo = (RETURN_PAGES as readonly string[]).includes(c.req.query("returnTo") ?? "")
      ? (c.req.query("returnTo") as string)
      : "integrations";
    const nonce = randomToken(16);
    const verifier = PROVIDERS[kind].pkce ? newVerifier() : "";
    const state = await signState(c.env.SESSION_SECRET, {
      kind,
      siteId: site.id,
      userId: getAccess(c).user.id,
      nonce,
      exp: Date.now() + STATE_TTL_MS,
      returnTo,
    });
    setCookie(c, STATE_COOKIE, `${nonce}.${verifier}`, {
      path: "/api/connect",
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      maxAge: STATE_TTL_MS / 1000,
    });
    const url = authorizeUrl(
      PROVIDERS[kind],
      client.id,
      redirectUri(c, kind),
      state,
      verifier ? await pkceChallenge(verifier) : null,
    );
    return c.redirect(url, 302);
  });

  integrationRoutes.get(
    `/api/connect/${slug}/callback`,
    authenticate,
    requireSession,
    async (c) => {
      const now = Date.now();
      const state = await verifyState(c.env.SESSION_SECRET, c.req.query("state") ?? "", now);
      const cookie = getCookie(c, STATE_COOKIE) ?? "";
      deleteCookie(c, STATE_COOKIE, { path: "/api/connect" });
      const [nonce = "", verifier = ""] = cookie.split(".");
      const user = getAuth(c).user;
      if (!state || state.kind !== kind || state.nonce !== nonce || state.userId !== user.id) {
        throw new ApiError(
          400,
          "Invalid or expired connection request; start again from the dashboard",
        );
      }
      // Re-check access now: the user's role may have changed during the round trip.
      const site = await siteCache.byId(c.env.DB, state.siteId);
      const role = site ? await getRole(c.env.DB, site.id, user.id) : null;
      if (!site || !role) throw new ApiError(404, "Website not found");
      if (!roleAllows(role, "settings:write")) {
        throw new ApiError(403, `Your role (${role}) does not allow settings:write`);
      }
      const providerError = c.req.query("error");
      if (providerError) {
        return c.redirect(
          backTo(site.id, state.returnTo, {
            error: providerError.slice(0, 100),
            integration: slug,
          }),
          302,
        );
      }
      const code = c.req.query("code");
      if (!code) throw new ApiError(400, "Missing authorization code");
      try {
        const creds = await exchangeCode(
          (i, init) => fetch(i, init),
          c.env,
          kind,
          code,
          redirectUri(c, kind),
          verifier || null,
          now,
        );
        const current = await getConnection(c.env.DB, site.id, kind);
        const settings: Record<string, unknown> = { ...(current?.settings ?? {}) };
        if (kind === "gsc" && !settings.property) {
          const property = await autoSelectProperty(
            (i, init) => fetch(i, init),
            creds.accessToken,
            site.domain,
          ).catch(() => null);
          if (property) settings.property = property;
        }
        await upsertConnectionStatement(c.env.DB, {
          siteId: site.id,
          kind,
          status: missingSettings(kind, settings) ? "pending" : "active",
          settings,
          credentialsEnc: await encryptCredentials(c.env, kind, site.id, creds),
          now,
        }).run();
      } catch (err) {
        log.warn("integrations.connect_failed", { kind, siteId: site.id, ...errorFields(err) });
        return c.redirect(
          backTo(site.id, state.returnTo, {
            error: errorMessage(err).slice(0, 200),
            integration: slug,
          }),
          302,
        );
      }
      return c.redirect(backTo(site.id, state.returnTo, { connected: slug }), 302);
    },
  );
}
