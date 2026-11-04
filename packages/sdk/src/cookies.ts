/** Cookie and storage names the DataGoat tracker uses (DataFast's names, plan §3.2). */
export const VISITOR_COOKIE = "datafast_visitor_id";
export const SESSION_COOKIE = "datafast_session_id";
export const FIRST_SEEN_COOKIE = "datafast_visitor_first_seen_at";
export const SESSION_COUNT_COOKIE = "datafast_visitor_session_count";
export const IGNORE_KEY = "datafast_ignore";

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
