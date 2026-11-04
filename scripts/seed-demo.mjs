#!/usr/bin/env node
// Seeds a LOCAL D1 database with a realistic demo website, for development,
// screenshots and demos. It writes raw data only (visitors, sessions, events,
// payments, funnels, goals, notes), so every number the dashboard shows is
// computed by the real query code.
//
//   npm run seed:demo                      90 days, ~220 visitors/day
//   npm run seed:demo -- --days 30 --daily 80
//   npm run seed:demo -- --out demo.sql    write the SQL without applying it
//
// Login afterwards: demo@datagoat.dev / demo-password (or --email/--password).
// Output is deterministic for the same --seed. Never runs against --remote.

import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAY = 86_400_000;
const MIN = 60_000;

// ---------------------------------------------------------------- arguments

export function parseArgs(argv) {
  const opts = {
    days: 90,
    daily: 220,
    domain: "demo.datagoat.dev",
    name: "DataGoat Demo",
    email: "demo@datagoat.dev",
    password: "demo-password",
    seed: 42,
    out: null,
    config: "wrangler.jsonc",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (!(key in opts)) throw new Error(`Unknown option --${key}`);
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    opts[key] = typeof opts[key] === "number" ? Number(value) : value;
    i++;
  }
  if (!(opts.days >= 1 && opts.days <= 400)) throw new Error("--days must be 1..400");
  if (!(opts.daily >= 1 && opts.daily <= 5000)) throw new Error("--daily must be 1..5000");
  return opts;
}

// ---------------------------------------------------------------- randomness

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    /** Pick from [[value, weight], ...]. */
    weighted: (pairs) => {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let x = next() * total;
      for (const [v, w] of pairs) {
        x -= w;
        if (x <= 0) return v;
      }
      return pairs[pairs.length - 1][0];
    },
    hex: (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join(""),
    uuid: () => {
      const h = r.hex(32).split("");
      h[12] = "4";
      h[16] = "89ab"[Math.floor(next() * 4)];
      const s = h.join("");
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    },
  };
  return r;
}

// ---------------------------------------------------------------- reference data

const CHANNELS = [
  // [channel, weight, sources: [display source, referrer domain, weight]]
  [
    "Organic Search",
    34,
    [
      ["Google", "www.google.com", 82],
      ["Bing", "www.bing.com", 8],
      ["DuckDuckGo", "duckduckgo.com", 7],
      ["Ecosia", "www.ecosia.org", 3],
    ],
  ],
  ["Direct", 22, [["Direct", null, 1]]],
  [
    "Organic Social",
    13,
    [
      ["X", "t.co", 45],
      ["Reddit", "www.reddit.com", 30],
      ["LinkedIn", "www.linkedin.com", 15],
      ["YouTube", "www.youtube.com", 10],
    ],
  ],
  [
    "Referral",
    9,
    [
      ["Hacker News", "news.ycombinator.com", 40],
      ["Product Hunt", "www.producthunt.com", 25],
      ["GitHub", "github.com", 20],
      ["Indie Hackers", "www.indiehackers.com", 15],
    ],
  ],
  [
    "AI",
    7,
    [
      ["ChatGPT", "chatgpt.com", 55],
      ["Perplexity", "www.perplexity.ai", 25],
      ["Claude", "claude.ai", 12],
      ["Gemini", "gemini.google.com", 8],
    ],
  ],
  ["Paid Search", 6, [["Google Ads", "www.google.com", 1]]],
  ["Newsletter", 4, [["Bytes Newsletter", null, 1]]],
  ["Affiliate", 3, [["Affiliates", null, 1]]],
  ["Email", 2, [["Email", null, 1]]],
];

