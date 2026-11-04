/**
 * IP verification for crawlers. Several operators publish the IP ranges their crawlers use as
 * JSON (`{"prefixes": [{"ipv4Prefix": "…"}, {"ipv6Prefix": "…"}]}`); a request whose user agent
 * claims to be such a crawler and whose source IP is inside the published ranges is "IP verified".
 * Anything else that matches a catalogued user agent is "user agent only".
 *
 * `bots.ip-ranges` (daily) downloads every source into `crawler_ip_ranges`, rewriting a row only
 * when its list changed. Ingest reads the table into an isolate cache (10 minutes) and matches
 * IPv4 and IPv6 addresses with bigint arithmetic.
 */
import type { JobContext } from "../../jobs/registry";
import { errorFields, log } from "../../lib/log";
import { errorMessage, requestJson } from "../shared/http";

/** Published IP range files, cited from each operator's crawler documentation. */
export const IP_SOURCES: Record<string, string> = {
  // https://platform.openai.com/docs/bots
  "openai-chatgpt-user": "https://openai.com/chatgpt-user.json",
  "openai-searchbot": "https://openai.com/searchbot.json",
  "openai-gptbot": "https://openai.com/gptbot.json",
  // https://docs.perplexity.ai/guides/bots
  "perplexity-user": "https://www.perplexity.com/perplexity-user.json",
  perplexitybot: "https://www.perplexity.com/perplexitybot.json",
  // https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot
  googlebot: "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
  "google-special":
    "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json",
  "google-user-triggered":
    "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json",
  // https://www.bing.com/webmasters/help/how-to-verify-bingbot-3905dc26
  bingbot: "https://www.bing.com/toolbox/bingbot.json",
  // https://support.apple.com/en-us/119829
  applebot: "https://search.developer.apple.com/applebot.json",
  // https://duckduckgo.com/duckduckgo-help-pages/results/duckduckbot
  duckduckbot: "https://duckduckgo.com/duckduckbot.json",
  duckassistbot: "https://duckduckgo.com/duckassistbot.json",
  // https://commoncrawl.org/ccbot
  ccbot: "https://index.commoncrawl.org/ccbot.json",
};

export interface Cidr {
  v6: boolean;
  base: bigint;
  mask: bigint;
}

export function parseIp(value: string): { v6: boolean; n: bigint } | null {
  const ip = value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    return {
      v6: false,
      n: parts.reduce((acc, p) => (acc << 8n) + BigInt(p), 0n),
    };
  }
  if (!ip.includes(":") || !/^[0-9a-f:.]+$/i.test(ip)) return null;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) verifies as IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return parseIp(mapped[1]);
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return {
    v6: true,
    n: groups.reduce((acc, g) => (acc << 16n) + BigInt(Number.parseInt(g, 16)), 0n),
  };
}

export function parseCidr(value: string): Cidr | null {
  const [addr, bitsRaw] = value.trim().split("/");
  if (!addr) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const width = ip.v6 ? 128 : 32;
  const bits = bitsRaw === undefined ? width : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return null;
  const all = (1n << BigInt(width)) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(width - bits)) & all;
  return { v6: ip.v6, base: ip.n & mask, mask };
}

export function ipInRanges(ip: string, ranges: readonly Cidr[]): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return ranges.some((r) => r.v6 === parsed.v6 && (parsed.n & r.mask) === r.base);
}

/** Extract CIDR strings from a published JSON file (several shapes are accepted). */
export function extractPrefixes(json: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      if (parseCidr(v)) out.add(v.trim());
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const key of [
        "ipv4Prefix",
        "ipv6Prefix",
        "ip_prefix",
        "ipv6_prefix",
        "cidr",
        "prefix",
      ]) {
        if (typeof o[key] === "string") visit(o[key]);
      }
      for (const key of ["prefixes", "ipv6_prefixes", "ips", "ranges", "addresses"]) {
        if (o[key] !== undefined) visit(o[key]);
      }
    }
  };
  visit(json);
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Isolate cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60_000;
let cache: { at: number; ranges: Map<string, Cidr[]> } | null = null;

export function resetIpRangeCache(): void {
  cache = null;
}

export async function loadIpRanges(db: D1Database, now = Date.now()): Promise<Map<string, Cidr[]>> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.ranges;
  const res = await db
    .prepare("SELECT source, prefixes FROM crawler_ip_ranges")
    .all<{ source: string; prefixes: string }>();
  const ranges = new Map<string, Cidr[]>();
  for (const row of res.results ?? []) {
    let list: string[] = [];
    try {
      list = JSON.parse(row.prefixes) as string[];
    } catch {
      list = [];
    }
    ranges.set(
      row.source,
      list.map(parseCidr).filter((c): c is Cidr => c !== null),
    );
  }
  cache = { at: now, ranges };
  return ranges;
}

// ---------------------------------------------------------------------------
// Refresh job
// ---------------------------------------------------------------------------

export async function refreshIpRanges(ctx: Pick<JobContext, "db" | "now" | "fetch">) {
  const { db, now } = ctx;
  const entries = Object.entries(IP_SOURCES);
  const fetched = await Promise.all(
    entries.map(async ([source, url]) => {
      try {
        const json = await requestJson<unknown>(ctx.fetch, "IP ranges", url, { timeoutMs: 8000 });
        const prefixes = extractPrefixes(json);
        if (prefixes.length === 0) throw new Error("no prefixes in the published file");
        return { source, prefixes, error: null as string | null };
      } catch (err) {
        log.warn("bots.ip_ranges_failed", { source, ...errorFields(err) });
        return { source, prefixes: null, error: errorMessage(err) };
      }
    }),
  );
  const stmts = fetched.map((f) =>
    f.prefixes
      ? db
          .prepare(
            `INSERT INTO crawler_ip_ranges (source, prefixes, fetched_at, updated_at, last_error) VALUES (?1, ?2, ?3, ?3, NULL)
             ON CONFLICT (source) DO UPDATE SET prefixes = ?2, updated_at = ?3, fetched_at = ?3, last_error = NULL
             WHERE crawler_ip_ranges.prefixes != ?2 OR crawler_ip_ranges.last_error IS NOT NULL`,
          )
          .bind(f.source, JSON.stringify(f.prefixes), now)
      : db
          .prepare(
            `INSERT INTO crawler_ip_ranges (source, prefixes, fetched_at, updated_at, last_error) VALUES (?1, '[]', ?2, ?2, ?3)
             ON CONFLICT (source) DO UPDATE SET last_error = ?3
             WHERE crawler_ip_ranges.last_error IS NOT ?3`,
          )
          .bind(f.source, now, f.error),
  );
  await db.batch(stmts);
  resetIpRangeCache();
  return {
    ok: fetched.filter((f) => f.prefixes).length,
    failed: fetched.filter((f) => !f.prefixes).length,
  };
}
