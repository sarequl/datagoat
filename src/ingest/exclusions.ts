/**
 * Site exclusions (plan §8 step 6, DataFast "Excluding analytics"). Excluded hits are not stored
 * and do not count anywhere, revenue attribution included.
 *
 * - IPs: exact IPv4/IPv6 addresses or CIDR ranges, matched against `CF-Connecting-IP`.
 * - Paths: `/admin` matches only that page (a trailing slash is ignored); `/admin/*` matches every
 *   page below it but not `/admin` itself; `*` matches any run of characters anywhere.
 * - Countries: ISO 3166-1 alpha-2 codes, matched against `request.cf.country`.
 * - Hostnames: exact hostnames only (`example.com` does not exclude `app.example.com`).
 * - User agents (DataGoat extension): case-insensitive substrings.
 */
import type { Site } from "../lib/sites";

export type ExclusionReason = "ip" | "path" | "country" | "hostname" | "user_agent";

interface ParsedIp {
  v: 4 | 6;
  value: bigint;
}

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  let input = text.toLowerCase();
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  let tail: bigint | null = null;
  const lastColon = input.lastIndexOf(":");
  if (input.includes(".", lastColon)) {
    tail = parseIpv4(input.slice(lastColon + 1));
    if (tail === null) return null;
    input = `${input.slice(0, lastColon + 1)}0:0`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(g, 16));
  }
  if (tail !== null) value = (value & ~0xffffffffn) | tail;
  return value;
}

export function parseIp(text: string): ParsedIp | null {
  const t = text.trim();
  if (!t) return null;
  if (!t.includes(":")) {
    const v4 = parseIpv4(t);
    return v4 === null ? null : { v: 4, value: v4 };
  }
  const v6 = parseIpv6(t);
  if (v6 === null) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address.
  if (v6 >> 32n === 0xffffn) return { v: 4, value: v6 & 0xffffffffn };
  return { v: 6, value: v6 };
}

/** True when `ip` equals the address or falls inside the CIDR range `rule`. */
export function ipMatches(ip: string, rule: string): boolean {
  const addr = parseIp(ip);
  if (!addr) return false;
  const [base, prefixText] = rule.trim().split("/");
  const net = parseIp(base ?? "");
  if (!net || net.v !== addr.v) return false;
  const bits = addr.v === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  if (prefix === 0) return true;
  const shift = BigInt(bits - prefix);
  return addr.value >> shift === net.value >> shift;
}

const globCache = new Map<string, RegExp>();

function globRegex(glob: string, flags: string): RegExp {
  const key = `${flags}:${glob}`;
  let re = globCache.get(key);
  if (!re) {
    const source = glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    re = new RegExp(`^${source}$`, flags);
    if (globCache.size > 1000) globCache.clear();
    globCache.set(key, re);
  }
  return re;
}

const trimSlash = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

/** DataFast path rules: exact (trailing slash ignored) or `*` wildcards. */
export function pathMatches(path: string, rule: string): boolean {
  const r = rule.trim();
  if (!r) return false;
  if (!r.includes("*")) return trimSlash(path) === trimSlash(r);
  return globRegex(r, "").test(path);
}

export function userAgentMatches(ua: string, rule: string): boolean {
  const r = rule.trim().toLowerCase();
  return r !== "" && ua.toLowerCase().includes(r);
}

export interface ExclusionInput {
  ip: string | null;
  path: string;
  hostname: string;
  country: string | null;
  ua: string | null;
}

export function matchExclusion(
  site: Pick<
    Site,
    | "excludedIps"
    | "excludedPaths"
    | "excludedCountries"
    | "excludedHostnames"
    | "excludedUserAgents"
  >,
  hit: ExclusionInput,
): ExclusionReason | null {
  const { ip } = hit;
  if (ip && site.excludedIps.some((rule) => ipMatches(ip, rule))) return "ip";
  if (site.excludedPaths.some((rule) => pathMatches(hit.path, rule))) return "path";
  const country = hit.country;
  if (country && site.excludedCountries.some((c) => c.toUpperCase() === country)) return "country";
  if (site.excludedHostnames.some((h) => h.toLowerCase() === hit.hostname)) return "hostname";
  const ua = hit.ua;
  if (ua && (site.excludedUserAgents ?? []).some((rule) => userAgentMatches(ua, rule))) {
    return "user_agent";
  }
  return null;
}
