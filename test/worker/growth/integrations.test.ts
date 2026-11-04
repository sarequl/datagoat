import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { syncGithub } from "../../../src/growth/commits/github";
import { githubWebhookSecret } from "../../../src/growth/integrations/routes";
import { hmacSha256Hex } from "../../../src/lib/crypto";
import { meterEnv, resetDb } from "../../helpers/db";
import {
  addMember,
  createApiKey,
  createSite,
  createUser,
  sessionCookie,
} from "../../helpers/factories";
import { api } from "../../helpers/http";
import { apiWith, jobCtx, jsonResponse, mockFetch, useGlobalFetch } from "./helpers";

beforeEach(() => resetDb());

const OAUTH = {
  GITHUB_CLIENT_ID: "gh-client",
  GITHUB_CLIENT_SECRET: "gh-secret",
  GOOGLE_CLIENT_ID: "g-client",
  GOOGLE_CLIENT_SECRET: "g-secret",
  META_APP_ID: "meta-app",
  META_APP_SECRET: "meta-secret",
  X_CLIENT_ID: "x-client",
  X_CLIENT_SECRET: "x-secret",
};

async function setup() {
  const owner = await createUser();
  const site = await createSite(owner.id, { domain: "example.com" });
  return {
    owner,
    site,
    cookie: await sessionCookie(owner.id),
    W: `/api/v1/admin/websites/${site.id}/integrations`,
  };
}