const COUNTRIES = [
  // [code, weight, [[region, city, lat, lon], ...]]
  [
    "US",
    34,
    [
      ["California", "San Francisco", 37.77, -122.42],
      ["New York", "New York", 40.71, -74.0],
      ["Texas", "Austin", 30.27, -97.74],
      ["Washington", "Seattle", 47.61, -122.33],
      ["Illinois", "Chicago", 41.88, -87.63],
    ],
  ],
  [
    "GB",
    9,
    [
      ["England", "London", 51.51, -0.13],
      ["England", "Manchester", 53.48, -2.24],
    ],
  ],
  [
    "DE",
    7,
    [
      ["Berlin", "Berlin", 52.52, 13.4],
      ["Bavaria", "Munich", 48.14, 11.58],
    ],
  ],
  [
    "IN",
    8,
    [
      ["Karnataka", "Bengaluru", 12.97, 77.59],
      ["Maharashtra", "Mumbai", 19.08, 72.88],
    ],
  ],
  [
    "CA",
    5,
    [
      ["Ontario", "Toronto", 43.65, -79.38],
      ["British Columbia", "Vancouver", 49.28, -123.12],
    ],
  ],
  ["FR", 5, [["Île-de-France", "Paris", 48.86, 2.35]]],
  ["NL", 3, [["North Holland", "Amsterdam", 52.37, 4.9]]],
  ["BR", 4, [["São Paulo", "São Paulo", -23.55, -46.63]]],
  ["AU", 3, [["New South Wales", "Sydney", -33.87, 151.21]]],
  ["ES", 3, [["Community of Madrid", "Madrid", 40.42, -3.7]]],
  ["BD", 3, [["Dhaka Division", "Dhaka", 23.81, 90.41]]],
  ["JP", 3, [["Tokyo", "Tokyo", 35.68, 139.69]]],
  ["SE", 2, [["Stockholm", "Stockholm", 59.33, 18.07]]],
  ["SG", 2, [["Singapore", "Singapore", 1.35, 103.82]]],
  ["PL", 2, [["Masovia", "Warsaw", 52.23, 21.01]]],
  ["NG", 2, [["Lagos", "Lagos", 6.52, 3.38]]],
];

const DEVICES = [
  [
    "desktop",
    58,
    [
      ["Chrome", "macOS", 34],
      ["Chrome", "Windows", 26],
      ["Safari", "macOS", 18],
      ["Firefox", "Windows", 7],
      ["Edge", "Windows", 8],
      ["Firefox", "Linux", 4],
      ["Chrome", "Linux", 3],
    ],
  ],
  [
    "mobile",
    38,
    [
      ["Mobile Safari", "iOS", 52],
      ["Chrome", "Android", 40],
      ["Samsung Internet", "Android", 8],
    ],
  ],
  [
    "tablet",
    4,
    [
      ["Mobile Safari", "iOS", 75],
      ["Chrome", "Android", 25],
    ],
  ],
];

const SCREENS = {
  desktop: [
    [1920, 1080],
    [1440, 900],
    [2560, 1440],
    [1536, 864],
  ],
  mobile: [
    [390, 844],
    [393, 852],
    [412, 915],
    [375, 667],
  ],
  tablet: [
    [820, 1180],
    [768, 1024],
  ],
};

const BLOG = [
  "/blog/revenue-attribution-explained",
  "/blog/google-analytics-alternatives",
  "/blog/self-hosted-analytics-cloudflare",
  "/blog/cookieless-tracking-gdpr",
  "/blog/stripe-revenue-by-channel",
];
const DOCS = ["/docs", "/docs/install", "/docs/stripe", "/docs/goals", "/docs/api"];
const LANGUAGES = [
  ["en-US", 55],
  ["en-GB", 10],
  ["de-DE", 7],
  ["fr-FR", 5],
  ["es-ES", 4],
  ["pt-BR", 4],
  ["ja-JP", 3],
  ["hi-IN", 3],
  ["nl-NL", 2],
  ["bn-BD", 2],
];
const FIRST = [
  "Ava",
  "Liam",
  "Noah",
  "Mia",
  "Leo",
  "Zara",
  "Omar",
  "Sofia",
  "Kenji",
  "Priya",
  "Lucas",
  "Emma",
  "Arjun",
  "Hana",
  "Mateo",
  "Chloe",
  "Ibrahim",
  "Nora",
  "Felix",
  "Aisha",
];
const LAST = [
  "Patel",
  "Smith",
  "Müller",
  "Garcia",
  "Kim",
  "Rahman",
  "Silva",
  "Nguyen",
  "Johnson",
  "Rossi",
  "Tanaka",
  "Haddad",
  "Novak",
  "Okafor",
  "Larsen",
  "Chen",
  "Dubois",
  "Khan",
  "Moreau",
  "Ali",
];
const PLANS = [
  ["starter", 900, 58],
  ["pro", 2900, 32],
  ["business", 9900, 10],
];

// ---------------------------------------------------------------- generation

