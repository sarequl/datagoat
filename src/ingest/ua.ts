/**
 * User-Agent → device, browser and OS (plan §8 step 9) with ua-parser-js 1.x (MIT; 2.x is AGPL
 * and must not be used). Device is DataFast's three buckets: desktop, mobile, tablet.
 * Results are memoised per isolate because a site's traffic repeats a small set of UAs.
 */
import UAParser from "ua-parser-js";

export interface UaInfo {
  device: "desktop" | "mobile" | "tablet";
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  deviceVendor: string | null;
  deviceModel: string | null;
}

const cache = new Map<string, UaInfo>();
const MAX_CACHE = 500;

export function parseUserAgent(ua: string): UaInfo {
  const hit = cache.get(ua);
  if (hit) return hit;
  const r = UAParser(ua);
  const type = r.device.type;
  let device: UaInfo["device"] = "desktop";
  if (type === "mobile" || type === "wearable") device = "mobile";
  else if (type === "tablet") device = "tablet";
  const info: UaInfo = {
    device,
    browser: r.browser.name ?? null,
    browserVersion: r.browser.major ?? r.browser.version ?? null,
    // Names exactly as ua-parser-js reports them ("Mac OS", "Windows", "iOS").
    os: r.os.name ?? null,
    osVersion: r.os.version ?? null,
    deviceVendor: r.device.vendor ?? null,
    deviceModel: r.device.model ?? null,
  };
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(ua, info);
  return info;
}
