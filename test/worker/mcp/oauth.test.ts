/** MCP OAuth 2.1: metadata, registration, authorization, consent, tokens, revocation. */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import {
  addMember,
  createApiKey,
  createSite,
  createUser,
  sessionCookie,
} from "../../helpers/factories";
import { api, ORIGIN } from "../../helpers/http";
import {
  beginConsent,
  callTool,
  connect,
  decide,
  pkcePair,
  REDIRECT,
  raw,
  registerClient,
  request,
  rpc,
  startAuthorize,
  tokenRequest,
} from "./helpers";

beforeEach(() => resetDb());

async function world() {
  const owner = await createUser({ email: "owner@example.com" });
  const site = await createSite(owner.id, { domain: "a.example.com" });
  const other = await createSite(owner.id, { domain: "b.example.com" });
  return { owner, site, other };
}

describe("metadata", () => {
  it("publishes RFC 8414 authorization server metadata", async () => {
    const res = await raw("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    expect(res.body.scopes_supported).toContain("analytics:read");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const suffixed = await raw("/.well-known/oauth-authorization-server/mcp");
    expect(suffixed.body.issuer).toBe(ORIGIN);
  });

  it("publishes RFC 9728 protected resource metadata for both MCP paths", async () => {
    for (const [path, resource] of [
      ["/.well-known/oauth-protected-resource", `${ORIGIN}/mcp`],
      ["/.well-known/oauth-protected-resource/mcp", `${ORIGIN}/mcp`],
      ["/.well-known/oauth-protected-resource/api/mcp", `${ORIGIN}/api/mcp`],
    ]) {
      const res = await raw(path as string);
      expect(res.body).toMatchObject({
        resource,
        authorization_servers: [ORIGIN],
        bearer_methods_supported: ["header"],
      });
    }
  });
});

describe("dynamic client registration", () => {
  it("registers public clients without a secret", async () => {
    const res = await raw("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:33418/cb"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        unknown_extension: true,
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^dgc_/);
    expect(res.body.client_secret).toBeUndefined();
    expect(res.body.token_endpoint_auth_method).toBe("none");
    expect(res.body.unknown_extension).toBeUndefined();
  });

  it("issues a secret to confidential clients (RFC 7591 default method)", async () => {
    const res = await raw("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    expect(res.body.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(res.body.client_secret).toMatch(/^dgcs_/);
    const stored = await env.DB.prepare("SELECT secret_hash FROM oauth_clients WHERE id = ?")
      .bind(res.body.client_id)
      .first<{ secret_hash: string }>();
    expect(stored?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [{ redirect_uris: [] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["https://x.example/cb#frag"] }, "invalid_redirect_uri"],
    [{ redirect_uris: [REDIRECT], grant_types: ["password"] }, "invalid_client_metadata"],
    [{ redirect_uris: [REDIRECT], response_types: ["token"] }, "invalid_client_metadata"],
    [
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt" },
      "invalid_client_metadata",
    ],
    [
      { redirect_uris: [REDIRECT], logo_uri: "http://insecure.example/logo.png" },
      "invalid_client_metadata",
    ],
  ])("rejects %j", async (metadata, error) => {
    const res = await raw("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metadata),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });

  it("accepts native-app private-use schemes", async () => {
    const { clientId } = await registerClient({
      redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
    });
    expect(clientId).toMatch(/^dgc_/);
  });
});

describe("authorization endpoint", () => {
  it("sends errors about the client itself to the consent page, never to a redirect", async () => {
    const noClient = await startAuthorize({ response_type: "code" });
    expect(noClient.status).toBe(302);
    expect(noClient.location).toMatch(/^\/oauth\/consent\?error=invalid_request/);
    const unknown = await startAuthorize({ response_type: "code", client_id: "dgc_nope" });
    expect(unknown.location).toContain("error=invalid_client");
    const { clientId } = await registerClient();
    const badRedirect = await startAuthorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://evil.example/cb",
    });
    expect(badRedirect.location).toMatch(/^\/oauth\/consent\?error=invalid_request/);
  });

  it("redirects other errors back to the client with state and iss", async () => {
    const { clientId } = await registerClient();
    const { challenge } = await pkcePair();
    const cases: Array<[Record<string, string>, string]> = [
      [
        { response_type: "token", code_challenge: challenge, code_challenge_method: "S256" },
        "unsupported_response_type",
      ],
      [{ response_type: "code" }, "invalid_request"],
      [
        { response_type: "code", code_challenge: challenge, code_challenge_method: "plain" },
        "invalid_request",
      ],
      [{ response_type: "code", code_challenge: challenge }, "invalid_request"],
      [
        {
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: "https://elsewhere.example/mcp",
        },
        "invalid_target",
      ],
    ];
    for (const [params, error] of cases) {
      const res = await startAuthorize({
        client_id: clientId,
        redirect_uri: REDIRECT,
        state: "s1",
        ...params,
      });
      const loc = new URL(res.location);
      expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
      expect(loc.searchParams.get("error")).toBe(error);
      expect(loc.searchParams.get("state")).toBe("s1");
      expect(loc.searchParams.get("iss")).toBe(ORIGIN);
    }
  });

  it("accepts a loopback redirect on another port", async () => {
    const { clientId } = await registerClient({
      redirect_uris: ["http://127.0.0.1:8000/callback"],
    });
    const { challenge } = await pkcePair();
    const res = await startAuthorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:53682/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(res.location).toMatch(/^\/oauth\/consent\?request=/);
    const other = await startAuthorize({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:53682/other",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(other.location).toContain("error=invalid_request");
  });

  it("serves the consent page with anti-framing headers", async () => {
    const res = await raw("/oauth/consent?request=x");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("consent", () => {
  it("describes the request; signed in it lists the user's websites", async () => {
    const { owner, site } = await world();
    const { clientId } = await registerClient({ client_name: "Agent X" });
    const { challenge } = await pkcePair();
    const start = await beginConsent(clientId, challenge, {
      scope: "analytics:read team:write bogus",
    });
    const q = `/oauth/consent/details?request=${encodeURIComponent(start.requestToken)}`;
    const anon = await raw(q);
    expect(anon.status).toBe(200);
    expect(anon.body.data).toMatchObject({
      client: { id: clientId, name: "Agent X", redirectHost: "client.example" },
      resource: `${ORIGIN}/mcp`,
      user: null,
      websites: [],
    });
    const scopes = Object.fromEntries(
      anon.body.data.scopes.map((s: { scope: string }) => [s.scope, s]),
    );
    expect(scopes["analytics:read"]).toMatchObject({ requested: true, defaultChecked: true });
    expect(scopes["team:write"]).toMatchObject({
      requested: true,
      defaultChecked: false,
      sensitive: true,
    });
    expect(scopes["websites:read"]).toMatchObject({ requested: false, defaultChecked: false });
    const signedIn = await raw(q, { headers: { cookie: await sessionCookie(owner.id) } });
    expect(signedIn.body.data.user.email).toBe("owner@example.com");
    expect(signedIn.body.data.websites.map((w: { _id: string }) => w._id)).toContain(site.id);
  });

  it("pre-selects the read scopes when the client asked for none", async () => {
    const { clientId } = await registerClient();
    const { challenge } = await pkcePair();
    const start = await beginConsent(clientId, challenge);
    const res = await raw(
      `/oauth/consent/details?request=${encodeURIComponent(start.requestToken)}`,
    );
    const checked = res.body.data.scopes
      .filter((s: { defaultChecked: boolean }) => s.defaultChecked)
      .map((s: { scope: string }) => s.scope);
    expect(checked).toContain("analytics:read");
    expect(checked).toContain("websites:read");
    expect(checked).not.toContain("visitors:details");
    expect(checked.every((s: string) => !s.endsWith(":write"))).toBe(true);
  });

  it("rejects tampered and expired requests", async () => {
    const tampered = await raw("/oauth/consent/details?request=abc.def");
    expect(tampered.status).toBe(400);
    const { clientId } = await registerClient();
    const { challenge } = await pkcePair();
    const start = await beginConsent(clientId, challenge);
    const [body, sig] = start.requestToken.split(".");
    const payload = JSON.parse(atob((body ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    payload.e = Date.now() - 1;
    const forged = `${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${sig}`;
    expect((await raw(`/oauth/consent/details?request=${forged}`)).status).toBe(400);
  });

  it("requires a session, the browser that started the request and the same origin", async () => {
    const { owner, site } = await world();
    const { clientId } = await registerClient();
    const { challenge } = await pkcePair();
    const start = await beginConsent(clientId, challenge);
    const session = await sessionCookie(owner.id);
    const body = { approve: true, scopes: ["analytics:read"], websiteIds: [site.id] };
    expect((await decide(start, session, body, { cookie: start.consentCookie })).status).toBe(401);
    expect((await decide(start, session, body, { cookie: session })).status).toBe(403);
    const cross = await raw("/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        cookie: `${session}; ${start.consentCookie}`,
      },
      body: JSON.stringify({ request: start.requestToken, ...body }),
    });
    expect(cross.status).toBe(403);
  });

  it("validates the selection", async () => {
    const { owner, site } = await world();
    const stranger = await createUser();
    const foreign = await createSite(stranger.id);
    const { clientId } = await registerClient();
    const { challenge } = await pkcePair();
    const start = await beginConsent(clientId, challenge);
    const session = await sessionCookie(owner.id);
    const none = await decide(start, session, { approve: true, scopes: [], websiteIds: [site.id] });
    expect(none.body.error.message).toBe("Select at least one permission");
    const unknown = await decide(start, session, {
      approve: true,
      scopes: ["root"],
      websiteIds: [],
    });
    expect(unknown.status).toBe(400);
    const theirs = await decide(start, session, {
      approve: true,
      scopes: ["analytics:read"],
      websiteIds: [foreign.id],
    });
    expect(theirs.body.error.message).toContain("Unknown websites");
    const usage = await decide(start, session, {
      approve: true,
      scopes: ["account-usage:read"],
      websiteIds: [site.id],
    });
    expect(usage.body.error.message).toContain("every website you own");
    // The browser binding survives a rejected selection, so the user can fix it and retry.
    const fixed = await decide(start, session, {
      approve: true,
      scopes: ["analytics:read"],
      websiteIds: [site.id],
    });
    expect(fixed.status).toBe(200);
    expect(fixed.cookies.join(";")).toContain("dg_oauth_consent=;");
  });

  it("redirects with access_denied when the user declines", async () => {
    const { owner } = await world();
    const { clientId } = await registerClient();
    const { challenge } = await pkcePair();
    const start = await beginConsent(clientId, challenge);
    const res = await decide(start, await sessionCookie(owner.id), { approve: false });
    const url = new URL(res.body.data.redirectTo);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("xyz-state");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_connections").first("n")).toBe(0);
  });
});

describe("token endpoint", () => {
  async function codeFor(clientId: string, challenge: string, userId: string, siteId: string) {
    const start = await beginConsent(clientId, challenge);
    const decision = await decide(start, await sessionCookie(userId), {
      approve: true,
      scopes: ["analytics:read", "websites:read"],
      websiteIds: [siteId],
    });
    return new URL(decision.body.data.redirectTo).searchParams.get("code") as string;
  }

  it("exchanges a code with PKCE; hashes everything it stores", async () => {
    const { owner, site } = await world();
    const { clientId } = await registerClient();
    const { verifier, challenge } = await pkcePair();
    const code = await codeFor(clientId, challenge, owner.id, site.id);
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "websites:read analytics:read",
    });
    expect(res.body.access_token).toMatch(/^dgo_/);
    expect(res.body.refresh_token).toMatch(/^dgr_/);
    const dump =
      JSON.stringify((await env.DB.prepare("SELECT * FROM oauth_tokens").all()).results) +
      JSON.stringify((await env.DB.prepare("SELECT * FROM oauth_codes").all()).results);
    expect(dump).not.toContain(res.body.access_token);
    expect(dump).not.toContain(res.body.refresh_token);
    expect(dump).not.toContain(code);
  });

  it("rejects a wrong verifier, redirect, resource or client", async () => {
    const { owner, site } = await world();
    const { clientId } = await registerClient();
    const other = await registerClient();
    const { verifier, challenge } = await pkcePair();
    const code = await codeFor(clientId, challenge, owner.id, site.id);
    const base = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    };
    const wrong = (await pkcePair()).verifier;
    expect((await tokenRequest({ ...base, code_verifier: wrong })).body.error).toBe(
      "invalid_grant",
    );
    expect(
      (await tokenRequest({ ...base, redirect_uri: "https://client.example/other" })).body.error,
    ).toBe("invalid_grant");
    expect((await tokenRequest({ ...base, resource: `${ORIGIN}/api/mcp` })).body.error).toBe(
      "invalid_target",
    );
    expect((await tokenRequest({ ...base, client_id: other.clientId })).body.error).toBe(
      "invalid_grant",
    );
    expect((await tokenRequest({ ...base, grant_type: "password" })).body.error).toBe(
      "unsupported_grant_type",
    );
    expect((await tokenRequest({ ...base, client_id: "" })).status).toBe(401);
    // The code is still unused, so the real exchange works.
    expect((await tokenRequest(base)).status).toBe(200);
  });

  it("revokes the connection when a code is replayed", async () => {
    const { owner, site } = await world();
    const { clientId } = await registerClient();
    const { verifier, challenge } = await pkcePair();
    const code = await codeFor(clientId, challenge, owner.id, site.id);
    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    };
    const first = await tokenRequest(params);
    expect((await rpc(first.body.access_token, request("ping"))).status).toBe(200);
    const replay = await tokenRequest(params);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await rpc(first.body.access_token, request("ping"))).status).toBe(401);
  });

  it("rejects expired codes", async () => {
    const { owner, site } = await world();
    const { clientId } = await registerClient();
    const { verifier, challenge } = await pkcePair();
    const code = await codeFor(clientId, challenge, owner.id, site.id);
    await env.DB.prepare("UPDATE oauth_codes SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(res.body).toMatchObject({
      error: "invalid_grant",
      error_description: "Authorization code expired",
    });
  });

  it("authenticates confidential clients with Basic or POST secrets", async () => {
    const { owner, site } = await world();
    const { clientId, clientSecret } = await registerClient({
      token_endpoint_auth_method: "client_secret_basic",
    });
    const { verifier, challenge } = await pkcePair();
    const code = await codeFor(clientId, challenge, owner.id, site.id);
    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    };
    const noSecret = await tokenRequest({ ...params, client_id: clientId });
    expect(noSecret.status).toBe(401);
    const badBasic = await tokenRequest(params, {
      authorization: `Basic ${btoa(`${clientId}:nope`)}`,
    });
    expect(badBasic.status).toBe(401);
    expect(badBasic.headers.get("www-authenticate")).toContain("Basic");
    const ok = await tokenRequest(params, {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    });
    expect(ok.status).toBe(200);
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: ok.body.refresh_token,
      client_id: clientId,
      client_secret: clientSecret as string,
    });
    expect(refreshed.status).toBe(200);
  });

  it("rotates refresh tokens and revokes the connection on reuse", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["websites:read"], [site.id]);
    const next = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: c.clientId,
    });
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(c.refreshToken);
    expect((await rpc(next.body.access_token, request("ping"))).status).toBe(200);
    const reuse = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: c.clientId,
    });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await rpc(next.body.access_token, request("ping"))).status).toBe(401);
    const after = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: next.body.refresh_token,
      client_id: c.clientId,
    });
    expect(after.body.error).toBe("invalid_grant");
  });

  it("caps refresh at the connection lifetime", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["websites:read"], [site.id]);
    await env.DB.prepare("UPDATE oauth_connections SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const res = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: c.clientId,
    });
    expect(res.body.error).toBe("invalid_grant");
    expect((await rpc(c.accessToken, request("ping"))).status).toBe(401);
  });

  it("revokes tokens (RFC 7009)", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["websites:read"], [site.id]);
    const revoke = (token: string) =>
      raw("/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, client_id: c.clientId }).toString(),
      });
    expect((await revoke("dgo_unknown")).status).toBe(200);
    expect((await revoke(c.accessToken)).status).toBe(200);
    expect((await rpc(c.accessToken, request("ping"))).status).toBe(401);
    const fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: c.clientId,
    });
    expect(fresh.status).toBe(200);
    await revoke(fresh.body.refresh_token);
    expect((await rpc(fresh.body.access_token, request("ping"))).status).toBe(401);
  });
});