describe("integration settings", () => {
  it("stores X keywords and handles (validated) and reports status", async () => {
    const { site, cookie, W } = await setup();
    const empty = await api(`${W}/x`, { cookie });
    expect(empty.body.data).toMatchObject({
      kind: "x",
      connected: false,
      status: null,
      oauthConfigured: false,
      connectUrl: null,
    });
    const bad = await api(`${W}/x`, { cookie, method: "PUT", body: { keywords: ["abc"] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain("4-15 characters");
    const saved = await api(`${W}/x`, {
      cookie,
      method: "PUT",
      body: {
        keywords: ["DataGoat", "#goatstats"],
        handles: ["@founder"],
        bearerToken: "AAAAAAAAAAAAAAAAAAAAAAAAAtoken",
      },
    });
    expect(saved.body.data).toMatchObject({
      kind: "x",
      connected: true,
      status: "active",
      hasCredentials: true,
      settings: { keywords: ["DataGoat", "#goatstats"], handles: ["founder"], redditEnabled: true },
    });
    expect(JSON.stringify(saved.body)).not.toContain("AAAAAAAA");
    const stored = await env.DB.prepare(
      "SELECT credentials_enc FROM integration_connections WHERE site_id = ? AND kind = 'x'",
    )
      .bind(site.id)
      .first<{ credentials_enc: string }>();
    expect(stored?.credentials_enc).toMatch(/^v1\./);
    const removed = await api(`${W}/x`, { cookie, method: "DELETE" });
    expect(removed.body.data.connected).toBe(false);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM integration_connections").first("n"),
    ).toBe(0);
  });

  it("GitHub: repository settings, webhook URL and secret only for writers", async () => {
    const { owner, site, cookie, W } = await setup();
    const res = await api(`${W}/github`, { cookie, method: "PUT", body: { repo: "acme/web" } });
    expect(res.body.data).toMatchObject({
      connected: true,
      status: "active",
      settings: { repo: "acme/web" },
    });
    expect(res.body.data.settings.webhookUrl).toBe(
      `https://datagoat.test/webhooks/github/${site.id}`,
    );
    expect(res.body.data.settings.webhookSecret).toBe(await githubWebhookSecret(env, site.id));
    const viewer = await createUser();
    await addMember(site.id, viewer.id, "viewer");
    const asViewer = await api(`${W}/github`, { cookie: await sessionCookie(viewer.id) });
    expect(asViewer.body.data.settings.webhookSecret).toBeUndefined();
    expect(
      (
        await api(`${W}/github`, {
          cookie: await sessionCookie(viewer.id),
          method: "PUT",
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(`${W}/github`, { cookie, method: "PUT", body: { repo: "not a repo" } })).status,
    ).toBe(400);
    const key = await createApiKey({ userId: owner.id, siteId: site.id });
    expect((await api(`${W}/github`, { token: key.secret })).status).toBe(200);
  });

  it("Search Console and Meta stay pending until connected and configured", async () => {
    const { cookie, W } = await setup();
    const gsc = await api(`${W}/google-search-console`, {
      cookie,
      method: "PUT",
      body: { property: "sc-domain:example.com" },
    });
    expect(gsc.body.data).toMatchObject({ kind: "gsc", status: "pending", connected: false });
    const meta = await api(`${W}/meta-ads`, {
      cookie,
      method: "PUT",
      body: {
        adAccountIds: ["123"],
        campaignIds: ["456"],
        accessToken: "EAAB-system-user-token-xxxxxxxx",
      },
    });
    expect(meta.body.data).toMatchObject({
      kind: "meta_ads",
      status: "active",
      connected: true,
      settings: { adAccountIds: ["act_123"], campaignIds: ["456"] },
    });
  });
});

describe("OAuth connect", () => {
  it("returns 503 when the provider is not configured and requires a session", async () => {
    const { site, cookie, owner } = await setup();
    const res = await api(`/api/connect/github/start?websiteId=${site.id}`, { cookie });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toContain("GITHUB_CLIENT_ID");
    const token = await createApiKey({ userId: owner.id });
    expect(
      (
        await apiWith(OAUTH, `/api/connect/github/start?websiteId=${site.id}`, {
          token: token.secret,
        })
      ).status,
    ).toBe(403);
    expect((await apiWith(OAUTH, `/api/connect/github/start?websiteId=${site.id}`)).status).toBe(
      401,
    );
  });

  it("Google: PKCE start → callback exchanges the code, picks the property, stores encrypted tokens", async () => {
    const { site, cookie } = await setup();
    const start = await apiWith(
      OAUTH,
      `/api/connect/google-search-console/start?websiteId=${site.id}&returnTo=search-console`,
      { cookie },
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("client_id")).toBe("g-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://datagoat.test/api/connect/google-search-console/callback",
    );
    expect(location.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const state = location.searchParams.get("state") ?? "";
    const stateCookie = start.cookies[0]?.split(";")[0] ?? "";
    expect(stateCookie).toMatch(/^dg_oauth=/);
    expect(start.cookies[0]).toContain("HttpOnly");

    const fetch = mockFetch()
      .on("https://oauth2.googleapis.com/token", (call) => {
        const form = new URLSearchParams(call.body);
        expect(form.get("code")).toBe("auth-code");
        expect(form.get("code_verifier")).toBeTruthy();
        expect(form.get("client_secret")).toBe("g-secret");
        return {
          access_token: "ya29.token",
          refresh_token: "1//refresh",
          expires_in: 3599,
          scope: "webmasters.readonly",
        };
      })
      .on("https://www.googleapis.com/webmasters/v3/sites", () => ({
        siteEntry: [
          { siteUrl: "https://other.com/", permissionLevel: "siteOwner" },
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteFullUser" },
        ],
      }));
    useGlobalFetch(fetch);
    const cb = await apiWith(
      OAUTH,
      `/api/connect/google-search-console/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      {
        cookie: `${cookie}; ${stateCookie}`,
      },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(
      `/app/${site.id}/search-console?connected=google-search-console`,
    );
    const conn = await env.DB.prepare(
      "SELECT status, settings, credentials_enc FROM integration_connections WHERE kind = 'gsc'",
    ).first<Record<string, string>>();
    expect(conn?.status).toBe("active");
    expect(JSON.parse(conn?.settings ?? "{}")).toEqual({ property: "sc-domain:example.com" });
    expect(conn?.credentials_enc).not.toContain("ya29");

    // Replaying the callback without the state cookie fails.
    const replay = await apiWith(
      OAUTH,
      `/api/connect/google-search-console/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      { cookie },
    );
    expect(replay.status).toBe(400);
  });

  it("rejects a tampered state and reports provider errors back to the page", async () => {
    const { site, cookie } = await setup();
    const start = await apiWith(OAUTH, `/api/connect/meta-ads/start?websiteId=${site.id}`, {
      cookie,
    });
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
    expect(location.searchParams.get("scope")).toBe("ads_read");
    const state = location.searchParams.get("state") ?? "";
    const stateCookie = start.cookies[0]?.split(";")[0] ?? "";
    const tampered = `${state.slice(0, -2)}xx`;
    expect(
      (
        await apiWith(OAUTH, `/api/connect/meta-ads/callback?code=c&state=${tampered}`, {
          cookie: `${cookie}; ${stateCookie}`,
        })
      ).status,
    ).toBe(400);
    const denied = await apiWith(
      OAUTH,
      `/api/connect/meta-ads/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      {
        cookie: `${cookie}; ${stateCookie}`,
      },
    );
    expect(denied.headers.get("location")).toBe(
      `/app/${site.id}/integrations?error=access_denied&integration=meta-ads`,
    );
  });

  it("Meta: exchanges for a long-lived token; X uses basic auth at the token endpoint", async () => {
    const { site, cookie } = await setup();
    const fetch = mockFetch()
      .on("https://graph.facebook.com/v23.0/oauth/access_token", (call) =>
        new URL(call.url).searchParams.get("grant_type") === "fb_exchange_token" ||
        call.body.includes("fb_exchange_token")
          ? { access_token: "EAA-long", expires_in: 5184000 }
          : { access_token: "EAA-short", expires_in: 3600 },
      )
      .on("https://api.x.com/2/oauth2/token", (call) => {
        expect(call.headers.get("authorization")).toBe(`Basic ${btoa("x-client:x-secret")}`);
        return { access_token: "x-user", refresh_token: "x-refresh", expires_in: 7200 };
      });
    useGlobalFetch(fetch);
    for (const slug of ["meta-ads", "x"]) {
      const start = await apiWith(OAUTH, `/api/connect/${slug}/start?websiteId=${site.id}`, {
        cookie,
      });
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const stateCookie = start.cookies[0]?.split(";")[0] ?? "";
      const cb = await apiWith(
        OAUTH,
        `/api/connect/${slug}/callback?code=c&state=${encodeURIComponent(state)}`,
        {
          cookie: `${cookie}; ${stateCookie}`,
        },
      );
      expect(cb.headers.get("location")).toBe(`/app/${site.id}/integrations?connected=${slug}`);
    }
    const { decryptJson } = await import("../../../src/lib/crypto");
    const meta = await env.DB.prepare(
      "SELECT credentials_enc FROM integration_connections WHERE kind = 'meta_ads'",
    ).first<{ credentials_enc: string }>();
    expect(
      await decryptJson(
        env.ENCRYPTION_KEY,
        meta?.credentials_enc ?? "",
        `integration:meta_ads:${site.id}`,
      ),
    ).toMatchObject({ accessToken: "EAA-long" });
    const x = await api(`/api/v1/admin/websites/${site.id}/integrations/x`, { cookie });
    expect(x.body.data).toMatchObject({ connected: true, status: "active", hasCredentials: true });
  });
});

describe("GitHub commits", () => {
  const commit = (sha: string, date: string, message: string) => ({
    sha,
    html_url: `https://github.com/acme/web/commit/${sha}`,
    commit: { message, author: { name: "Ana", date } },
    author: { login: "ana", avatar_url: "https://avatars.githubusercontent.com/u/1" },
  });

  it("syncs commits, fills line stats and serves them filtered by prefix", async () => {
    const { site, cookie, W } = await setup();
    await api(`${W}/github`, {
      cookie,
      method: "PUT",
      body: { repo: "acme/web", accessToken: "github_pat_0123456789" },
    });
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const fetch = mockFetch()
      .on("https://api.github.com/repos/acme/web/commits?", () => [
        commit(shaA, "2026-10-20T10:00:00Z", "feat: new pricing page"),
        commit(shaB, "2026-10-21T10:00:00Z", "fix: typo"),
      ])
      .on(`https://api.github.com/repos/acme/web/commits/${shaA}`, () => ({
        stats: { additions: 120, deletions: 4 },
      }))
      .on(`https://api.github.com/repos/acme/web/commits/${shaB}`, () => ({
        stats: { additions: 1, deletions: 1 },
      }));
    const now = Date.UTC(2026, 10, 1);
    await syncGithub(jobCtx({ now, fetch }));
    expect(fetch.calls[0]?.headers.get("authorization")).toBe("Bearer github_pat_0123456789");
    expect(new URL(fetch.calls[0]?.url ?? "").searchParams.get("since")).toBe(
      new Date(now - 90 * 86_400_000).toISOString(),
    );
    // Second run fills stats (the first run stored commits before asking for stats).
    await syncGithub(jobCtx({ now: now + 3_600_000, fetch }));
    const res = await api(
      `/api/v1/github/commits?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31`,
      { cookie },
    );
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[1]).toEqual({
      sha: shaA,
      repo: "acme/web",
      branch: null,
      message: "feat: new pricing page",
      author: { name: "Ana", login: "ana", avatar: "https://avatars.githubusercontent.com/u/1" },
      additions: 120,
      deletions: 4,
      url: `https://github.com/acme/web/commit/${shaA}`,
      timestamp: "2026-10-20T10:00:00.000Z",
    });
    const feat = await api(
      `/api/v1/github/commits?websiteId=${site.id}&startAt=2026-10-01&endAt=2026-10-31&q=feat:`,
      { cookie },
    );
    expect(feat.body.data.map((c: { sha: string }) => c.sha)).toEqual([shaA]);

    // Re-reading the same commits writes nothing but the status row.
    const m = meterEnv();
    await syncGithub(jobCtx({ now: now + 7_200_000, fetch, db: m.db }));
    expect(m.d1.rowsWritten).toBe(1);
  });

  it("accepts signed push webhooks for the configured repository and branch", async () => {
    const { site, cookie, W } = await setup();
    await api(`${W}/github`, { cookie, method: "PUT", body: { repo: "acme/web" } });
    const payload = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "acme/web", default_branch: "main" },
      commits: [
        {
          id: "c".repeat(40),
          message: "feat: launch",
          timestamp: "2026-10-22T09:00:00Z",
          url: "https://github.com/acme/web/commit/c",
          author: { name: "Ana", username: "ana" },
        },
      ],
    });
    const secret = await githubWebhookSecret(env, site.id);
    const signature = `sha256=${await hmacSha256Hex(secret, payload)}`;
    const send = (body: string, sig: string, event = "push") =>
      api(`/webhooks/github/${site.id}`, {
        body,
        origin: null,
        headers: {
          "x-hub-signature-256": sig,
          "x-github-event": event,
          "content-type": "application/json",
        },
      });
    expect((await send(payload, "sha256=deadbeef")).status).toBe(401);
    expect((await send("{}", signature, "ping")).status).toBe(401);
    expect((await send(payload, signature)).body).toEqual({ ok: true, stored: 1 });
    const other = payload.replace("refs/heads/main", "refs/heads/dev");
    expect((await send(other, `sha256=${await hmacSha256Hex(secret, other)}`)).body.ignored).toBe(
      "other branch",
    );
    const row = await env.DB.prepare("SELECT message, author_avatar FROM github_commits").first();
    expect(row).toEqual({ message: "feat: launch", author_avatar: "https://github.com/ana.png" });
  });

  it("lists repositories for the connected account", async () => {
    const { site, cookie, W } = await setup();
    await api(`${W}/github`, {
      cookie,
      method: "PUT",
      body: { accessToken: "github_pat_0123456789" },
    });
    useGlobalFetch(
      mockFetch().on("https://api.github.com/user/repos", () => [
        { full_name: "acme/web", private: true, default_branch: "main" },
      ]),
    );
    const res = await api(`/api/v1/github/repos?websiteId=${site.id}`, { cookie });
    expect(res.body.data).toEqual([
      { fullName: "acme/web", private: true, defaultBranch: "main", pushedAt: null },
    ]);
    useGlobalFetch(
      mockFetch().on("https://api.github.com/user/repos", () =>
        jsonResponse({ message: "Bad credentials" }, 401),
      ),
    );
    const failed = await api(`/api/v1/github/repos?websiteId=${site.id}`, { cookie });
    expect(failed.body.error).toBe("GitHub: Bad credentials");
  });
});
