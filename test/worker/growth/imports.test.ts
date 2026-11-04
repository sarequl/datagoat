import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  parseCsv,
  parseCsvFiles,
  parsePlausibleZip,
  tableOf,
} from "../../../src/growth/imports/plausible";
import {
  importCutoff,
  importedBreakdown,
  importedDailyTotals,
} from "../../../src/growth/imports/read";
import { readZip } from "../../../src/growth/imports/zip";
import { meterEnv, resetDb } from "../../helpers/db";
import { createSession, createSite, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { apiWith } from "./helpers";
import { buildZip, PLAUSIBLE_FILES } from "./zip-fixture";

beforeEach(() => resetDb());

describe("ZIP and CSV parsing (Web APIs only)", () => {
  it("reads stored and deflated entries", async () => {
    const zip = await buildZip([
      { name: "a.txt", text: "hello" },
      { name: "dir/b.txt", text: "x".repeat(1000), deflate: true },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ["a.txt", 0, 5],
      ["dir/b.txt", 8, 1000],
    ]);
    expect(new TextDecoder().decode(await entries[1]?.read())).toBe("x".repeat(1000));
    expect(() => readZip(new Uint8Array(100))).toThrow("Not a ZIP file");
  });

  it("parses RFC 4180 CSV", () => {
    expect(parseCsv('a,b\r\n1,"x, ""y"""\n\n2,\n')).toEqual([
      ["a", "b"],
      ["1", 'x, "y"'],
      ["2", ""],
    ]);
    expect(tableOf("export/imported_entry_pages_20240101_20240131.csv")).toBe("entry_pages");
    expect(tableOf("readme.txt")).toBeNull();
  });

  it("maps a Plausible export to imported daily rows", async () => {
    const parsed = await parsePlausibleZip(
      await buildZip(PLAUSIBLE_FILES.map((f) => ({ ...f, deflate: true }))),
    );
    expect(parsed.rangeStart).toBe("2024-01-01");
    expect(parsed.rangeEnd).toBe("2024-01-02");
    expect(parsed.skipped).toEqual(["imported_custom_events_20240101_20240102.csv"]);
    const find = (dimension: string, value: string, day = "2024-01-01") =>
      parsed.rows.find((r) => r.day === day && r.dimension === dimension && r.value === value);
    expect(find("", "")).toEqual({
      day: "2024-01-01",
      dimension: "",
      value: "",
      visitors: 10,
      visits: 12,
      pageviews: 25,
      bounces: 4,
      durationSum: 600_000,
    });
    expect(find("referrer", "Google")?.visitors).toBe(6);
    expect(find("referrer", "Direct / None")?.visitors).toBe(4);
    expect(find("utm_campaign", "Launch, v2")?.visits).toBe(5);
    expect(find("page", "/pricing")?.pageviews).toBe(5);
    expect(find("entry_page", "/")?.visits).toBe(10);
    expect(find("country", "US")?.visitors).toBe(8);
    expect(find("region", "US-CA")?.visitors).toBe(6);
    expect(find("device", "desktop")?.visitors).toBe(7);
    expect(find("browser", "Chrome")?.visitors).toBe(6);
    expect(find("os", "Mac")?.visitors).toBe(6);
    expect(() => parseCsvFiles([{ name: "imported_pages.csv", text: "date,page\n" }])).toThrow(
      "imported_visitors",
    );
  });
});

describe("imports API", () => {
  async function setup() {
    const owner = await createUser();
    const site = await createSite(owner.id);
    return {
      site,
      cookie: await sessionCookie(owner.id),
      base: `/api/v1/admin/websites/${site.id}/imports`,
    };
  }

  it("creates a job, accepts rows in chunks and completes it", async () => {
    const { site, cookie, base } = await setup();
    const created = await api(base, {
      cookie,
      body: { source: "plausible", fileName: "export.zip" },
    });
    const job = created.body.data[0];
    expect(job).toMatchObject({
      websiteId: site.id,
      source: "plausible",
      status: "pending",
      fileName: "export.zip",
      rowsImported: 0,
    });
    const rows = Array.from({ length: 25 }, (_, i) => ({
      day: `2024-01-${String(i + 1).padStart(2, "0")}`,
      dimension: "",
      value: "",
      visitors: 10,
      visits: 12,
      pageviews: 30,
      bounces: 3,
      durationSum: 60_000,
    }));
    const m = meterEnv();
    const posted = await apiWith({ DB: m.db }, `${base}/${job.id}/rows`, {
      cookie,
      body: { rows },
    });
    expect(posted.body.data).toEqual([{ accepted: 25 }]);
    // One written row per imported row (+1 for the job row update), in a single D1 batch.
    expect(m.d1.rowsWritten).toBe(25 + 1);
    expect(m.d1.queries).toBeLessThanOrEqual(4);
    const bad = await api(`${base}/${job.id}/rows`, {
      cookie,
      body: { rows: [{ ...rows[0], dimension: "nope" }] },
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await api(`${base}/${job.id}/rows`, {
          cookie,
          body: { rows: [{ ...rows[0], value: "x" }] },
        })
      ).status,
    ).toBe(400);
    const done = await api(`${base}/${job.id}/complete`, { cookie, method: "POST" });
    expect(done.body.data[0]).toMatchObject({
      status: "completed",
      rowsImported: 25,
      rowsTotal: 25,
      rangeStart: "2024-01-01",
      rangeEnd: "2024-01-25",
    });
    expect((await api(`${base}/${job.id}/rows`, { cookie, body: { rows } })).status).toBe(409);
    expect((await api(base, { cookie })).body.data).toHaveLength(1);
  });

  it("imports the ZIP on the server and feeds the read helpers until native data starts", async () => {
    const { site, cookie, base } = await setup();
    const job = (await api(base, { cookie, body: { fileName: "plausible.zip" } })).body.data[0];
    const zip = await buildZip(PLAUSIBLE_FILES.map((f) => ({ ...f, deflate: true })));
    const res = await apiWith({}, `${base}/${job.id}/file`, {
      cookie,
      body: zip,
      headers: { "content-type": "application/zip" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      status: "completed",
      rangeStart: "2024-01-01",
      rangeEnd: "2024-01-02",
    });
    expect(res.body.tables).toContain("visitors");

    const totals = await importedDailyTotals(env.DB, site.id, "2024-01-01", "2024-12-31", null);
    expect(totals).toEqual([
      {
        day: "2024-01-01",
        visitors: 10,
        visits: 12,
        pageviews: 25,
        bounces: 4,
        durationSum: 600_000,
      },
      {
        day: "2024-01-02",
        visitors: 8,
        visits: 9,
        pageviews: 16,
        bounces: 2,
        durationSum: 300_000,
      },
    ]);
    expect(
      (await importedBreakdown(env.DB, site.id, "referrer", "2024-01-01", "2024-01-31", null)).map(
        (r) => r.value,
      ),
    ).toEqual(["Google", "Direct / None"]);
    await createSession({ siteId: site.id, startedAt: Date.UTC(2024, 0, 2, 5) });
    const cutoff = await importCutoff(env.DB, site.id, "UTC");
    expect(cutoff).toBe("2024-01-02");
    expect(
      (await importedDailyTotals(env.DB, site.id, "2024-01-01", "2024-12-31", cutoff)).map(
        (r) => r.day,
      ),
    ).toEqual(["2024-01-01"]);

    // Cancelling removes the rows.
    const cancelled = await api(`${base}/${job.id}`, { cookie, method: "DELETE" });
    expect(cancelled.body.data[0]).toMatchObject({ status: "cancelled", rowsImported: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM imported_daily").first("n")).toBe(0);
  });

  it("rejects files that are not Plausible exports and marks the job failed", async () => {
    const { cookie, base } = await setup();
    const job = (await api(base, { cookie, body: {} })).body.data[0];
    const res = await api(`${base}/${job.id}/file`, {
      cookie,
      body: "not a zip",
      headers: { "content-type": "application/zip" },
    });
    expect(res.status).toBe(400);
    expect((await api(`${base}/${job.id}`, { cookie })).body.data[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Not a ZIP"),
    });
  });
});
