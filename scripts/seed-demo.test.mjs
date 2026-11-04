// Run with: npm run test:scripts
import assert from "node:assert/strict";
import { test } from "node:test";
import { generate, parseArgs, sqlValue, toSql } from "./seed-demo.mjs";

const opts = { ...parseArgs([]), days: 14, daily: 40 };
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

test("is deterministic for the same seed", () => {
  const a = generate(opts, NOW);
  const b = generate(opts, NOW);
  assert.equal(a.visitors.length, b.visitors.length);
  assert.deepEqual(
    a.sessions.map((s) => s.id),
    b.sessions.map((s) => s.id),
  );
  assert.notDeepEqual(generate({ ...opts, seed: 7 }, NOW).sessions[0].id, a.sessions[0].id);
});

test("produces consistent, realistic data", () => {
  const d = generate(opts, NOW);
  const sessionIds = new Set(d.sessions.map((s) => s.id));
  const visitorIds = new Set(d.visitors.map((v) => v.id));
  for (const e of d.events) {
    assert.ok(sessionIds.has(e[2]), "event session exists");
    assert.ok(visitorIds.has(e[3]), "event visitor exists");
    assert.ok(e[1] <= NOW, "no events in the future");
  }
  for (const s of d.sessions) {
    assert.ok(s.last_seen_at >= s.started_at);
    assert.ok(s.pageviews >= 1);
    assert.ok(["desktop", "mobile", "tablet"].includes(s.device));
  }
  for (const p of d.payments) {
    if (p.visitor_id) assert.ok(visitorIds.has(p.visitor_id), "payment visitor exists");
    if (p.kind === "refund") assert.ok(p.amount < 0 && p.refund_of);
  }
  const live = d.sessions.filter((s) => s.last_seen_at > NOW - 10 * 60_000);
  assert.ok(live.length >= 6, "has live visitors for the realtime view");
  const channels = new Set(d.sessions.map((s) => s.channel));
  assert.ok(channels.size >= 6, "spreads traffic across channels");
});

test("emits SQL that replaces only the demo site and escapes values", () => {
  const sql = toSql(generate(opts, NOW), opts);
  assert.match(sql, /DELETE FROM sites WHERE domain = 'demo\.datagoat\.dev';/);
  assert.match(sql, /INSERT INTO users .* ON CONFLICT \(email\) DO NOTHING;/);
  assert.doesNotMatch(sql, /--remote/);
  assert.equal(sqlValue("O'Brien"), "'O''Brien'");
  assert.equal(sqlValue(null), "NULL");
});

test("rejects unknown and out-of-range options", () => {
  assert.throws(() => parseArgs(["--nope", "1"]), /Unknown option/);
  assert.throws(() => parseArgs(["--days", "0"]), /--days/);
});