function entryPathFor(r, channel, source) {
  if (channel === "Organic Search")
    return r.weighted([
      [r.pick(BLOG), 55],
      ["/", 25],
      [r.pick(DOCS), 20],
    ]);
  if (channel === "AI")
    return r.weighted([
      ["/", 45],
      ["/pricing", 25],
      [r.pick(DOCS), 30],
    ]);
  if (channel === "Paid Search")
    return r.weighted([
      ["/", 40],
      ["/pricing", 60],
    ]);
  if (channel === "Newsletter" || channel === "Email") return r.pick(BLOG);
  if (source === "GitHub") return r.pick(DOCS);
  if (source === "Hacker News" || source === "Product Hunt") return "/";
  return r.weighted([
    ["/", 60],
    ["/pricing", 15],
    [r.pick(BLOG), 25],
  ]);
}

function nextPath(r, current) {
  if (current.startsWith("/blog/"))
    return r.weighted([
      ["/", 40],
      ["/pricing", 35],
      [r.pick(BLOG), 25],
    ]);
  if (current.startsWith("/docs"))
    return r.weighted([
      [r.pick(DOCS), 60],
      ["/pricing", 25],
      ["/", 15],
    ]);
  if (current === "/pricing")
    return r.weighted([
      ["/signup", 45],
      ["/", 20],
      [r.pick(DOCS), 20],
      ["/blog", 15],
    ]);
  if (current === "/signup") return "/app";
  return r.weighted([
    ["/pricing", 45],
    [r.pick(DOCS), 20],
    ["/blog", 15],
    [r.pick(BLOG), 20],
  ]);
}

/** Daily visitor target: growth, weekly cycle, noise and one launch spike. */
function dailyTarget(r, opts, dayIndex, dayStart) {
  const t = dayIndex / Math.max(1, opts.days - 1);
  const weekday = new Date(dayStart).getUTCDay();
  const weekly = weekday === 0 || weekday === 6 ? 0.68 : 1;
  const spikeDay = Math.floor(opts.days * 0.62);
  const spike = dayIndex === spikeDay ? 4.2 : dayIndex === spikeDay + 1 ? 2.1 : 1;
  const noise = 0.85 + r.next() * 0.3;
  return Math.max(1, Math.round(opts.daily * (0.55 + 0.9 * t) * weekly * spike * noise));
}

