/**
 * Identity in the three privacy modes, GPC, cookieless salts and their rotation job.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ingestJobs } from "../../../src/ingest";
import { handleEvent } from "../../../src/ingest/handler";
import { clearIdentityCache, uuidFromBytes } from "../../../src/ingest/identity";
import { clearSaltCache, getSalts, rotateSalts, utcDay } from "../../../src/ingest/salts";
import { runScheduled } from "../../../src/jobs/scheduler";
import { isUuidV4 } from "../../../src/lib/ids";
import { siteCache } from "../../../src/lib/site-cache";
import { DATAFAST_SHAPES } from "../../fixtures/datafast/captured";
import {
  eventBody,
  freshIp,
  ingestSite,
  postEvent,
  resetIngest,
  rows,
  UA_CHROME,
  UA_IPHONE,
} from "./helpers";

const DAY = 86_400_000;

async function setSite(siteId: string, assignments: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(assignments);
  await env.DB.prepare(`UPDATE sites SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .bind(...cols.map((c) => assignments[c]), siteId)
    .run();
  siteCache.clear();
}

/** Call the handler with a fixed clock. */
async function postAt(now: number, body: unknown, ip: string, ua = UA_CHROME) {
  const ctx = createExecutionContext();
  const res = await handleEvent(
    new Request("https://collector.test/api/events", {
      method: "POST",
      headers: { "user-agent": ua, "cf-connecting-ip": ip, "accept-language": "en" },
      body: JSON.stringify(body),
    }),
    { env, waitUntil: (p) => ctx.waitUntil(p), now },
  );
  await waitOnExecutionContext(ctx);
  return {
    status: res.status,
    body: (await res.json()) as { visitorId?: string; sessionId?: string },
  };
}

describe("cookie mode", () => {
  beforeEach(resetIngest);

  it("turns on DataFast compatibility once a browser reports DataFast's cookie", async () => {
    const site = await ingestSite({ domain: "example.com" });
    // A site that never used DataFast: plain reply, setting stays off.
    expect((await postEvent(eventBody({ websiteId: site.publicId }))).body).toEqual({});
    const off = await rows("SELECT datafast_compat FROM sites WHERE id = ?", site.id);
    expect(off[0]).toEqual({ datafast_compat: 0 });

    // A returning DataFast visitor: the site switches to compatibility, in one write.
    const res = await postEvent(eventBody({ websiteId: site.publicId, datafastCookie: true }));
    expect(res.body).toEqual({ compat: "datafast" });
    const on = await rows("SELECT datafast_compat FROM sites WHERE id = ?", site.id);
    expect(on[0]).toEqual({ datafast_compat: 1 });

    // From now on even brand-new visitors are told to write datafast_* cookies too.
    siteCache.invalidate(site);
    const fresh = await postEvent(
      eventBody({
        websiteId: site.publicId,
        visitorId: "33333333-3333-4333-8333-333333333333",
        sessionId: "s44444444-4444-4444-8444-444444444444",
      }),
    );
    expect(fresh.body).toEqual({ compat: "datafast" });
  });

  it("leaves compatibility off when the owner turned it off", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await env.DB.prepare("UPDATE sites SET datafast_compat = 2 WHERE id = ?").bind(site.id).run();
    siteCache.invalidate(site);
    const res = await postEvent(eventBody({ websiteId: site.publicId, datafastCookie: true }));
    expect(res.body).toEqual({});
    const [row] = await rows("SELECT datafast_compat FROM sites WHERE id = ?", site.id);
    expect(row).toEqual({ datafast_compat: 2 });
  });

  it("uses the tracker's visitor and session ids and session number", async () => {
    const site = await ingestSite({ domain: "example.com" });
    const res = await postEvent(eventBody({ websiteId: site.publicId, sessionNumber: 3 }));
    expect(res.body).toEqual({});
    const [s] = await rows(
      "SELECT id, visitor_id, session_number, cookieless FROM sessions WHERE site_id = ?",
      site.id,
    );
    expect(s).toEqual({
      id: "s22222222-2222-4222-8222-222222222222",
      visitor_id: "11111111-1111-4111-8111-111111111111",
      session_number: 3,
      cookieless: 0,
    });
  });

  it("normalises upper-case ids", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await postEvent(
      eventBody({
        websiteId: site.publicId,
        visitorId: "AAAAAAAA-1111-4111-8111-111111111111",
        sessionId: "sAAAAAAAA-2222-4222-8222-222222222222",
      }),
    );
    const [s] = await rows("SELECT id, visitor_id FROM sessions WHERE site_id = ?", site.id);
    expect(s).toEqual({
      id: "saaaaaaaa-2222-4222-8222-222222222222",
      visitor_id: "aaaaaaaa-1111-4111-8111-111111111111",
    });
  });

  it("sessionises server-side when a valid visitor id comes without a session id", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await postEvent(eventBody({ websiteId: site.publicId, sessionId: "" }));
    await postEvent(
      eventBody({ websiteId: site.publicId, sessionId: "", href: "https://example.com/two" }),
    );
    const sessions = await rows<{ id: string; pageviews: number }>(
      "SELECT id, pageviews FROM sessions WHERE site_id = ?",
      site.id,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.pageviews).toBe(2);
    expect(sessions[0]?.id).toMatch(/^s[0-9a-f-]{36}$/);
  });

  it("falls back to a server hash when the visitor id is not a UUID", async () => {
    const site = await ingestSite({ domain: "example.com" });
    const res = await postEvent(eventBody({ websiteId: site.publicId, visitorId: "<script>" }));
    expect(isUuidV4(res.body.visitorId)).toBe(true);
    const [s] = await rows(
      "SELECT cookieless, session_number FROM sessions WHERE site_id = ?",
      site.id,
    );
    expect(s).toEqual({ cookieless: 1, session_number: null });
  });
});

