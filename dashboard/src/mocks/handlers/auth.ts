/** F0 endpoints: setup, auth, account, tokens, websites, keys, team. */
import { HttpResponse, http } from "msw";
import type {
  LoginRequest,
  SetupRequest,
  Website,
  WebsiteUpdate,
} from "../../../../shared/api-types";
import {
  accessTokens,
  account,
  MOCK_PASSWORD,
  NOW,
  pendingInvites,
  summary,
  team,
  websiteKeys,
} from "../fixtures/core";
import { state } from "../state";
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
  http.get("/api/auth/password-resets/:token", () => ok({ email: state.user.email })),
  http.post("/api/auth/password-resets/:token", () =>
    ok({ message: "Password updated. You can now sign in." }),
  ),

  http.get("/api/v1/admin/account", () => ok([account])),
  http.put("/api/v1/admin/account", async ({ request }) => {
    const { name } = (await request.json()) as { name: string };
    return ok([{ id: account._id, name, email: account.email, image: null }]);
  }),
  http.get("/api/v1/admin/access-tokens", () => ok(accessTokens)),
  http.post("/api/v1/admin/access-tokens", async ({ request }) => {
    const body = (await request.json()) as {
      name?: string;
      permissions?: string[];
      websiteIds?: string[];
    };
    const base = accessTokens[0];
    return ok([
      {
        ...base,
        id: `tok_${Date.now()}`,
        name: body.name ?? null,
        permissions: body.permissions ?? ["*"],
        websiteIds: body.websiteIds ?? [],
        key: "dft_mockSecretShownOnce0000000000000000000",
      },
    ]);
  }),
  http.delete("/api/v1/admin/access-tokens/:id", () =>
    ok([{ message: "Access token deleted successfully" }]),
  ),

  http.get("/api/v1/admin/websites", () => ok(state.websites.map(summary))),
  http.post("/api/v1/admin/websites", async ({ request }) => {
    const body = (await request.json()) as {
      domain: string;
      timezone: string;
      name?: string | null;
    };
    const id = `6728f0a0a1b2c3d4e5f6a${String(state.websites.length + 1).padStart(3, "0")}`;
    const created: Website = {
      ...(state.websites[0] as Website),
      _id: id,
      domain: body.domain,
      name: body.name ?? null,
      timezone: body.timezone,
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
    Object.assign(w, (await request.json()) as WebsiteUpdate, {
      updatedAt: new Date().toISOString(),
    });
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
    ok(websiteKeys(String(params.websiteId))),
  ),
  http.post("/api/v1/admin/websites/:websiteId/apikeys", ({ params }) =>
    ok([
      {
        ...websiteKeys(String(params.websiteId))[0],
        id: `key_${Date.now()}`,
        key: "df_mockSecretShownOnce00000000000000000000",
      },
    ]),
  ),
  http.put("/api/v1/admin/websites/:websiteId/apikeys/:id", ({ params }) =>
    ok([
      {
        ...websiteKeys(String(params.websiteId))[0],
        key: "df_mockRolledSecret000000000000000000000",
      },
    ]),
  ),
  http.delete("/api/v1/admin/websites/:websiteId/apikeys/:id", () => ok([{ deleted: true }])),
  http.get("/api/v1/admin/websites/:websiteId/team", () => ok(team)),
  http.post("/api/v1/admin/websites/:websiteId/team", async ({ request }) => {
    const body = (await request.json()) as { email: string; role?: string };
    return ok([
      {
        message: "Invitation created. Send the invite link to the user.",
        invitationId: "inv_mock",
        email: body.email,
        role: body.role ?? "viewer",
        inviteUrl: `${location.origin}/invite/mock-invite-token-0000000000`,
        expiresAt: "2026-11-11T12:00:00.000Z",
      },
    ]);
  }),
  http.put("/api/v1/admin/websites/:websiteId/team", async ({ request }) =>
    ok([{ message: "Role updated", ...((await request.json()) as object) }]),
  ),
  http.delete("/api/v1/admin/websites/:websiteId/team", () =>
    ok([{ message: "Member removed successfully" }]),
  ),
  http.get("/api/v1/admin/websites/:websiteId/team/invites", () => ok(pendingInvites)),
  http.delete("/api/v1/admin/websites/:websiteId/team/invites/:id", () =>
    ok([{ message: "Invitation revoked" }]),
  ),
  http.get("/api/health", () => HttpResponse.json({ status: "success", data: { ok: true } })),
];
