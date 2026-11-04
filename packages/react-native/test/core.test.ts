import { describe, expect, it, vi } from "vitest";
import {
  createMemoryStorage,
  DataGoatClient,
  type EventBody,
  mobileUserAgent,
  type PlatformInfo,
  SESSION_TIMEOUT_MS,
  screenPath,
} from "../src/core";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const IOS: PlatformInfo = {
  os: "ios",
  osVersion: "18.1",
  model: "iPhone16,1",
  screen: { width: 393, height: 852 },
  window: { width: 393, height: 800 },
  locale: "de-DE",
  timeZone: "Europe/Berlin",
};

function setup(options: { status?: number | (() => number); online?: boolean } = {}) {
  let now = Date.parse("2026-11-04T10:00:00Z");
  const storage = createMemoryStorage();
  const sent: Array<{ url: string; body: EventBody; headers: Record<string, string> }> = [];
  let online = options.online ?? true;
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const status =
      typeof options.status === "function" ? options.status() : (options.status ?? 200);
    if (status === 0) throw new TypeError("Network request failed");
    sent.push({
      url,
      body: JSON.parse(String(init.body)) as EventBody,
      headers: init.headers as Record<string, string>,
    });
    return new Response("{}", { status });
  });
  const make = () =>
    new DataGoatClient(
      {
        websiteId: "dfid_app",
        domain: "example.com",
        host: "https://a.example.com/",
        flushAt: 100,
      },
      {
        storage,
        platform: IOS,
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => now,
        network: { isOnline: () => online },
      },
    );
  return {
    storage,
    sent,
    fetch,
    make,
    advance: (ms: number) => {
      now += ms;
    },
    setOnline: (v: boolean) => {
      online = v;
    },
  };
}