export function generate(opts, now = Date.now()) {
  const r = rng(opts.seed);
  const siteId = (Math.floor(now / 1000) >>> 0).toString(16).padStart(8, "0") + r.hex(16);
  const userId = (Math.floor(now / 1000) >>> 0).toString(16).padStart(8, "0") + r.hex(16);
  const publicId = `dfid_demo${r.hex(11)}`;
  const start = now - opts.days * DAY;
  const spikeDay = Math.floor(opts.days * 0.62);

  const visitors = [];
  const sessions = [];
  const events = [];
  const payments = [];
  let eventId = 1;

  const makeSession = (visitor, startedAt, sessionNumber, forceLive) => {
    const [channel, , sourceList] = r.weighted(CHANNELS.map((c) => [c, c[1]]));
    let [source, referrerDomain] = r.weighted(sourceList.map((s) => [s, s[2]]));
    // The launch spike is Hacker News traffic.
    const dayIndex = Math.floor((startedAt - start) / DAY);
    let ch = channel;
    if ((dayIndex === spikeDay || dayIndex === spikeDay + 1) && r.chance(0.65)) {
      ch = "Referral";
      source = "Hacker News";
      referrerDomain = "news.ycombinator.com";
    }
    const entry = entryPathFor(r, ch, source);
    const utm = {};
    if (ch === "Paid Search")
      Object.assign(utm, {
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: r.pick(["brand", "analytics-alternative", "stripe-analytics"]),
        utm_term: r.pick(["revenue analytics", "datafast alternative", "web analytics"]),
      });
    if (ch === "Newsletter")
      Object.assign(utm, {
        utm_source: "bytes",
        utm_medium: "newsletter",
        utm_campaign: r.pick(["issue-214", "issue-219", "issue-223"]),
      });
    if (ch === "Email")
      Object.assign(utm, {
        utm_source: "lifecycle",
        utm_medium: "email",
        utm_campaign: r.pick(["welcome", "trial-ending", "monthly-digest"]),
      });
    if (ch === "Organic Social" && source === "X" && r.chance(0.4))
      Object.assign(utm, { utm_source: "x", utm_medium: "social", utm_campaign: "launch-thread" });
    const via = ch === "Affiliate" ? r.pick(["marc", "jordan", "toolsweekly"]) : null;
    const ref = ch === "Organic Social" && r.chance(0.2) ? r.pick(["twitter", "reddit"]) : null;

    const { device, browser, os } = visitor;
    const [sw, sh] = visitor.screen;
    const bounce = r.chance(entry.startsWith("/blog/") ? 0.55 : 0.38);
    const views = bounce ? 1 : r.int(2, 7);
    const sid = `s${r.uuid()}`;
    const paths = [entry];
    for (let i = 1; i < views; i++) paths.push(nextPath(r, paths[i - 1]));

    let ts = startedAt;
    let interactions = 0;
    const firstEvent = events.length;
    for (const [i, path] of paths.entries()) {
      if (i > 0) ts += r.int(8, 140) * 1000;
      events.push([eventId++, ts, sid, visitor.id, "pageview", opts.domain, path, null, null]);
      if (path === "/signup" && r.chance(0.62)) {
        ts += r.int(20, 90) * 1000;
        events.push([
          eventId++,
          ts,
          sid,
          visitor.id,
          "custom",
          opts.domain,
          path,
          "signup",
          JSON.stringify({ plan: r.weighted(PLANS.map((p) => [p[0], p[2]])) }),
        ]);
        visitor.signedUp = true;
        interactions++;
      }
      if (path === "/pricing" && r.chance(0.2)) {
        ts += r.int(5, 40) * 1000;
        events.push([
          eventId++,
          ts,
          sid,
          visitor.id,
          "custom",
          opts.domain,
          path,
          "checkout_started",
          JSON.stringify({ plan: r.weighted(PLANS.map((p) => [p[0], p[2]])) }),
        ]);
        interactions++;
      }
      if (path.startsWith("/blog/") && r.chance(0.035)) {
        ts += r.int(30, 200) * 1000;
        events.push([
          eventId++,
          ts,
          sid,
          visitor.id,
          "custom",
          opts.domain,
          path,
          "newsletter_signup",
          null,
        ]);
        interactions++;
      }
      if (path.startsWith("/blog/") && r.chance(0.3)) {
        ts += r.int(15, 120) * 1000;
        events.push([
          eventId++,
          ts,
          sid,
          visitor.id,
          "custom",
          opts.domain,
          path,
          "scroll_75",
          JSON.stringify({ scroll_percentage: 75 }),
        ]);
      }
      if (path.startsWith("/docs") && r.chance(0.12)) {
        ts += r.int(10, 60) * 1000;
        events.push([
          eventId++,
          ts,
          sid,
          visitor.id,
          "external_link",
          opts.domain,
          path,
          null,
          JSON.stringify({ url: "https://github.com/sarequl/datagoat", text: "GitHub" }),
        ]);
        interactions++;
      }
    }
    // Keep every event in the past; live sessions end in the last few minutes.
    const end = forceLive ? now - r.int(5, 240) * 1000 : Math.min(ts, now - 1000);
    const shift = ts - end;
    if (shift !== 0) {
      for (let i = firstEvent; i < events.length; i++) events[i][1] -= shift;
      startedAt -= shift;
      ts = end;
      if (sessionNumber === 1) visitor.first_seen_at = startedAt;
    }
    const [country] = visitor.country;
    const [region, city, lat, lon] = visitor.place;
    const session = {
      id: sid,
      visitor_id: visitor.id,
      started_at: startedAt,
      last_seen_at: ts,
      session_number: sessionNumber,
      entry_path: entry,
      exit_path: paths[paths.length - 1],
      pageviews: views,
      interactions,
      referrer: referrerDomain ? `https://${referrerDomain}/` : null,
      referrer_domain: referrerDomain,
      channel: ch,
      source,
      ...utm,
      ref,
      via,
      country,
      region,
      city,
      lat: lat + (r.next() - 0.5) * 0.2,
      lon: lon + (r.next() - 0.5) * 0.2,
      device,
      browser,
      os,
      language: visitor.language,
      screen_width: sw,
      screen_height: sh,
      viewport_width: sw,
      viewport_height: Math.round(sh * 0.85),
    };
    sessions.push(session);
    return session;
  };

  for (let d = 0; d < opts.days; d++) {
    const dayStart = start + d * DAY;
    const target = dailyTarget(r, opts, d, dayStart);
    for (let i = 0; i < target; i++) {
      // Traffic peaks in the (UTC) afternoon.
      const hour = Math.min(
        23,
        Math.max(0, Math.round(14 + (r.next() + r.next() + r.next() - 1.5) * 6)),
      );
      const first = dayStart + hour * 3_600_000 + r.int(0, 59) * MIN + r.int(0, 59) * 1000;
      if (first > now - 15 * MIN) continue;
      const deviceRow = r.weighted(DEVICES.map((x) => [x, x[1]]));
      const [browser, os] = r.weighted(deviceRow[2].map((b) => [b, b[2]]));
      const countryRow = r.weighted(COUNTRIES.map((c) => [c, c[1]]));
      const visitor = {
        id: r.uuid(),
        first_seen_at: first,
        device: deviceRow[0],
        browser,
        os,
        screen: r.pick(SCREENS[deviceRow[0]]),
        country: countryRow,
        place: r.pick(countryRow[2]),
        language: r.weighted(LANGUAGES),
        sessions: [],
      };
      visitors.push(visitor);
      const count = r.weighted([
        [1, 74],
        [2, 17],
        [3, 6],
        [4, 3],
      ]);
      let at = first;
      for (let s = 1; s <= count; s++) {
        if (at > now - 15 * MIN) break;
        visitor.sessions.push(makeSession(visitor, at, s, false));
        at += r.int(1, 9) * DAY + r.int(0, 600) * MIN;
      }
    }
  }

  // Visitors browsing right now, for the realtime view.
  for (let i = 0; i < Math.max(6, Math.round(opts.daily / 18)); i++) {
    const deviceRow = r.weighted(DEVICES.map((x) => [x, x[1]]));
    const [browser, os] = r.weighted(deviceRow[2].map((b) => [b, b[2]]));
    const countryRow = r.weighted(COUNTRIES.map((c) => [c, c[1]]));
    const startedAt = now - r.int(1, 9) * MIN;
    const visitor = {
      id: r.uuid(),
      first_seen_at: startedAt,
      device: deviceRow[0],
      browser,
      os,
      screen: r.pick(SCREENS[deviceRow[0]]),
      country: countryRow,
      place: r.pick(countryRow[2]),
      language: r.weighted(LANGUAGES),
      sessions: [],
    };
    visitors.push(visitor);
    visitor.sessions.push(makeSession(visitor, startedAt, 1, true));
  }

  // Payments: signed-up visitors convert; subscriptions renew monthly; a few refund.
  let txn = 1;
  for (const v of visitors) {
    if (!v.signedUp || !r.chance(0.2)) continue;
    const plan = r.weighted(PLANS.map((p) => [p, p[2]]));
    const last = v.sessions[v.sessions.length - 1];
    const paidAt = Math.min(now - 5 * MIN, last.last_seen_at + r.int(2, 30) * MIN);
    const provider = r.weighted([
      ["stripe", 78],
      ["polar", 12],
      ["lemonsqueezy", 10],
    ]);
    const attributed = r.weighted([
      ["metadata", 84],
      ["email", 9],
      ["none", 7],
    ]);
    const name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, ".")}${r.int(1, 99)}@example.com`;
    v.identity = { user_id: `user_${r.hex(10)}`, name, email, plan: plan[0] };
    const nonDirect =
      [...v.sessions].reverse().find((s) => s.channel !== "Direct") ?? v.sessions[0];
    const customer = `cus_${r.hex(14)}`;
    const base = {
      provider,
      customer,
      visitor_id: attributed === "none" ? null : v.id,
      first_session_id: attributed === "none" ? null : v.sessions[0].id,
      last_session_id: attributed === "none" ? null : last.id,
      last_non_direct_session_id: attributed === "none" ? null : nonDirect.id,
      attributed_via: attributed,
      email,
      name,
    };
    const trial = r.chance(0.18);
    if (trial) {
      payments.push({
        ...base,
        txn: `txn_${txn++}`,
        kind: "free_trial",
        amount: 0,
        at: paidAt,
        goal: "trial_started",
      });
    }
    const firstPaid = trial ? paidAt + 14 * DAY : paidAt;
    for (let at = firstPaid, n = 0; at < now; at += 30 * DAY, n++) {
      if (n > 0 && r.chance(0.12)) break; // churn
      const id = `txn_${txn++}`;
      payments.push({
        ...base,
        txn: id,
        kind: n === 0 ? "payment" : "renewal",
        amount: plan[1],
        at,
        goal:
          n === 0 ? (trial ? "trial_converted" : "subscription_started") : "subscription_renewed",
      });
      if (n === 0 && r.chance(0.03)) {
        payments.push({
          ...base,
          txn: `txn_${txn++}`,
          kind: "refund",
          amount: -plan[1],
          at: at + r.int(1, 6) * DAY,
          refund_of: id,
          goal: null,
        });
        break;
      }
    }
  }

  return { siteId, userId, publicId, start, now, visitors, sessions, events, payments };
}

// ---------------------------------------------------------------- SQL

export function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function inserts(table, columns, rows, chunk = 150) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const values = rows
      .slice(i, i + chunk)
      .map((row) => `(${row.map(sqlValue).join(",")})`)
      .join(",\n");
    out.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values};`);
  }
  return out;
}

