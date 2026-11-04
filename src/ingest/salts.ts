/**
 * Daily random salts for cookieless visitor ids (plan §11). One random 256-bit salt per UTC day in
 * `cookieless_salts`. The `ingest.rotate-salts` job creates the new day's salt at 00:00 UTC and
 * deletes every salt older than yesterday's (so a salt lives at most 48 hours). Yesterday's salt
 * is kept so sessions running across midnight UTC are not split.
 *
 * Ingest reads the salts once per isolate per day (cached). If the job has not run yet (fresh
 * install, missed tick) the first event of the day creates the salt with `INSERT OR IGNORE`,
 * which is race-safe: every isolate then reads back the same row.
 */
import type { JobDefinition } from "../jobs/registry";
import { randomBytes } from "../lib/crypto";
import { toHex } from "../lib/encoding";

const DAY_MS = 86_400_000;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface Salts {
  today: string;
  yesterday: string | null;
}

const cache = new Map<string, Salts>();

export function clearSaltCache(): void {
  cache.clear();
}

const newSalt = () => toHex(randomBytes(32));

export async function getSalts(db: D1Database, now: number): Promise<Salts> {
  const day = utcDay(now);
  const hit = cache.get(day);
  if (hit) return hit;
  const prev = utcDay(now - DAY_MS);
  const select = db
    .prepare("SELECT day, salt FROM cookieless_salts WHERE day IN (?, ?)")
    .bind(day, prev);
  let rows = (await select.all<{ day: string; salt: string }>()).results ?? [];
  if (!rows.some((r) => r.day === day)) {
    const [, reread] = await db.batch<{ day: string; salt: string }>([
      db
        .prepare("INSERT OR IGNORE INTO cookieless_salts (day, salt, created_at) VALUES (?, ?, ?)")
        .bind(day, newSalt(), now),
      select,
    ]);
    rows = reread?.results ?? [];
  }
  const today = rows.find((r) => r.day === day)?.salt;
  if (!today) throw new Error("cookieless salt unavailable");
  const salts = { today, yesterday: rows.find((r) => r.day === prev)?.salt ?? null };
  cache.clear(); // only the current day is ever needed
  cache.set(day, salts);
  return salts;
}

/** Create today's salt (if missing) and delete salts older than yesterday's. */
export async function rotateSalts(db: D1Database, now: number): Promise<void> {
  const day = utcDay(now);
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO cookieless_salts (day, salt, created_at) VALUES (?, ?, ?)")
      .bind(day, newSalt(), now),
    db.prepare("DELETE FROM cookieless_salts WHERE day < ?").bind(utcDay(now - DAY_MS)),
  ]);
  cache.clear();
}

export const rotateSaltsJob: JobDefinition = {
  name: "ingest.rotate-salts",
  schedule: { every: "day", at: "00:00" },
  priority: 10,
  minQueries: 1,
  description: "New random cookieless salt at 00:00 UTC; salts older than 48 hours are deleted.",
  run: (ctx) => rotateSalts(ctx.db, ctx.now),
};
