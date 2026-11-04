/**
 * Wire protocol: DataFast's captured request bodies replay into the collector and produce the
 * expected rows; content types, CORS, preflight and error responses.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CAPTURED_GOAL,
  CAPTURED_HEADERS,
  CAPTURED_IDENTIFY,
  CAPTURED_PAGEVIEW,
  CAPTURED_SPA_PAGEVIEW,
  DATAFAST_SHAPES,
} from "../../fixtures/datafast/captured";
import { freshIp, ingestSite, postEvent, resetIngest, rows } from "./helpers";

const VISITOR = CAPTURED_PAGEVIEW.visitorId;
const SESSION = CAPTURED_PAGEVIEW.sessionId;

function replay(body: unknown, ip = "203.0.113.20") {
  const { "user-agent": ua, "content-type": contentType, ...headers } = CAPTURED_HEADERS;
  return postEvent(body, { ua, contentType, headers, ip });
}

describe("DataFast captured bodies", () => {
  beforeEach(resetIngest);

  it("stores the captured pageview as a session, visitor and event", async () => {
    const site = await ingestSite();
    const res = await replay(CAPTURED_PAGEVIEW);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});

    const [session] = await rows("SELECT * FROM sessions WHERE site_id = ?", site.id);
    expect(session).toMatchObject({
      id: SESSION,
      visitor_id: VISITOR,
      session_number: 1,
      cookieless: 0,
      hostname: "localhost",
      entry_path: "/",
      exit_path: "/",
      pageviews: 1,
      interactions: 0,
      referrer: null,
      referrer_domain: null,
      channel: "Referral",
      source: "capture_test",
      utm_source: "capture_test",
      country: "US",
      region: "California",
      city: "San Francisco",
      lat: 37.77,
      lon: -122.42,
      device: "desktop",
      browser: "Chrome",
      browser_version: "130",
      os: "Mac OS",
      language: "en-US",
      timezone: "Asia/Dhaka",
      screen_width: 1280,
      screen_height: 720,
      viewport_width: 1280,
      viewport_height: 720,
    });
    expect(session?.started_at).toBe(session?.last_seen_at);

    const [visitor] = await rows("SELECT * FROM visitors WHERE site_id = ?", site.id);
    expect(visitor).toMatchObject({
      id: VISITOR,
      first_session_id: SESSION,
      client_first_seen_at: Date.parse("2026-11-04T17:26:33.885Z"),
      user_id: null,
    });

    const events = await rows("SELECT * FROM events WHERE site_id = ?", site.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "pageview",
      session_id: SESSION,
      visitor_id: VISITOR,
      hostname: "localhost",
      path: "/",
      name: null,
      props: null,
    });
  });

  it("stores the captured goal with its parameters and counts an interaction", async () => {
    const site = await ingestSite();
    await replay(CAPTURED_PAGEVIEW);
    const res = await replay(CAPTURED_GOAL);
    expect(res.status).toBe(200);
    const goal = await rows<{ name: string; props: string }>(
      "SELECT name, props FROM events WHERE site_id = ? AND type = 'custom'",
      site.id,
    );
    expect(goal).toHaveLength(1);
    expect(goal[0]?.name).toBe("test_goal");
    expect(JSON.parse(goal[0]?.props ?? "")).toEqual({ plan: "pro" });
    const [session] = await rows(
      "SELECT pageviews, interactions FROM sessions WHERE id = ?",
      SESSION,
    );
    expect(session).toEqual({ pageviews: 1, interactions: 1 });
  });

  it("stores the captured identify on the visitor profile", async () => {
    const site = await ingestSite();
    await replay(CAPTURED_PAGEVIEW);
    const res = await replay(CAPTURED_IDENTIFY);
    expect(res.status).toBe(200);
    const [visitor] = await rows(
      "SELECT user_id, name, image, profile, identified_at FROM visitors WHERE site_id = ?",
      site.id,
    );
    // DataFast sends name "" and image "" when they are absent: those are not stored.
    expect(visitor).toMatchObject({ user_id: "u1", name: null, image: null, profile: "{}" });
    expect(visitor?.identified_at).toBeTypeOf("number");
    const events = await rows<{ props: string }>(
      "SELECT props FROM events WHERE site_id = ? AND type = 'identify'",
      site.id,
    );
    expect(JSON.parse(events[0]?.props ?? "")).toEqual({ user_id: "u1" });
  });

  it("extends the session with the captured pushState pageview", async () => {
    const site = await ingestSite();
    await replay(CAPTURED_PAGEVIEW);
    await replay(CAPTURED_SPA_PAGEVIEW);
    const [session] = await rows(
      "SELECT entry_path, exit_path, pageviews, utm_source FROM sessions WHERE site_id = ?",
      site.id,
    );
    expect(session).toEqual({
      entry_path: "/",
      exit_path: "/spa-route",
      pageviews: 2,
      utm_source: "capture_test",
    });
    const paths = await rows<{ path: string }>(
      "SELECT path FROM events WHERE site_id = ? ORDER BY id",
      site.id,
    );
    expect(paths.map((p) => p.path)).toEqual(["/", "/spa-route"]);
  });

  it("accepts every other body shape DataFast's script builds", async () => {
    const site = await ingestSite();
    await replay(CAPTURED_PAGEVIEW);
    for (const [name, body] of Object.entries(DATAFAST_SHAPES)) {
      const res = await replay(body, freshIp());
      expect(res.status, name).toBe(200);
    }
    const types = await rows<{ type: string; n: number }>(
      "SELECT type, COUNT(*) AS n FROM events WHERE site_id = ? GROUP BY type ORDER BY type",
      site.id,
    );
    expect(types).toEqual([
      { type: "custom", n: 1 },
      { type: "external_link", n: 1 },
      { type: "pageview", n: 3 },
      { type: "payment", n: 4 },
    ]);
    const hints = await rows(
      "SELECT provider, ref FROM payment_hints WHERE site_id = ? ORDER BY provider",
      site.id,
    );
    expect(hints).toEqual([
      { provider: "lemonsqueezy", ref: "1234567" },
      { provider: "polar", ref: "9f5e3c5e-1d1e-4a35-8f0b-1c2d3e4f5a6b" },
      { provider: "stripe", ref: "cs_test_a1b2c3d4e5f6" },
    ]);
  });
});

describe("transport and CORS", () => {
  beforeEach(resetIngest);

  it("answers the CORS preflight DataFast's application/json XHR triggers", async () => {
    const res = await postEvent(null, {
      method: "OPTIONS",
      contentType: null,
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it.each([
    ["application/json", "application/json"],
    ["text/plain (sendBeacon)", "text/plain;charset=UTF-8"],
    ["no content type", null],
  ])("parses the body as JSON with %s", async (_label, contentType) => {
    const site = await ingestSite();
    const res = await postEvent(CAPTURED_PAGEVIEW, { contentType, ip: freshIp() });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await rows("SELECT id FROM events WHERE site_id = ?", site.id)).toHaveLength(1);
  });

  it("rejects malformed bodies with 400 and keeps CORS headers on errors", async () => {
    await ingestSite();
    for (const body of ["not json", "[]", "null", JSON.stringify({ type: "pageview" })]) {
      const res = await postEvent(body);
      expect(res.status, body).toBe(400);
      expect(res.body.status).toBe("error");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    const badType = await postEvent({ ...CAPTURED_PAGEVIEW, type: "nope" });
    expect(badType.status).toBe(400);
    expect(badType.body.error.message).toContain("type must be one of");
    const badHref = await postEvent({ ...CAPTURED_PAGEVIEW, href: "/relative" });
    expect(badHref.status).toBe(400);
  });

  it("rejects bodies over 8 KB with 413", async () => {
    await ingestSite();
    const big = { ...CAPTURED_PAGEVIEW, referrer: `https://example.org/?q=${"x".repeat(9000)}` };
    const res = await postEvent(big);
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers 404 for an unknown website id", async () => {
    const res = await postEvent({ ...CAPTURED_PAGEVIEW, websiteId: "dfid_unknown" });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Website not found");
  });

  it("ignores deleted websites", async () => {
    const site = await ingestSite();
    const { env } = await import("cloudflare:test");
    await env.DB.prepare("UPDATE sites SET deleted_at = ? WHERE id = ?")
      .bind(Date.now(), site.id)
      .run();
    const { siteCache } = await import("../../../src/lib/site-cache");
    siteCache.clear();
    expect((await postEvent(CAPTURED_PAGEVIEW)).status).toBe(404);
  });

  it("does not let API caching or auth middleware touch the collector", async () => {
    await ingestSite();
    const res = await postEvent(CAPTURED_PAGEVIEW, {
      headers: { authorization: "Bearer df_nope" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
