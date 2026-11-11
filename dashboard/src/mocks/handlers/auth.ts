/** F0 endpoints: setup, auth, account, tokens, websites, keys, team. */
import { HttpResponse, http } from "msw";
import type {
  AccessToken,
  CreateAccessTokenRequest,
  LoginRequest,
  OverviewLayout,
  SetupRequest,
  TeamMember,
  Website,
  WebsiteKey,
  WebsiteUpdate,
} from "../../../../shared/api-types";
import { accessTokens, account, MOCK_PASSWORD, NOW, summary } from "../fixtures/core";
import { invitesOf, keysOf, state, teamOf } from "../state";
import { fail, ok } from "./util";

const me = () => ({
  user: state.user,
  websites: state.websites.map(summary),
  authKind: "session" as const,
});

function site(id: string | readonly string[] | undefined): Website | undefined {
  return state.websites.find((w) => w._id === id || w.trackingId === id);
}

export const authHandlers = [
  http.get("/api/setup", () => ok({ needsSetup: state.needsSetup, configErrors: [] })),
  http.post("/api/setup", async ({ request }) => {
    const body = (await request.json()) as SetupRequest;
    if (!state.needsSetup) return fail(409, "Setup has already been completed");
    if (body.token !== "mock-setup-token") return fail(403, "Invalid setup token");
    state.needsSetup = false;
    state.signedIn = true;
    state.user = { ...state.user, email: body.email, name: body.name ?? null };
    return ok({
      ...me(),
      website: body.website
        ? { websiteId: state.websites[0]?._id, domain: body.website.domain, trackingId: "dfid_new" }
        : null,
    });
  }),
  http.post("/api/auth/login", async ({ request }) => {
    const body = (await request.json()) as LoginRequest;
    if (body.email.toLowerCase() !== state.user.email || body.password !== MOCK_PASSWORD) {
      return fail(401, "Invalid email or password");
    }
    state.signedIn = true;
    return ok(me());
  }),
  http.post("/api/auth/logout", () => {
    state.signedIn = false;
    return ok({ message: "Logged out" });
  }),
  http.post("/api/auth/logout-all", () => {
    if (!state.signedIn) return fail(401, "Authentication required");
    state.signedIn = false;
    return ok({ message: "Signed out of every session" });
  }),
  http.get("/api/auth/me", () =>
    state.signedIn ? ok(me()) : fail(401, "Authentication required"),
  ),
  http.put("/api/auth/password", () =>
    ok({ message: "Password changed. Other sessions were signed out." }),
  ),
  http.get("/api/auth/invites/:token", () =>
    ok({
      email: "new@example.com",
      role: "viewer",
      website: {
        id: state.websites[0]?._id,
        domain: state.websites[0]?.domain,
        name: state.websites[0]?.name,
      },
      invitedBy: { name: state.user.name, email: state.user.email },
      expiresAt: "2026-11-11T12:00:00.000Z",
      userExists: false,
      signedInAs: null,
    }),
  ),
  http.post("/api/auth/invites/:token/accept", () => {
    state.signedIn = true;
    return ok({
      message: "Account created and invitation accepted",
      websiteId: state.websites[0]?._id,
      ...me(),
    });
  }),
  // W6: same answer whether or not the account exists (contract §11).
  http.post("/api/auth/password-resets", () =>
    ok({ message: "If an account exists for that email, a password reset link is on its way." }),
  ),
  http.get("/api/auth/password-resets/:token", () => ok({ email: state.user.email })),
  http.post("/api/auth/password-resets/:token", () =>
    ok({ message: "Password updated. You can now sign in." }),
  ),

  http.get("/api/v1/admin/account", () => ok([account])),
  http.put("/api/v1/admin/account", async ({ request }) => {
    const { name } = (await request.json()) as { name: string };
    state.user = { ...state.user, name };
    return ok([{ id: account._id, name, email: account.email, image: null }]);
  }),
  http.get("/api/v1/admin/access-tokens", () =>
    ok(state.accessTokens.map(({ key: _key, ...t }) => t)),
  ),
  http.post("/api/v1/admin/access-tokens", async ({ request }) => {
    const body = (await request.json()) as CreateAccessTokenRequest;
    const id = `6728f0a0a1b2c3d4e5f6b${String(state.accessTokens.length + 100).padStart(3, "0")}`;
    const secret = `dgt_mock${id.slice(-6)}SecretShownOnce000000000000`;
    const token: AccessToken = {
      ...(accessTokens[0] as AccessToken),
      id,
      name: body.name ?? null,
      displayKey: `${secret.slice(0, 7)}...${secret.slice(-4)}`,
      permissions: body.permissions ?? ["*"],
      websiteIds: body.websiteIds ?? [],
      lastUsedAt: null,
      usageCount: 0,
      expiresAt: body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString()
        : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.accessTokens.push(token);
    return ok([{ ...token, key: secret }]);
  }),
  http.delete("/api/v1/admin/access-tokens/:id", ({ params }) => {
    const before = state.accessTokens.length;
    state.accessTokens = state.accessTokens.filter((t) => t.id !== params.id);
    return before === state.accessTokens.length
      ? fail(404, "Access token not found")
      : ok([{ message: "Access token deleted successfully" }]);
  }),

  http.get("/api/v1/admin/websites", () => ok(state.websites.map(summary))),
  http.put("/api/v1/admin/account/website-order", async ({ request }) => {
    const { websiteIds } = (await request.json()) as { websiteIds: string[] };
    const rank = (id: string) => {
      const i = websiteIds.indexOf(id);
      return i === -1 ? websiteIds.length : i;
    };
    state.websites = [...state.websites].sort((a, b) => rank(a._id) - rank(b._id));
    return ok(state.websites.map(summary));
  }),
  http.get("/api/v1/admin/account/overview-layout", ({ request }) => {
    const websiteId = new URL(request.url).searchParams.get("websiteId") ?? "";
    if (!state.websites.some((w) => w._id === websiteId)) return fail(404, "Website not found");
    return ok([{ websiteId, layout: state.overviewLayouts[websiteId] ?? null }]);
  }),
  http.put("/api/v1/admin/account/overview-layout", async ({ request }) => {
    const { websiteId, layout } = (await request.json()) as {
      websiteId: string;
      layout: OverviewLayout | null;
    };
    if (!state.websites.some((w) => w._id === websiteId)) return fail(404, "Website not found");
    state.overviewLayouts[websiteId] = layout;
    return ok([{ websiteId, layout }]);
  }),
  http.post("/api/v1/admin/websites", async ({ request }) => {
    const body = (await request.json()) as {
      domain: string;
      timezone: string;
      name?: string | null;
      currency?: string;
    };
    if (state.websites.some((w) => w.domain === body.domain))
      return fail(409, "A website with this domain already exists");
    const id = `6728f0a0a1b2c3d4e5f6a${String(state.websites.length + 1).padStart(3, "0")}`;
    const created: Website = {
      ...(state.websites[0] as Website),
      _id: id,
      domain: body.domain,
      name: body.name ?? null,
      timezone: body.timezone,
      currency: body.currency ?? "USD",
      kpi: null,
      excludedPaths: [],
      allowedHostnames: [],
      isPublicDashboardEnabled: false,
      shareToken: null,
      trackingId: `dfid_mock${state.websites.length + 1}`,
      createdAt: NOW,
      role: "owner",
    };
    state.websites.push(created);
    return ok([{ websiteId: id, domain: body.domain, trackingId: created.trackingId }]);
  }),
  http.get("/api/v1/admin/websites/:websiteId", ({ params }) => {
    const w = site(params.websiteId);
    return w ? ok([w]) : fail(404, "Website not found");
  }),
  http.put("/api/v1/admin/websites/:websiteId", async ({ params, request }) => {
    const w = site(params.websiteId);
    if (!w) return fail(404, "Website not found");
    const body = (await request.json()) as WebsiteUpdate;
    Object.assign(w, body, { updatedAt: new Date().toISOString() });
    if (body.isPublicDashboardEnabled !== undefined) {
      w.shareToken = body.isPublicDashboardEnabled
        ? (w.shareToken ?? `share_${Date.now().toString(36)}`)
        : null;
    }
    return ok([w]);
  }),
  http.delete("/api/v1/admin/websites/:websiteId", ({ params }) => {
    state.websites = state.websites.filter((w) => w._id !== params.websiteId);
    return ok([
      {
        message: "Website deleted. Its data is removed in the background.",
        websiteId: params.websiteId,
      },
    ]);
  }),
  http.get("/api/v1/admin/websites/:websiteId/apikeys", ({ params }) =>
    ok(keysOf(String(params.websiteId))),
  ),
  http.post("/api/v1/admin/websites/:websiteId/apikeys", async ({ params, request }) => {
    const siteId = String(params.websiteId);
    const body = (await request.json()) as { name?: string | null; includePii?: boolean };
    const keys = keysOf(siteId);
    if (keys.length >= 10) return fail(400, "A website can have at most 10 API keys");
    const id = `6728f0a0a1b2c3d4e5f6c${String(keys.length + 100).padStart(3, "0")}`;
    const secret = `dg_mock${id.slice(-6)}SecretShownOnce0000000000000`;
    const key: WebsiteKey = {
      id,
      userId: state.user.id,
      name: body.name ?? null,
      displayKey: `${secret.slice(0, 6)}...${secret.slice(-4)}`,
      websiteId: siteId,
      keyPrefix: secret.slice(0, 8),
      lastUsedAt: null,
      usageCount: 0,
      isMobile: false,
      includePii: Boolean(body.includePii),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    keys.push(key);
    return ok([{ ...key, key: secret }]);
  }),
  http.put("/api/v1/admin/websites/:websiteId/apikeys/:id", ({ params }) => {
    const key = keysOf(String(params.websiteId)).find((k) => k.id === params.id);
    if (!key) return fail(404, "API key not found");
    const secret = `dg_mockRolled${Date.now().toString(36)}000000000000000`;
    Object.assign(key, {
      displayKey: `${secret.slice(0, 6)}...${secret.slice(-4)}`,
      updatedAt: new Date().toISOString(),
    });
    return ok([{ ...key, key: secret }]);
  }),
  http.delete("/api/v1/admin/websites/:websiteId/apikeys/:id", ({ params }) => {
    const siteId = String(params.websiteId);
    const keys = keysOf(siteId);
    if (!keys.some((k) => k.id === params.id)) return fail(404, "API key not found");
    state.siteKeys[siteId] = keys.filter((k) => k.id !== params.id);
    return ok([{ deleted: true }]);
  }),
  http.get("/api/v1/admin/websites/:websiteId/team", ({ params }) =>
    ok(teamOf(String(params.websiteId))),
  ),
  http.post("/api/v1/admin/websites/:websiteId/team", async ({ params, request }) => {
    const siteId = String(params.websiteId);
    const body = (await request.json()) as { email: string; role?: "member" | "viewer" };
    const email = body.email.trim().toLowerCase();
    if (email === state.user.email) return fail(400, "You cannot invite yourself");
    if (teamOf(siteId).some((m) => m.email === email))
      return fail(409, "This user is already a member of the website");
    if (invitesOf(siteId).some((i) => i.email === email))
      return fail(409, "An invitation is already pending for this email");
    const invite = {
      invitationId: `6728f0a0a1b2c3d4e5f6d${String(invitesOf(siteId).length + 100).padStart(3, "0")}`,
      email,
      role: body.role ?? "viewer",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
    invitesOf(siteId).push(invite);
    return ok([
      {
        message: "Invitation created. Send the invite link to the user.",
        invitationId: invite.invitationId,
        email,
        role: invite.role,
        inviteUrl: `${location.origin}/invite/mock-invite-token-${invite.invitationId.slice(-3)}`,
        expiresAt: invite.expiresAt,
      },
    ]);
  }),
  http.put("/api/v1/admin/websites/:websiteId/team", async ({ params, request }) => {
    const members = teamOf(String(params.websiteId));
    const body = (await request.json()) as { userId: string; role: TeamMember["role"] };
    const member = members.find((m) => m.userId === body.userId);
    if (!member) return fail(404, "Member not found");
    const owners = members.filter((m) => m.role === "owner").length;
    if (member.role === "owner" && body.role !== "owner" && owners === 1)
      return fail(400, "A website needs at least one owner");
    member.role = body.role;
    return ok([{ message: "Role updated", userId: member.userId, role: member.role }]);
  }),
  http.delete("/api/v1/admin/websites/:websiteId/team", async ({ params, request }) => {
    const siteId = String(params.websiteId);
    const { userId } = (await request.json()) as { userId: string };
    if (userId === state.user.id) return fail(400, "You cannot remove yourself");
    if (!teamOf(siteId).some((m) => m.userId === userId)) return fail(404, "Member not found");
    state.team[siteId] = teamOf(siteId).filter((m) => m.userId !== userId);
    return ok([{ message: "Member removed successfully" }]);
  }),
  http.get("/api/v1/admin/websites/:websiteId/team/invites", ({ params }) =>
    ok(invitesOf(String(params.websiteId))),
  ),
  http.delete("/api/v1/admin/websites/:websiteId/team/invites/:id", ({ params }) => {
    const siteId = String(params.websiteId);
    state.invites[siteId] = invitesOf(siteId).filter((i) => i.invitationId !== params.id);
    return ok([{ message: "Invitation revoked" }]);
  }),
  http.get("/api/health", () =>
    HttpResponse.json({ status: "success", data: { ok: true, schema: "current", migrations: 1 } }),
  ),
];