describe("DataGoatClient", () => {
  it("sends screens, goals and identify as the collector's documented body", async () => {
    const t = setup();
    const client = t.make();
    await client.trackScreen("HomeScreen");
    await client.track("Upgrade_Click", { source: "home", "price-tier": 2, empty: "" });
    await client.identify("ada@example.com", { name: "Ada", user_id: "ignored" });
    await client.flush();
    expect(t.sent).toHaveLength(3);
    const [screen, goal, ident] = t.sent.map((s) => s.body);
    expect(t.sent[0]?.url).toBe("https://a.example.com/api/events");
    expect(t.sent[0]?.headers["Content-Type"]).toBe("text/plain");
    expect(t.sent[0]?.headers["User-Agent"]).toContain("iPhone OS 18_1 like Mac OS X");
    expect(screen).toMatchObject({
      websiteId: "dfid_app",
      domain: "example.com",
      href: "datafast://ios/HomeScreen",
      referrer: null,
      viewport: { width: 393, height: 800 },
      screenWidth: 393,
      screenHeight: 852,
      language: "de-DE",
      timezone: "Europe/Berlin",
      type: "pageview",
      visitorSessionNumber: 1,
      visitorFirstSeenAt: "2026-11-04T10:00:00.000Z",
    });
    expect(screen?.extraData).toBeUndefined();
    expect(screen?.visitorId).toMatch(UUID_V4);
    expect(screen?.sessionId).toMatch(/^s[0-9a-f-]{36}$/);
    expect(goal).toMatchObject({
      type: "custom",
      href: "datafast://ios/HomeScreen",
      extraData: { eventName: "upgrade_click", source: "home", price_tier: "2" },
    });
    expect(ident).toMatchObject({
      type: "identify",
      extraData: { name: "Ada", user_id: "ada@example.com" },
    });
    expect(new Set(t.sent.map((s) => s.body.visitorId)).size).toBe(1);
    expect(client.queued()).toBe(0);
  });

  it("rejects invalid goals and parameters like the web API", async () => {
    const client = setup().make();
    expect(await client.track("bad goal")).toBe(false);
    expect(await client.track("identify")).toBe(false);
    expect(await client.track("ok", { "bad key": 1 })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
    expect(await client.track("ok", many)).toBe(false);
    expect(await client.identify("")).toBe(false);
    expect(client.queued()).toBe(0);
  });

  it("keeps the visitor across restarts and starts a new session after 30 minutes", async () => {
    const t = setup();
    const first = t.make();
    await first.trackScreen("Home");
    await first.flush();
    const restarted = t.make();
    await restarted.trackScreen("Settings/Profile");
    t.advance(SESSION_TIMEOUT_MS + 1);
    await restarted.trackScreen("Home");
    await restarted.flush();
    const [a, b, c] = t.sent.map((s) => s.body);
    expect(b?.visitorId).toBe(a?.visitorId);
    expect(b?.sessionId).toBe(a?.sessionId);
    expect(b?.href).toBe("datafast://ios/Settings/Profile");
    expect(c?.visitorId).toBe(a?.visitorId);
    expect(c?.sessionId).not.toBe(a?.sessionId);
    expect(c?.visitorSessionNumber).toBe(2);
  });

  it("dedupes the same screen reported twice in a row", async () => {
    const t = setup();
    const client = t.make();
    await client.trackScreen("Home");
    await client.trackScreen("Home");
    await client.trackScreen("Details");
    await client.trackScreen("Home");
    await client.flush();
    expect(t.sent.map((s) => s.body.href)).toEqual([
      "datafast://ios/Home",
      "datafast://ios/Details",
      "datafast://ios/Home",
    ]);
  });

  it("queues offline and on server errors, persists the queue, and sends in order later", async () => {
    let status = 0;
    const t = setup({ status: () => status, online: false });
    const client = t.make();
    await client.trackScreen("A");
    await client.track("one");
    await client.flush();
    expect(t.fetch).not.toHaveBeenCalled();
    t.setOnline(true);
    await client.flush(); // network error
    status = 503;
    await client.flush(); // server error
    expect(client.queued()).toBe(2);
    const stored = JSON.parse(t.storage.data.get("datagoat:queue") ?? "[]");
    expect(stored).toHaveLength(2);
    expect(stored[0].attempts).toBe(2);

    // App restarts and comes back online.
    status = 200;
    const restarted = t.make();
    await restarted.flush();
    expect(t.sent.slice(-2).map((s) => s.body.type)).toEqual(["pageview", "custom"]);
    expect(restarted.queued()).toBe(0);
    expect(JSON.parse(t.storage.data.get("datagoat:queue") ?? "[]")).toEqual([]);
  });

  it("drops events the collector rejects (4xx) but retries 429", async () => {
    let status = 400;
    const t = setup({ status: () => status });
    const client = t.make();
    await client.track("bad_for_server");
    await client.flush();
    expect(client.queued()).toBe(0);
    status = 429;
    await client.track("later");
    await client.flush();
    expect(client.queued()).toBe(1);
  });

  it("flushes automatically at flushAt and caps the stored queue", async () => {
    const t = setup({ online: false });
    const client = new DataGoatClient(
      {
        websiteId: "w",
        domain: "example.com",
        host: "https://a.example.com",
        maxStoredEvents: 3,
        flushAt: 100,
      },
      { storage: t.storage, platform: IOS, network: { isOnline: () => false } },
    );
    for (let i = 0; i < 5; i++) await client.track(`g${i}`);
    expect(client.queued()).toBe(3);
    const auto = new DataGoatClient(
      { websiteId: "w", domain: "example.com", host: "https://a.example.com", flushAt: 2 },
      { storage: createMemoryStorage(), platform: IOS, fetch: t.fetch as unknown as typeof fetch },
    );
    await auto.track("a");
    expect(t.fetch).not.toHaveBeenCalled();
    await auto.track("b");
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it("reset() forgets the visitor; setEnabled(false) holds events", async () => {
    const t = setup();
    const client = t.make();
    await client.trackScreen("Home");
    const before = client.getVisitorId();
    await client.reset();
    expect(client.getVisitorId()).toBeNull();
    client.setEnabled(false);
    await client.track("after_reset");
    await client.flush();
    expect(t.sent).toHaveLength(0);
    client.setEnabled(true);
    await client.flush();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]?.body.visitorId).not.toBe(before);
  });

  it("validates config and builds platform user agents", () => {
    expect(
      () =>
        new DataGoatClient(
          { websiteId: "", domain: "x", host: "h" },
          { storage: createMemoryStorage(), platform: IOS },
        ),
    ).toThrow(/websiteId/);
    expect(
      () =>
        new DataGoatClient(
          { websiteId: "w", domain: "x", host: "" },
          { storage: createMemoryStorage(), platform: IOS },
        ),
    ).toThrow(/host/);
    expect(mobileUserAgent({ ...IOS, model: "iPad13,1" })).toContain("iPad; CPU OS 18_1");
    expect(
      mobileUserAgent({ os: "android", osVersion: "15", model: "Pixel 9", screen: IOS.screen }),
    ).toBe(
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 DataGoatReactNative/0.1.0",
    );
    expect(mobileUserAgent({ os: "web", screen: IOS.screen })).toBeUndefined();
    expect(screenPath(" /Settings / Dark mode/ ")).toBe("Settings/Dark%20mode");
  });
});
