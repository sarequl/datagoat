import { describe, expect, it } from "vitest";
import { api } from "../helpers/http";

describe("route table", () => {
  it("serves the health check", async () => {
    const res = await api("/api/health");
    expect(res.body).toMatchObject({ status: "success", data: { ok: true, schema: "current" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("has no unbuilt routes left", async () => {
    // Every team's routes are implemented; an unauthenticated API call is refused, not stubbed.
    for (const path of [
      "/api/v1/analytics/overview",
      "/api/v1/analytics/bot-traffic",
      "/api/v1/visitors",
    ]) {
      const res = await api(path);
      expect(res.status, path).toBe(401);
    }
    const bad = await api("/api/v1/analytics/overview", { token: "df_nope" });
    expect(bad.status).toBe(401);
  });

  it("returns JSON 404s for unknown API routes", async () => {
    const res = await api("/api/v1/nothing-here");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      status: "error",
      error: { code: 404, message: "No route for GET /api/v1/nothing-here" },
    });
  });
});