describe("OAuth access at /mcp", () => {
  it("works at /mcp and its /api/mcp alias but never on the REST API", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["websites:read", "account:read"], [site.id], {
      resource: `${ORIGIN}/api/mcp`,
    });
    expect((await rpc(c.accessToken, request("tools/list"), { path: "/api/mcp" })).status).toBe(
      200,
    );
    expect((await rpc(c.accessToken, request("tools/list"))).status).toBe(200);
    expect((await api("/api/v1/admin/websites", { token: c.accessToken })).status).toBe(401);
    expect((await api("/api/v1/admin/account", { token: c.accessToken })).status).toBe(401);
    await env.DB.prepare("UPDATE oauth_tokens SET resource = 'https://other.example/mcp'").run();
    expect((await rpc(c.accessToken, request("ping"))).status).toBe(401);
  });

  it("whoami describes the connection; the account needs account:read", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["websites:read"], [site.id]);
    const res = await callTool(c.accessToken, "whoami");
    const data = res.structuredContent.data;
    expect(data.credential).toMatchObject({
      type: "oauth",
      scopes: ["websites:read"],
      websiteIds: [site.id],
    });
    expect(data.account.email).toBeUndefined();
    expect(data.websites.map((w: { _id: string }) => w._id)).toEqual([site.id]);
    const full = await connect(owner.id, ["account:read"], []);
    const me = await callTool(full.accessToken, "whoami");
    expect(me.structuredContent.data.account.email).toBe("owner@example.com");
    expect(me.structuredContent.data.websites).toBeUndefined();
  });

  it("limits the connection to the approved websites and scopes", async () => {
    const { owner, site, other } = await world();
    const c = await connect(owner.id, ["websites:read", "settings:read"], [site.id]);
    const list = await callTool(c.accessToken, "websites_list");
    expect(list.structuredContent.data.map((w: { _id: string }) => w._id)).toEqual([site.id]);
    expect((await callTool(c.accessToken, "websites_get")).structuredContent.data[0]._id).toBe(
      site.id,
    );
    const outside = await callTool(c.accessToken, "websites_get", { websiteId: other.id });
    expect(outside.structuredContent.error.code).toBe(403);
    const write = await callTool(c.accessToken, "websites_update", {
      websiteId: site.id,
      changes: { name: "x" },
      confirm: true,
      idempotencyKey: "oauth-write-1",
    });
    expect(write.isError).toBe(true);
    expect(write.content[0]?.text).toContain("settings:write");
    const challenge = (write._meta?.["mcp/www_authenticate"] as string[] | undefined)?.[0] ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain("settings:write");
    expect(challenge).toContain("resource_metadata=");
  });

  it("follows membership: removing the user from a website removes access", async () => {
    const { owner, site } = await world();
    const member = await createUser();
    await addMember(site.id, member.id, "member");
    const c = await connect(member.id, ["settings:read"], [site.id]);
    expect((await callTool(c.accessToken, "websites_get")).isError).toBeUndefined();
    await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?").bind(member.id).run();
    const { invalidateMembership } = await import("../../../src/auth/memberships");
    invalidateMembership();
    const res = await callTool(c.accessToken, "websites_get", { websiteId: site.id });
    expect(res.structuredContent.error.code).toBe(404);
    void owner;
  });

  it("OAuth writes need confirm and an idempotencyKey", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["settings:write"], [site.id]);
    const preview = await callTool(c.accessToken, "websites_update", { changes: { name: "N" } });
    expect(preview.structuredContent.dryRun).toBe(true);
    expect(preview.structuredContent.message).toContain("idempotencyKey");
    const noKey = await callTool(c.accessToken, "websites_update", {
      changes: { name: "N" },
      confirm: true,
    });
    expect(noKey.content[0]?.text).toContain("idempotencyKey");
    const ok = await callTool(c.accessToken, "websites_update", {
      changes: { name: "N" },
      confirm: true,
      idempotencyKey: "oauth-rename-1",
    });
    expect(ok.structuredContent.data[0].name).toBe("N");
  });

  it("websites created through the connection join it", async () => {
    const { owner } = await world();
    const c = await connect(owner.id, ["websites:write", "websites:read", "settings:read"], []);
    expect((await callTool(c.accessToken, "websites_list")).structuredContent.data).toEqual([]);
    const created = await callTool(c.accessToken, "websites_create", {
      domain: "new.example.com",
      timezone: "UTC",
      confirm: true,
      idempotencyKey: "create-site-1",
    });
    const id = created.structuredContent.data[0].websiteId;
    const list = await callTool(c.accessToken, "websites_list");
    expect(list.structuredContent.data.map((w: { _id: string }) => w._id)).toEqual([id]);
  });

  it("binds minted website keys to the connection and needs the owner role", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["api-keys:write", "api-keys:read"], [site.id]);
    const created = await callTool(c.accessToken, "apikeys_create", {
      name: "From agent",
      confirm: true,
      idempotencyKey: "mint-df-key-1",
    });
    const key = created.structuredContent.data[0];
    const row = await env.DB.prepare(
      "SELECT oauth_connection_id, expires_at FROM api_keys WHERE id = ?",
    )
      .bind(key.id)
      .first<{ oauth_connection_id: string; expires_at: number }>();
    const conn = await env.DB.prepare("SELECT id, expires_at FROM oauth_connections").first<{
      id: string;
      expires_at: number;
    }>();
    expect(row).toEqual({ oauth_connection_id: conn?.id, expires_at: conn?.expires_at });
    expect((await api("/api/v1/admin/account", { token: key.key })).status).toBe(200);

    const member = await createUser();
    await addMember(site.id, member.id, "member");
    const mc = await connect(member.id, ["api-keys:write"], [site.id]);
    const denied = await callTool(mc.accessToken, "apikeys_create", {
      confirm: true,
      idempotencyKey: "mint-df-key-2",
    });
    expect(denied.content[0]?.text).toContain("owner role");

    const session = await sessionCookie(owner.id);
    const revoke = await api(`/api/v1/admin/oauth/connections/${conn?.id}`, {
      method: "DELETE",
      cookie: session,
    });
    expect(revoke.status).toBe(200);
    expect((await api("/api/v1/admin/account", { token: key.key })).status).toBe(401);
  });

  it("mints account tokens only inside the connection's access", async () => {
    const { owner, site, other } = await world();
    const c = await connect(
      owner.id,
      ["analytics:read", "access-tokens:write", "access-tokens:read"],
      [site.id],
    );
    const wild = await callTool(c.accessToken, "access_tokens_create", {
      permissions: ["*"],
      confirm: true,
      idempotencyKey: "tok-mint-01",
    });
    expect(wild.content[0]?.text).toContain("subset");
    const wider = await callTool(c.accessToken, "access_tokens_create", {
      permissions: ["settings:write"],
      confirm: true,
      idempotencyKey: "tok-mint-02",
    });
    expect(wider.isError).toBe(true);
    const otherSite = await callTool(c.accessToken, "access_tokens_create", {
      websiteIds: [other.id],
      confirm: true,
      idempotencyKey: "tok-mint-03",
    });
    expect(otherSite.isError).toBe(true);
    const ok = await callTool(c.accessToken, "access_tokens_create", {
      name: "child",
      confirm: true,
      idempotencyKey: "tok-mint-04",
    });
    const token = ok.structuredContent.data[0];
    expect(token).toMatchObject({ permissions: ["analytics:read"], websiteIds: [site.id] });
    const outsider = (await createApiKey({ userId: owner.id })).secret;
    const listed = await callTool(c.accessToken, "access_tokens_list");
    const ids = listed.structuredContent.data.map((t: { id: string }) => t.id);
    expect(ids).toEqual([token.id]);
    void outsider;
    const bound = await env.DB.prepare("SELECT oauth_connection_id FROM api_keys WHERE id = ?")
      .bind(token.id)
      .first("oauth_connection_id");
    expect(bound).toBeTruthy();
  });
});