describe("cookieless mode", () => {
  beforeEach(resetIngest);

  it("derives a UUID-shaped visitor id from the daily salt, IP and UA and returns it", async () => {
    const site = await ingestSite({ domain: "localhost.test", privacyMode: "cookieless" });
    const ip = freshIp();
    const a = await postEvent(DATAFAST_SHAPES.cookieless, { ip });
    const b = await postEvent(
      { ...DATAFAST_SHAPES.cookieless, href: "http://localhost:8787/two" },
      { ip },
    );
    expect(a.status).toBe(200);
    expect(isUuidV4(a.body.visitorId)).toBe(true);
    expect(a.body.sessionId).toMatch(/^s[0-9a-f-]{36}$/);
    expect(b.body).toEqual(a.body);
    // The random visitorId DataFast's cookieless script sends is ignored.
    expect(a.body.visitorId).not.toBe(DATAFAST_SHAPES.cookieless.visitorId);

    const sessions = await rows(
      "SELECT id, visitor_id, cookieless, session_number, pageviews FROM sessions WHERE site_id = ?",
      site.id,
    );
    expect(sessions).toEqual([
      {
        id: a.body.sessionId,
        visitor_id: a.body.visitorId,
        cookieless: 1,
        session_number: null,
        pageviews: 2,
      },
    ]);
    const [visitor] = await rows(
      "SELECT id, client_first_seen_at FROM visitors WHERE site_id = ?",
      site.id,
    );
    expect(visitor).toEqual({ id: a.body.visitorId, client_first_seen_at: null });
  });

  it("ignores client cookie ids on a cookieless site", async () => {
    const site = await ingestSite({ domain: "example.com", privacyMode: "cookieless" });
    const res = await postEvent(eventBody({ websiteId: site.publicId }));
    expect(res.body.visitorId).not.toBe("11111111-1111-4111-8111-111111111111");
  });

  it("separates visitors by IP and by user agent, and sites from each other", async () => {
    const site = await ingestSite({ domain: "example.com", privacyMode: "cookieless" });
    const other = await ingestSite({
      domain: "other.com",
      publicId: "dfid_other",
      privacyMode: "cookieless",
    });
    const ip = freshIp();
    const base = await postEvent(eventBody({ websiteId: site.publicId }), { ip });
    const otherIp = await postEvent(eventBody({ websiteId: site.publicId }), { ip: freshIp() });
    const otherUa = await postEvent(eventBody({ websiteId: site.publicId }), { ip, ua: UA_IPHONE });
    const otherSite = await postEvent(
      eventBody({ websiteId: other.publicId, href: "https://other.com/" }),
      { ip },
    );
    const ids = [base, otherIp, otherUa, otherSite].map((r) => r.body.visitorId);
    expect(new Set(ids).size).toBe(4);
  });

  it("starts a new session after 30 minutes of inactivity", async () => {
    const site = await ingestSite({ domain: "example.com", privacyMode: "cookieless" });
    const ip = freshIp();
    const t0 = Date.UTC(2026, 10, 4, 12, 0, 0);
    const a = await postAt(t0, eventBody({ websiteId: site.publicId }), ip);
    const b = await postAt(t0 + 29 * 60_000, eventBody({ websiteId: site.publicId }), ip);
    const c = await postAt(
      t0 + 29 * 60_000 + 31 * 60_000,
      eventBody({ websiteId: site.publicId }),
      ip,
    );
    expect(b.body.sessionId).toBe(a.body.sessionId);
    expect(c.body.sessionId).not.toBe(a.body.sessionId);
    expect(c.body.visitorId).toBe(a.body.visitorId);
  });

  it("finds the session from the database when another isolate served the earlier event", async () => {
    const site = await ingestSite({ domain: "example.com", privacyMode: "cookieless" });
    const ip = freshIp();
    const t0 = Date.UTC(2026, 10, 4, 12, 0, 0);
    const a = await postAt(t0, eventBody({ websiteId: site.publicId }), ip);
    clearIdentityCache();
    const b = await postAt(t0 + 60_000, eventBody({ websiteId: site.publicId }), ip);
    expect(b.body).toEqual(a.body);
  });

  it("continues a session across midnight UTC with yesterday's salt, then rotates", async () => {
    const site = await ingestSite({ domain: "example.com", privacyMode: "cookieless" });
    const ip = freshIp();
    const before = Date.UTC(2026, 10, 4, 23, 50);
    const after = Date.UTC(2026, 10, 5, 0, 10);
    const a = await postAt(before, eventBody({ websiteId: site.publicId }), ip);
    clearIdentityCache(); // force the database lookup
    clearSaltCache();
    const b = await postAt(after, eventBody({ websiteId: site.publicId }), ip);
    expect(b.body).toEqual(a.body);
    // After the session lapses, the same person gets today's (different) visitor id.
    const c = await postAt(after + 40 * 60_000, eventBody({ websiteId: site.publicId }), ip);
    expect(c.body.visitorId).not.toBe(a.body.visitorId);
    expect(c.body.sessionId).not.toBe(a.body.sessionId);
  });

  it("does not link identities: identify is ignored and payment emails are not stored", async () => {
    const site = await ingestSite({ domain: "example.com", privacyMode: "cookieless" });
    const ip = freshIp();
    await postEvent(eventBody({ websiteId: site.publicId }), { ip });
    const identify = await postEvent(
      eventBody({
        websiteId: site.publicId,
        type: "identify",
        extraData: { user_id: "u1", email: "a@b.co" },
      }),
      { ip },
    );
    expect(identify.status).toBe(200);
    await postEvent(
      eventBody({ websiteId: site.publicId, type: "payment", extraData: { email: "a@b.co" } }),
      { ip },
    );
    const [v] = await rows(
      "SELECT user_id, email, email_hash FROM visitors WHERE site_id = ?",
      site.id,
    );
    expect(v).toEqual({ user_id: null, email: null, email_hash: null });
    const types = await rows<{ type: string }>(
      "SELECT type FROM events WHERE site_id = ? ORDER BY id",
      site.id,
    );
    expect(types.map((t) => t.type)).toEqual(["pageview", "payment"]);
  });

  it("still records payment-link references (same-day attribution)", async () => {
    const site = await ingestSite({ domain: "localhost.test", privacyMode: "cookieless" });
    const res = await postEvent(DATAFAST_SHAPES.stripe);
    const hints = await rows(
      "SELECT provider, ref, visitor_id, session_id FROM payment_hints WHERE site_id = ?",
      site.id,
    );
    expect(hints).toEqual([
      {
        provider: "stripe",
        ref: "cs_test_a1b2c3d4e5f6",
        visitor_id: res.body.visitorId,
        session_id: res.body.sessionId,
      },
    ]);
  });
});

