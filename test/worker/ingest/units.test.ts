/** Pure helpers of the ingest pipeline. */
import { describe, expect, it } from "vitest";
import { isBotUserAgent } from "../../../src/ingest/bots";
import { normaliseGoalName, sanitiseValue } from "../../../src/ingest/events";
import { ipMatches, parseIp, pathMatches, userAgentMatches } from "../../../src/ingest/exclusions";
import { geoFromCf } from "../../../src/ingest/geo";
import { checkHostname, isLocalHostname } from "../../../src/ingest/hostnames";
import { parseUserAgent } from "../../../src/ingest/ua";

describe("isBotUserAgent", () => {
  it.each([
    [
      "Chrome on macOS",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    ],
    [
      "Firefox on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    ],
    [
      "Safari on iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    ],
    [
      "Edge",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    ],
    [
      "Samsung Internet",
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    ],
    [
      "DuckDuckGo's browser",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15",
    ],
    [
      "Facebook in-app browser",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0]",
    ],
    [
      "Yandex Browser",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 YaBrowser/24.4.0.0 Safari/537.36",
    ],
  ])("lets %s through", (_label, ua) => {
    expect(isBotUserAgent(ua)).toBe(false);
  });

  it.each([
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "Twitterbot/1.0",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Chrome-Lighthouse",
    "Go-http-client/1.1",
    "axios/1.6.0",
    "node-fetch/1.0",
    "Wget/1.21",
    "Java/17.0.1",
    "PostmanRuntime/7.36.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Playwright/1.40",
    "Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1",
  ])("drops %s", (ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });
});

describe("IP matching", () => {
  it("parses IPv4, IPv6, compressed and embedded forms", () => {
    expect(parseIp("10.0.0.1")).toEqual({ v: 4, value: 0x0a000001n });
    expect(parseIp("::1")).toEqual({ v: 6, value: 1n });
    expect(parseIp("2001:db8::")?.value).toBe(0x20010db8n << 96n);
    expect(parseIp("::ffff:10.0.0.1")).toEqual({ v: 4, value: 0x0a000001n });
    expect(parseIp("64:ff9b::192.0.2.1")?.v).toBe(6);
    for (const bad of ["", "1.2.3", "256.1.1.1", "1:2:3", "1::2::3", "gggg::1", "1.2.3.4.5"]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });
  it("matches CIDR prefixes of every length", () => {
    expect(ipMatches("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipMatches("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(ipMatches("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipMatches("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(ipMatches("10.0.0.1", "10.0.0.1/33")).toBe(false);
    expect(ipMatches("2001:db8::1", "2001:db8::/127")).toBe(true);
    expect(ipMatches("2001:db8::2", "2001:db8::/127")).toBe(false);
    expect(ipMatches("10.0.0.1", "2001:db8::/32")).toBe(false);
    expect(ipMatches("not-an-ip", "10.0.0.0/8")).toBe(false);
  });
});

describe("path and UA rules", () => {
  it("follows DataFast's path semantics", () => {
    expect(pathMatches("/admin", "/admin")).toBe(true);
    expect(pathMatches("/admin/x", "/admin")).toBe(false);
    expect(pathMatches("/admin/x/y", "/admin/*")).toBe(true);
    expect(pathMatches("/admin", "/admin/*")).toBe(false);
    expect(pathMatches("/a.b", "/a.b")).toBe(true);
    expect(pathMatches("/axb", "/a.b")).toBe(false);
    expect(pathMatches("/docs/v1/intro", "/docs/*/intro")).toBe(true);
    expect(pathMatches("/", "/")).toBe(true);
    expect(pathMatches("/x", "  ")).toBe(false);
  });
  it("matches user agents by case-insensitive substring", () => {
    expect(userAgentMatches("Mozilla/5.0 MyMonitor/1", "mymonitor")).toBe(true);
    expect(userAgentMatches("Mozilla/5.0 MyMonitor/1", " MYMONITOR/1 ")).toBe(true);
    expect(userAgentMatches("Mozilla/5.0 MyMonitor/1", "Mozilla*/1")).toBe(false);
    expect(userAgentMatches("Mozilla/5.0 MyMonitor/1", "   ")).toBe(false);
  });
});

describe("hostnames", () => {
  const site = {
    domain: "example.com",
    allowedHostnames: ["shop.example.net"],
    allHostnamesAllowed: false,
  };
  it("recognises development hosts", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "127.1.2.3",
      "[::1]",
      "app.local",
      "dev.localhost",
    ]) {
      expect(isLocalHostname(h), h).toBe(true);
    }
    expect(isLocalHostname("localhost.example.com")).toBe(false);
  });
  it("classifies URLs", () => {
    expect(checkHostname(site, new URL("https://example.com/"))).toBe("site");
    expect(checkHostname(site, new URL("https://shop.example.net/"))).toBe("site");
    expect(checkHostname(site, new URL("https://example.net/"))).toBeNull();
    expect(checkHostname(site, new URL("http://localhost/"))).toBe("dev");
    expect(checkHostname(site, new URL("file:///index.html"))).toBe("file");
    expect(checkHostname(site, new URL("datagoat://android/Home"))).toBe("app");
    expect(
      checkHostname({ ...site, domain: "Example.COM." }, new URL("https://WWW.example.com/")),
    ).toBe("site");
  });
});

describe("goal names and values", () => {
  it("normalises names", () => {
    expect(normaliseGoalName("  Sign Up  ")).toBe("sign_up");
    expect(normaliseGoalName("initiate:checkout")).toBe("initiate:checkout");
    expect(normaliseGoalName("a".repeat(64))).toHaveLength(64);
    expect(normaliseGoalName("a".repeat(65))).toBeNull();
    expect(normaliseGoalName("emoji🎉")).toBeNull();
    expect(normaliseGoalName(42)).toBeNull();
  });
  it("sanitises values", () => {
    expect(sanitiseValue(49)).toBe("49");
    expect(sanitiseValue(true)).toBe("true");
    expect(sanitiseValue({ a: 1 })).toBe('{"a":1}');
    expect(sanitiseValue("<b>bold</b>")).toBe("bbold/b");
    expect(sanitiseValue("data:text/html,x")).toBe("text/html,x");
    expect(sanitiseValue('x" onclick="y')).toBe('x" "y');
    expect(sanitiseValue(undefined)).toBeNull();
  });
});

describe("user agent parsing", () => {
  it.each([
    [
      "iPad",
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "tablet",
    ],
    [
      "Android phone",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      "mobile",
    ],
    [
      "Windows desktop",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
      "desktop",
    ],
  ])("%s → %s", (_label, ua, device) => {
    expect(parseUserAgent(ua).device).toBe(device);
  });
  it("names browsers and systems", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
      ),
    ).toMatchObject({
      browser: "Firefox",
      browserVersion: "131",
      os: "Windows",
      osVersion: "10",
    });
  });
});

describe("geo", () => {
  it("reads request.cf and rounds coordinates", () => {
    expect(
      geoFromCf({
        country: "de",
        region: "Berlin",
        city: "Berlin",
        latitude: "52.52437",
        longitude: "13.41053",
        asn: 3320,
      }),
    ).toEqual({
      country: "DE",
      region: "Berlin",
      city: "Berlin",
      lat: 52.52,
      lon: 13.41,
      asn: 3320,
    });
    expect(geoFromCf(undefined)).toEqual({
      country: null,
      region: null,
      city: null,
      lat: null,
      lon: null,
      asn: null,
    });
    expect(geoFromCf({ country: "XX", latitude: "999" }).lat).toBeNull();
  });
});
