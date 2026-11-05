/**
 * Cookie and storage names the DataGoat tracker uses. Readers also accept DataFast's names
 * (`datafast_*`, see `legacyName`), which the tracker reads too and writes with
 * `data-compat="datafast"`.
 */
export const VISITOR_COOKIE = "datagoat_visitor_id";
export const SESSION_COOKIE = "datagoat_session_id";
export const FIRST_SEEN_COOKIE = "datagoat_visitor_first_seen_at";
export const SESSION_COUNT_COOKIE = "datagoat_visitor_session_count";
export const IGNORE_KEY = "datagoat_ignore";

/** DataFast's name for one of our cookies: `datagoat_visitor_id` → `datafast_visitor_id`. */
export function legacyName(name: string): string {
  return name.replace(/^datagoat_/, "datafast_");
}

/** Parse a `Cookie` header (or `document.cookie`) into a map. Later duplicates do not override. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
