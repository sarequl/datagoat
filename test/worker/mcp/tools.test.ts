/**
 * MCP tools end to end over the implemented (F0) endpoints: websites, API keys, team, account,
 * access tokens. Covers authorization, dry runs, confirmation, idempotency and secret handling.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { addMember, createApiKey, createSite, createUser } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { callTool } from "./helpers";

beforeEach(() => resetDb());

async function world() {
  const owner = await createUser({ email: "owner@example.com", name: "Owner" });
  const site = await createSite(owner.id, { domain: "a.example.com", timezone: "Europe/Paris" });
  const other = await createSite(owner.id, { domain: "b.example.com" });
  const token = (await createApiKey({ userId: owner.id })).secret;
  return { owner, site, other, token };
}

describe("read tools", () => {
  it("whoami returns the account, the credential and the websites", async () => {
    const { token, site } = await world();
    const res = await callTool(token, "whoami");
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent.data;
    expect(data.account).toMatchObject({ email: "owner@example.com", name: "Owner" });
    expect(data.credential).toMatchObject({ type: "account_token", permissions: ["*"] });
    expect(data.websites.map((w: { _id: string }) => w._id)).toContain(site.id);
    expect(JSON.parse(res.content[0]?.text ?? "{}").data.account.email).toBe("owner@example.com");
  });

  it("websites_list and websites_get call the same handlers as REST", async () => {
    const { token, site } = await world();
    const list = await callTool(token, "websites_list");
    const rest = await api("/api/v1/admin/websites", { token });
    expect(list.structuredContent.data).toEqual(rest.body.data);
    const one = await callTool(token, "websites_get", { websiteId: site.id });
    expect(one.structuredContent.data[0]).toMatchObject({ _id: site.id, domain: "a.example.com" });
    const byTracking = await callTool(token, "websites_get", { websiteId: site.publicId });
    expect(byTracking.structuredContent.data[0]._id).toBe(site.id);
  });

  it("surfaces REST errors as tool errors", async () => {
    const { token } = await world();
    const missing = await callTool(token, "websites_get", {
      websiteId: "000000000000000000000000",
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toBe("Error 404: Website not found");
    expect(missing.structuredContent.error).toEqual({ code: 404, message: "Website not found" });
  });

  it("validates arguments", async () => {
    const { token } = await world();
    const res = await callTool(token, "websites_get", { websiteId: 42 });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/^Invalid arguments: websiteId/);
    const extra = await callTool(token, "websites_list", { surprise: true });
    expect(extra.isError).toBe(true);
    const site = await callTool(token, "websites_get", {});
    expect(site.content[0]?.text).toContain("websiteId is required");
  });

  it("a df_ website key targets its own website without websiteId", async () => {
    const { owner, site, other } = await world();
    const key = (await createApiKey({ userId: owner.id, siteId: site.id })).secret;
    const res = await callTool(key, "websites_get");
    expect(res.structuredContent.data[0]._id).toBe(site.id);
    const denied = await callTool(key, "websites_get", { websiteId: other.id });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error.code).toBe(403);
    const whoami = await callTool(key, "whoami");
    expect(whoami.structuredContent.data.credential.type).toBe("website_key");
  });

  it("enforces the token's permissions and website allowlist", async () => {
    const { owner, site, other } = await world();
    const limited = (
      await createApiKey({
        userId: owner.id,
        permissions: ["analytics:read"],
        websiteIds: [site.id],
      })
    ).secret;
    const res = await callTool(limited, "websites_get", { websiteId: site.id });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("Missing permission: settings:read");
    const reader = (
      await createApiKey({
        userId: owner.id,
        permissions: ["settings:read"],
        websiteIds: [site.id],
      })
    ).secret;
    expect((await callTool(reader, "websites_get")).structuredContent.data[0]._id).toBe(site.id);
    const outside = await callTool(reader, "websites_get", { websiteId: other.id });
    expect(outside.structuredContent.error.code).toBe(403);
  });

  it("team_list shows members", async () => {
    const { token, site } = await world();
    const member = await createUser({ email: "m@example.com" });
    await addMember(site.id, member.id, "viewer");
    const res = await callTool(token, "team_list", { websiteId: site.id });
    expect(res.structuredContent.data.map((m: { role: string }) => m.role)).toEqual([
      "owner",
      "viewer",
    ]);
  });
});

describe("write tools", () => {
  it("return a dry-run preview unless confirm is true", async () => {
    const { token, site } = await world();
    const preview = await callTool(token, "websites_update", {
      websiteId: site.id,
      changes: { name: "Renamed" },
    });
    expect(preview.isError).toBeUndefined();
    expect(preview.structuredContent).toMatchObject({
      dryRun: true,
      tool: "websites_update",
      request: {
        method: "PUT",
        path: `/api/v1/admin/websites/${site.id}`,
        body: { name: "Renamed" },
      },
    });
    const unchanged = await api(`/api/v1/admin/websites/${site.id}`, { token });
    expect(unchanged.body.data[0].name).not.toBe("Renamed");

    const applied = await callTool(token, "websites_update", {
      websiteId: site.id,
      changes: { name: "Renamed" },
      confirm: true,
    });
    expect(applied.structuredContent.data[0].name).toBe("Renamed");
  });

  it("creates websites and manages website API keys", async () => {
    const { token } = await world();
    const created = await callTool(token, "websites_create", {
      domain: "new.example.com",
      timezone: "UTC",
      confirm: true,
    });
    const websiteId = created.structuredContent.data[0].websiteId;
    expect(websiteId).toMatch(/^[0-9a-f]{24}$/);

    const preview = await callTool(token, "apikeys_create", { websiteId, name: "CI" });
    expect(preview.structuredContent.warning).toContain("irreversible");
    const key = await callTool(token, "apikeys_create", { websiteId, name: "CI", confirm: true });
    const { id, key: secret } = key.structuredContent.data[0];
    expect(secret).toMatch(/^dg_/);
    expect((await api("/api/v1/admin/account", { token: secret })).status).toBe(200);

    const list = await callTool(token, "apikeys_list", { websiteId });
    expect(list.structuredContent.data[0].key).toBeUndefined();

    const rolled = await callTool(token, "apikeys_roll", {
      websiteId,
      apiKeyId: id,
      confirm: true,
    });
    expect(rolled.structuredContent.data[0].key).not.toBe(secret);
    expect((await api("/api/v1/admin/account", { token: secret })).status).toBe(401);

    const deleted = await callTool(token, "apikeys_delete", {
      websiteId,
      apiKeyId: id,
      confirm: true,
    });
    expect(deleted.structuredContent.data).toEqual([{ deleted: true }]);
  });

  it("invites, re-roles and removes team members (owner only)", async () => {
    const { token, site, owner } = await world();
    const invite = await callTool(token, "team_invite", {
      websiteId: site.id,
      email: "new@example.com",
      role: "viewer",
      confirm: true,
    });
    expect(invite.structuredContent.data[0].inviteUrl).toContain("/invite/");
    const member = await createUser();
    await addMember(site.id, member.id, "viewer");
    const role = await callTool(token, "team_update_role", {
      websiteId: site.id,
      userId: member.id,
      role: "member",
      confirm: true,
    });
    expect(role.isError).toBeUndefined();
    const memberToken = (await createApiKey({ userId: member.id })).secret;
    const notOwner = await callTool(memberToken, "team_remove", {
      websiteId: site.id,
      userId: owner.id,
      confirm: true,
    });
    expect(notOwner.structuredContent.error.code).toBe(403);
    const removed = await callTool(token, "team_remove", {
      websiteId: site.id,
      userId: member.id,
      confirm: true,
    });
    expect(removed.isError).toBeUndefined();
  });

  it("viewers cannot write through MCP either", async () => {
    const { site } = await world();
    const viewer = await createUser();
    await addMember(site.id, viewer.id, "viewer");
    const t = (await createApiKey({ userId: viewer.id })).secret;
    const res = await callTool(t, "websites_update", {
      websiteId: site.id,
      changes: { name: "x" },
      confirm: true,
    });
    expect(res.structuredContent.error).toEqual({
      code: 403,
      message: "Your role (viewer) does not allow settings:write",
    });
  });

  it("updates the account name and manages access tokens", async () => {
    const { token } = await world();
    const named = await callTool(token, "account_update", { name: "New Name", confirm: true });
    expect(named.structuredContent.data[0].name).toBe("New Name");
    const created = await callTool(token, "access_tokens_create", {
      name: "Read only",
      permissions: ["analytics:read"],
      confirm: true,
    });
    const { id, key } = created.structuredContent.data[0];
    expect(key).toMatch(/^dgt_/);
    const list = await callTool(token, "access_tokens_list");
    expect(list.structuredContent.data.some((t: { id: string }) => t.id === id)).toBe(true);
    const deleted = await callTool(token, "access_tokens_delete", { tokenId: id, confirm: true });
    expect(deleted.isError).toBeUndefined();
    expect((await api("/api/v1/admin/account", { token: key })).status).toBe(401);
  });
});

describe("idempotency", () => {
  it("replays the first result for the same key and arguments", async () => {
    const { token, site } = await world();
    const args = {
      websiteId: site.id,
      changes: { name: "Once" },
      confirm: true,
      idempotencyKey: "rename-0001",
    };
    const first = await callTool(token, "websites_update", args);
    expect(first.structuredContent.replayed).toBeUndefined();
    // Change the name behind the tool's back: a replay must not re-apply the write.
    await api(`/api/v1/admin/websites/${site.id}`, {
      token,
      method: "PUT",
      body: { name: "Other" },
    });
    const again = await callTool(token, "websites_update", args);
    expect(again.structuredContent.replayed).toBe(true);
    expect(again.structuredContent.data[0].name).toBe("Once");
    const now = await api(`/api/v1/admin/websites/${site.id}`, { token });
    expect(now.body.data[0].name).toBe("Other");
  });

  it("rejects the same key with different arguments", async () => {
    const { token, site } = await world();
    await callTool(token, "websites_update", {
      websiteId: site.id,
      changes: { name: "A" },
      confirm: true,
      idempotencyKey: "key-same-0001",
    });
    const res = await callTool(token, "websites_update", {
      websiteId: site.id,
      changes: { name: "B" },
      confirm: true,
      idempotencyKey: "key-same-0001",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("different arguments");
  });

  it("never stores issued secrets for replay", async () => {
    const { token, site } = await world();
    const args = {
      websiteId: site.id,
      name: "Once",
      confirm: true,
      idempotencyKey: "mint-key-0001",
    };
    const first = await callTool(token, "apikeys_create", args);
    expect(first.structuredContent.data[0].key).toMatch(/^dg_/);
    const stored = await env.DB.prepare("SELECT response FROM idempotency_keys").first<{
      response: string;
    }>();
    expect(stored?.response).not.toContain(first.structuredContent.data[0].key);
    const replay = await callTool(token, "apikeys_create", args);
    expect(replay.structuredContent.replayed).toBe(true);
    expect(replay.structuredContent.data[0].key).toContain("already issued");
    expect(replay.content[1]?.text).toContain("shown only in the first response");
    const keys = await api(`/api/v1/admin/websites/${site.id}/apikeys`, { token });
    expect(keys.body.data).toHaveLength(1);
  });

  it("replays a completed delete even though the target is gone", async () => {
    const { token } = await world();
    const created = await callTool(token, "access_tokens_create", { name: "tmp", confirm: true });
    const id = created.structuredContent.data[0].id;
    const args = { tokenId: id, confirm: true, idempotencyKey: "delete-tok-01" };
    expect((await callTool(token, "access_tokens_delete", args)).isError).toBeUndefined();
    const replay = await callTool(token, "access_tokens_delete", args);
    expect(replay.structuredContent.replayed).toBe(true);
    const fresh = await callTool(token, "access_tokens_delete", {
      ...args,
      idempotencyKey: "delete-tok-02",
    });
    expect(fresh.structuredContent.error.code).toBe(404);
  });

  it("lets a failed (4xx) call be retried with the same key", async () => {
    const { token, site } = await world();
    const args = {
      websiteId: site.id,
      changes: { timezone: "Not/AZone" },
      confirm: true,
      idempotencyKey: "bad-tz-00001",
    };
    const bad = await callTool(token, "websites_update", args);
    expect(bad.structuredContent.error.code).toBe(400);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").first<{
      n: number;
    }>();
    expect(row?.n).toBe(0);
  });

  it("scopes keys to the credential", async () => {
    const { token, owner, site } = await world();
    const other = (await createApiKey({ userId: owner.id })).secret;
    const args = {
      websiteId: site.id,
      changes: { name: "X1" },
      confirm: true,
      idempotencyKey: "shared-key-01",
    };
    await callTool(token, "websites_update", args);
    const res = await callTool(other, "websites_update", { ...args, changes: { name: "X2" } });
    expect(res.structuredContent.data[0].name).toBe("X2");
  });
});