describe("connected apps API", () => {
  it("lists and revokes the user's connections", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["analytics:read"], [site.id]);
    const session = await sessionCookie(owner.id);
    const list = await api("/api/v1/admin/oauth/connections", { cookie: session });
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([
      {
        id: expect.any(String),
        client: { id: c.clientId, name: "Test Agent" },
        scopes: ["analytics:read"],
        websiteIds: [site.id],
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
        lastUsedAt: null,
      },
    ]);
    const days = (Date.parse(list.body.data[0].expiresAt) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    const token = (await createApiKey({ userId: owner.id, permissions: ["api-keys:read"] })).secret;
    expect((await api("/api/v1/admin/oauth/connections", { token })).body.data).toHaveLength(1);
    const key = (await createApiKey({ userId: owner.id, siteId: site.id })).secret;
    expect((await api("/api/v1/admin/oauth/connections", { token: key })).status).toBe(403);

    const stranger = await createUser();
    const notMine = await api(`/api/v1/admin/oauth/connections/${list.body.data[0].id}`, {
      method: "DELETE",
      cookie: await sessionCookie(stranger.id),
    });
    expect(notMine.status).toBe(404);
    const del = await api(`/api/v1/admin/oauth/connections/${list.body.data[0].id}`, {
      method: "DELETE",
      cookie: session,
    });
    expect(del.body.data).toEqual([{ message: "Access revoked" }]);
    expect((await rpc(c.accessToken, request("ping"))).status).toBe(401);
    const refresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: c.clientId,
    });
    expect(refresh.body.error).toBe("invalid_grant");
    expect((await api("/api/v1/admin/oauth/connections", { cookie: session })).body.data).toEqual(
      [],
    );
  });

  it("records when a connection was last used", async () => {
    const { owner, site } = await world();
    const c = await connect(owner.id, ["analytics:read"], [site.id]);
    await rpc(c.accessToken, request("ping"));
    const used = await env.DB.prepare("SELECT last_used_at FROM oauth_connections").first<{
      last_used_at: number | null;
    }>();
    expect(used?.last_used_at).toBeGreaterThan(0);
  });
});