describe("DataFast's cookieless script on a cookie-mode site", () => {
  beforeEach(resetIngest);

  it("is processed cookieless because the body says so", async () => {
    const site = await ingestSite({ domain: "localhost.test" });
    const res = await postEvent(DATAFAST_SHAPES.cookieless);
    expect(isUuidV4(res.body.visitorId)).toBe(true);
    const [s] = await rows("SELECT cookieless FROM sessions WHERE site_id = ?", site.id);
    expect(s?.cookieless).toBe(1);
  });
});

describe("consent mode", () => {
  beforeEach(resetIngest);

  it("is cookieless until consent, then uses the cookie ids the tracker adopts", async () => {
    const site = await ingestSite({ domain: "example.com", privacyMode: "consent" });
    const ip = freshIp();
    const before = await postEvent(
      eventBody({
        websiteId: site.publicId,
        cookieless: true,
        visitorId: undefined,
        sessionId: undefined,
      }),
      { ip },
    );
    expect(isUuidV4(before.body.visitorId)).toBe(true);
    // datafast("consent", true): the tracker writes the server ids into its cookies.
    const after = await postEvent(
      eventBody({
        websiteId: site.publicId,
        visitorId: before.body.visitorId,
        sessionId: before.body.sessionId,
        href: "https://example.com/after-consent",
      }),
      { ip },
    );
    expect(after.body).toEqual({});
    const sessions = await rows(
      "SELECT id, visitor_id, pageviews FROM sessions WHERE site_id = ?",
      site.id,
    );
    expect(sessions).toEqual([
      { id: before.body.sessionId, visitor_id: before.body.visitorId, pageviews: 2 },
    ]);
  });
});

