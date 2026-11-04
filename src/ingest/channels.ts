/**
 * Channel and source classification (plan §8.1). Rules, first match wins:
 *
 * 1. Paid click ids: gclid/gbraid/wbraid/msclkid → Paid Search; fbclid/ttclid/twclid/li_fat_id →
 *    Paid Social. UTMs override: a non-paid utm_medium (email, newsletter, affiliate, social,
 *    organic) wins over a click id.
 * 2. utm_medium: cpc/ppc/paid* → Paid Search (Paid Social when the utm_source or referrer is a
 *    social network); email → Email; newsletter → Newsletter; affiliate → Affiliate; social →
 *    Organic Social; display/banner/cpm → Display.
 * 3. `via` parameter → Affiliate (DataFast uses `via` for affiliate links).
 * 4. Referrer domain lists: search engines → Organic Search, social networks → Organic Social,
 *    AI assistants → AI, webmail → Email.
 * 5. Any other external referrer → Referral. A campaign parameter (utm_source, ref, source)
 *    without a referrer → Referral. Nothing at all → Direct.
 *
 * `source` is the display name: `ref`, then `source`, `via` (as written), then `utm_source`
 * (known names normalised, e.g. "google" → "Google"), then the referrer's display name or bare
 * domain.
 * The lists are DataGoat's own, written for this project.
 */

export type Channel =
  | "Direct"
  | "Organic Search"
  | "Paid Search"
  | "Organic Social"
  | "Paid Social"
  | "Email"
  | "Newsletter"
  | "Affiliate"
  | "Display"
  | "AI"
  | "Referral";

type Kind = "search" | "social" | "ai" | "email";

/** domain (without www.) → [kind, display name]. Subdomains match their parent entry. */
const REFERRERS: Record<string, [Kind, string]> = {};
function add(kind: Kind, name: string, ...domains: string[]): void {
  for (const d of domains) REFERRERS[d] = [kind, name];
}

add("search", "Google", "google.com", "google.co.uk", "google.de", "google.fr", "google.es");
add("search", "Google", "google.it", "google.ca", "google.com.au", "google.co.in", "google.co.jp");
add("search", "Google", "google.com.br", "google.nl", "google.pl", "google.com.mx", "google.ru");
add("search", "Google", "google.co.id", "google.com.tr", "google.ch", "google.be", "google.se");
add(
  "search",
  "Google",
  "google.at",
  "google.dk",
  "google.no",
  "google.fi",
  "google.pt",
  "google.ie",
);
add("search", "Google", "google.co.kr", "google.com.ar", "google.co.za", "google.com.sg");
add("search", "Google", "google.com.bd", "google.com.pk", "google.com.vn", "google.com.ph");
add("search", "Bing", "bing.com", "cn.bing.com");
add("search", "DuckDuckGo", "duckduckgo.com");
add("search", "Yahoo", "search.yahoo.com", "yahoo.com", "yahoo.co.jp");
add("search", "Yandex", "yandex.ru", "yandex.com", "ya.ru");
add("search", "Baidu", "baidu.com");
add("search", "Ecosia", "ecosia.org");
add("search", "Brave Search", "search.brave.com");
add("search", "Startpage", "startpage.com");
add("search", "Qwant", "qwant.com");
add("search", "Naver", "naver.com", "search.naver.com");
add("search", "Seznam", "seznam.cz");
add("search", "Kagi", "kagi.com");
add("search", "Sogou", "sogou.com");
add("search", "AOL", "search.aol.com");
add("search", "Ask", "ask.com");
add("search", "Yep", "yep.com");
add("search", "Mojeek", "mojeek.com");

