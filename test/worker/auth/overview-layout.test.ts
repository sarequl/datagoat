/**
 * Per-user Overview layout (dashboard Customize mode): GET/PUT /api/v1/admin/account/overview-layout.
 */
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
import { api } from "../../helpers/http";

beforeEach(() => resetDb());

const PATH = "/api/v1/admin/account/overview-layout";
const layout = {
  sections: ["growth", "breakdowns", "conversions", "live"],
  cards: { breakdowns: ["pages", "source", "location", "system"] },
  hidden: ["crawlers"],
};

describe("overview layout", () => {
  it("starts empty, saves, reads back and resets", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const cookie = await sessionCookie(user.id);
    const first = await api(`${PATH}?websiteId=${site.id}`, { cookie });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual([{ websiteId: site.id, layout: null }]);

    const saved = await api(PATH, {
      method: "PUT",
      cookie,
      body: { websiteId: site.publicId, layout },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data[0]).toEqual({ websiteId: site.id, layout });
    expect((await api(`${PATH}?websiteId=${site.id}`, { cookie })).body.data[0].layout).toEqual(
      layout,
    );

    await api(PATH, { method: "PUT", cookie, body: { websiteId: site.id, layout: null } });
    expect((await api(`${PATH}?websiteId=${site.id}`, { cookie })).body.data[0].layout).toBeNull();
  });

  it("is per user, and only for websites the user belongs to", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const viewer = await createUser();
    await addMember(site.id, viewer.id, "viewer");
    const stranger = await createUser();
    // Viewers can arrange their own Overview; it does not change anyone else's.
    const res = await api(PATH, {
      method: "PUT",
      cookie: await sessionCookie(viewer.id),
      body: { websiteId: site.id, layout },
    });
    expect(res.status).toBe(200);
    const ownerView = await api(`${PATH}?websiteId=${site.id}`, {
      cookie: await sessionCookie(owner.id),
    });
    expect(ownerView.body.data[0].layout).toBeNull();
    const denied = await api(PATH, {
      method: "PUT",
      cookie: await sessionCookie(stranger.id),
      body: { websiteId: site.id, layout },
    });
    expect(denied.status).toBe(404);
    const row = await env.DB.prepare(
      "SELECT overview_layout FROM memberships WHERE site_id = ? AND user_id = ?",
    )
      .bind(site.id, viewer.id)
      .first<{ overview_layout: string }>();
    expect(JSON.parse(row?.overview_layout ?? "null")).toEqual(layout);
  });

  it("validates the layout and rejects website keys", async () => {
    const user = await createUser();
    const site = await createSite(user.id);
    const cookie = await sessionCookie(user.id);
    for (const bad of [
      { sections: ["Not An Id"], cards: {}, hidden: [] },
      { sections: [], cards: {}, hidden: [], extra: 1 },
      { sections: Array.from({ length: 13 }, (_, i) => `s${i}`), cards: {}, hidden: [] },
    ]) {
      const res = await api(PATH, {
        method: "PUT",
        cookie,
        body: { websiteId: site.id, layout: bad },
      });
      expect(res.status).toBe(400);
    }
    const key = await createApiKey({ userId: user.id, siteId: site.id });
    const denied = await api(`${PATH}?websiteId=${site.id}`, { token: key.secret });
    expect(denied.status).toBe(403);
  });
});
