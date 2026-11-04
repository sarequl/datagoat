/** The `excludedUserAgents` website setting (migration 0100) round-trips and applies at ingest. */
import { beforeEach, describe, expect, it } from "vitest";
import { createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { eventBody, postEvent, resetIngest, rows } from "./helpers";

describe("excludedUserAgents setting", () => {
  beforeEach(resetIngest);

  it("is saved through the website settings API and drops matching hits", async () => {
    const user = await createUser();
    const site = await createSite(user.id, { domain: "example.com" });
    const cookie = await sessionCookie(user.id);

    const initial = await api(`/api/v1/admin/websites/${site.id}`, { cookie });
    expect(initial.body.data[0].excludedUserAgents).toEqual([]);

    const put = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      cookie,
      body: { excludedUserAgents: ["InternalQA", "InternalQA", "UptimeBot"] },
    });
    expect(put.status).toBe(200);
    expect(put.body.data[0].excludedUserAgents).toEqual(["InternalQA", "UptimeBot"]);

    const bad = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      cookie,
      body: { excludedUserAgents: ["ab"] },
    });
    expect(bad.status).toBe(400); // at least 3 characters
    const tooMany = await api(`/api/v1/admin/websites/${site.id}`, {
      method: "PUT",
      cookie,
      body: { excludedUserAgents: Array.from({ length: 51 }, (_, i) => `agent-${i}`) },
    });
    expect(tooMany.status).toBe(400); // at most 50

    await postEvent(eventBody({ websiteId: site.publicId }), {
      ua: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 internalqa/2",
    });
    expect(await rows("SELECT id FROM events WHERE site_id = ?", site.id)).toEqual([]);
    await postEvent(eventBody({ websiteId: site.publicId }));
    expect(await rows("SELECT id FROM events WHERE site_id = ?", site.id)).toHaveLength(1);
  });
});