add("social", "X", "twitter.com", "x.com", "t.co", "mobile.twitter.com");
add("social", "Facebook", "facebook.com", "m.facebook.com", "l.facebook.com", "lm.facebook.com");
add("social", "Facebook", "fb.com", "fb.me");
add("social", "Instagram", "instagram.com", "l.instagram.com");
add("social", "LinkedIn", "linkedin.com", "lnkd.in");
add("social", "Reddit", "reddit.com", "old.reddit.com", "out.reddit.com");
add("social", "YouTube", "youtube.com", "m.youtube.com", "youtu.be");
add("social", "TikTok", "tiktok.com");
add("social", "Pinterest", "pinterest.com", "pin.it");
add("social", "Hacker News", "news.ycombinator.com");
add("social", "Product Hunt", "producthunt.com");
add("social", "Threads", "threads.net", "threads.com");
add("social", "Bluesky", "bsky.app");
add("social", "Mastodon", "mastodon.social", "mastodon.online");
add("social", "Discord", "discord.com", "discord.gg");
add("social", "Telegram", "t.me", "web.telegram.org");
add("social", "WhatsApp", "whatsapp.com", "web.whatsapp.com", "wa.me");
add("social", "Quora", "quora.com");
add("social", "Tumblr", "tumblr.com");
add("social", "VK", "vk.com");
add("social", "Weibo", "weibo.com");
add("social", "Snapchat", "snapchat.com");
add("social", "Indie Hackers", "indiehackers.com");
add("social", "Medium", "medium.com");
add("social", "Substack", "substack.com");
add("social", "Dev.to", "dev.to");
add("social", "Lobsters", "lobste.rs");
add("social", "Slack", "slack.com", "app.slack.com");

add("ai", "ChatGPT", "chatgpt.com", "chat.openai.com");
add("ai", "Perplexity", "perplexity.ai");
add("ai", "Claude", "claude.ai");
add("ai", "Gemini", "gemini.google.com", "bard.google.com");
add("ai", "Copilot", "copilot.microsoft.com", "copilot.cloud.microsoft");
add("ai", "DeepSeek", "chat.deepseek.com");
add("ai", "Grok", "grok.com");
add("ai", "Meta AI", "meta.ai");
add("ai", "Mistral", "chat.mistral.ai");
add("ai", "Poe", "poe.com");
add("ai", "You.com", "you.com");
add("ai", "Phind", "phind.com");

add("email", "Gmail", "mail.google.com");
add("email", "Outlook", "outlook.live.com", "outlook.office.com", "outlook.office365.com");
add("email", "Yahoo Mail", "mail.yahoo.com");
add("email", "Proton Mail", "mail.proton.me");

/** Known `utm_source` spellings → display names. */
const SOURCE_NAMES: Record<string, string> = {
  google: "Google",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  facebook: "Facebook",
  fb: "Facebook",
  instagram: "Instagram",
  ig: "Instagram",
  twitter: "X",
  x: "X",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  youtube: "YouTube",
  tiktok: "TikTok",
  pinterest: "Pinterest",
  hackernews: "Hacker News",
  hn: "Hacker News",
  producthunt: "Product Hunt",
  chatgpt: "ChatGPT",
  "chatgpt.com": "ChatGPT",
  openai: "ChatGPT",
  perplexity: "Perplexity",
  claude: "Claude",
  gemini: "Gemini",
  newsletter: "Newsletter",
};

const SOCIAL_SOURCES = new Set([
  "facebook",
  "fb",
  "instagram",
  "ig",
  "twitter",
  "x",
  "linkedin",
  "reddit",
  "youtube",
  "tiktok",
  "pinterest",
  "snapchat",
  "threads",
  "meta",
]);

const SEARCH_CLICK_IDS = ["gclid", "gbraid", "wbraid", "msclkid"];
const SOCIAL_CLICK_IDS = ["fbclid", "ttclid", "twclid", "li_fat_id"];

export interface ReferrerInfo {
  kind: Kind | null;
  name: string;
}

/** Strip `www.`/`m.` style prefixes for display and lookups. */
export function bareDomain(host: string): string {
  return host.toLowerCase().replace(/^(www\d?|m)\./, "");
}

/** Look a referrer domain up in the lists (exact, then each parent domain). */
export function lookupReferrer(domain: string): ReferrerInfo {
  const host = domain.toLowerCase();
  let candidate = host;
  for (;;) {
    const hit = REFERRERS[candidate] ?? REFERRERS[bareDomain(candidate)];
    if (hit) return { kind: hit[0], name: hit[1] };
    // Any Google ccTLD (google.co.th, google.com.eg, ...).
    if (/^(www\.)?google\.(com?\.)?[a-z]{2,3}$/.test(candidate))
      return { kind: "search", name: "Google" };
    const dot = candidate.indexOf(".");
    if (dot < 0 || candidate.indexOf(".", dot + 1) < 0) break;
    candidate = candidate.slice(dot + 1);
  }
  return { kind: null, name: bareDomain(host) };
}

