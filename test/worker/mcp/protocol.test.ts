/** MCP Streamable HTTP transport and JSON-RPC behaviour at /mcp and /api/mcp. */
import { beforeEach, describe, expect, it } from "vitest";
import { TOOLS } from "../../../src/mcp/tools";
import {
  MCP_APP_MIME,
  SKYBRIDGE_MIME,
  WIDGET_SKYBRIDGE_URI,
  WIDGET_URI,
} from "../../../src/mcp/widgets";
import { resetDb } from "../../helpers/db";
import { createApiKey, createSite, createUser } from "../../helpers/factories";
import { ORIGIN } from "../../helpers/http";
import { raw, request, rpc } from "./helpers";

beforeEach(() => resetDb());

async function token() {
  const user = await createUser();
  await createSite(user.id);
  return (await createApiKey({ userId: user.id })).secret;
}

describe("MCP transport", () => {
  it("answers 401 with WWW-Authenticate pointing at the protected-resource metadata", async () => {
    const res = await rpc(null, request("initialize"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer realm="DataGoat", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const alias = await rpc(null, request("initialize"), { path: "/api/mcp" });
    expect(alias.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/api/mcp",
    );
  });

  it("rejects unknown, malformed and internal-only bearer tokens", async () => {
    for (const bad of ["dft_nope", "dgo_nope", "dgi_nope", "sk_live_x"]) {
      const res = await rpc(bad, request("ping"));
      expect(res.status, bad).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    const malformed = await raw("/mcp", {
      method: "POST",
      headers: { authorization: "Token abc", "content-type": "application/json" },
      body: "{}",
    });
    expect(malformed.status).toBe(401);
  });

  it("initializes with a negotiated protocol version and server info", async () => {
    const t = await token();
    const res = await rpc(
      t,
      request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      serverInfo: { name: "datagoat", version: expect.any(String) },
    });
    expect(res.body.result.instructions).toContain("websites_list");
    const unknown = await rpc(t, request("initialize", { protocolVersion: "1999-01-01" }));
    expect(unknown.body.result.protocolVersion).toBe("2025-11-25");
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const t = await token();
    const res = await rpc(t, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  it("handles batches, ping, the resource and prompt lists and unknown methods", async () => {
    const t = await token();
    const res = await rpc(t, [
      request("ping"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request("resources/list"),
      request("prompts/list"),
      request("does/not/exist"),
      { nope: true },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body[0].result).toEqual({});
    expect(res.body[1].result.resources.map((r: { uri: string }) => r.uri)).toEqual([
      WIDGET_URI,
      WIDGET_SKYBRIDGE_URI,
    ]);
    expect(res.body[2].result).toEqual({ prompts: [] });
    expect(res.body[3].error.code).toBe(-32601);
    expect(res.body[4].error.code).toBe(-32600);
  });

  it("serves the chart view for UI-capable clients (MCP Apps and ChatGPT apps)", async () => {
    const t = await token();
    const list = await rpc(t, request("tools/list"));
    const tools = list.body.result.tools as Array<{ name: string; _meta: Record<string, unknown> }>;
    const ts = tools.find((x) => x.name === "analytics_timeseries");
    expect(ts?._meta).toMatchObject({
      ui: { resourceUri: WIDGET_URI },
      "openai/outputTemplate": WIDGET_SKYBRIDGE_URI,
    });
    for (const name of ["analytics_referrers", "analytics_funnel", "analytics_realtime_map"]) {
      expect(tools.find((x) => x.name === name)?._meta.ui, name).toEqual({
        resourceUri: WIDGET_URI,
      });
    }
    // Write and account tools have no view.
    expect(tools.find((x) => x.name === "goals_track")?._meta.ui).toBeUndefined();

    for (const [uri, mime] of [
      [WIDGET_URI, MCP_APP_MIME],
      [WIDGET_SKYBRIDGE_URI, SKYBRIDGE_MIME],
    ]) {
      const read = await rpc(t, request("resources/read", { uri }));
      const [content] = read.body.result.contents;
      expect(content).toMatchObject({ uri, mimeType: mime });
      expect(content.text).toContain("<!doctype html>");
      expect(content.text).toContain("ui/notifications/tool-result");
      expect(content.text).toContain("openai:set_globals");
      // Self-contained: no network loads, no tokens.
      expect(content.text).not.toMatch(/<script[^>]+src=|https?:\/\//);
    }
    const missing = await rpc(t, request("resources/read", { uri: "ui://nope" }));
    expect(missing.body.error.code).toBe(-32602);
  });

  it("rejects parse errors, wrong content types and unsupported protocol versions", async () => {
    const t = await token();
    const parse = await raw("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(parse.status).toBe(400);
    expect(parse.body.error.code).toBe(-32700);
    const type = await raw("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "text/plain" },
      body: JSON.stringify(request("ping")),
    });
    expect(type.status).toBe(415);
    const version = await rpc(t, request("ping"), {
      headers: { "mcp-protocol-version": "2020-01-01" },
    });
    expect(version.status).toBe(400);
    const ok = await rpc(t, request("ping"), { headers: { "mcp-protocol-version": "2025-06-18" } });
    expect(ok.status).toBe(200);
  });

  it("is stateless: GET and DELETE answer 405", async () => {
    const t = await token();
    for (const method of ["GET", "DELETE"]) {
      const res = await raw("/mcp", { method, headers: { authorization: `Bearer ${t}` } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST, OPTIONS");
    }
  });

  it("answers CORS preflight for browser-based clients", async () => {
    const res = await raw("/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("Mcp-Protocol-Version");
    expect(res.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
  });

  it("serves the same server at /api/mcp", async () => {
    const t = await token();
    const res = await rpc(t, request("tools/list"), { path: "/api/mcp" });
    expect(res.status).toBe(200);
    expect(res.body.result.tools.length).toBe(TOOLS.length);
  });
});

describe("tools/list", () => {
  it("lists every tool with a JSON Schema, annotations and its scopes", async () => {
    const t = await token();
    const res = await rpc(t, request("tools/list"));
    // biome-ignore lint/suspicious/noExplicitAny: inspecting arbitrary tool JSON
    const tools = res.body.result.tools as Array<Record<string, any>>;
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.$schema).toBeUndefined();
      expect(tool.annotations.readOnlyHint).toBe(tool._meta["datagoat/access"] === "read");
      expect(tool.securitySchemes[0].type).toBe("oauth2");
      if (tool._meta["datagoat/access"] === "write") {
        expect(tool.inputSchema.properties.confirm.type).toBe("boolean");
        expect(tool.inputSchema.properties.idempotencyKey.type).toBe("string");
      }
    }
  });

  it("covers DataFast's MCP catalog (DataGoat names without the vendor prefix)", async () => {
    const names = new Set(TOOLS.map((t) => t.name));
    const datafast = [
      "analytics_overview",
      "analytics_timeseries",
      "analytics_realtime",
      "analytics_realtime_map",
      "analytics_metadata",
      "analytics_pages",
      "analytics_exit_clicks",
      "analytics_referrers",
      "analytics_countries",
      "analytics_regions",
      "analytics_cities",
      "analytics_browsers",
      "analytics_devices",
      "analytics_operating_systems",
      "analytics_campaigns",
      "analytics_goals_breakdown",
      "analytics_goal_properties",
      "analytics_hostnames",
      "analytics_funnel",
      "bot_traffic_summary",
      "bot_traffic_pages",
      "bot_traffic_usage",
      "bot_traffic_settings_get",
      "bot_traffic_settings_update",
      "bot_traffic_token_get",
      "bot_traffic_token_create",
      "bot_traffic_token_rotate",
      "bot_traffic_token_delete",
      "mentions_list",
      "notes_list",
      "notes_create",
      "notes_update",
      "notes_delete",
      "websites_list",
      "websites_get",
      "websites_create",
      "websites_update",
      "apikeys_list",
      "apikeys_create",
      "apikeys_roll",
      "apikeys_delete",
      "team_list",
      "team_invite",
      "team_remove",
      "goals_track",
      "goals_delete_events",
      "goals_list",
      "goals_customizations_list",
      "goals_customizations_update",
      "goals_customizations_reset",
      "funnels_list",
      "funnels_create",
      "funnels_update",
      "funnels_delete",
      "visitors_search",
      "visitors_get",
      "alerts_list",
      "alerts_create",
      "alerts_update",
      "alerts_delete",
      "alerts_history",
      "account_update",
      "access_tokens_list",
      "access_tokens_create",
      "access_tokens_delete",
      "integrations_status",
      "whoami",
    ];
    expect(datafast.filter((n) => !names.has(n))).toEqual([]);
  });

  it("accepts DataFast's tool names as aliases", async () => {
    const t = await token();
    const res = await rpc(
      t,
      request("tools/call", { name: "datafast_account_get", arguments: {} }),
    );
    expect(res.body.result.isError).toBeUndefined();
    expect(res.body.result.structuredContent.data.account.email).toMatch(/@example.com$/);
    const unknown = await rpc(t, request("tools/call", { name: "nope", arguments: {} }));
    expect(unknown.body.error.code).toBe(-32602);
  });
});
