import { describe, expect, it } from "vitest";
import { api } from "../helpers/http";

describe("route table", () => {
  it("serves the health check", async () => {
    const res = await api("/api/health");
    expect(res.body).toMatchObject({ status: "success", data: { ok: true, schema: "current" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it.each([
    ["GET", "/api/v1/visitors/abc", "W2"],
    ["POST", "/api/ai-crawls", "W6"],
    ["POST", "/webhooks/github/site1", "W6"],
    ["GET", "/share/abc", "W2"],
  ])("%s %s answers 501 naming %s", async (method, path, owner) => {
    const res = await api(path, { method, origin: null });
    expect(res.status).toBe(501);
    expect(res.body.status).toBe("error");
    expect(res.body.error.code).toBe(501);
    expect(res.body.error.message).toContain(`owner: ${owner}`);
  });

  it("requires authentication before reaching unbuilt /api/v1 routes", async () => {
    const res = await api("/api/v1/analytics/overview");
    // Unauthenticated callers still hit the stub: auth is the handler's job (requireSiteAccess).
    expect(res.status).toBe(501);
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
