/**
 * Request bodies DataFast's real script.js produced in a sealed capture run (primary-sources
 * report, "Captured requests", run B, 4 November 2026). Copied verbatim except where noted; the
 * ingest tests replay them so DataFast's unmodified script stays compatible with our collector.
 * The capture used `websiteId: "dfid_test"` on `http://localhost:8787`.
 */

/** Request headers of the first captured POST (DataFast sends JSON over XHR). */
export const CAPTURED_HEADERS = {
  accept: "*/*",
  "content-type": "application/json",
  origin: "http://localhost:8787",
  referer: "http://localhost:8787/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  // The capture ran headless Chromium, whose Client Hints brand is "HeadlessChrome"; a real
  // Chrome sends this instead (the tests replay the bodies as a real browser would send them).
  "sec-ch-ua": '"Not:A-Brand";v="8", "Chromium";v="130", "Google Chrome";v="130"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "accept-language": "en-US,en;q=0.9",
};

const common = {
  websiteId: "dfid_test",
  domain: "localhost",
  href: "http://localhost:8787/?utm_source=capture_test",
  referrer: null,
  viewport: { width: 1280, height: 720 },
  visitorId: "72de85b4-8d8a-48d6-a920-c50470a86a1a",
  sessionId: "s3457d400-1b6c-4565-b487-f1cf45306cc1",
  visitorFirstSeenAt: "2026-11-04T17:26:33.885Z",
  visitorSessionNumber: 1,
  language: "en-US",
  timezone: "Asia/Dhaka",
  screenWidth: 1280,
  screenHeight: 720,
};

export const CAPTURED_PAGEVIEW = { ...common, type: "pageview" };

/** `window.datafast("test_goal", {plan: "pro"})` */
export const CAPTURED_GOAL = {
  ...common,
  type: "custom",
  extraData: { eventName: "test_goal", plan: "pro" },
};

/** `window.datafast("identify", {user_id: "u1"})` */
export const CAPTURED_IDENTIFY = {
  ...common,
  type: "identify",
  extraData: { user_id: "u1", name: "", image: "" },
};

/** The pageview from `history.pushState` to `/spa-route`: differs only in `href`. */
export const CAPTURED_SPA_PAGEVIEW = {
  ...common,
  href: "http://localhost:8787/spa-route",
  type: "pageview",
};

/**
 * Shapes DataFast's script builds but the capture did not exercise (script analysis, "Other
 * `type` and `extraData` shapes in the code"), on top of the captured common fields.
 */
export const DATAFAST_SHAPES = {
  stripe: { ...common, type: "payment", extraData: { stripe_session_id: "cs_test_a1b2c3d4e5f6" } },
  lemonsqueezy: { ...common, type: "payment", extraData: { lemonsqueezy_order_id: "1234567" } },
  polar: {
    ...common,
    type: "payment",
    extraData: { polar_checkout_id: "9f5e3c5e-1d1e-4a35-8f0b-1c2d3e4f5a6b" },
  },
  email: { ...common, type: "payment", extraData: { email: "buyer@example.com" } },
  externalLink: {
    ...common,
    type: "external_link",
    extraData: { url: "https://github.com/sarequl/datagoat", text: "GitHub" },
  },
  scroll: {
    ...common,
    type: "custom",
    extraData: { eventName: "viewed_pricing", scroll_percentage: 62, threshold: 0.5, delay: 0 },
  },
  cookieless: (() => {
    const { visitorFirstSeenAt: _a, visitorSessionNumber: _b, ...rest } = common;
    return {
      ...rest,
      visitorId: "0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4b",
      cookieless: true,
      type: "pageview",
    };
  })(),
  hash: { ...common, href: "http://localhost:8787/#/pricing", trackHash: true, type: "pageview" },
};
