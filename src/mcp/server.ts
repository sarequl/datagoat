/**
 * MCP over Streamable HTTP, stateless (no `Mcp-Session-Id`, no server-initiated streams): every
 * POST carries one JSON-RPC message (or a batch) and gets a JSON answer. GET and DELETE answer
 * 405, which the transport spec allows for servers without SSE streams or sessions.
 *
 * Auth: `Authorization: Bearer` with a df_/dft_ credential or an MCP OAuth access token. Without
 * one, 401 + `WWW-Authenticate` pointing at the protected-resource metadata, which is how MCP
 * clients discover the OAuth server.
 */
import type { Context } from "hono";
import { errorFields, log } from "../lib/log";
import type { AppEnv } from "../types";
import { type McpCaller, resolveMcpCaller, wwwAuthenticate } from "./auth";
import { type CallToolResult, callTool } from "./executor";
import { findTool, listTools } from "./tools";
import { listWidgetResources, readWidgetResource } from "./widgets";

export const SERVER_NAME = "datagoat";
export const SERVER_VERSION = "0.1.0";
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST = PROTOCOL_VERSIONS[0];
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_BATCH = 20;

export const INSTRUCTIONS = [
  "DataGoat web analytics (DataFast-compatible).",
  "Call websites_list (or whoami) first to find the websiteId, then pass it to website tools; df_ website keys and single-website connections may omit it.",
  "Dates: use period (today, yesterday, last24h, last7d, last30d, last90d, last12m, week, month, year, all) or startAt/endAt as YYYY-MM-DD in the website timezone.",
  "Revenue on breakdown rows is attributed revenue; overview and timeseries revenue is total revenue.",
  "Write tools return a dry-run preview unless confirm is true: explain the exact change and ask the user before confirming, and pass an idempotencyKey so retries are safe.",
].join(" ");

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

type Id = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const rpcError = (id: Id, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { "content-type": "application/json" }),
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

interface Session {
  c: Context<AppEnv>;
  caller: McpCaller;
  origin: string;
  path: string;
  now: number;
}

function negotiate(requested: unknown): string {
  return typeof requested === "string" &&
    (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST;
}

async function dispatch(message: JsonRpcRequest, s: Session): Promise<unknown> {
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "DataGoat", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: listTools() };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") throw new RpcError(-32602, "params.name must be a string");
      const tool = findTool(name);
      if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
      const result: CallToolResult = await callTool(tool, params.arguments, {
        env: s.c.env,
        ctx: s.c.executionCtx as unknown as ExecutionContext,
        origin: s.origin,
        path: s.path,
        caller: s.caller,
        now: s.now,
      });
      return result;
    }
    case "resources/list":
      return { resources: listWidgetResources() };
    case "resources/read": {
      const uri = params.uri;
      const res = typeof uri === "string" ? readWidgetResource(uri) : null;
      if (!res) throw new RpcError(-32602, `Unknown resource: ${String(uri)}`);
      return res;
    }
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    case "logging/setLevel":
      return {};
    default:
      throw new RpcError(-32601, `Method not found: ${message.method}`);
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function isRequestShape(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.jsonrpc === "2.0" &&
    typeof v.method === "string" &&
    (v.params === undefined || (typeof v.params === "object" && v.params !== null))
  );
}

async function handleMessage(raw: unknown, s: Session): Promise<JsonRpcResponse | null> {
  const id = (raw as { id?: Id } | null)?.id ?? null;
  if (!isRequestShape(raw)) {
    // Client responses (to server requests we never send) are ignored.
    if (raw && typeof raw === "object" && ("result" in raw || "error" in raw)) return null;
    return rpcError(id, -32600, "Invalid JSON-RPC request");
  }
  const isNotification = !("id" in raw) || raw.id === undefined;
  if (isNotification) return null;
  try {
    return { jsonrpc: "2.0", id: raw.id ?? null, result: await dispatch(raw, s) };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(raw.id ?? null, err.code, err.message);
    log.error("mcp.request_failed", { method: raw.method, ...errorFields(err) });
    return rpcError(raw.id ?? null, -32603, "Internal error");
  }
}

export function unauthorized(origin: string, path: string, description?: string): Response {
  return json(
    {
      error: description ? "invalid_token" : "unauthorized",
      error_description:
        description ?? "Authentication required: send Authorization: Bearer <token>",
    },
    401,
    {
      "WWW-Authenticate": wwwAuthenticate(
        origin,
        path,
        description
          ? {
              error: "invalid_token",
              description,
            }
          : {},
      ),
    },
  );
}

/** The `/mcp` handler for every method. */
export async function handleMcp(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const origin = url.origin;
  const path = url.pathname;
  if (c.req.method === "OPTIONS") return json(null, 204);

  const header = c.req.header("authorization");
  if (!header) return unauthorized(origin, path);
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) return unauthorized(origin, path, "Malformed Authorization header");
  const now = Date.now();
  const caller = await resolveMcpCaller(
    match[1],
    c.env,
    c.executionCtx as unknown as ExecutionContext,
    origin,
    now,
  );
  if (!caller) return unauthorized(origin, path, "Invalid, expired or revoked token");

  if (c.req.method !== "POST") {
    return json(
      rpcError(null, -32000, "This MCP server is stateless: use POST (no SSE stream or session)"),
      405,
      { Allow: "POST, OPTIONS" },
    );
  }
  const version = c.req.header("mcp-protocol-version");
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${version}`), 400);
  }
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json(rpcError(null, -32600, "Content-Type must be application/json"), 415);
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(rpcError(null, -32600, "Request too large"), 413);
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return json(rpcError(null, -32600, "Request too large"), 413);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  const session: Session = { c, caller, origin, path, now };
  if (Array.isArray(payload)) {
    if (payload.length === 0) return json(rpcError(null, -32600, "Empty batch"), 400);
    if (payload.length > MAX_BATCH) {
      return json(rpcError(null, -32600, `Batches are limited to ${MAX_BATCH} messages`), 400);
    }
    const responses: JsonRpcResponse[] = [];
    for (const message of payload) {
      const res = await handleMessage(message, session);
      if (res) responses.push(res);
    }
    return responses.length ? json(responses) : json(null, 202);
  }
  const res = await handleMessage(payload, session);
  return res ? json(res) : json(null, 202);
}
