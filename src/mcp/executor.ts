/**
 * Runs one `tools/call`: argument validation, the credential's permission or OAuth scopes,
 * the dry-run preview for writes without `confirm: true`, idempotency, the in-process `/api/v1`
 * call and the MCP result shape. The REST handler still performs its own authorization
 * (website access, membership, role) on every call.
 */
import type { z } from "zod";
import { grantsAllow, type Permission } from "../../shared/permissions";
import type { AuthContext } from "../auth/context";
import { getRole } from "../auth/memberships";
import { siteCache } from "../lib/site-cache";
import { type McpCaller, wwwAuthenticate } from "./auth";
import { type ApiRequest, type ApiResult, callApi } from "./dispatch";
import { beginIdempotent, finishIdempotent, REDACTED_SECRET, requestHash } from "./idempotency";
import {
  type Args,
  type CallOptions,
  type ToolContext,
  type ToolDef,
  ToolError,
} from "./tools/kit";

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ExecutorEnv {
  env: Cloudflare.Env;
  ctx: ExecutionContext;
  origin: string;
  /** Path of the MCP endpoint that received the call (for WWW-Authenticate). */
  path: string;
  caller: McpCaller;
  now: number;
}

function errorResult(message: string, meta?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: { message } },
    isError: true,
    ...(meta ? { _meta: meta } : {}),
  };
}

function messageOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; message?: unknown };
    if (b.error && typeof b.error === "object" && "message" in b.error) {
      return String((b.error as { message: unknown }).message);
    }
    if (typeof b.message === "string") return b.message;
    if (typeof b.error === "string") return b.error;
  }
  if (typeof body === "string" && body) return body.slice(0, 500);
  return `Request failed with HTTP ${status}`;
}

