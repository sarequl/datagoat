/**
 * Bot filtering (plan §8 step 5). No bot score exists below Enterprise, so this is heuristic:
 *
 * - `ua`: the User-Agent names a crawler, preview fetcher, monitor, HTTP library or automation
 *   tool (DataGoat's own list), or is missing / shorter than 5 characters.
 * - `headless`: the browser says it is headless (Client Hints brand `HeadlessChrome`).
 * - `automation`: the body cannot come from a real screen (0×0 screen and viewport).
 * - `strict` (bot level "strict", DataFast's attack mode): the request comes from a datacenter
 *   ASN, or carries no `Accept-Language` header.
 *
 * Site `bot_level` = "off" skips every check. Dropped hits are counted per day and reason in
 * `bot_daily` with one upsert.
 */
import type { TrackerBody } from "./body";

export type BotReason = "ua" | "headless" | "automation" | "strict";

// Lower-case substrings. `bot` is matched separately so phone brands such as "Cubot" pass.
const UA_TOKENS = [
  "crawl",
  "spider",
  "slurp",
  "scrap",
  "headless",
  "phantomjs",
  "selenium",
  "webdriver",
  "puppeteer",
  "playwright",
  "cypress",
  "jsdom",
  "python",
  "aiohttp",
  "httpx",
  "curl/",
  "wget",
  "java/",
  "okhttp",
  "go-http",
  "node.js",
  "node-fetch",
  "undici",
  "axios",
  "postman",
  "insomnia",
  "httpie",
  "libwww",
  "lwp-",
  "guzzle",
  "ruby",
  "perl",
  "php/",
  "facebookexternalhit",
  "facebookcatalog",
  "meta-externalagent",
  "whatsapp",
  "embedly",
  "quora link preview",
  "lighthouse",
  "pagespeed",
  "gtmetrix",
  "pingdom",
  "uptimerobot",
  "statuscake",
  "site24x7",
  "monitor",
  "checkly",
  "datadog",
  "newrelic",
  "google-inspectiontool",
  "mediapartners-google",
  "adsbot",
  "apis-google",
  "feedfetcher",
  "googleother",
  "google-read-aloud",
  "bingpreview",
  "ahrefs",
  "semrush",
  "mj12",
  "dotbot",
  "petalbot",
  "bytespider",
  "gptbot",
  "chatgpt-user",
  "oai-searchbot",
  "claude-web",
  "anthropic-ai",
  "perplexity",
  "ccbot",
  "amazonbot",
  "applebot",
  "yandex",
  "baiduspider",
  "sogou",
  "exabot",
  "ia_archiver",
  "archive.org",
  "nutch",
  "httrack",
  "wappalyzer",
  "zgrab",
  "masscan",
  "nmap",
  "nuclei",
  "preview",
  "validator",
  "prerender",
  "screenshot",
  "rendertron",
];
const BOT_WORD = /(?<!cu)bot\b/i;

/** True when the User-Agent string itself identifies a non-human client. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua || ua.trim().length < 5) return true;
  const lower = ua.toLowerCase();
  if (BOT_WORD.test(lower)) return true;
  for (const token of UA_TOKENS) if (lower.includes(token)) return true;
  return false;
}

/**
 * Autonomous systems of large hosting and cloud providers. Humans rarely browse from these; VPN
 * users sometimes do, which is why this list applies only at the strict level.
 */
export const DATACENTER_ASNS: ReadonlySet<number> = new Set([
  16509,
  14618,
  8987, // Amazon AWS
  396982,
  19527,
  36492, // Google Cloud
  8075,
  8068,
  8069, // Microsoft Azure
  14061, // DigitalOcean
  16276, // OVH
  24940,
  213230, // Hetzner
  63949, // Linode / Akamai Connected Cloud
  20473, // Vultr / Choopa
  31898, // Oracle Cloud
  45102,
  37963, // Alibaba Cloud
  132203,
  45090, // Tencent Cloud
  12876, // Scaleway
  51167, // Contabo
  60781,
  28753, // Leaseweb
  9009, // M247
  40021, // Contabo US / Nocix
  62567, // DigitalOcean (legacy)
  46606, // Unified Layer
  26496, // GoDaddy
  398101, // GoDaddy
  55286, // Server Central
  36352, // ColoCrossing
  53667, // FranTech / BuyVM
  202425, // IP Volume
  135377, // UCloud
  136907, // Huawei Cloud
  23470, // ReliableSite
  29802, // HIVELOCITY
  7979, // Servers.com
  30633, // Leaseweb US
  25369, // Hydra Communications
  44477, // Stark Industries
  210644, // Aeza
  47583, // Hostinger
  204957, // GreenFloid
]);

export interface BotCheckInput {
  ua: string | null;
  secChUa: string | null;
  acceptLanguage: string | null;
  asn: number | null;
  body: TrackerBody;
  level: "off" | "standard" | "strict";
}

/** Returns why the hit looks automated, or null for a human-looking hit. */
export function detectBot(input: BotCheckInput): BotReason | null {
  if (input.level === "off") return null;
  if (isBotUserAgent(input.ua)) return "ua";
  if (input.secChUa && /headless/i.test(input.secChUa)) return "headless";
  const b = input.body;
  if (
    b.screenWidth === 0 &&
    b.screenHeight === 0 &&
    (b.viewport === null || (b.viewport.width === 0 && b.viewport.height === 0))
  ) {
    return "automation";
  }
  if (input.level === "strict") {
    if (input.asn !== null && DATACENTER_ASNS.has(input.asn)) return "strict";
    if (!input.acceptLanguage) return "strict";
  }
  return null;
}
