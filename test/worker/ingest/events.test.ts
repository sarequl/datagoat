/**
 * Every event type end to end (rows written), goal validation and session enrichment.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../../src/lib/crypto";
import { siteCache } from "../../../src/lib/site-cache";
import { createPayment, createSession } from "../../helpers/factories";
import { eventBody, freshIp, ingestSite, postEvent, resetIngest, rows, UA_IPHONE } from "./helpers";

const VISITOR = "11111111-1111-4111-8111-111111111111";
const SESSION = "s22222222-2222-4222-8222-222222222222";

async function site() {
  return ingestSite({ domain: "example.com" });
}

describe("goals (custom)", () => {
  beforeEach(resetIngest);

  const goal = (websiteId: string, extraData: Record<string, unknown>) =>
    postEvent(eventBody({ websiteId, type: "custom", extraData }), { ip: freshIp() });

  it("normalises the goal name and keeps up to 10 sanitised parameters", async () => {
    const s = await site();
    const params = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, i]));
    const res = await goal(s.publicId, { eventName: "Initiate Checkout", ...params, empty: null });
    expect(res.status).toBe(200);
    const [e] = await rows<{ name: string; props: string }>(
      "SELECT name, props FROM events WHERE site_id = ?",
      s.id,
    );
    expect(e?.name).toBe("initiate_checkout");
    expect(Object.keys(JSON.parse(e?.props ?? "{}"))).toHaveLength(10);
  });

  it("sanitises values and caps them at 255 characters", async () => {
    const s = await site();
    await goal(s.publicId, {
      eventName: "signup",
      html: '<img src=x onerror=alert(1)>"hi"',
      link: "javascript:alert(1)",
      long: "y".repeat(400),
    });
    const [e] = await rows<{ props: string }>("SELECT props FROM events WHERE site_id = ?", s.id);
    const props = JSON.parse(e?.props ?? "{}");
    expect(props.html).not.toMatch(/[<>]|onerror=/);
    expect(props.link).toBe("alert(1)");
    expect(props.long).toHaveLength(255);
  });

  it("accepts parameter names up to 64 characters (DataFast's client stops at 32)", async () => {
    const s = await site();
    expect((await goal(s.publicId, { eventName: "a", ["k".repeat(40)]: "v" })).status).toBe(200);
    expect((await goal(s.publicId, { eventName: "a", ["k".repeat(64)]: "v" })).status).toBe(200);
    expect((await goal(s.publicId, { eventName: "a", ["k".repeat(65)]: "v" })).status).toBe(400);
  });

  it.each([
    [
      "more than 10 parameters",
      {
        eventName: "a",
        ...Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, "v"])),
      },
    ],
    ["an invalid parameter name", { eventName: "a", "bad key!": "v" }],
    ["a missing name", { plan: "pro" }],
    ["a name with invalid characters", { eventName: "sign up!" }],
    ["a name over 64 characters", { eventName: "g".repeat(65) }],
    ["the reserved name identify", { eventName: "identify" }],
  ])("rejects %s with 400", async (_label, extraData) => {
    const s = await site();
    const res = await goal(s.publicId, extraData);
    expect(res.status).toBe(400);
    expect(await rows("SELECT id FROM events WHERE site_id = ?", s.id)).toEqual([]);
  });

  it("accepts colons and hyphens in goal names", async () => {
    const s = await site();
    expect((await goal(s.publicId, { eventName: "initiate:checkout-v2" })).status).toBe(200);
  });

  it("counts goals and outbound clicks as interactions, not pageviews", async () => {
    const s = await site();
    await postEvent(eventBody({ websiteId: s.publicId }));
    await goal(s.publicId, { eventName: "a" });
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        type: "external_link",
        extraData: { url: "https://x.com/a", text: "X" },
      }),
    );
    const [session] = await rows(
      "SELECT pageviews, interactions, exit_path FROM sessions WHERE site_id = ?",
      s.id,
    );
    expect(session).toEqual({ pageviews: 1, interactions: 2, exit_path: "/" });
  });
});

describe("identify", () => {
  beforeEach(resetIngest);

  const identify = (websiteId: string, extraData: Record<string, unknown>) =>
    postEvent(eventBody({ websiteId, type: "identify", extraData }));

  it("sets user_id, name, image and shallow-merges the profile", async () => {
    const s = await site();
    await postEvent(eventBody({ websiteId: s.publicId }));
    await identify(s.publicId, {
      user_id: "user_123",
      name: "Jane",
      image: "https://example.com/a.png",
      plan: "free",
      role: "admin",
    });
    await identify(s.publicId, { user_id: "user_123", plan: "pro", seats: 3 });
    const [v] = await rows(
      "SELECT user_id, name, image, profile FROM visitors WHERE site_id = ?",
      s.id,
    );
    expect(v).toMatchObject({
      user_id: "user_123",
      name: "Jane",
      image: "https://example.com/a.png",
    });
    expect(JSON.parse(String(v?.profile))).toEqual({ plan: "pro", role: "admin", seats: 3 });
  });

  it("requires user_id", async () => {
    const s = await site();
    expect((await identify(s.publicId, { name: "x" })).status).toBe(400);
  });

  it("drops a non-http image URL and keeps at most 10 custom fields", async () => {
    const s = await site();
    const extra = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, "v"]));
    await identify(s.publicId, { user_id: "u", image: "javascript:alert(1)", ...extra });
    const [v] = await rows<{ image: string | null; profile: string }>(
      "SELECT image, profile FROM visitors WHERE site_id = ?",
      s.id,
    );
    expect(v?.image).toBeNull();
    expect(Object.keys(JSON.parse(v?.profile ?? "{}"))).toHaveLength(10);
  });

  it("stores the email hash (and the email when the site keeps emails) for payment matching", async () => {
    const s = await site();
    await identify(s.publicId, { user_id: "Jane@Example.com" });
    const [v] = await rows("SELECT email, email_hash FROM visitors WHERE site_id = ?", s.id);
    expect(v).toEqual({
      email: "jane@example.com",
      email_hash: await sha256Hex("jane@example.com"),
    });
  });

  it("does not store the email itself when the site does not keep customer emails", async () => {
    const s = await site();
    await env.DB.prepare("UPDATE sites SET store_customer_emails = 0 WHERE id = ?")
      .bind(s.id)
      .run();
    siteCache.clear();
    await identify(s.publicId, { user_id: "u1", email: "jane@example.com" });
    const [v] = await rows("SELECT email, email_hash FROM visitors WHERE site_id = ?", s.id);
    expect(v).toEqual({ email: null, email_hash: await sha256Hex("jane@example.com") });
  });
});

describe("payments", () => {
  beforeEach(resetIngest);

  const pay = (websiteId: string, extraData: Record<string, unknown>) =>
    postEvent(eventBody({ websiteId, type: "payment", extraData }), { ip: freshIp() });

  it.each([
    ["stripe", { stripe_session_id: "cs_live_a1B2c3D4e5F6g7" }, "cs_live_a1B2c3D4e5F6g7"],
    [
      "polar",
      { polar_checkout_id: "4b7f6c1e-3c2d-4f0a-9e8b-7a6d5c4b3a21" },
      "4b7f6c1e-3c2d-4f0a-9e8b-7a6d5c4b3a21",
    ],
    ["lemonsqueezy", { lemonsqueezy_order_id: 9876543 }, "9876543"],
    [
      "paddle",
      { paddle_transaction_id: "txn_01h8bxq3m4n5p6q7r8s9t0v1w2" },
      "txn_01h8bxq3m4n5p6q7r8s9t0v1w2",
    ],
  ])("records a %s success-page reference as a payment hint", async (provider, extraData, ref) => {
    const s = await site();
    expect((await pay(s.publicId, extraData)).status).toBe(200);
    expect((await pay(s.publicId, extraData)).status).toBe(200); // a second redirect: still one hint
    const hints = await rows(
      "SELECT provider, ref, visitor_id, session_id, resolved_at FROM payment_hints WHERE site_id = ?",
      s.id,
    );
    expect(hints).toEqual([
      { provider, ref, visitor_id: VISITOR, session_id: SESSION, resolved_at: null },
    ]);
    const [e] = await rows<{ name: string; props: string }>(
      "SELECT name, props FROM events WHERE site_id = ? LIMIT 1",
      s.id,
    );
    expect(e?.name).toBe(provider);
    expect(JSON.parse(e?.props ?? "{}")).toEqual(
      Object.fromEntries(Object.entries(extraData).map(([k, v]) => [k, String(v)])),
    );
  });

  it.each([
    [{ stripe_session_id: "pi_123" }],
    [{ stripe_session_id: "cs_<x>" }],
    [{ paddle_transaction_id: "123" }],
    [{ email: "not-an-email" }],
    [{}],
  ])("rejects an invalid reference %j", async (extraData) => {
    const s = await site();
    expect((await pay(s.publicId, extraData)).status).toBe(400);
  });

  it("stores the payment email on the visitor without putting it in the event", async () => {
    const s = await site();
    await pay(s.publicId, { email: "Buyer@Example.com" });
    const [v] = await rows("SELECT email, email_hash FROM visitors WHERE site_id = ?", s.id);
    expect(v).toEqual({
      email: "buyer@example.com",
      email_hash: await sha256Hex("buyer@example.com"),
    });
    const [e] = await rows(
      "SELECT name, props FROM events WHERE site_id = ? AND type = 'payment'",
      s.id,
    );
    expect(e).toEqual({ name: "email", props: null });
  });

  it("attributes earlier unattributed payments with the same email to the visitor", async () => {
    const s = await site();
    const t0 = Date.now() - 3_600_000;
    // The visitor's earlier, non-direct session, then the payment, then the email arrives today.
    const first = await createSession({
      siteId: s.id,
      visitorId: VISITOR,
      startedAt: t0 - 86_400_000,
      channel: "Organic Search",
    });
    const paymentId = await createPayment({ siteId: s.id, amountMinor: 4900, occurredAt: t0 });
    const hash = await sha256Hex("buyer@example.com");
    await env.DB.prepare("UPDATE payments SET email_hash = ? WHERE id = ?")
      .bind(hash, paymentId)
      .run();
    const unrelated = await createPayment({ siteId: s.id, amountMinor: 100, occurredAt: t0 });
    await env.DB.prepare("UPDATE payments SET email_hash = ? WHERE id = ?")
      .bind(await sha256Hex("x@y.zz"), unrelated)
      .run();

    await pay(s.publicId, { email: "buyer@example.com" });
    const [p] = await rows(
      "SELECT visitor_id, first_session_id, last_session_id, last_non_direct_session_id, attributed_via FROM payments WHERE id = ?",
      paymentId,
    );
    expect(p).toEqual({
      visitor_id: VISITOR,
      first_session_id: first.id,
      last_session_id: first.id,
      last_non_direct_session_id: first.id,
      attributed_via: "email",
    });
    const [u] = await rows(
      "SELECT visitor_id, attributed_via FROM payments WHERE id = ?",
      unrelated,
    );
    expect(u).toEqual({ visitor_id: null, attributed_via: "none" });
  });

  it("identify with an email attributes unattributed payments too", async () => {
    const s = await site();
    const paymentId = await createPayment({
      siteId: s.id,
      amountMinor: 900,
      occurredAt: Date.now() - 1000,
    });
    await env.DB.prepare("UPDATE payments SET email_hash = ? WHERE id = ?")
      .bind(await sha256Hex("jane@example.com"), paymentId)
      .run();
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        type: "identify",
        extraData: { user_id: "u9", email: "jane@example.com" },
      }),
    );
    const [p] = await rows(
      "SELECT visitor_id, last_session_id, attributed_via FROM payments WHERE id = ?",
      paymentId,
    );
    // The payment predates every session of the visitor: the current session is the fallback.
    expect(p).toEqual({ visitor_id: VISITOR, last_session_id: SESSION, attributed_via: "email" });
  });
});

describe("outbound links and engagement", () => {
  beforeEach(resetIngest);

  it("stores external_link with url and text", async () => {
    const s = await site();
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        type: "external_link",
        extraData: { url: "https://github.com/x", text: " GitHub " },
      }),
    );
    const [e] = await rows<{ type: string; props: string }>(
      "SELECT type, props FROM events WHERE site_id = ?",
      s.id,
    );
    expect(e?.type).toBe("external_link");
    expect(JSON.parse(e?.props ?? "{}")).toEqual({ url: "https://github.com/x", text: "GitHub" });
  });

  it("rejects an external_link without an http(s) url", async () => {
    const s = await site();
    const res = await postEvent(
      eventBody({
        websiteId: s.publicId,
        type: "external_link",
        extraData: { url: "javascript:alert(1)" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("adds engagement time and keeps the deepest scroll on the session, without an event row", async () => {
    const s = await site();
    await postEvent(eventBody({ websiteId: s.publicId }));
    const beacon = (active_ms: number, max_scroll: number) =>
      postEvent(
        eventBody({
          websiteId: s.publicId,
          type: "engagement",
          extraData: { active_ms, max_scroll },
        }),
      );
    expect((await beacon(12_000, 40)).status).toBe(200);
    await beacon(3_000, 25);
    const [session] = await rows(
      "SELECT engaged_ms, max_scroll FROM sessions WHERE site_id = ?",
      s.id,
    );
    expect(session).toEqual({ engaged_ms: 15_000, max_scroll: 40 });
    expect(await rows("SELECT type FROM events WHERE site_id = ?", s.id)).toEqual([
      { type: "pageview" },
    ]);
  });

  it("clamps engagement values", async () => {
    const s = await site();
    await postEvent(eventBody({ websiteId: s.publicId }));
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        type: "engagement",
        extraData: { active_ms: 1e12, max_scroll: 500 },
      }),
    );
    const [session] = await rows(
      "SELECT engaged_ms, max_scroll FROM sessions WHERE site_id = ?",
      s.id,
    );
    expect(session).toEqual({ engaged_ms: 3_600_000, max_scroll: 100 });
  });
});

describe("enrichment", () => {
  beforeEach(resetIngest);

  const session = async (siteId: string) =>
    (await rows("SELECT * FROM sessions WHERE site_id = ?", siteId))[0] as Record<string, unknown>;

  it("reads UTM, ref, source and via from href and classifies the channel", async () => {
    const s = await site();
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        href: "https://example.com/pricing?utm_source=newsletter42&utm_medium=email&utm_campaign=launch&utm_term=t&utm_content=c&ref=producthunt&source=src&via=partner",
      }),
    );
    expect(await session(s.id)).toMatchObject({
      entry_path: "/pricing",
      utm_source: "newsletter42",
      utm_medium: "email",
      utm_campaign: "launch",
      utm_term: "t",
      utm_content: "c",
      ref: "producthunt",
      source_param: "src",
      via: "partner",
      channel: "Email",
      source: "producthunt",
    });
  });

  it("classifies an external referrer and stores its domain", async () => {
    const s = await site();
    await postEvent(
      eventBody({ websiteId: s.publicId, referrer: "https://www.google.com/search?q=x" }),
    );
    expect(await session(s.id)).toMatchObject({
      referrer: "https://www.google.com/search?q=x",
      referrer_domain: "google.com",
      channel: "Organic Search",
      source: "Google",
    });
  });

  it("treats referrers from the site's own hosts as internal (Direct)", async () => {
    const s = await site();
    await postEvent(
      eventBody({ websiteId: s.publicId, referrer: "https://blog.example.com/post" }),
    );
    expect(await session(s.id)).toMatchObject({
      referrer: null,
      referrer_domain: null,
      channel: "Direct",
      source: null,
    });
  });

  it("stores ad click ids from the body and the URL", async () => {
    const s = await site();
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        href: "https://example.com/?fbclid=fb1",
        adClickIds: { gclid: "g1" },
      }),
    );
    const row = await session(s.id);
    expect(JSON.parse(String(row.ad_click_ids))).toEqual({ gclid: "g1", fbclid: "fb1" });
    expect(row.channel).toBe("Paid Search");
  });

  it("keeps the session's first-event dimensions on later events", async () => {
    const s = await site();
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        href: "https://example.com/a?utm_source=first",
        referrer: "https://news.ycombinator.com/",
      }),
    );
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        href: "https://example.com/b?utm_source=second",
        referrer: "https://google.com/",
      }),
      {
        ua: UA_IPHONE,
        cf: { country: "FR" },
      },
    );
    expect(await session(s.id)).toMatchObject({
      entry_path: "/a",
      exit_path: "/b",
      utm_source: "first",
      channel: "Organic Social",
      source: "first",
      referrer_domain: "news.ycombinator.com",
      country: "US",
      device: "desktop",
      pageviews: 2,
    });
  });

  it("parses mobile user agents", async () => {
    const s = await site();
    await postEvent(eventBody({ websiteId: s.publicId }), { ua: UA_IPHONE });
    expect(await session(s.id)).toMatchObject({
      device: "mobile",
      browser: "Mobile Safari",
      os: "iOS",
      os_version: "17.5",
      device_vendor: "Apple",
      device_model: "iPhone",
    });
  });

  it("keeps the hash in the path for the hash build", async () => {
    const s = await site();
    await postEvent(
      eventBody({
        websiteId: s.publicId,
        href: "https://example.com/app?x=1#/settings/billing",
        trackHash: true,
      }),
    );
    await postEvent(
      eventBody({ websiteId: s.publicId, href: "https://example.com/plain#section" }),
      { ip: freshIp() },
    );
    const paths = await rows<{ path: string }>(
      "SELECT path FROM events WHERE site_id = ? ORDER BY id",
      s.id,
    );
    expect(paths.map((p) => p.path)).toEqual(["/app#/settings/billing", "/plain"]);
  });

  it("decodes percent-encoded paths and leaves the query out", async () => {
    const s = await site();
    await postEvent(
      eventBody({ websiteId: s.publicId, href: "https://example.com/caf%C3%A9?token=secret" }),
    );
    const [e] = await rows<{ path: string }>("SELECT path FROM events WHERE site_id = ?", s.id);
    expect(e?.path).toBe("/café");
  });

  it("drops Cloudflare's unknown and Tor country codes", async () => {
    const s = await site();
    await postEvent(eventBody({ websiteId: s.publicId }), {
      cf: { country: "T1", city: "Nowhere" },
    });
    expect(await session(s.id)).toMatchObject({ country: null, city: null });
  });
});