export interface ChannelInput {
  /** External referrer domain (internal referrers already removed), or null. */
  referrerDomain: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  ref: string | null;
  sourceParam: string | null;
  via: string | null;
  clickIds: Record<string, string>;
}

export interface ChannelResult {
  channel: Channel;
  source: string | null;
}

const SEARCH_SOURCES = new Set([
  "google",
  "bing",
  "duckduckgo",
  "yahoo",
  "yandex",
  "baidu",
  "ecosia",
]);
const AI_SOURCES = new Set(["chatgpt", "openai", "perplexity", "claude", "gemini", "copilot"]);

function sourceKind(value: string): Kind | null {
  const v = value.toLowerCase();
  if (SOCIAL_SOURCES.has(v)) return "social";
  if (SEARCH_SOURCES.has(v)) return "search";
  if (AI_SOURCES.has(v)) return "ai";
  return v.includes(".") ? lookupReferrer(v).kind : null;
}

function displaySource(value: string): string {
  const v = value.toLowerCase();
  if (SOURCE_NAMES[v]) return SOURCE_NAMES[v];
  const known = v.includes(".") ? lookupReferrer(v) : null;
  return known?.kind ? known.name : value;
}

export function classifyChannel(input: ChannelInput): ChannelResult {
  const medium = input.utmMedium?.toLowerCase() ?? "";
  const utmSource = input.utmSource?.toLowerCase() ?? "";
  const referrer = input.referrerDomain ? lookupReferrer(input.referrerDomain) : null;
  const socialHint = SOCIAL_SOURCES.has(utmSource) || referrer?.kind === "social";

  const named = input.ref ?? input.sourceParam ?? input.via ?? input.utmSource;
  // ref/source/via are shown as written; a utm_source gets its well-known display name.
  const explicit = input.ref ?? input.sourceParam ?? input.via;
  const source =
    explicit ?? (input.utmSource ? displaySource(input.utmSource) : (referrer?.name ?? null));
  const result = (channel: Channel): ChannelResult => ({ channel, source });

  // 2a. Non-paid mediums win over click ids ("unless UTMs say otherwise").
  if (medium === "email" || medium === "e-mail") return result("Email");
  if (medium === "newsletter") return result("Newsletter");
  if (medium === "affiliate" || medium === "affiliates") return result("Affiliate");

  // 1. Paid click ids.
  if (SEARCH_CLICK_IDS.some((k) => input.clickIds[k])) {
    return result(medium === "social" || medium === "paid_social" ? "Paid Social" : "Paid Search");
  }
  if (SOCIAL_CLICK_IDS.some((k) => input.clickIds[k])) return result("Paid Social");

  // 2b. Paid and other mediums.
  if (medium === "cpc" || medium === "ppc" || medium.startsWith("paid")) {
    if (medium.includes("social") || socialHint) return result("Paid Social");
    return result("Paid Search");
  }
  if (medium === "display" || medium === "banner" || medium === "cpm") return result("Display");
  if (medium === "social" || medium === "social-media" || medium === "social_media") {
    return result("Organic Social");
  }

  // 3. Affiliate links.
  if (input.via) return result("Affiliate");

  // 4. Referrer lists.
  if (referrer) {
    if (referrer.kind === "search") return result("Organic Search");
    if (referrer.kind === "social") return result("Organic Social");
    if (referrer.kind === "ai") return result("AI");
    if (referrer.kind === "email") return result("Email");
    return result("Referral");
  }
  if (medium === "organic" && utmSource) {
    return result(SOCIAL_SOURCES.has(utmSource) ? "Organic Social" : "Organic Search");
  }
  // utm_source / ref / source without a referrer: a tagged link, not direct traffic. Known
  // names keep their kind (ChatGPT appends utm_source=chatgpt.com to the links it cites).
  if (named) {
    const kind = sourceKind(named);
    if (kind === "search") return result("Organic Search");
    if (kind === "social") return result("Organic Social");
    if (kind === "ai") return result("AI");
    return result("Referral");
  }
  return { channel: "Direct", source: null };
}
