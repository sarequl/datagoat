/** Small site lookups shared by the growth features. */
import { PUBLIC_URL_KEY } from "../../setup";

export async function ownerEmails(db: D1Database, siteId: string): Promise<string[]> {
  const res = await db
    .prepare(
      "SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = ? AND m.role = 'owner' ORDER BY m.created_at",
    )
    .bind(siteId)
    .all<{ email: string }>();
  return (res.results ?? []).map((r) => r.email);
}

/** Owner emails for many sites in one query. */
export async function ownerEmailsBySite(
  db: D1Database,
  siteIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (siteIds.length === 0) return out;
  const res = await db
    .prepare(
      `SELECT m.site_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.role = 'owner' AND m.site_id IN (${siteIds.map(() => "?").join(", ")})
       ORDER BY m.created_at`,
    )
    .bind(...siteIds)
    .all<{ site_id: string; email: string }>();
  for (const row of res.results ?? []) {
    const list = out.get(row.site_id) ?? [];
    list.push(row.email);
    out.set(row.site_id, list);
  }
  return out;
}

/** The install's public origin (recorded at setup), for links in emails. */
export async function publicUrl(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM instance_settings WHERE key = ?")
    .bind(PUBLIC_URL_KEY)
    .first<{ value: string }>();
  return row?.value ? row.value.replace(/\/$/, "") : null;
}

export function dashboardUrl(
  base: string | null,
  siteId: string,
  page = "overview",
): string | null {
  return base ? `${base}/app/${siteId}/${page}` : null;
}

/** True when `host` is the site's domain, one of its subdomains, or an allowed hostname. */
export function hostBelongsToSite(
  host: string,
  site: { domain: string; allowedHostnames: string[]; allHostnamesAllowed: boolean },
): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const domain = site.domain.toLowerCase();
  if (h === domain || h.endsWith(`.${domain}`)) return true;
  if (site.allHostnamesAllowed) return true;
  return site.allowedHostnames.some((a) => {
    const x = a.toLowerCase();
    return h === x || h.endsWith(`.${x}`);
  });
}
