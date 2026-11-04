import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { siteCache } from "../../../src/lib/site-cache";
import { CLOSED_RANGE_TTL, cacheTtl, OPEN_RANGE_TTL } from "../../../src/query/cache";
import { resetDb } from "../../helpers/db";
import { createSession } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { RANGE, seedFixture, T } from "../analytics/fixture";
import { qcFor } from "./helpers";

beforeEach(() => resetDb());

describe("analytics response cache", () => {
  it("serves repeated closed-range queries from the Cache API", async () => {
    const f = await seedFixture();
    const url = `/api/v1/analytics/overview?${RANGE}&fields=sessions`;
    const first = await api(url, { token: f.key });
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(first.headers.get("cache-control")).toBe("no-store");
    await createSession({ siteId: f.site.id, startedAt: T("2026-03-10T15:00:00Z") });
    const second = await api(url, { token: f.key });
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(second.body.data[0].sessions).toBe(4);
    // Query parameter order and websiteId do not change the key.
    const reordered = await api(
      `/api/v1/analytics/overview?fields=sessions&endAt=2026-03-11&startAt=2026-03-10&websiteId=${f.site.id}`,
      { token: f.key },
    );
    expect(reordered.headers.get("x-cache")).toBe("HIT");
    const fresh = await api(url, { token: f.key, headers: { "cache-control": "no-cache" } });
    expect(fresh.headers.get("x-cache")).toBe("MISS");
    expect(fresh.body.data[0].sessions).toBe(5);
  });

  it("a settings change starts a fresh cache; errors are not cached", async () => {
    const f = await seedFixture();
    const url = `/api/v1/analytics/overview?${RANGE}&fields=revenue`;
    expect((await api(url, { token: f.key })).body.data[0].revenue).toBe(59.99);
    await env.DB.prepare(
      "UPDATE sites SET include_renewal_revenue = 0, updated_at = ? WHERE id = ?",
    )
      .bind(Date.now() + 1, f.site.id)
      .run();
    siteCache.clear();
    const after = await api(url, { token: f.key });
    expect(after.headers.get("x-cache")).toBe("MISS");
    expect(after.body.data[0].revenue).toBe(49.99);
    const bad = await api(`/api/v1/analytics/pages?${RANGE}&fields=nope`, { token: f.key });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("x-cache")).toBeNull();
  });

  it("keeps public share responses apart from member responses", async () => {
    const f = await seedFixture();
    const share = await api(`/api/v1/admin/websites/${f.site.id}/share`, {
      token: f.key,
      body: {},
    });
    const token = share.body.data.token as string;
    siteCache.clear();
    const member = await api(`/api/v1/analytics/overview?${RANGE}`, { token: f.key });
    expect(member.body.data[0]).toHaveProperty("revenue");
    const pub = await api(`/api/share/${token}/analytics/overview?${RANGE}`);
    expect(pub.headers.get("x-cache")).toBe("MISS");
    expect(pub.body.data[0]).not.toHaveProperty("revenue");
  });

  it("caches closed ranges for a day and open ranges for a minute", async () => {
    const f = await seedFixture();
    const now = T("2026-03-12T10:00:00Z");
    expect(cacheTtl(qcFor(f.site, { startAt: "2026-03-10", endAt: "2026-03-11" }, { now }))).toBe(
      CLOSED_RANGE_TTL,
    );
    expect(cacheTtl(qcFor(f.site, { startAt: "2026-03-10", endAt: "2026-03-12" }, { now }))).toBe(
      OPEN_RANGE_TTL,
    );
    expect(cacheTtl(qcFor(f.site, null, { now }))).toBe(OPEN_RANGE_TTL);
  });
});
