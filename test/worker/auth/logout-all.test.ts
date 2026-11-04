import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createApiKey, createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";

beforeEach(() => resetDb());

describe("POST /api/auth/logout-all", () => {
  it("ends every session of the user, including the current one, and leaves others alone", async () => {
    const jane = await createUser({ email: "jane@example.com" });
    const sam = await createUser({ email: "sam@example.com" });
    const laptop = await sessionCookie(jane.id);
    const phone = await sessionCookie(jane.id);
    const samSession = await sessionCookie(sam.id);

    const res = await api("/api/auth/logout-all", { method: "POST", cookie: laptop });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("Signed out of every session");
    expect(res.cookies.join(";")).toMatch(/dg_session=;/);

    expect((await api("/api/auth/me", { cookie: laptop })).status).toBe(401);
    expect((await api("/api/auth/me", { cookie: phone })).status).toBe(401);
    expect((await api("/api/auth/me", { cookie: samSession })).status).toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?")
      .bind(jane.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("requires a dashboard session and a same-origin request", async () => {
    const jane = await createUser({ email: "jane@example.com" });
    const site = await createSite(jane.id);
    const key = await createApiKey({ siteId: site.id, userId: jane.id });
    expect((await api("/api/auth/logout-all", { method: "POST" })).status).toBe(401);
    expect((await api("/api/auth/logout-all", { method: "POST", token: key.secret })).status).toBe(
      403,
    );
    const cookie = await sessionCookie(jane.id);
    const crossSite = await api("/api/auth/logout-all", {
      method: "POST",
      cookie,
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    expect((await api("/api/auth/me", { cookie })).status).toBe(200);
  });
});
