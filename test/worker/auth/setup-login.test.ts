import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/app";
import { hashPassword } from "../../../src/lib/crypto";
import { configErrors } from "../../../src/setup";
import { meterEnv, resetDb } from "../../helpers/db";
import { createUser } from "../../helpers/factories";
import { api, cookieFrom } from "../../helpers/http";

beforeEach(() => resetDb());

const TOKEN = env.SETUP_TOKEN;

describe("first-run setup", () => {
  it("reports that setup is needed and the config is valid", async () => {
    const res = await api("/api/setup");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "success", data: { needsSetup: true, configErrors: [] } });
  });

  it("creates the first owner and website, signs them in, and only works once", async () => {
    const res = await api("/api/setup", {
      body: {
        token: TOKEN,
        email: "Owner@Example.com",
        password: "a-long-password",
        name: "Owner",
        website: { domain: "https://www.example.com/", timezone: "Europe/Paris" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: "owner@example.com", name: "Owner" });
    expect(res.body.data.website).toMatchObject({ domain: "www.example.com" });
    expect(res.body.data.website.trackingId).toMatch(/^dfid_/);
    expect(res.body.data.websites).toHaveLength(1);
    expect(res.body.data.websites[0].role).toBe("owner");
    const setCookie = res.cookies.find((c) => c.startsWith("dg_session="));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=2592000/);

    const cookie = cookieFrom(res.cookies, "dg_session");
    const me = await api("/api/auth/me", { cookie });
    expect(me.status).toBe(200);
    expect(me.body.data.authKind).toBe("session");

    expect((await api("/api/setup")).body.data.needsSetup).toBe(false);
    const again = await api("/api/setup", {
      body: { token: TOKEN, email: "x@example.com", password: "another-password" },
    });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      status: "error",
      error: { code: 409, message: "Setup has already been completed" },
    });
  });

  it("rejects a wrong token and weak passwords", async () => {
    const wrong = await api("/api/setup", {
      body: { token: "nope", email: "a@example.com", password: "a-long-password" },
    });
    expect(wrong.status).toBe(403);
    const weak = await api("/api/setup", {
      body: { token: TOKEN, email: "a@example.com", password: "short" },
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toContain("password");
  });

  it("refuses to run with placeholder or short secrets", () => {
    expect(
      configErrors({ ...env, SESSION_SECRET: "replace-with-output-of-openssl-rand-hex-32" }),
    ).toEqual(["SESSION_SECRET still has the example placeholder value"]);
    expect(configErrors({ ...env, ENCRYPTION_KEY: "short", SETUP_TOKEN: "" })).toEqual([
      "SETUP_TOKEN is not set",
      "ENCRYPTION_KEY must be at least 32 characters",
    ]);
  });

  it("rejects cross-origin setup requests", async () => {
    const res = await api("/api/setup", {
      origin: "https://evil.example",
      body: { token: TOKEN, email: "a@example.com", password: "a-long-password" },
    });
    expect(res.status).toBe(403);
  });
});

describe("login, me, logout", () => {
  it("logs in with email and password and returns the user's websites", async () => {
    const user = await createUser({ email: "jane@example.com" });
    const res = await api("/api/auth/login", {
      body: { email: "JANE@example.com", password: user.password },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    const cookie = cookieFrom(res.cookies, "dg_session");
    expect(cookie).toBeDefined();
    expect((await api("/api/auth/me", { cookie })).status).toBe(200);

    const out = await api("/api/auth/logout", { method: "POST", cookie });
    expect(out.status).toBe(200);
    expect(out.cookies.join(";")).toMatch(/dg_session=;/);
    expect((await api("/api/auth/me", { cookie })).status).toBe(401);
  });

  it("returns the same error for unknown emails and wrong passwords", async () => {
    await createUser({ email: "jane@example.com" });
    const a = await api("/api/auth/login", {
      body: { email: "jane@example.com", password: "wrong-password" },
    });
    const b = await api("/api/auth/login", {
      body: { email: "nobody@example.com", password: "wrong-password" },
    });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it("throttles repeated failures with KV and writes KV only on failures", async () => {
    const user = await createUser({ email: "jane@example.com" });
    const m = meterEnv();
    const app = createApp();
    const login = (password: string) =>
      app.fetch(
        new Request("https://datagoat.test/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://datagoat.test",
            "cf-connecting-ip": "203.0.113.9",
          },
          body: JSON.stringify({ email: "jane@example.com", password }),
        }),
        m.env,
        { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
      );
    expect((await login(user.password)).status).toBe(200);
    expect(m.kv.writes).toBe(0);
    for (let i = 0; i < 8; i++) expect((await login("wrong")).status).toBe(401);
    expect(m.kv.writes).toBe(16);
    const blocked = await login(user.password);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("rejects forged and expired session cookies", async () => {
    const user = await createUser();
    expect((await api("/api/auth/me", { cookie: "dg_session=abc.def" })).status).toBe(401);
    const res = await api("/api/auth/login", {
      body: { email: user.email, password: user.password },
    });
    const cookie = cookieFrom(res.cookies, "dg_session") ?? "";
    const tampered = `${cookie.slice(0, -3)}xyz`;
    expect((await api("/api/auth/me", { cookie: tampered })).status).toBe(401);
    await env.DB.prepare("UPDATE auth_sessions SET expires_at = 1").run();
    expect((await api("/api/auth/me", { cookie })).status).toBe(401);
  });

  it("changes the password and signs out other sessions", async () => {
    const user = await createUser();
    const login = async () =>
      cookieFrom(
        (await api("/api/auth/login", { body: { email: user.email, password: user.password } }))
          .cookies,
        "dg_session",
      );
    const a = await login();
    const b = await login();
    const bad = await api("/api/auth/password", {
      method: "PUT",
      cookie: a,
      body: { currentPassword: "nope", newPassword: "new-password-1" },
    });
    expect(bad.status).toBe(400);
    const ok = await api("/api/auth/password", {
      method: "PUT",
      cookie: a,
      body: { currentPassword: user.password, newPassword: "new-password-1" },
    });
    expect(ok.status).toBe(200);
    expect((await api("/api/auth/me", { cookie: a })).status).toBe(200);
    expect((await api("/api/auth/me", { cookie: b })).status).toBe(401);
    expect(
      (await api("/api/auth/login", { body: { email: user.email, password: "new-password-1" } }))
        .status,
    ).toBe(200);
  });

  it("rehashes passwords stored with other iteration counts on login", async () => {
    const user = await createUser();
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(await hashPassword(user.password, 12_000), user.id)
      .run();
    expect(
      (await api("/api/auth/login", { body: { email: user.email, password: user.password } }))
        .status,
    ).toBe(200);
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ password_hash: string }>();
    expect(row?.password_hash.split("$")[1]).toBe("10000");
  });
});
