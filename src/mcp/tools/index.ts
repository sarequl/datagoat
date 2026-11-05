/**
 * The MCP tool catalog. Names follow DataFast's catalog without the vendor prefix
 * (`analytics_overview`, `visitors_get`, …); calls using DataFast's names (`datafast_…`) are
 * accepted as aliases so prompts and scripts written for DataFast keep working.
 */
import { z } from "zod";
import { WIDGET_TOOLS, widgetToolMeta } from "../widgets";
import { accountTools } from "./account";
import { analyticsTools } from "./analytics";
import type { ToolDef } from "./kit";
import { resourceTools } from "./resources";

export const WRITE_ARGS = {
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Set true to apply the change. Without it the tool only returns a dry-run preview of exactly what it would do.",
    ),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional()
    .describe(
      "Retry key (8–128 chars, required with OAuth). Reusing it with the same arguments returns the first result instead of repeating the change.",
    ),
};

function finalize(tool: ToolDef): ToolDef {
  if (tool.access !== "write") return tool;
  return {
    ...tool,
    input: tool.input.extend(WRITE_ARGS),
    description: `${tool.description} Write tool: returns a dry-run preview unless confirm is true.`,
  };
}

export const TOOLS: readonly ToolDef[] = [...analyticsTools, ...resourceTools, ...accountTools].map(
  finalize,
);

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const ALIASES: Record<string, string> = {
  account_get: "whoami",
};

/** Find a tool by name or DataFast alias. */
export function findTool(name: string): ToolDef | undefined {
  const bare = name.startsWith("datafast_") ? name.slice("datafast_".length) : name;
  return BY_NAME.get(bare) ?? BY_NAME.get(ALIASES[bare] ?? "");
}

export interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  securitySchemes: Array<{ type: "oauth2"; scopes: string[] }>;
  _meta: Record<string, unknown>;
}

function jsonSchema(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: "input", target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}

let listed: ListedTool[] | undefined;

/** `tools/list` entries (computed once per isolate). */
export function listTools(): ListedTool[] {
  listed ??= TOOLS.map((tool) => {
    const securitySchemes = [{ type: "oauth2" as const, scopes: tool.oauth }];
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: jsonSchema(tool),
      annotations: {
        title: tool.title,
        readOnlyHint: tool.access === "read",
        destructiveHint: tool.access === "write" && tool.destructive === true,
        idempotentHint: tool.access === "read",
        openWorldHint: false,
      },
      securitySchemes,
      _meta: {
        securitySchemes,
        "datagoat/permission": tool.permission,
        "datagoat/oauthScopes": tool.oauth,
        "datagoat/access": tool.access,
        // Clients that render UI (MCP Apps, ChatGPT apps) draw these results as charts.
        ...(WIDGET_TOOLS.has(tool.name) ? widgetToolMeta() : {}),
      },
    };
  });
  return listed;
}
