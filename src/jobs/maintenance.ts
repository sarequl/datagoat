/**
 * Foundation maintenance jobs (F0).
 *
 * - `auth.cleanup` (daily 03:17 UTC): deletes expired dashboard sessions, used/expired password
 *   resets, stale invites and expired idempotency keys.
 * - `sites.purge` (hourly at :41): removes the data of soft-deleted websites in bounded chunks.
 *   Deleting rows costs D1 writes like inserting them (row + index entries), so each run deletes
 *   at most PURGE_ROWS_PER_RUN rows (default 1000) to protect the Free plan's daily write budget.
 *   Site-scoped tables are discovered from the schema (every table with a `site_id` column), so
 *   tables added by feature teams are purged without registration.
 */
import { chunk } from "../lib/d1";
import { log } from "../lib/log";
import type { JobContext, JobDefinition } from "./registry";

const DAY = 86_400_000;
export const DEFAULT_PURGE_ROWS_PER_RUN = 1000;

export async function cleanupAuth(ctx: JobContext): Promise<void> {
  const { db, now } = ctx;
  await db.batch([
    db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now),
    db
      .prepare("DELETE FROM password_resets WHERE expires_at <= ? OR used_at IS NOT NULL")
      .bind(now - DAY),
    db
      .prepare(
        "DELETE FROM invites WHERE (accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= ?) AND created_at <= ?",
      )
      .bind(now, now - 30 * DAY),
    db.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").bind(now),
  ]);
}

interface TableInfo {
  name: string;
  /** Columns used to address a row in DELETE ... WHERE (cols) IN (SELECT cols ... LIMIT n). */
  key: string[];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Every table with a `site_id` column (except `sites` itself), with its row-address columns. */
export async function siteScopedTables(db: D1Database): Promise<TableInfo[]> {
  const master = await db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('d1_migrations', 'sites') ORDER BY name",
    )
    .all<{ name: string; sql: string }>();
  const tables = (master.results ?? []).filter((t) => IDENT.test(t.name));
  if (!tables.length) return [];
  const infos = await db.batch<{ name: string; pk: number }>(
    tables.map((t) => db.prepare(`PRAGMA table_info("${t.name}")`)),
  );
  const out: TableInfo[] = [];
  tables.forEach((t, i) => {
    const cols = infos[i]?.results ?? [];
    if (!cols.some((c) => c.name === "site_id")) return;
    const withoutRowid = /WITHOUT\s+ROWID/i.test(t.sql);
    const key = withoutRowid
      ? cols
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name)
      : ["rowid"];
    out.push({ name: t.name, key });
  });
  // Big tables first so the budget goes where the data is.
  const order = [
    "events",
    "sessions",
    "visitors",
    "payments",
    "bot_traffic",
    "daily_dimensions",
    "daily_pages",
  ];
  return out.sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  });
}

function deleteChunk(
  db: D1Database,
  table: TableInfo,
  siteId: string,
  limit: number,
): D1PreparedStatement {
  const cols = table.key.join(", ");
  const target = table.key.length === 1 ? cols : `(${cols})`;
  return db
    .prepare(
      `DELETE FROM "${table.name}" WHERE ${target} IN (SELECT ${cols} FROM "${table.name}" WHERE site_id = ?1 LIMIT ?2)`,
    )
    .bind(siteId, limit);
}

export async function purgeDeletedSites(ctx: JobContext): Promise<void> {
  const { db } = ctx;
  const site = await db
    .prepare("SELECT id FROM sites WHERE deleted_at IS NOT NULL ORDER BY deleted_at LIMIT 1")
    .first<{ id: string }>();
  if (!site) return;
  const tables = await siteScopedTables(db);
  // One batch: which tables still hold rows for this site. One row of EXISTS() columns per
  // statement (D1 limits compound SELECTs and result columns, so groups of 40 tables).
  const groups = chunk(tables, 40);
  const probes = await db.batch<Record<string, number>>(
    groups.map((group) =>
      db
        .prepare(
          `SELECT ${group.map((t, i) => `EXISTS (SELECT 1 FROM "${t.name}" WHERE site_id = ?1) AS c${i}`).join(", ")}`,
        )
        .bind(site.id),
    ),
  );
  const nonEmpty = new Set<string>();
  groups.forEach((group, g) => {
    const row = probes[g]?.results?.[0] ?? {};
    group.forEach((t, i) => {
      if (row[`c${i}`]) nonEmpty.add(t.name);
    });
  });
  let remaining =
    Number.parseInt((ctx.env as unknown as Record<string, string>).PURGE_ROWS_PER_RUN ?? "", 10) ||
    DEFAULT_PURGE_ROWS_PER_RUN;
  for (const table of tables) {
    if (!nonEmpty.has(table.name)) continue;
    if (remaining <= 0 || ctx.remainingQueries() < 3) return;
    const res = await deleteChunk(db, table, site.id, remaining).run();
    remaining -= res.meta.changes ?? 0;
  }
  if (remaining > 0 && [...nonEmpty].every((t) => t === "memberships")) {
    await db.batch([
      db.prepare("DELETE FROM memberships WHERE site_id = ?").bind(site.id),
      db.prepare("DELETE FROM sites WHERE id = ? AND deleted_at IS NOT NULL").bind(site.id),
    ]);
    log.info("site.purged", { siteId: site.id });
  }
}

export const maintenanceJobs: JobDefinition[] = [
  {
    name: "auth.cleanup",
    schedule: { every: "day", at: "03:17" },
    run: cleanupAuth,
    description: "Expire sessions, invites, resets",
  },
  {
    name: "sites.purge",
    schedule: { every: "hour", minute: 41 },
    run: purgeDeletedSites,
    minQueries: 6,
    description: "Delete data of soft-deleted websites in bounded chunks",
  },
];