/** Turn an API status + body into an MCP tool result. */
export function formatResult(status: number, body: unknown): CallToolResult {
  if (status >= 400) {
    const message = messageOf(body, status);
    return {
      content: [{ type: "text", text: `Error ${status}: ${message}` }],
      structuredContent: { error: { code: status, message } },
      isError: true,
    };
  }
  let structured: Record<string, unknown>;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { status: _s, ...rest } = body as Record<string, unknown>;
    structured = rest;
  } else {
    structured = { result: body };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "arguments"}: ${i.message}`)
    .join("; ");
}

function defaultSite(auth: AuthContext): string | undefined {
  if (auth.keySiteId) return auth.keySiteId;
  if (Array.isArray(auth.websiteIds) && auth.websiteIds.length === 1) return auth.websiteIds[0];
  return undefined;
}

async function findSite(db: D1Database, ref: string) {
  return (await siteCache.byId(db, ref)) ?? (await siteCache.byPublicId(db, ref));
}

function buildContext(tool: ToolDef, x: ExecutorEnv): ToolContext {
  const { caller } = x;
  const authFor = (options: CallOptions = {}): AuthContext => {
    if (!caller.connection) return caller.auth;
    const grants: Permission[] = options.grants ?? tool.callOptions?.grants ?? [tool.permission];
    const scopes = [...new Set([...caller.auth.scopes, ...grants])];
    const allSites = options.allSites ?? tool.callOptions?.allSites ?? false;
    return { ...caller.auth, scopes, websiteIds: allSites ? "all" : caller.connection.siteIds };
  };
  const tc: ToolContext = {
    caller,
    now: x.now,
    origin: x.origin,
    env: x.env,
    call: (request: ApiRequest, options?: CallOptions) =>
      callApi(x.env, x.ctx, x.origin, authFor(options), request),
    siteRef: (args) => args.websiteId ?? defaultSite(caller.auth),
    requireSite: (args) => {
      const ref = tc.siteRef(args);
      if (!ref) throw new ToolError("websiteId is required: call websites_list to find it");
      return ref;
    },
    siteTimezone: async (ref) => {
      if (!ref) return "UTC";
      const site = await findSite(x.env.DB, ref);
      return site?.timezone ?? "UTC";
    },
  };
  return tc;
}

/** OAuth: the connection must hold every scope the tool needs. */
function missingScopes(tool: ToolDef, caller: McpCaller): string[] {
  if (!caller.connection) return [];
  return tool.oauth.filter((s) => !caller.oauthScopes.includes(s));
}

async function requireOwner(tc: ToolContext, args: Args): Promise<void> {
  const ref = tc.requireSite(args);
  const site = await findSite(tc.env.DB, ref);
  const role = site ? await getRole(tc.env.DB, site.id, tc.caller.auth.user.id) : null;
  if (!site || !role) throw new ToolError("Website not found");
  if (role !== "owner") {
    throw new ToolError(`Through OAuth this action requires the owner role (yours: ${role})`);
  }
}

/** Before replaying a recorded result, make sure the caller still has the website. */
async function stillHasSite(tc: ToolContext, tool: ToolDef, args: Args): Promise<boolean> {
  if (!tool.site) return true;
  const ref = tc.siteRef(args);
  if (!ref) return true;
  const site = await findSite(tc.env.DB, ref);
  if (!site) return false;
  const ids = tc.caller.connection ? tc.caller.connection.siteIds : tc.caller.auth.websiteIds;
  if (ids !== "all" && !ids.includes(site.id)) return false;
  return (await getRole(tc.env.DB, site.id, tc.caller.auth.user.id)) !== null;
}

function describeRequest(request: ApiRequest): Record<string, unknown> {
  const query = Object.fromEntries(
    Object.entries(request.query ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    ),
  );
  return {
    method: request.method,
    path: request.path,
    ...(Object.keys(query).length ? { query } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
  };
}

async function execute(
  tool: ToolDef,
  args: Args,
  tc: ToolContext,
): Promise<ApiResult | { status: number; body: unknown }> {
  if (tool.run) return tool.run(args, tc);
  if (!tool.request) throw new Error(`Tool ${tool.name} has no implementation`);
  const request = await tool.request(args, tc);
  const result = await tc.call(request);
  if (tool.after && result.status < 400) return (await tool.after(args, result, tc)) ?? result;
  return result;
}

export async function callTool(
  tool: ToolDef,
  rawArgs: unknown,
  x: ExecutorEnv,
): Promise<CallToolResult> {
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) return errorResult(`Invalid arguments: ${zodMessage(parsed.error)}`);
  const args = parsed.data as Args;
  const { caller } = x;

  const missing = missingScopes(tool, caller);
  if (missing.length) {
    const scope = [...new Set([...caller.oauthScopes, ...tool.oauth])].join(" ");
    return errorResult(
      `This connection was not granted ${missing.join(", ")}. Reconnect DataGoat and approve ${missing.length === 1 ? "that permission" : "those permissions"} to use ${tool.name}.`,
      {
        "mcp/www_authenticate": [
          wwwAuthenticate(x.origin, x.path, {
            error: "insufficient_scope",
            scope,
            description: `${tool.name} requires ${tool.oauth.join(" ")}`,
          }),
        ],
      },
    );
  }
  if (!caller.connection && !grantsAllow(caller.auth.scopes, tool.permission)) {
    return errorResult(`Missing permission: ${tool.permission}`);
  }

  const tc = buildContext(tool, x);
  const checks = async () => {
    if (tool.oauthOwnerOnly && caller.connection) await requireOwner(tc, args);
    if (tool.guard) await tool.guard(args, tc);
  };
  try {
    if (tool.access === "write") {
      if (args.confirm !== true) {
        await checks();
        const preview: Record<string, unknown> = {
          dryRun: true,
          tool: tool.name,
          message: `Nothing was changed. Review the request below with the user, then call ${tool.name} again with confirm: true${caller.connection ? " and an idempotencyKey" : ""} to apply it.`,
        };
        if (tool.request) {
          const { confirm: _c, idempotencyKey: _k, ...rest } = args;
          preview.request = describeRequest(await tool.request(rest, tc));
        }
        if (tool.destructive)
          preview.warning = "This action is irreversible or issues a credential.";
        return {
          content: [{ type: "text", text: JSON.stringify(preview) }],
          structuredContent: preview,
        };
      }
      if (caller.connection && !args.idempotencyKey) {
        return errorResult("idempotencyKey (8–128 characters) is required for OAuth write tools");
      }
    }

    const key = tool.access === "write" ? (args.idempotencyKey as string | undefined) : undefined;
    if (!key) {
      await checks();
      const result = await execute(tool, args, tc);
      return formatResult(result.status, result.body);
    }
    const scope = `mcp:${caller.auth.kind}:${caller.auth.credentialId}`;
    const hash = await requestHash(tool.name, args);
    const begin = await beginIdempotent(x.env.DB, scope, key, hash, x.now);
    if (begin.kind === "conflict") return errorResult(begin.message);
    if (begin.kind === "replay") {
      if (!(await stillHasSite(tc, tool, args))) return errorResult("Website not found");
      const replay = formatResult(begin.status, begin.response);
      if (replay.structuredContent) {
        replay.structuredContent = { ...replay.structuredContent, replayed: true };
        replay.content = [{ type: "text", text: JSON.stringify(replay.structuredContent) }];
      }
      if (JSON.stringify(begin.response).includes(REDACTED_SECRET)) {
        replay.content.push({
          type: "text",
          text: "This call already ran with this idempotencyKey. The credential it issued was shown only in the first response.",
        });
      }
      return replay;
    }
    // A replay above returns the recorded result even when the change it made (e.g. a deleted
    // token) would now fail these checks; a new call runs them.
    let result: { status: number; body: unknown };
    try {
      await checks();
      result = await execute(tool, args, tc);
    } catch (err) {
      if (err instanceof ToolError) {
        await finishIdempotent(x.env.DB, scope, key, 400, null);
      }
      throw err;
    }
    await finishIdempotent(x.env.DB, scope, key, result.status, result.body);
    return formatResult(result.status, result.body);
  } catch (err) {
    if (err instanceof ToolError) return errorResult(err.message, err.meta);
    throw err;
  }
}
