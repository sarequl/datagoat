/**
 * Isolate-level site cache (plan §8 step 3). Most ingest events and API calls then cost no D1
 * read for the site. Entries live `ttlMs` (60 s); unknown ids are cached for `negativeTtlMs`
 * (10 s) so a flood of events with a bogus `websiteId` does not hit D1 each time.
 *
 * The cache is per isolate: `invalidate()` clears this isolate only, so other isolates may serve
 * a settings change up to `ttlMs` late. Settings writers call `invalidate()` after updating.
 */
import { loadSiteById, loadSiteByPublicId, type Site } from "./sites";

interface Entry {
  site: Site | null;
  expires: number;
}

export class SiteCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly negativeTtlMs = 10_000,
    private readonly maxEntries = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  private get(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private put(key: string, site: Site | null): void {
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest insertion (Map preserves insertion order).
      const first = this.entries.keys().next();
      if (!first.done) this.entries.delete(first.value);
    }
    this.entries.set(key, { site, expires: this.now() + (site ? this.ttlMs : this.negativeTtlMs) });
  }

  private store(site: Site | null, ...keys: string[]): void {
    for (const key of keys) this.put(key, site);
    if (site) {
      this.put(`id:${site.id}`, site);
      this.put(`pub:${site.publicId}`, site);
    }
  }

  /** Lookup by public tracking id (`data-website-id`). */
  async byPublicId(db: D1Database, publicId: string): Promise<Site | null> {
    const key = `pub:${publicId}`;
    const hit = this.get(key);
    if (hit) return hit.site;
    const site = await loadSiteByPublicId(db, publicId);
    this.store(site, key);
    return site;
  }

  /** Lookup by internal id (`websiteId` in the API). */
  async byId(db: D1Database, id: string): Promise<Site | null> {
    const key = `id:${id}`;
    const hit = this.get(key);
    if (hit) return hit.site;
    const site = await loadSiteById(db, id);
    this.store(site, key);
    return site;
  }

  /** Forget a site in this isolate (call after updating or deleting it). */
  invalidate(site: Pick<Site, "id" | "publicId"> | string): void {
    if (typeof site === "string") {
      const entry = this.entries.get(`id:${site}`);
      this.entries.delete(`id:${site}`);
      if (entry?.site) this.entries.delete(`pub:${entry.site.publicId}`);
      return;
    }
    this.entries.delete(`id:${site.id}`);
    this.entries.delete(`pub:${site.publicId}`);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The process-wide instance used by handlers. Tests call `siteCache.clear()` between cases. */
export const siteCache = new SiteCache();
