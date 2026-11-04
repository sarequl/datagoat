/**
 * Hostname policy (plan §8 step 4). An event is accepted when the host of `href` is the site
 * domain, any subdomain of it (DataFast tracks subdomains automatically), an allowed hostname
 * (cross-domain tracking) or a subdomain of one, or anything when "all hostnames" is on.
 *
 * Development hosts (localhost, 127.x, ::1, `*.local`, `*.localhost`) and `file:` pages are
 * accepted: both trackers only send from them when the page opted in with
 * `data-allow-localhost` / `data-allow-file-protocol`. App screens from the mobile SDKs use
 * `datafast://ios/<Screen>` style URLs (also `datagoat://`) and are accepted as well.
 */
import type { Site } from "../lib/sites";

export type HostKind = "site" | "dev" | "file" | "app";

export function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h === "0.0.0.0" ||
    h.endsWith(".local") ||
    h.endsWith(".localhost")
  );
}

export function normaliseHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

/** `host` equals `domain` or is a subdomain of it (both already lowercase, no `www.`). */
export function withinDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Classify the page URL against the site; null means the hostname is not allowed. */
export function checkHostname(
  site: Pick<Site, "domain" | "allowedHostnames" | "allHostnamesAllowed">,
  url: URL,
): HostKind | null {
  if (url.protocol === "file:") return "file";
  if (url.protocol === "datafast:" || url.protocol === "datagoat:") return "app";
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = normaliseHost(url.hostname);
  if (isLocalHostname(host)) return "dev";
  if (site.allHostnamesAllowed) return "site";
  const domain = normaliseHost(site.domain);
  if (withinDomain(host, domain)) return "site";
  for (const allowed of site.allowedHostnames) {
    if (withinDomain(host, normaliseHost(allowed))) return "site";
  }
  return null;
}

/** True when a referrer host belongs to this site (same domain or allowed host): internal. */
export function isInternalHost(
  site: Pick<Site, "domain" | "allowedHostnames">,
  host: string,
  pageHost: string,
): boolean {
  const h = normaliseHost(host);
  if (h === normaliseHost(pageHost)) return true;
  if (withinDomain(h, normaliseHost(site.domain))) return true;
  return site.allowedHostnames.some((a) => withinDomain(h, normaliseHost(a)));
}
