/** Channel classification, one test per rule of plan §8.1 (and DataGoat's additions). */
import { describe, expect, it } from "vitest";
import { type ChannelInput, classifyChannel, lookupReferrer } from "../../../src/ingest/channels";

const none: ChannelInput = {
  referrerDomain: null,
  utmSource: null,
  utmMedium: null,
  ref: null,
  sourceParam: null,
  via: null,
  clickIds: {},
};
const c = (input: Partial<ChannelInput>) => classifyChannel({ ...none, ...input });

describe("rule 1: paid click ids", () => {
  it.each(["gclid", "gbraid", "wbraid", "msclkid"])("%s → Paid Search", (id) => {
    expect(c({ clickIds: { [id]: "x" } }).channel).toBe("Paid Search");
  });
  it.each(["fbclid", "ttclid", "twclid", "li_fat_id"])("%s → Paid Social", (id) => {
    expect(c({ clickIds: { [id]: "x" } }).channel).toBe("Paid Social");
  });
  it("a click id beats an organic referrer", () => {
    expect(c({ clickIds: { gclid: "x" }, referrerDomain: "google.com" })).toEqual({
      channel: "Paid Search",
      source: "Google",
    });
  });
  it("UTMs say otherwise: an email campaign with fbclid stays Email", () => {
    expect(c({ clickIds: { fbclid: "x" }, utmMedium: "email" }).channel).toBe("Email");
  });
  it("a search click id with utm_medium=social is Paid Social", () => {
    expect(c({ clickIds: { gclid: "x" }, utmMedium: "social" }).channel).toBe("Paid Social");
  });
});

describe("rule 2: utm_medium", () => {
  it.each(["cpc", "ppc", "paid", "paidsearch", "paid_search", "CPC"])("%s → Paid Search", (m) => {
    expect(c({ utmMedium: m, utmSource: "google" }).channel).toBe("Paid Search");
  });
  it("paid with a social source → Paid Social", () => {
    expect(c({ utmMedium: "cpc", utmSource: "facebook" })).toEqual({
      channel: "Paid Social",
      source: "Facebook",
    });
    expect(c({ utmMedium: "paid_social", utmSource: "newsletter" }).channel).toBe("Paid Social");
    expect(c({ utmMedium: "cpc", referrerDomain: "l.instagram.com" }).channel).toBe("Paid Social");
  });
  it("email → Email", () => expect(c({ utmMedium: "email" }).channel).toBe("Email"));
  it("newsletter → Newsletter", () =>
    expect(c({ utmMedium: "newsletter" }).channel).toBe("Newsletter"));
  it("affiliate → Affiliate", () =>
    expect(c({ utmMedium: "affiliate" }).channel).toBe("Affiliate"));
  it("display/banner/cpm → Display", () => {
    for (const m of ["display", "banner", "cpm"])
      expect(c({ utmMedium: m }).channel).toBe("Display");
  });
  it("social → Organic Social", () =>
    expect(c({ utmMedium: "social", utmSource: "x" }).channel).toBe("Organic Social"));
  it("organic with a search source and no referrer → Organic Search", () => {
    expect(c({ utmMedium: "organic", utmSource: "bing" })).toEqual({
      channel: "Organic Search",
      source: "Bing",
    });
  });
});

describe("rule 3: via means Affiliate", () => {
  it("via → Affiliate with the via value as source", () => {
    expect(c({ via: "jane" })).toEqual({ channel: "Affiliate", source: "jane" });
  });
  it("via beats a referrer", () => {
    expect(c({ via: "jane", referrerDomain: "twitter.com" }).channel).toBe("Affiliate");
  });
});

describe("rule 4: referrer lists", () => {
  it.each([
    ["google.com", "Organic Search", "Google"],
    ["www.google.co.uk", "Organic Search", "Google"],
    ["google.com.eg", "Organic Search", "Google"],
    ["bing.com", "Organic Search", "Bing"],
    ["duckduckgo.com", "Organic Search", "DuckDuckGo"],
    ["search.brave.com", "Organic Search", "Brave Search"],
    ["yandex.ru", "Organic Search", "Yandex"],
    ["t.co", "Organic Social", "X"],
    ["x.com", "Organic Social", "X"],
    ["m.facebook.com", "Organic Social", "Facebook"],
    ["news.ycombinator.com", "Organic Social", "Hacker News"],
    ["old.reddit.com", "Organic Social", "Reddit"],
    ["lnkd.in", "Organic Social", "LinkedIn"],
    ["youtube.com", "Organic Social", "YouTube"],
    ["chatgpt.com", "AI", "ChatGPT"],
    ["chat.openai.com", "AI", "ChatGPT"],
    ["perplexity.ai", "AI", "Perplexity"],
    ["www.perplexity.ai", "AI", "Perplexity"],
    ["claude.ai", "AI", "Claude"],
    ["gemini.google.com", "AI", "Gemini"],
    ["copilot.microsoft.com", "AI", "Copilot"],
    ["mail.google.com", "Email", "Gmail"],
    ["outlook.live.com", "Email", "Outlook"],
  ])("%s → %s (%s)", (domain, channel, source) => {
    expect(c({ referrerDomain: domain })).toEqual({ channel, source });
  });
  it("gemini.google.com is AI, not Google search", () => {
    expect(lookupReferrer("gemini.google.com").kind).toBe("ai");
  });
});

describe("rule 5: everything else", () => {
  it("another external referrer → Referral, with the bare domain as source", () => {
    expect(c({ referrerDomain: "blog.somebody.dev" })).toEqual({
      channel: "Referral",
      source: "blog.somebody.dev",
    });
  });
  it("no referrer and no parameters → Direct", () => {
    expect(c({})).toEqual({ channel: "Direct", source: null });
  });
  it("a ref link without a referrer is not Direct", () => {
    expect(c({ ref: "twitter-bio" })).toEqual({ channel: "Referral", source: "twitter-bio" });
  });
  it("a known utm_source without a referrer keeps its kind (ChatGPT citations)", () => {
    expect(c({ utmSource: "chatgpt.com" })).toEqual({ channel: "AI", source: "ChatGPT" });
    expect(c({ utmSource: "google" }).channel).toBe("Organic Search");
    expect(c({ ref: "reddit" }).channel).toBe("Organic Social");
  });
});

describe("source display name", () => {
  it("prefers ref, then source, then via, then utm_source, then the referrer", () => {
    expect(
      c({ ref: "r", sourceParam: "s", via: "v", utmSource: "u", referrerDomain: "google.com" })
        .source,
    ).toBe("r");
    expect(c({ sourceParam: "s", via: "v", utmSource: "u" }).source).toBe("s");
    expect(c({ via: "v", utmSource: "u" }).source).toBe("v");
    expect(c({ utmSource: "u", referrerDomain: "google.com" }).source).toBe("u");
    expect(c({ referrerDomain: "google.com" }).source).toBe("Google");
  });
  it("normalises well-known utm_source spellings", () => {
    expect(c({ utmSource: "fb", utmMedium: "cpc" }).source).toBe("Facebook");
    expect(c({ utmSource: "twitter" }).source).toBe("X");
  });
});
