/**
 * Write budget of every ingest path (plan §7, docs/architecture/data-model.md), measured with
 * `meta.rows_written` through the real Worker. Every path also costs 0 KV writes and at most one
 * D1 batch plus the documented reads. Changing a statement or index on the hot path must update
 * these numbers deliberately.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureSchema } from "../../../src/db/migrate";
import { sha256Hex } from "../../../src/lib/crypto";
import { siteCache } from "../../../src/lib/site-cache";
import type { Site } from "../../../src/lib/sites";
import { meterEnv, type WriteMeter } from "../../helpers/db";
import { createPayment } from "../../helpers/factories";
import { eventBody, freshIp, ingestSite, postEvent, resetIngest } from "./helpers";

let site: Site;
let m: WriteMeter;
const ip = "198.18.0.1";

const S2 = "s33333333-3333-4333-8333-333333333333";

async function send(
  extra: Record<string, unknown> = {},
  options: Parameters<typeof postEvent>[1] = {},
) {
  m.reset();
  const res = await postEvent(eventBody({ websiteId: site.publicId, ...extra }), {
    env: m.env,
    ip: freshIp(),
    ...options,
  });
  return { res, written: m.d1.rowsWritten, queries: m.d1.queries, kvWrites: m.kv.writes };
}

async function setup(overrides: Parameters<typeof ingestSite>[0] = {}) {
  site = await ingestSite({ domain: "example.com", ...overrides });
  m = meterEnv(env);
  await ensureSchema(env.DB); // the per-isolate migration check, done by any earlier request
  await siteCache.byPublicId(m.env.DB, site.publicId); // warm the isolate cache
}

describe("ingest write budget (cookie mode)", () => {
  beforeEach(async () => {
    await resetIngest();
    await setup();
  });

  it("first pageview of a new visitor: 6 rows in one batch", async () => {
    const r = await send();
    expect(r.res.status).toBe(200);
    expect(r).toMatchObject({ written: 6, queries: 1, kvWrites: 0 });
  });

  it("first pageview of a new session of a known visitor: 5 rows", async () => {
    await send();
    expect(await send({ sessionId: S2, sessionNumber: 2 })).toMatchObject({
      written: 5,
      queries: 1,
      kvWrites: 0,
    });
  });

  it("pageview within an existing session: 3 rows", async () => {
    await send();
    expect(await send({ href: "https://example.com/two" })).toMatchObject({
      written: 3,
      queries: 1,
      kvWrites: 0,
    });
  });

  it("goal and outbound click within a session: 3 rows each", async () => {
    await send();
    expect(
      await send({ type: "custom", extraData: { eventName: "signup", plan: "pro" } }),
    ).toMatchObject({ written: 3, queries: 1 });
    expect(
      await send({ type: "external_link", extraData: { url: "https://x.com/", text: "X" } }),
    ).toMatchObject({ written: 3, queries: 1 });
  });

  it("identify: 5 rows for a new user id, 4 for profile changes, 3 when nothing changed", async () => {
    await send();
    const identify = (extraData: Record<string, unknown>) => send({ type: "identify", extraData });
    expect(await identify({ user_id: "u1", plan: "pro" })).toMatchObject({
      written: 5,
      queries: 1,
    });
    expect(await identify({ user_id: "u1", plan: "pro" })).toMatchObject({
      written: 3,
      queries: 1,
    });
    expect(await identify({ user_id: "u1", plan: "team" })).toMatchObject({
      written: 4,
      queries: 1,
    });
    // New user id (row + index entry) and a first email (row + index entry), one batch.
    expect(await identify({ user_id: "u2", email: "a@b.co" })).toMatchObject({
      written: 7,
      queries: 1,
    });
    expect(await identify({ user_id: "u2", email: "a@b.co" })).toMatchObject({
      written: 3,
      queries: 1,
    });
  });

  it("payment with a provider reference: 5 rows (hint + its pending index), 3 for a repeat", async () => {
    await send();
    const hint = () =>
      send({ type: "payment", extraData: { stripe_session_id: "cs_test_abcdef123" } });
    expect(await hint()).toMatchObject({ written: 5, queries: 1, kvWrites: 0 });
    expect(await hint()).toMatchObject({ written: 3, queries: 1 });
  });

  it("payment with an email: 5 rows the first time, 3 for a repeat", async () => {
    await send();
    const email = () => send({ type: "payment", extraData: { email: "buyer@example.com" } });
    expect(await email()).toMatchObject({ written: 5, queries: 1 });
    expect(await email()).toMatchObject({ written: 3, queries: 1 });
  });

  it("payment email matching an unattributed payment adds the payment row and its visitor index", async () => {
    await send();
    const id = await createPayment({ siteId: site.id, amountMinor: 1000, occurredAt: Date.now() });
    await env.DB.prepare("UPDATE payments SET email_hash = ? WHERE id = ?")
      .bind(await sha256Hex("buyer@example.com"), id)
      .run();
    expect(
      await send({ type: "payment", extraData: { email: "buyer@example.com" } }),
    ).toMatchObject({ written: 7, queries: 1 });
  });

  it("engagement beacon: 1 row, one statement", async () => {
    await send();
    expect(
      await send({ type: "engagement", extraData: { active_ms: 5000, max_scroll: 80 } }),
    ).toMatchObject({
      written: 1,
      queries: 1,
      kvWrites: 0,
    });
    // Nothing new to record: nothing written.
    expect(
      await send({ type: "engagement", extraData: { active_ms: 0, max_scroll: 10 } }),
    ).toMatchObject({ written: 0 });
  });

  it("bot drop: 1 row (bot_daily upsert)", async () => {
    expect(await send({}, { ua: "curl/8.0" })).toMatchObject({
      written: 1,
      queries: 1,
      kvWrites: 0,
    });
    expect(await send({}, { ua: "curl/8.0" })).toMatchObject({ written: 1, queries: 1 });
  });

  it("excluded hit: nothing written, no query", async () => {
    await env.DB.prepare("UPDATE sites SET excluded_paths = ? WHERE id = ?")
      .bind('["/admin/*"]', site.id)
      .run();
    siteCache.clear();
    await siteCache.byPublicId(env.DB, site.publicId);
    expect(await send({ href: "https://example.com/admin/x" })).toMatchObject({
      written: 0,
      queries: 0,
      kvWrites: 0,
    });
  });

  it("rejected body: nothing written, no query", async () => {
    expect(await send({ type: "custom", extraData: { eventName: "bad name!" } })).toMatchObject({
      written: 0,
      queries: 0,
    });
  });

  it("a known site costs no site read (isolate cache)", async () => {
    await send();
    const r = await send({ href: "https://example.com/three" });
    expect(r.queries).toBe(1);
    expect(m.d1.rowsRead).toBeLessThan(10);
  });
});

describe("ingest write budget (cookieless)", () => {
  beforeEach(async () => {
    await resetIngest();
    await setup({ privacyMode: "cookieless" });
  });

  it("first hit of the day creates the salt (1 row), then 6 rows; later hits 3 rows", async () => {
    const first = await send({}, { ip });
    // salt read, salt insert + reread (batch), session lookup, write batch
    expect(first).toMatchObject({ written: 7, queries: 4, kvWrites: 0 });
    // Same visitor, same isolate: salts and session are cached; only the write batch.
    expect(await send({ href: "https://example.com/two" }, { ip })).toMatchObject({
      written: 3,
      queries: 1,
    });
    // A new visitor: one indexed session lookup plus the write batch.
    expect(await send({}, { ip: "198.18.0.2" })).toMatchObject({ written: 6, queries: 2 });
  });
});