describe("Global Privacy Control", () => {
  beforeEach(resetIngest);

  it("processes Sec-GPC: 1 hits cookieless when the site honours GPC (default)", async () => {
    const site = await ingestSite({ domain: "example.com" });
    const res = await postEvent(eventBody({ websiteId: site.publicId }), {
      headers: { "sec-gpc": "1" },
    });
    expect(isUuidV4(res.body.visitorId)).toBe(true);
    expect(res.body.visitorId).not.toBe("11111111-1111-4111-8111-111111111111");
  });

  it("keeps cookie ids when the site does not honour GPC", async () => {
    const site = await ingestSite({ domain: "example.com" });
    await setSite(site.id, { honor_gpc: 0 });
    const res = await postEvent(eventBody({ websiteId: site.publicId }), {
      headers: { "sec-gpc": "1" },
    });
    expect(res.body).toEqual({});
    const [s] = await rows("SELECT visitor_id FROM sessions WHERE site_id = ?", site.id);
    expect(s?.visitor_id).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("cookieless salts", () => {
  beforeEach(resetIngest);

  it("are random per day and created on demand when the job has not run", async () => {
    const now = Date.UTC(2026, 10, 4, 9);
    const salts = await getSalts(env.DB, now);
    expect(salts.today).toMatch(/^[0-9a-f]{64}$/);
    expect(salts.yesterday).toBeNull();
    clearSaltCache();
    expect((await getSalts(env.DB, now)).today).toBe(salts.today);
    clearSaltCache();
    const tomorrow = await getSalts(env.DB, now + DAY);
    expect(tomorrow.today).not.toBe(salts.today);
    expect(tomorrow.yesterday).toBe(salts.today);
  });

  it("the 00:00 UTC job creates today's salt, keeps yesterday's and deletes older ones", async () => {
    const d0 = Date.UTC(2026, 10, 1);
    for (let i = 0; i < 4; i++) await rotateSalts(env.DB, d0 + i * DAY);
    const days = await rows<{ day: string }>("SELECT day FROM cookieless_salts ORDER BY day");
    expect(days.map((d) => d.day)).toEqual([utcDay(d0 + 2 * DAY), utcDay(d0 + 3 * DAY)]);
    // Idempotent within a day: the salt does not change.
    const [before] = await rows<{ salt: string }>(
      "SELECT salt FROM cookieless_salts WHERE day = ?",
      utcDay(d0 + 3 * DAY),
    );
    await rotateSalts(env.DB, d0 + 3 * DAY + 3_600_000);
    const [again] = await rows<{ salt: string }>(
      "SELECT salt FROM cookieless_salts WHERE day = ?",
      utcDay(d0 + 3 * DAY),
    );
    expect(again?.salt).toBe(before?.salt);
  });

  it("is registered with the cron multiplexer at 00:00 UTC", async () => {
    const at = Date.UTC(2026, 10, 6, 0, 0, 30);
    const res = await runScheduled(ingestJobs, env, createExecutionContext(), at);
    expect(res.results).toEqual([
      expect.objectContaining({ name: "ingest.rotate-salts", status: "ok" }),
    ]);
    expect(await rows("SELECT day FROM cookieless_salts")).toEqual([{ day: "2026-11-06" }]);
    // Already ran for this slot: not due again later the same day.
    const later = await runScheduled(ingestJobs, env, createExecutionContext(), at + 3_600_000);
    expect(later.results[0]?.status).toBe("not_due");
  });

  it("formats HMAC bytes as a UUID v4", () => {
    const id = uuidFromBytes(new Uint8Array(32).fill(0xff));
    expect(id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(isUuidV4(id)).toBe(true);
  });
});
