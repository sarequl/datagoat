import { BOT_PATTERNS, DATACENTER_ASNS } from './data/lists';
import type { BotFilterLevel } from './env';
import { HONEYPOT_VISITOR } from './env';
import { parseUserAgent } from './util/ua';

export interface BotInput {
  userAgent: string;
  accept: string | null;
  acceptLanguage: string | null;
  ip: string;
  path: string;
  visitorId: string | null;
  level: BotFilterLevel;
  excludedIps: string[];
  excludedPaths: string[];
  excludedUa: string[];
  asn: number | null;
}

export interface BotDecision {
  isBot: boolean;
  reason: string | null;
  score: number;
}

const HEADLESS = /headlesschrome|phantomjs|puppeteer|selenium|playwright|webdriver/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Simple glob where `*` matches any run of characters. */
export function globToRegExp(glob: string): RegExp {
  const source = glob.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`, 'i');
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function matchesCidr(ip: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  if (bitsRaw === undefined) return ip === cidr;
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (ipInt === null || netInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return ip === cidr;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
}

function matchesAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => matchesCidr(ip, cidr));
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * Bot filter, design/worker.md §7. Rules run in order; first match wins.
 * The returned decision is advisory: the caller drops the event at
 * `standard`/`strict` and records it with `is_bot = 1` at `off`.
 */
export function evaluateBot(input: BotInput): BotDecision {
  const ua = input.userAgent || '';
  const lowerUa = ua.toLowerCase();

  // 1. Known bot list.
  if (BOT_PATTERNS.some((pattern) => lowerUa.includes(pattern))) {
    return { isBot: true, reason: 'known_bot', score: 100 };
  }

  // 2. Missing User-Agent.
  if (!ua.trim()) {
    return { isBot: true, reason: 'no_ua', score: 100 };
  }

  // 3. Headless markers.
  if (HEADLESS.test(ua)) {
    return { isBot: true, reason: 'headless', score: 100 };
  }

  // 4. No accept and no accept-language headers.
  if (!input.accept && !input.acceptLanguage) {
    return { isBot: true, reason: 'no_headers', score: 90 };
  }

  // 5. Excluded IPs / CIDRs.
  if (matchesAnyCidr(input.ip, input.excludedIps)) {
    return { isBot: true, reason: 'excluded_ip', score: 80 };
  }

  // 6. Excluded path globs.
  if (matchesAnyGlob(input.path, input.excludedPaths)) {
    return { isBot: true, reason: 'excluded_path', score: 80 };
  }

  // 7. Excluded UA fragments.
  if (input.excludedUa.some((fragment) => lowerUa.includes(fragment.toLowerCase()))) {
    return { isBot: true, reason: 'excluded_ua', score: 80 };
  }

  // 8. Datacenter ASN (strict only).
  if (input.level === 'strict' && input.asn !== null && DATACENTER_ASNS.includes(input.asn)) {
    return { isBot: true, reason: 'datacenter', score: 90 };
  }

  // 9. Honeypot visitor id.
  if (input.visitorId === HONEYPOT_VISITOR) {
    return { isBot: true, reason: 'honeypot', score: 100 };
  }

  // 10. UA parses as a bot device.
  if (parseUserAgent(ua).device_type === 'bot') {
    return { isBot: true, reason: 'uaparse', score: 100 };
  }

  return { isBot: false, reason: null, score: 0 };
}
