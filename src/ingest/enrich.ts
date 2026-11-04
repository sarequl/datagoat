/**
 * Enrichment (plan §8 step 9): page URL → hostname, path, UTM, `ref`/`source`/`via`, click ids;
 * referrer → domain (internal referrers dropped); channel and source; geo; device/browser/OS.
 * Session dimensions come from the session's first event and are never overwritten.
 */
import type { Site } from "../lib/sites";
import { AD_CLICK_ID_KEYS, type TrackerBody } from "./body";
import { type Channel, classifyChannel } from "./channels";
import type { Geo } from "./geo";
import { isInternalHost, normaliseHost } from "./hostnames";
import { parseUserAgent, type UaInfo } from "./ua";

const MAX_PARAM = 255;

export interface PageInfo {
  hostname: string;
  /** Pathname, plus `#hash` for the hash build. Query strings are never stored in paths. */
  path: string;
}

export interface SessionDims {
  referrer: string | null;
  referrerDomain: string | null;
  channel: Channel;
  source: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  ref: string | null;
  sourceParam: string | null;
  via: string | null;
  adClickIds: Record<string, string>;
  ua: UaInfo;
  geo: Geo;
}

export function pageInfo(url: URL, trackHash: boolean): PageInfo {
  let path = url.pathname || "/";
  try {
    path = decodeURI(path);
  } catch {
    // keep the encoded form
  }
  if (trackHash && url.hash && url.hash !== "#") path += url.hash;
  const hostname =
    url.protocol === "file:" ? "file" : url.hostname.toLowerCase().replace(/\.$/, "");
  return { hostname, path: path.slice(0, 1024) };
}

function param(url: URL, name: string): string | null {
  const v = url.searchParams.get(name);
  if (v === null) return null;
  const t = v.trim();
  return t ? t.slice(0, MAX_PARAM) : null;
}

export function enrichSession(
  site: Pick<Site, "domain" | "allowedHostnames">,
  body: TrackerBody,
  url: URL,
  ua: string,
  geo: Geo,
): SessionDims {
  let referrer: string | null = null;
  let referrerDomain: string | null = null;
  if (body.referrer) {
    try {
      const r = new URL(body.referrer);
      if (
        (r.protocol === "http:" || r.protocol === "https:" || r.protocol === "android-app:") &&
        !isInternalHost(site, r.hostname, url.hostname)
      ) {
        referrer = r.href.slice(0, 1024);
        referrerDomain = normaliseHost(r.hostname) || null;
      }
    } catch {
      // not a URL: ignore
    }
  }

  const adClickIds: Record<string, string> = { ...body.adClickIds };
  for (const key of AD_CLICK_ID_KEYS) {
    const v = param(url, key);
    if (v && !adClickIds[key]) adClickIds[key] = v;
  }

  const utmSource = param(url, "utm_source");
  const utmMedium = param(url, "utm_medium");
  const ref = param(url, "ref");
  const sourceParam = param(url, "source");
  const via = param(url, "via");
  const { channel, source } = classifyChannel({
    referrerDomain,
    utmSource,
    utmMedium,
    ref,
    sourceParam,
    via,
    clickIds: adClickIds,
  });

  return {
    referrer,
    referrerDomain,
    channel,
    source,
    utmSource,
    utmMedium,
    utmCampaign: param(url, "utm_campaign"),
    utmTerm: param(url, "utm_term"),
    utmContent: param(url, "utm_content"),
    ref,
    sourceParam,
    via,
    adClickIds,
    ua: parseUserAgent(ua),
    geo,
  };
}
