import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, normalizeInstanceUrl, signIn, toBreakdownRow } from "./api";

function mockFetch(handler: (url: URL, init: RequestInit) => [number, unknown]) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    const [status, body] = handler(url, init);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  });
  return { fetch, calls };
}

const range = { startAt: "2026-11-04", endAt: "2026-11-04", timezone: "Europe/Berlin" };

describe("normalizeInstanceUrl", () => {
  it("adds https, strips paths and refuses plain http on public hosts", () => {
    expect(normalizeInstanceUrl(" analytics.example.com/app ")).toBe(
      "https://analytics.example.com",
    );
    expect(normalizeInstanceUrl("https://dg.example.workers.dev/")).toBe(
      "https://dg.example.workers.dev",
    );
    expect(normalizeInstanceUrl("http://analytics.example.com")).toBeNull();
    expect(normalizeInstanceUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeInstanceUrl("http://192.168.1.20:8787")).toBe("http://192.168.1.20:8787");
    expect(normalizeInstanceUrl("nope")).toBeNull();
    expect(normalizeInstanceUrl("")).toBeNull();
  });
});

describe("signIn", () => {
  it("posts credentials and returns the session", async () => {
    const { fetch, calls } = mockFetch(() => [
      200,
      {
        status: "success",
        data: { token: "dft_x", tokenId: "t", expiresAt: "", user: {}, websites: [] },
      },
    ]);
    const session = await signIn(fetch, "https://dg.test", "a@b.co", "pw", "Pixel");
    expect(session.token).toBe("dft_x");
    expect(calls[0]?.url.toString()).toBe("https://dg.test/api/v1/mobile/session");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      email: "a@b.co",
      password: "pw",
      deviceName: "Pixel",
    });
  });

  it("surfaces the server's message, a not-DataGoat 404 and network failures", async () => {
    const bad = mockFetch(() => [
      401,
      { status: "error", error: { code: 401, message: "Invalid email or password" } },
    ]);
    await expect(signIn(bad.fetch, "https://dg.test", "a@b.co", "x")).rejects.toMatchObject({
      message: "Invalid email or password",
      status: 401,
    });
    const missing = mockFetch(() => [404, "<html>"]);
    await expect(signIn(missing.fetch, "https://dg.test", "a@b.co", "x")).rejects.toThrow(
      /not a DataGoat/,
    );
    const offline = vi.fn(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(signIn(offline, "https://dg.test", "a@b.co", "x")).rejects.toThrow(
      /Could not reach/,
    );
  });
});

describe("createApi", () => {
  it("sends the token and the site range on analytics calls", async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.pathname.endsWith("/overview"))
        return [200, { status: "success", data: [{ visitors: 12, currency: "EUR" }] }];
      if (url.pathname.endsWith("/realtime"))
        return [200, { status: "success", data: [{ visitors: 3 }] }];
      if (url.pathname.endsWith("/timeseries"))
        return [200, { status: "success", data: [{ timestamp: "t", visitors: 1 }] }];
      if (url.pathname.endsWith("/referrers"))
        return [
          200,
          { status: "success", data: [{ referrer: "Google", visitors: 9, revenue: 10 }] },
        ];
      return [404, { status: "error", error: { code: 404, message: "nope" } }];
    });
    const api = createApi(fetch, "https://dg.test/", "dft_tok");
    expect((await api.overview("site1", range)).visitors).toBe(12);
    expect(await api.realtime("site1")).toBe(3);
    expect(await api.timeseries("site1", range, "hour")).toHaveLength(1);
    expect(await api.breakdown("site1", "referrers", range, 5)).toEqual([
      { label: "Google", visitors: 9, revenue: 10 },
    ]);
    const first = calls[0];
    expect(new Headers(first?.init.headers).get("authorization")).toBe("Bearer dft_tok");
    expect(Object.fromEntries(first?.url.searchParams ?? [])).toEqual({
      websiteId: "site1",
      startAt: "2026-11-04",
      endAt: "2026-11-04",
      timezone: "Europe/Berlin",
    });
    expect(calls[1]?.url.search).toBe("?websiteId=site1");
    expect(calls[2]?.url.searchParams.get("fields")).toBe("visitors,revenue");
    expect(calls[2]?.url.searchParams.get("interval")).toBe("hour");
    expect(calls[3]?.url.searchParams.get("limit")).toBe("5");
  });

  it("marks 401 as an auth error and reports offline state", async () => {
    const { fetch } = mockFetch(() => [
      401,
      { status: "error", error: { code: 401, message: "Invalid, expired or revoked API key" } },
    ]);
    const err = await createApi(fetch, "https://dg.test", "t")
      .websites()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isAuth).toBe(true);
    const offline = vi.fn(async () => {
      throw new TypeError("x");
    });
    await expect(createApi(offline, "https://dg.test", "t").websites()).rejects.toMatchObject({
      status: 0,
    });
  });

  it("registers and deletes devices and signs out", async () => {
    const { fetch, calls } = mockFetch((url, init) => {
      if (url.pathname.endsWith("/mobile/devices") && init.method === "POST")
        return [201, { status: "success", data: [{ id: "d1" }] }];
      return [200, { status: "success", data: [{ deleted: true }] }];
    });
    const api = createApi(fetch, "https://dg.test", "t");
    expect(
      (await api.registerDevice({ pushToken: "ExponentPushToken[x]", platform: "ios" })).id,
    ).toBe("d1");
    await api.deleteDevice("d/1");
    await api.signOut();
    expect(calls.map((c) => `${c.init.method} ${c.url.pathname}`)).toEqual([
      "POST /api/v1/mobile/devices",
      "DELETE /api/v1/mobile/devices/d%2F1",
      "DELETE /api/v1/mobile/session",
    ]);
  });
});

describe("toBreakdownRow", () => {
  it("labels every breakdown kind", () => {
    expect(
      toBreakdownRow("countries", { country: "Germany", image: "🇩🇪", visitors: 3 }).label,
    ).toBe("🇩🇪 Germany");
    expect(
      toBreakdownRow("pages", { hostname: "a.com", path: "/pricing", visitors: 1 }).label,
    ).toBe("/pricing");
    expect(
      toBreakdownRow("campaigns", {
        campaign: { utm_campaign: "", utm_source: "newsletter" },
        visitors: 2,
      }).label,
    ).toBe("newsletter");
    expect(toBreakdownRow("goals", { goal: "signup", visitors: 4 })).toEqual({
      label: "signup",
      visitors: 4,
      revenue: null,
    });
    expect(toBreakdownRow("channels", { channel: "", visitors: 0 }).label).toBe("(none)");
  });
});
