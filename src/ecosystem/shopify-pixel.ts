/**
 * Shopify custom pixel (Settings → Customer events → Add custom pixel). Optional: the storefront
 * loader installed on connect already tracks pageviews and the two funnel goals. The pixel is for
 * stores whose cart or checkout buttons the loader cannot see (app-driven carts, Shop Pay buttons):
 * it subscribes to Shopify's standard events and sends `add_to_cart` and `initiate_checkout` goals
 * to /api/events, using the visitor and session cookies the DataGoat tracker set on the storefront.
 * It never creates visitors itself, so it cannot double count. Load the storefront loader with
 * `&goals=0` when you use the pixel, so the goals are not sent twice.
 *
 * The pixel runs in Shopify's sandbox: it reads cookies with `browser.cookie.get()` and posts with
 * `fetch(..., {keepalive: true})` as `text/plain`, which needs no CORS preflight.
 */

export interface PixelOptions {
  origin: string;
  trackingId: string;
  domain: string;
}

export function shopifyPixelCode(options: PixelOptions): string {
  const config = JSON.stringify({
    api: `${options.origin}/api/events`,
    websiteId: options.trackingId,
    domain: options.domain,
  });
  return `// DataGoat custom pixel for Shopify. Paste into Settings > Customer events > Add custom pixel.
const DATAGOAT = ${config};

// Our cookie first, then DataFast's (stores that switched keep their visitors).
async function cookie(key) {
  return (await browser.cookie.get("datagoat_" + key)) || (await browser.cookie.get("datafast_" + key));
}

async function datagoatSend(name, params, event) {
  const [visitorId, sessionId, firstSeen, sessionCount] = await Promise.all([
    cookie("visitor_id"),
    cookie("session_id"),
    cookie("visitor_first_seen_at"),
    cookie("visitor_session_count"),
  ]);
  if (!visitorId || !sessionId) return;
  const ctx = (event && event.context) || {};
  const doc = ctx.document || {};
  const win = ctx.window || {};
  const nav = ctx.navigator || {};
  const screen = win.screen || {};
  const extraData = { eventName: name };
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value !== undefined && value !== null && value !== "") extraData[key] = String(value).slice(0, 255);
  }
  const body = {
    websiteId: DATAGOAT.websiteId,
    domain: DATAGOAT.domain,
    href: (doc.location && doc.location.href) || "",
    referrer: doc.referrer || null,
    viewport: { width: win.innerWidth || 0, height: win.innerHeight || 0 },
    visitorId: visitorId,
    sessionId: sessionId,
    language: nav.language || "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screenWidth: screen.width || 0,
    screenHeight: screen.height || 0,
    type: "custom",
    extraData: extraData,
  };
  if (firstSeen) body.visitorFirstSeenAt = firstSeen;
  if (sessionCount && /^\\d+$/.test(sessionCount)) body.visitorSessionNumber = Number(sessionCount);
  try {
    await fetch(DATAGOAT.api, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch (e) {}
}

analytics.subscribe("product_added_to_cart", (event) => {
  const line = (event.data && event.data.cartLine) || {};
  const merch = line.merchandise || {};
  datagoatSend("add_to_cart", {
    product_id: merch.product && merch.product.id,
    variant_id: merch.id,
    quantity: line.quantity,
  }, event);
});

analytics.subscribe("checkout_started", (event) => {
  const checkout = (event.data && event.data.checkout) || {};
  const total = checkout.totalPrice || {};
  datagoatSend("initiate_checkout", { value: total.amount, currency: total.currencyCode || checkout.currencyCode }, event);
});
`;
}
