import { describe, expect, it } from "vitest";
import {
  countryName,
  countryOptions,
  currencyOptions,
  formatBytes,
  formatRelative,
  isIpOrCidr,
  isValidHostname,
  normaliseHostname,
  timezoneOptions,
} from "../../pages/settings/lib/format";
import { changedFields } from "../../pages/settings/lib/hooks";
import { PROVIDERS, providerById } from "../../pages/settings/lib/providers";
import {
  htmlSnippet,
  injectorSnippet,
  PLATFORMS,
  platformGuide,
  type SnippetOptions,
  variantFor,
} from "../../pages/settings/lib/snippets";

const base: SnippetOptions = {
  trackingId: "dfid_abc",
  domain: "example.com",
  origin: "https://stats.example.net/",
  variant: "default",
};

describe("tracking snippets", () => {
  it("builds DataFast's tag with an explicit data-api-url to the DataGoat host", () => {
    expect(htmlSnippet(base, false)).toBe(
      '<script defer data-website-id="dfid_abc" data-domain="example.com" data-api-url="https://stats.example.net/api/events" src="https://stats.example.net/js/script.js"></script>',
    );
  });

  it("adds allowed hostnames and localhost, and picks the build for the privacy mode", () => {
    const tag = htmlSnippet({
      ...base,
      variant: variantFor("cookieless", true),
      allowLocalhost: true,
      allowedHostnames: ["app.io", "shop.example.org"],
    });
    expect(tag).toContain('data-allowed-hostnames="app.io,shop.example.org"');
    expect(tag).toContain('data-allow-localhost="true"');
    expect(tag).toContain("/js/script.cookieless.js");
    expect(variantFor("cookie", true)).toBe("hash");
    expect(variantFor("consent", false)).toBe("default");
  });

  it("escapes attribute values", () => {
    expect(htmlSnippet({ ...base, domain: 'a"b<c' }, false)).toContain(
      'data-domain="a&quot;b&lt;c"',
    );
  });

  it("has a guide with steps and code for every platform", () => {
    for (const { id } of PLATFORMS) {
      const g = platformGuide(id, base);
      expect(g.steps.length).toBeGreaterThan(0);
      expect(g.code).toContain("dfid_abc");
    }
    expect(platformGuide("nextjs", base).code).toContain('import Script from "next/script"');
    expect(platformGuide("datafast", base).code).toContain("https://datafa.st/js/script.js");
    expect(platformGuide("vue", base).code).toContain('"data-website-id": "dfid_abc"');
  });

  it('adds data-compat="datafast" only to the switch-from-DataFast snippet', () => {
    expect(platformGuide("html", base).code).not.toContain("data-compat");
    const after = platformGuide("datafast", base).code.split("<!-- After (DataGoat) -->")[1] ?? "";
    expect(after).toContain('data-compat="datafast"');
    expect(platformGuide("datafast", base).steps.join(" ")).toContain("datafast_visitor_id");
  });

  it("builds an injector for tag managers that keeps the data attributes", () => {
    const code = injectorSnippet(base);
    expect(code).toContain('s.setAttribute("data-website-id", "dfid_abc");');
    expect(code).toContain('s.src = "https://stats.example.net/js/script.js";');
  });
});

describe("format and validation helpers", () => {
  it("validates IPs and CIDR ranges like the server", () => {
    for (const ok of ["127.0.0.1", "10.0.0.0/8", "2001:db8::1", "2001:db8::/32"])
      expect(isIpOrCidr(ok)).toBe(true);
    for (const bad of ["256.1.1.1", "10.0.0.0/33", "abc", "1.2.3.4/8/9", "::1::2"])
      expect(isIpOrCidr(bad)).toBe(false);
  });

  it("normalises and validates hostnames", () => {
    expect(normaliseHostname("https://App.Example.com:8080/path?q")).toBe("app.example.com");
    expect(isValidHostname("app.example.com")).toBe(true);
    expect(isValidHostname("localhost")).toBe(true);
    expect(isValidHostname("nodot")).toBe(false);
    expect(isValidHostname("-bad.example.com")).toBe(false);
  });

  it("formats bytes in decimal units and relative times", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(86_000_000)).toBe("86.0 MB");
    expect(formatBytes(500_000_000)).toBe("500 MB");
    expect(formatBytes(10_000_000_000)).toBe("10.0 GB");
    const now = Date.parse("2026-11-04T12:00:00Z");
    expect(formatRelative(null, now)).toBe("Never");
    expect(formatRelative("2026-11-04T11:57:00Z", now)).toBe("3 minutes ago");
    expect(formatRelative("2026-11-11T12:00:00Z", now)).toBe("in 7 days");
  });

  it("lists timezones, currencies and countries", () => {
    const tz = timezoneOptions("Asia/Dhaka");
    expect(tz[0]).toBe("UTC");
    expect(tz).toContain("Asia/Dhaka");
    const currencies = currencyOptions("XYZ").map((c) => c.code);
    expect(currencies.slice(0, 3)).toEqual(["USD", "EUR", "GBP"]);
    expect(currencies).toContain("XYZ");
    expect(countryName("FR")).toBe("France");
    expect(countryName("T1")).toBe("Tor network");
    expect(countryOptions().length).toBeGreaterThan(240);
  });

  it("diffs only changed fields", () => {
    expect(changedFields({ a: 1, b: ["x"], c: "same" }, { a: 2, b: ["x"], c: "same" })).toEqual({
      a: 2,
    });
  });
});

describe("payment providers", () => {
  it("validates Stripe restricted keys and refuses secret keys", () => {
    const rak = providerById("stripe")?.fields[0]?.validate;
    expect(rak?.("rk_live_123")).toBeNull();
    expect(rak?.("sk_live_123")).toMatch(/restricted key/);
    expect(rak?.("whatever")).toMatch(/rk_live_/);
    expect(providerById("paddle")?.fields[0]?.validate?.("pdl_sdbx_1")).toMatch(/pdl_live_/);
  });

  it("covers every DataFast provider plus Dodo and Creem", () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual([
      "creem",
      "dodo",
      "lemonsqueezy",
      "paddle",
      "polar",
      "shopify",
      "stripe",
      "woocommerce",
    ]);
    for (const p of PROVIDERS) expect(p.steps.length).toBeGreaterThan(1);
  });
});
