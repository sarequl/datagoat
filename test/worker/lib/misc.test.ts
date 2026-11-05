import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { countryFlag, countryName, toCountryCode } from "../../../src/lib/countries";
import {
  isObjectIdLike,
  isSessionId,
  isUuidV4,
  newId,
  newTrackingId,
  randomBase62,
  randomToken,
  uuidv4,
} from "../../../src/lib/ids";
import { currencyExponent, round2, toMajor, toMinor } from "../../../src/lib/money";
import { SiteCache } from "../../../src/lib/site-cache";
import {
  isValidHostname,
  normaliseDomain,
  normaliseGoalName,
  parseFields,
  parsePagination,
  validate,
  zGoalName,
} from "../../../src/lib/validate";
import { resetDb } from "../../helpers/db";
import { createSite } from "../../helpers/factories";

describe("ids", () => {
  it("generates ObjectId-like ids that sort by time", () => {
    const a = newId(1_000_000_000_000);
    const b = newId(1_000_000_100_000);
    expect(isObjectIdLike(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(newTrackingId()).toMatch(/^dgid_[0-9A-Za-z]{16}$/);
    expect(randomBase62(30)).toMatch(/^[0-9A-Za-z]{30}$/);
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("recognises DataFast visitor and session ids", () => {
    const v = uuidv4();
    expect(isUuidV4(v)).toBe(true);
    expect(isSessionId(`s${v}`)).toBe(true);
    expect(isSessionId(v)).toBe(false);
    expect(isUuidV4("a3ab2331-989f-1cfa-91c6-2461c9e3c6bd")).toBe(false);
  });
});

describe("money and countries", () => {
  it("converts major and minor units per currency", () => {
    expect(toMinor(29.99, "USD")).toBe(2999);
    expect(toMinor(-10.005, "USD")).toBe(-1001);
    expect(toMinor(1500, "JPY")).toBe(1500);
    expect(toMajor(12345, "KWD")).toBe(12.345);
    expect(toMajor(2999, "usd")).toBe(29.99);
    expect(currencyExponent("EUR")).toBe(2);
    expect(round2(2.2851)).toBe(2.29);
  });

  it("maps country names, codes and aliases", () => {
    expect(toCountryCode("United States")).toBe("US");
    expect(toCountryCode("us")).toBe("US");
    expect(toCountryCode("UK")).toBe("GB");
    expect(toCountryCode("france")).toBe("FR");
    expect(toCountryCode("Atlantis")).toBeNull();
    expect(countryName("DE")).toBe("Germany");
    expect(countryName("T1")).toBe("Tor network");
    expect(countryFlag("US")).toBe("🇺🇸");
    expect(countryFlag("XX")).toBeNull();
  });
});

describe("validation helpers", () => {
  it("parses DataFast fields lists", () => {
    expect(parseFields(undefined, ["a", "b"] as const)).toEqual(["a", "b"]);
    expect(parseFields("b, a,b", ["a", "b"] as const)).toEqual(["b", "a"]);
    expect(() => parseFields("a,c", ["a", "b"] as const)).toThrow("Invalid fields value: c");
  });

  it("parses pagination with DataFast limits", () => {
    expect(parsePagination({})).toEqual({ limit: 100, offset: 0 });
    expect(parsePagination({ limit: "50", offset: "100" })).toEqual({ limit: 50, offset: 100 });
    expect(() => parsePagination({ limit: "1001" })).toThrow("at most 1000");
    expect(() => parsePagination({ limit: "300" }, { max: 250 })).toThrow("250");
    expect(() => parsePagination({ offset: "-1" })).toThrow();
    expect(() => parsePagination({ limit: "abc" })).toThrow();
  });

  it("normalises goal names and domains", () => {
    expect(normaliseGoalName(" Newsletter Signup ")).toBe("newsletter_signup");
    expect(validate(zGoalName, "checkout:started")).toBe("checkout:started");
    expect(() => validate(zGoalName, "identify")).toThrow("reserved");
    expect(() => validate(zGoalName, "x".repeat(65))).toThrow();
    expect(normaliseDomain("https://WWW.Example.com:443/path?q")).toBe("www.example.com");
    expect(isValidHostname("example.com")).toBe(true);
    expect(isValidHostname("localhost")).toBe(true);
    expect(isValidHostname("exa mple.com")).toBe(false);
  });
});

describe("site cache", () => {
  beforeEach(() => resetDb());

  it("caches by id and public id, caches misses briefly, and invalidates", async () => {
    let now = 0;
    const cache = new SiteCache(60_000, 10_000, 100, () => now);
    const site = await createSite(null, { publicId: "dfid_cache" });
    expect((await cache.byPublicId(env.DB, "dfid_cache"))?.id).toBe(site.id);
    await env.DB.prepare("UPDATE sites SET name = 'Renamed' WHERE id = ?").bind(site.id).run();
    expect((await cache.byId(env.DB, site.id))?.name).toBe(site.name);
    cache.invalidate(site);
    expect((await cache.byId(env.DB, site.id))?.name).toBe("Renamed");
    now += 61_000;
    expect(await cache.byPublicId(env.DB, "missing")).toBeNull();
    await createSite(null, { publicId: "missing" });
    expect(await cache.byPublicId(env.DB, "missing")).toBeNull();
    now += 11_000;
    expect(await cache.byPublicId(env.DB, "missing")).not.toBeNull();
  });

  it("does not return soft-deleted sites", async () => {
    const cache = new SiteCache();
    const site = await createSite(null);
    await env.DB.prepare("UPDATE sites SET deleted_at = 1 WHERE id = ?").bind(site.id).run();
    expect(await cache.byId(env.DB, site.id)).toBeNull();
  });
});
