/**
 * Unit tests: redirect URI rules, client ID metadata documents (mocked fetch), period presets,
 * idempotency helpers, the cleanup job and the write cost of MCP calls.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/app";
import { runScheduled } from "../../../src/jobs/scheduler";
import { canonicalJson, redactSecrets, requestHash } from "../../../src/mcp/idempotency";
import { cleanupStatements, mcpCleanupJob } from "../../../src/mcp/jobs";
import {
  fetchClientMetadata,
  findClient,
  isMetadataUrl,
  redirectUriMatches,
  redirectUriProblem,
} from "../../../src/mcp/oauth/clients";
import { resolvePeriod } from "../../../src/mcp/periods";
import { meterEnv, resetDb } from "../../helpers/db";
import { createApiKey, createSite, createUser } from "../../helpers/factories";
import { ORIGIN } from "../../helpers/http";
import { connect, request } from "./helpers";

beforeEach(() => resetDb());

describe("redirect URIs", () => {
  it.each([
    ["https://claude.ai/api/mcp/auth_callback", null],
    ["http://127.0.0.1:4000/cb", null],
    ["http://localhost/cb", null],
    ["http://[::1]:9/cb", null],
    ["cursor://anysphere.cursor-mcp/oauth/callback", null],
    ["http://example.com/cb", "loopback"],
    ["javascript:alert(1)", "not allowed"],
    ["data:text/html,x", "not allowed"],
    ["https://x.example/cb#f", "fragment"],
    ["not a url", "not a valid URL"],
  ])("%s", (uri, problem) => {
    const result = redirectUriProblem(uri);
    if (problem === null) expect(result).toBeNull();
    else expect(result).toContain(problem);
  });

  it("matches exactly, except the port of loopback redirects", () => {
    const reg = ["https://a.example/cb", "http://127.0.0.1:8000/cb?x=1"];
    expect(redirectUriMatches(reg, "https://a.example/cb")).toBe(true);
    expect(redirectUriMatches(reg, "https://a.example/cb/")).toBe(false);
    expect(redirectUriMatches(reg, "https://a.example:444/cb")).toBe(false);
    expect(redirectUriMatches(reg, "http://127.0.0.1:9999/cb?x=1")).toBe(true);
    expect(redirectUriMatches(reg, "http://127.0.0.1:9999/cb?x=2")).toBe(false);
    expect(redirectUriMatches(reg, "http://localhost:8000/cb?x=1")).toBe(false);
  });
});

describe("client ID metadata documents", () => {
  const URL_ID = "https://agent.example/oauth/client.json";
  const doc = {
    client_id: URL_ID,
    client_name: "Agent",
    redirect_uris: ["https://agent.example/cb"],
    token_endpoint_auth_method: "none",
  };
  const fetcher =
    (body: unknown, init: ResponseInit = {}) =>
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      });

  it("recognises metadata URLs", () => {
    expect(isMetadataUrl(URL_ID)).toBe(true);
    expect(isMetadataUrl("https://agent.example/")).toBe(false);
    expect(isMetadataUrl("http://agent.example/c.json")).toBe(false);
    expect(isMetadataUrl("dgc_abc")).toBe(false);
  });

  it("fetches, validates and caches a document", async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return fetcher(doc)();
    };
    const now = Date.now();
    const client = await findClient(env.DB, URL_ID, now, counting as typeof fetch);
    expect(client).toMatchObject({
      id: URL_ID,
      name: "Agent",
      authMethod: "none",
      metadataUrl: URL_ID,
    });
    await findClient(env.DB, URL_ID, now + 1000, counting as typeof fetch);
    expect(calls).toBe(1);
    await findClient(env.DB, URL_ID, now + 25 * 3_600_000, counting as typeof fetch);
    expect(calls).toBe(2);
  });

  it.each([
    [
      "a mismatched client_id",
      fetcher({ ...doc, client_id: "https://other.example/c.json" }),
      "does not match",
    ],
    ["a redirect", fetcher("", { status: 302, headers: { location: "https://x" } }), "302"],
    ["non-JSON", fetcher("<html>"), "not JSON"],
    ["a huge body", fetcher({ ...doc, pad: "x".repeat(20_000) }), "too large"],
    [
      "a confidential method",
      fetcher({ ...doc, token_endpoint_auth_method: "client_secret_basic" }),
      "none",
    ],
    ["a network error", async () => Promise.reject(new Error("boom")), "Could not fetch"],
  ])("rejects %s", async (_label, f, message) => {
    await expect(fetchClientMetadata(URL_ID, f as typeof fetch)).rejects.toThrow(message);
  });

  it("refuses private hosts without fetching", async () => {
    let fetched = false;
    const f = async () => {
      fetched = true;
      return new Response("{}");
    };
    for (const id of [
      "https://localhost/c.json",
      "https://10.0.0.1/c.json",
      "https://router.local/c.json",
      "https://intranet/c.json",
    ]) {
      await expect(fetchClientMetadata(id, f as typeof fetch)).rejects.toThrow("public host");
    }
    expect(fetched).toBe(false);
  });
});

describe("period presets", () => {
  const now = Date.parse("2026-11-04T02:00:00Z"); // Nov 3 in New York, Nov 4 in Paris
  it.each([
    ["today", "America/New_York", "2026-11-03", "2026-11-03"],
    ["today", "Europe/Paris", "2026-11-04", "2026-11-04"],
    ["yesterday", "UTC", "2026-11-03", "2026-11-03"],
    ["last7d", "UTC", "2026-10-29", "2026-11-04"],
    ["last30d", "UTC", "2026-10-06", "2026-11-04"],
    ["last90d", "UTC", "2026-08-07", "2026-11-04"],
    ["last12m", "UTC", "2025-11-05", "2026-11-04"],
    ["week", "UTC", "2026-11-02", "2026-11-04"],
    ["month", "UTC", "2026-11-01", "2026-11-04"],
    ["year", "UTC", "2026-01-01", "2026-11-04"],
  ])("%s in %s", (period, tz, startAt, endAt) => {
    expect(resolvePeriod(period, tz, now)).toEqual({ startAt, endAt });
  });

  it("last24h uses instants; all has no bounds; unknown throws", () => {
    expect(resolvePeriod("last24h", "UTC", now)).toEqual({
      startAt: "2026-11-03T02:00:00.000Z",
      endAt: "2026-11-04T02:00:00.000Z",
    });
    expect(resolvePeriod("all", "UTC", now)).toEqual({});
    expect(() => resolvePeriod("fortnight", "UTC", now)).toThrow("Unknown period");
  });
});

describe("idempotency helpers", () => {
  it("hashes arguments canonically, ignoring confirm and the key", async () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }], u: undefined })).toBe(
      '{"a":[{"c":3,"d":2}],"b":1}',
    );
    const a = await requestHash("t", { x: 1, y: 2, confirm: true, idempotencyKey: "k1" });
    const b = await requestHash("t", { y: 2, x: 1, idempotencyKey: "k2" });
    expect(a).toBe(b);
    expect(await requestHash("other", { x: 1, y: 2 })).not.toBe(a);
  });

  it("redacts issued secrets", () => {
    const out = redactSecrets({
      data: [{ id: "1", key: "df_secret", nested: { requestAuthToken: "dfbot_x" } }],
    });
    expect(JSON.stringify(out)).not.toContain("df_secret");
    expect(JSON.stringify(out)).not.toContain("dfbot_x");
    expect((out as { data: Array<{ id: string }> }).data[0]?.id).toBe("1");
  });
});

describe("mcp.cleanup", () => {
  it("deletes expired codes, tokens, connections and retry records only", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const live = await connect(owner.id, ["analytics:read"], [site.id]);
    const old = Date.now() - 400 * 86_400_000;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO oauth_clients (id, redirect_uris, created_at, expires_at) VALUES ('dgc_old', '[]', ?, ?)",
      ).bind(old, old),
      env.DB.prepare(
        "INSERT INTO oauth_connections (id, user_id, client_id, scopes, site_ids, resource, created_at, expires_at, revoked_at) VALUES ('c_old', ?, 'dgc_old', '[]', '[]', 'r', ?, ?, ?)",
      ).bind(owner.id, old, old + 1, old + 1),
      env.DB.prepare(
        "INSERT INTO oauth_tokens (token_hash, kind, connection_id, client_id, resource, created_at, expires_at) VALUES ('h_old', 'access', 'c_old', 'dgc_old', 'r', ?, ?)",
      ).bind(old, old),
      env.DB.prepare(
        "INSERT INTO idempotency_keys (scope, key, request_hash, created_at, expires_at) VALUES ('mcp:oauth:x', 'k', 'h', ?, ?), ('notes:s:u', 'k', 'h', ?, ?)",
      ).bind(old, old, old, old),
    ]);
    await runScheduled(
      [mcpCleanupJob],
      env,
      createExecutionContext(),
      Date.parse("2026-11-04T03:17:00Z"),
    );
    const count = async (sql: string) => env.DB.prepare(sql).first<number>("n");
    expect(await count("SELECT COUNT(*) AS n FROM oauth_clients WHERE id = 'dgc_old'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM oauth_connections WHERE id = 'c_old'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM oauth_tokens WHERE token_hash = 'h_old'")).toBe(
      0,
    );
    expect(await count("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope LIKE 'mcp:%'")).toBe(
      0,
    );
    expect(
      await count("SELECT COUNT(*) AS n FROM idempotency_keys WHERE scope = 'notes:s:u'"),
    ).toBe(1);
    // The live connection and its tokens survive.
    expect(await count("SELECT COUNT(*) AS n FROM oauth_connections")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM oauth_tokens")).toBe(2);
    void live;
  });

  it("writes nothing when there is nothing to clean", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    await connect(owner.id, ["analytics:read"], [site.id]);
    const m = meterEnv();
    await m.db.batch(cleanupStatements(m.db, Date.now()));
    expect(m.d1.rowsWritten).toBe(0);
    expect(m.d1.queries).toBe(1);
  });
});

describe("write budget", () => {
  it("read tools write no D1 rows; a confirmed idempotent write adds two", async () => {
    const owner = await createUser();
    const site = await createSite(owner.id);
    const token = (await createApiKey({ userId: owner.id })).secret;
    const app = createApp();
    const m = meterEnv();
    const call = async (name: string, args: Record<string, unknown>) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(request("tools/call", { name, arguments: args })),
        }),
        m.env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res.json() as Promise<{ result: { isError?: boolean } }>;
    };
    // Warm the credential cache and the schema check, then measure.
    await call("websites_list", {});
    m.reset();
    for (const name of ["websites_list", "whoami", "team_list", "apikeys_list"]) {
      await call(name, {
        ...(name.endsWith("_list") && name !== "websites_list" ? { websiteId: site.id } : {}),
      });
    }
    expect(m.d1.rowsWritten).toBe(0);
    m.reset();
    const res = await call("websites_update", {
      websiteId: site.id,
      changes: { name: "Budget" },
      confirm: true,
      idempotencyKey: "budget-key-1",
    });
    expect(res.result.isError).toBeUndefined();
    const updateRows = m.d1.rowsWritten;
    m.reset();
    await call("websites_update", {
      websiteId: site.id,
      changes: { name: "Budget2" },
      confirm: true,
    });
    // The idempotency record costs exactly two rows (insert + completion update).
    expect(updateRows - m.d1.rowsWritten).toBe(2);
  });
});