function hashPassword(password) {
  const iterations = 50_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  return `pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function toSql(data, opts) {
  const { siteId, userId, publicId, now } = data;
  const sql = [];
  // Replace a previous demo site and its data; keep everything else.
  const old = `(SELECT id FROM sites WHERE domain = ${sqlValue(opts.domain)})`;
  for (const t of [
    "events",
    "sessions",
    "visitors",
    "payments",
    "funnels",
    "goal_customizations",
    "notes",
    "memberships",
  ]) {
    sql.push(`DELETE FROM ${t} WHERE site_id IN ${old};`);
  }
  sql.push(`DELETE FROM sites WHERE domain = ${sqlValue(opts.domain)};`);

  sql.push(
    `INSERT INTO users (id, email, password_hash, name, created_at, updated_at, password_changed_at) VALUES (${[userId, opts.email.toLowerCase(), hashPassword(opts.password), "Demo Owner", now, now, now].map(sqlValue).join(", ")}) ON CONFLICT (email) DO NOTHING;`,
  );
  sql.push(
    `INSERT OR IGNORE INTO instance_settings (key, value, updated_at) VALUES ('setup_completed_at', ${sqlValue(String(now))}, ${now});`,
  );
  sql.push(
    `INSERT INTO sites (id, public_id, domain, name, timezone, currency, kpi, created_by, created_at, updated_at) VALUES (${[siteId, publicId, opts.domain, opts.name, "UTC", "USD", "signup", userId, data.start, now].map(sqlValue).join(", ")});`,
  );
  // The demo owner, and every existing user, can see the demo site.
  sql.push(
    `INSERT OR IGNORE INTO memberships (site_id, user_id, role, created_at) SELECT ${sqlValue(siteId)}, id, 'owner', ${now} FROM users;`,
  );

  sql.push(
    ...inserts(
      "visitors",
      [
        "site_id",
        "id",
        "first_seen_at",
        "client_first_seen_at",
        "first_session_id",
        "user_id",
        "name",
        "profile",
        "identified_at",
        "email",
      ],
      data.visitors
        .filter((v) => v.sessions.length > 0)
        .map((v) => [
          siteId,
          v.id,
          v.first_seen_at,
          v.first_seen_at,
          v.sessions[0].id,
          v.identity?.user_id ?? null,
          v.identity?.name ?? null,
          v.identity ? JSON.stringify({ plan: v.identity.plan }) : null,
          v.identity ? v.sessions[v.sessions.length - 1].last_seen_at : null,
          v.identity?.email ?? null,
        ]),
    ),
  );

  const sessionCols = [
    "site_id",
    "id",
    "visitor_id",
    "started_at",
    "last_seen_at",
    "session_number",
    "hostname",
    "entry_path",
    "exit_path",
    "pageviews",
    "interactions",
    "referrer",
    "referrer_domain",
    "channel",
    "source",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "via",
    "country",
    "region",
    "city",
    "lat",
    "lon",
    "device",
    "browser",
    "os",
    "language",
    "screen_width",
    "screen_height",
    "viewport_width",
    "viewport_height",
  ];
  sql.push(
    ...inserts(
      "sessions",
      sessionCols,
      data.sessions.map((s) =>
        sessionCols.map((c) =>
          c === "site_id" ? siteId : c === "hostname" ? opts.domain : (s[c] ?? null),
        ),
      ),
    ),
  );

  // Event ids are left to SQLite (INTEGER PRIMARY KEY).
  sql.push(
    ...inserts(
      "events",
      ["site_id", "ts", "session_id", "visitor_id", "type", "hostname", "path", "name", "props"],
      data.events.map(([, ts, sid, vid, type, host, path, name, props]) => [
        siteId,
        ts,
        sid,
        vid,
        type,
        host,
        path,
        name,
        props,
      ]),
    ),
  );

  sql.push(
    ...inserts(
      "payments",
      [
        "site_id",
        "id",
        "provider",
        "provider_txn_id",
        "provider_customer_id",
        "kind",
        "amount_minor",
        "currency",
        "reporting_minor",
        "reporting_currency",
        "fx_rate",
        "visitor_id",
        "first_session_id",
        "last_session_id",
        "last_non_direct_session_id",
        "attributed_via",
        "customer_email",
        "customer_name",
        "refund_of",
        "lifecycle_goal",
        "source",
        "occurred_at",
        "created_at",
        "updated_at",
      ],
      data.payments.map((p, i) => [
        siteId,
        `pay_${String(i + 1).padStart(6, "0")}`,
        p.provider,
        p.txn,
        p.customer,
        p.kind,
        p.amount,
        "USD",
        p.amount,
        "USD",
        1,
        p.visitor_id,
        p.first_session_id,
        p.last_session_id,
        p.last_non_direct_session_id,
        p.attributed_via,
        p.email,
        p.name,
        p.refund_of ?? null,
        p.goal,
        "poll",
        p.at,
        p.at,
        p.at,
      ]),
    ),
  );

  const steps = [
    { id: "step1", name: "Visited home", type: "pageview", url: "/", urlMatchType: "equals" },
    {
      id: "step2",
      name: "Viewed pricing",
      type: "pageview",
      url: "/pricing",
      urlMatchType: "equals",
    },
    {
      id: "step3",
      name: "Signed up",
      type: "goal",
      goalName: "signup",
      goalCompletionType: "completed",
    },
    {
      id: "step4",
      name: "Started checkout",
      type: "goal",
      goalName: "checkout_started",
      goalCompletionType: "completed",
    },
  ];
  sql.push(
    `INSERT INTO funnels (id, site_id, name, slug, steps, is_active, created_by, created_at, updated_at) VALUES (${[`${siteId.slice(0, 16)}f0000001`, siteId, "Signup funnel", "signup-funnel", JSON.stringify(steps), 1, userId, now, now].map(sqlValue).join(", ")});`,
  );
  sql.push(
    ...inserts(
      "goal_customizations",
      ["site_id", "name", "display_name", "color", "updated_at"],
      [
        [siteId, "signup", "Sign up", "#00a96e", now],
        [siteId, "checkout_started", "Checkout started", "#e16540", now],
        [siteId, "newsletter_signup", "Newsletter", "#8dcdff", now],
        [siteId, "scroll_75", "Read 75% of a post", "#00cdb7", now],
      ],
    ),
  );
  const spikeAt = data.start + Math.floor(opts.days * 0.62) * DAY + 15 * 3_600_000;
  sql.push(
    ...inserts(
      "notes",
      ["id", "site_id", "ts", "text", "author_id", "created_at", "updated_at"],
      [
        [
          `${siteId.slice(0, 16)}n0000001`,
          siteId,
          spikeAt,
          "Launched on Hacker News",
          userId,
          now,
          now,
        ],
        [
          `${siteId.slice(0, 16)}n0000002`,
          siteId,
          data.start + Math.floor(opts.days * 0.3) * DAY,
          "New pricing page",
          userId,
          now,
          now,
        ],
        [
          `${siteId.slice(0, 16)}n0000003`,
          siteId,
          now - 6 * DAY,
          "Started Google Ads",
          userId,
          now,
          now,
        ],
      ],
    ),
  );
  return `${sql.join("\n")}\n`;
}

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = generate(opts);
  const sql = toSql(data, opts);
  const file = opts.out ?? join(mkdtempSync(join(tmpdir(), "datagoat-seed-")), "demo.sql");
  writeFileSync(file, sql);
  const revenue = data.payments.reduce((s, p) => s + p.amount, 0) / 100;
  console.log(
    `Demo site ${opts.domain}: ${data.visitors.length} visitors, ${data.sessions.length} sessions, ${data.events.length} events, ${data.payments.length} payments ($${revenue.toFixed(0)} net) over ${opts.days} days.`,
  );
  if (opts.out) {
    console.log(`Wrote ${file}`);
    return;
  }
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", "--local", "--config", opts.config, "--file", file],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  console.log(`Seeded the local database. Sign in as ${opts.email} / ${opts.password}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
