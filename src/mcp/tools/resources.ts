/**
 * Website resources: websites, website API keys, team, goals, funnels, notes, alerts, payment
 * integration status and bot traffic controls. Each tool is one `/api/v1` call.
 */
import { z } from "zod";
import type { Permission } from "../../../shared/permissions";
import { resolvePeriod } from "../periods";
import {
  type Args,
  enc,
  type Owner,
  rangeArgs,
  rangeQuery,
  type ToolContext,
  type ToolDef,
  ToolError,
  zWebsiteId,
} from "./kit";

const W = "/api/v1/admin/websites";
const zId = (what: string) => z.string().min(1).max(128).describe(`${what} id.`);

interface SiteToolOptions {
  name: string;
  title: string;
  description: string;
  access: "read" | "write";
  destructive?: boolean;
  permission: Permission;
  oauth?: string[];
  owner: Owner;
  shape?: z.ZodRawShape;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path after /api/v1/admin/websites/:id */
  path: (args: Args) => string;
  body?: (args: Args) => unknown;
  query?: (
    args: Args,
    tc: ToolContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  oauthOwnerOnly?: boolean;
}

function siteTool(o: SiteToolOptions): ToolDef {
  return {
    name: o.name,
    title: o.title,
    description: o.description,
    input: z.object({ websiteId: zWebsiteId.optional(), ...(o.shape ?? {}) }).strict(),
    access: o.access,
    ...(o.destructive ? { destructive: true } : {}),
    permission: o.permission,
    oauth: o.oauth ?? [o.permission],
    owner: o.owner,
    site: true,
    ...(o.oauthOwnerOnly ? { oauthOwnerOnly: true } : {}),
    request: async (args, tc) => ({
      method: o.method,
      path: `${W}/${enc(tc.requireSite(args))}${o.path(args)}`,
      ...(o.query ? { query: (await o.query(args, tc)) as Record<string, string> } : {}),
      ...(o.body ? { body: o.body(args) } : {}),
    }),
  };
}

/** Pick defined keys from args. */
function pick(args: Args, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/** Bind a credential minted through an OAuth connection to it (expiry + revocation). */
async function bindToConnection(tc: ToolContext, keyId: unknown): Promise<void> {
  const conn = tc.caller.connection;
  if (!conn || typeof keyId !== "string") return;
  await tc.env.DB.prepare(
    `UPDATE api_keys SET oauth_connection_id = ?,
       expires_at = CASE WHEN expires_at IS NULL OR expires_at > ? THEN ? ELSE expires_at END
     WHERE id = ? AND user_id = ?`,
  )
    .bind(conn.id, conn.expiresAt, conn.expiresAt, keyId, tc.caller.auth.user.id)
    .run();
}

function firstId(body: unknown): unknown {
  const data = (body as { data?: Array<{ id?: unknown }> } | null)?.data;
  return Array.isArray(data) ? data[0]?.id : undefined;
}

const zStep = z
  .object({
    name: z.string().min(1).max(100),
    type: z.enum(["pageview", "goal"]),
    url: z.string().max(2000).optional().describe("Page path for pageview steps."),
    urlMatchType: z
      .enum([
        "equals",
        "contains",
        "starts_with",
        "ends_with",
        "not_equals",
        "not_contains",
        "wildcard",
      ])
      .optional(),
    hostname: z.string().max(253).optional(),
    goalName: z.string().max(64).optional().describe("Goal name for goal steps."),
    goalCompletionType: z.enum(["completed", "not_completed"]).optional(),
  })
  .strict();

// Mirrors the alerts API's destination (src/growth/alerts/model.ts); the API validates details.
const zAlertDestination = z
  .object({
    type: z.enum(["email", "telegram", "webhook"]),
    email: z.string().max(320).optional(),
    chatId: z.string().max(100).optional(),
    botToken: z.string().max(200).optional(),
    url: z.string().max(2000).optional().describe("HTTPS endpoint for webhook destinations."),
  })
  .strict();

const zAlertTemplate = z
  .object({ message: z.string().min(10).max(2000), subject: z.string().max(200).optional() })
  .strict();

const zAlertTrigger = z
  .record(z.string(), z.unknown())
  .describe('What fires the alert: {"goalName": "signup"} or {"type": "new_sale"} etc.');

export const resourceTools: ToolDef[] = [
  // ---------------------------------------------------------------- websites (F0)
  {
    name: "websites_list",
    title: "List websites",
    description:
      "Websites this credential can access, with domain, name, tracking id, timezone, currency and your role. Start here to find a websiteId.",
    input: z.object({}).strict(),
    access: "read",
    permission: "websites:read",
    oauth: ["websites:read"],
    owner: "F0",
    site: false,
    request: () => ({ method: "GET", path: W }),
  },
  siteTool({
    name: "websites_get",
    title: "Get website settings",
    description: "Every setting of one website (privacy mode, exclusions, KPI, attribution, …).",
    access: "read",
    permission: "settings:read",
    owner: "F0",
    method: "GET",
    path: () => "",
  }),
  {
    name: "websites_create",
    title: "Create website",
    description:
      "Add a website. Returns its websiteId and trackingId (the data-website-id for the script tag). With OAuth, the new website joins this connection.",
    input: z
      .object({
        domain: z.string().min(1).max(253).describe("example.com"),
        timezone: z.string().min(1).max(64).describe("IANA timezone, e.g. America/New_York."),
        name: z.string().max(100).optional(),
        currency: z.string().length(3).optional().describe("ISO 4217, default USD."),
      })
      .strict(),
    access: "write",
    permission: "websites:write",
    oauth: ["websites:write"],
    owner: "F0",
    site: false,
    callOptions: { allSites: true },
    request: (args) => ({
      method: "POST",
      path: W,
      body: pick(args, ["domain", "timezone", "name", "currency"]),
    }),
    after: async (_args, result, tc) => {
      const conn = tc.caller.connection;
      const id = (result.body as { data?: Array<{ websiteId?: string }> })?.data?.[0]?.websiteId;
      if (!conn || result.status !== 200 || !id) return undefined;
      const siteIds = [...new Set([...conn.siteIds, id])];
      await tc.env.DB.prepare("UPDATE oauth_connections SET site_ids = ? WHERE id = ?")
        .bind(JSON.stringify(siteIds), conn.id)
        .run();
      conn.siteIds = siteIds;
      return undefined;
    },
  },
  siteTool({
    name: "websites_update",
    title: "Update website settings",
    description:
      "Change one or more settings. `changes` takes the fields of PUT /api/v1/admin/websites/{id}: name, domain, timezone, currency, kpi, kpiColorScheme, revenueMetric, privacyMode, attributionModel, botLevel, honorGpc, includeRenewalRevenue, allowedHostnames, excludedIps, excludedPaths, excludedCountries, excludedHostnames, sendWeeklyReports, sendViralTrafficAlerts, retentionDays, …",
    access: "write",
    permission: "settings:write",
    owner: "F0",
    method: "PUT",
    path: () => "",
    shape: {
      changes: z
        .record(z.string(), z.unknown())
        .describe('Only the fields to change, e.g. {"name": "Blog", "timezone": "Europe/Paris"}.'),
    },
    body: (args) => args.changes,
  }),

  // ---------------------------------------------------------------- website API keys (F0)
  siteTool({
    name: "apikeys_list",
    title: "List website API keys",
    description: "The website's df_ keys (names and masked prefixes; secrets are never returned).",
    access: "read",
    permission: "api-keys:read",
    owner: "F0",
    method: "GET",
    path: () => "/apikeys",
  }),
  {
    ...siteTool({
      name: "apikeys_create",
      title: "Create website API key",
      description:
        "Create a df_ key for one website. The full key is returned once. Keys created through OAuth expire and are revoked with the connection.",
      access: "write",
      destructive: true,
      permission: "api-keys:write",
      owner: "F0",
      method: "POST",
      path: () => "/apikeys",
      oauthOwnerOnly: true,
      shape: {
        name: z.string().max(100).optional(),
        includePii: z
          .boolean()
          .optional()
          .describe("Allow the key to read customer names and emails."),
      },
      body: (args) => pick(args, ["name", "includePii"]),
    }),
    after: async (_args, result, tc) => {
      if (result.status === 200) await bindToConnection(tc, firstId(result.body));
      return undefined;
    },
  },
  siteTool({
    name: "apikeys_roll",
    title: "Roll website API key",
    description:
      "Replace a df_ key's secret. The old secret stops working immediately; the new one is returned once.",
    access: "write",
    destructive: true,
    permission: "api-keys:write",
    owner: "F0",
    method: "PUT",
    oauthOwnerOnly: true,
    shape: { apiKeyId: zId("API key") },
    path: (args) => `/apikeys/${enc(args.apiKeyId)}`,
  }),
  siteTool({
    name: "apikeys_delete",
    title: "Delete website API key",
    description: "Permanently delete a df_ key.",
    access: "write",
    destructive: true,
    permission: "api-keys:write",
    owner: "F0",
    method: "DELETE",
    oauthOwnerOnly: true,
    shape: { apiKeyId: zId("API key") },
    path: (args) => `/apikeys/${enc(args.apiKeyId)}`,
  }),

  // ---------------------------------------------------------------- team (F0)
  siteTool({
    name: "team_list",
    title: "List team",
    description: "Members of the website with name, email and role (owner first).",
    access: "read",
    permission: "team:read",
    owner: "F0",
    method: "GET",
    path: () => "/team",
  }),
  siteTool({
    name: "team_invite",
    title: "Invite team member",
    description:
      "Create a pending invitation (owners only). Returns an invite link to share; no email is sent unless email delivery is configured.",
    access: "write",
    permission: "team:write",
    owner: "F0",
    method: "POST",
    path: () => "/team",
    shape: {
      email: z.string().min(3).max(320),
      role: z.enum(["member", "viewer"]),
    },
    body: (args) => pick(args, ["email", "role"]),
  }),
  siteTool({
    name: "team_remove",
    title: "Remove team member",
    description:
      "Remove a member from the website (owners only). Their df_ keys for it stop working.",
    access: "write",
    destructive: true,
    permission: "team:write",
    owner: "F0",
    method: "DELETE",
    path: () => "/team",
    shape: { userId: zId("User") },
    body: (args) => ({ userId: args.userId }),
  }),
  siteTool({
    name: "team_update_role",
    title: "Change member role",
    description: "Change a member's role (owners only). The last owner cannot be demoted.",
    access: "write",
    permission: "team:write",
    owner: "F0",
    method: "PUT",
    path: () => "/team",
    shape: { userId: zId("User"), role: z.enum(["owner", "member", "viewer"]) },
    body: (args) => pick(args, ["userId", "role"]),
  }),

  // ---------------------------------------------------------------- goals (W2)
  {
    name: "goals_track",
    title: "Track goal",
    description:
      "Record a custom goal for a visitor from the server side (the visitor needs at least one pageview).",
    input: z
      .object({
        websiteId: zWebsiteId.optional(),
        visitorId: z.string().min(1).max(128).describe("datafast_visitor_id of the visitor."),
        name: z
          .string()
          .min(1)
          .max(64)
          .describe("Goal name: lowercase letters, digits, _ - : (max 64)."),
        description: z.string().max(500).optional(),
        metadata: z
          .record(z.string(), z.string().max(255))
          .optional()
          .describe("Up to 10 parameters, names ^[a-z0-9_-]+$."),
      })
      .strict(),
    access: "write",
    permission: "goals:write",
    oauth: ["goals:write"],
    owner: "W2",
    site: true,
    request: (args, tc) => ({
      method: "POST",
      path: "/api/v1/goals",
      query: { websiteId: tc.siteRef(args) },
      body: {
        datafast_visitor_id: args.visitorId,
        name: args.name,
        ...pick(args, ["description", "metadata"]),
      },
    }),
  },
  {
    name: "goals_delete_events",
    title: "Delete goal events",
    description:
      "Bulk-delete recorded custom goal events by visitor and/or goal name. Without a visitor, a date range is required.",
    input: z
      .object({
        websiteId: zWebsiteId.optional(),
        visitorId: z.string().max(128).optional(),
        name: z.string().max(64).optional().describe("Goal name."),
        ...rangeArgs,
      })
      .strict(),
    access: "write",
    destructive: true,
    permission: "goals:write",
    oauth: ["goals:write"],
    owner: "W2",
    site: true,
    request: async (args, tc) => ({
      method: "DELETE",
      path: "/api/v1/goals",
      query: {
        websiteId: tc.siteRef(args),
        datafast_visitor_id: args.visitorId,
        name: args.name,
        ...(await rangeQuery(args, tc, resolvePeriod)),
      },
    }),
  },
  siteTool({
    name: "goals_list",
    title: "List tracked goals",
    description:
      "Goals the website has recorded, with completion counts and saved display customizations.",
    access: "read",
    permission: "settings:read",
    oauth: ["goals:read"],
    owner: "W2",
    method: "GET",
    path: () => "/goals",
  }),
  siteTool({
    name: "goals_customizations_list",
    title: "List goal customizations",
    description: "Saved display names, colours, descriptions and hidden flags, plus the palette.",
    access: "read",
    permission: "goals:read",
    owner: "W2",
    method: "GET",
    path: () => "/goals/customizations",
    shape: { goalName: z.string().max(64).optional() },
    query: (args) => ({ goalName: args.goalName }),
  }),
  siteTool({
    name: "goals_customizations_update",
    title: "Customize goal display",
    description:
      "Set a goal's display name, colour (from the palette), description or hidden flag. Display only: keep sending the raw goal name.",
    access: "write",
    permission: "goals:write",
    owner: "W2",
    method: "PATCH",
    path: () => "/goals/customizations",
    shape: {
      goalName: z.string().min(1).max(64),
      displayName: z.string().max(80).nullable().optional(),
      color: z.string().max(20).nullable().optional(),
      description: z.string().max(300).nullable().optional(),
      hidden: z.boolean().optional(),
    },
    body: (args) => pick(args, ["goalName", "displayName", "color", "description", "hidden"]),
  }),
  siteTool({
    name: "goals_customizations_reset",
    title: "Reset goal display",
    description: "Remove a goal's saved display customization. Goal events are kept.",
    access: "write",
    destructive: true,
    permission: "goals:write",
    owner: "W2",
    method: "DELETE",
    path: () => "/goals/customizations",
    shape: { goalName: z.string().min(1).max(64) },
    query: (args) => ({ goalName: args.goalName }),
  }),

  // ---------------------------------------------------------------- funnels (W2)
  siteTool({
    name: "funnels_list",
    title: "List funnels",
    description: "Active funnels with their steps. Use analytics_funnel for results.",
    access: "read",
    permission: "funnels:read",
    owner: "W2",
    method: "GET",
    path: () => "/funnels",
  }),
  siteTool({
    name: "funnels_create",
    title: "Create funnel",
    description: "Create a funnel of 2–8 pageview or goal steps.",
    access: "write",
    permission: "funnels:write",
    owner: "W2",
    method: "POST",
    path: () => "/funnels",
    shape: { name: z.string().min(1).max(100), steps: z.array(zStep).min(2).max(8) },
    body: (args) => pick(args, ["name", "steps"]),
  }),
  siteTool({
    name: "funnels_update",
    title: "Update funnel",
    description: "Rename a funnel, replace its steps (2–10) or turn it on/off.",
    access: "write",
    permission: "funnels:write",
    owner: "W2",
    method: "PUT",
    path: (args) => `/funnels/${enc(args.funnelId)}`,
    shape: {
      funnelId: zId("Funnel"),
      name: z.string().min(1).max(100).optional(),
      steps: z.array(zStep).min(2).max(10).optional(),
      isActive: z.boolean().optional(),
    },
    body: (args) => pick(args, ["name", "steps", "isActive"]),
  }),
  siteTool({
    name: "funnels_delete",
    title: "Delete funnel",
    description: "Delete a funnel (soft delete: it becomes inactive).",
    access: "write",
    destructive: true,
    permission: "funnels:write",
    owner: "W2",
    method: "DELETE",
    path: (args) => `/funnels/${enc(args.funnelId)}`,
    shape: { funnelId: zId("Funnel") },
  }),

  // ---------------------------------------------------------------- notes (W2)
  siteTool({
    name: "notes_list",
    title: "List notes",
    description: "Manual chart notes, searchable; defaults to the last 30 days.",
    access: "read",
    permission: "notes:read",
    owner: "W2",
    method: "GET",
    path: () => "/notes",
    shape: {
      ...rangeArgs,
      q: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    query: async (args, tc) => ({
      ...(await rangeQuery(args, tc, resolvePeriod)),
      ...pick(args, ["q", "limit", "offset", "order"]),
    }),
  }),
  siteTool({
    name: "notes_create",
    title: "Add note",
    description:
      'Add a timestamped note to the charts, e.g. "Launched the new landing page". The idempotencyKey also deduplicates at the notes API.',
    access: "write",
    permission: "notes:write",
    owner: "W2",
    method: "POST",
    path: () => "/notes",
    shape: {
      text: z.string().min(1).max(500),
      timestamp: z.string().max(40).describe("ISO 8601 instant or YYYY-MM-DD."),
    },
    body: (args) => pick(args, ["text", "timestamp", "idempotencyKey"]),
  }),
  siteTool({
    name: "notes_update",
    title: "Edit note",
    description: "Change a note's text or timestamp.",
    access: "write",
    permission: "notes:write",
    owner: "W2",
    method: "PUT",
    path: (args) => `/notes/${enc(args.noteId)}`,
    shape: {
      noteId: zId("Note"),
      text: z.string().min(1).max(500).optional(),
      timestamp: z.string().max(40).optional(),
    },
    body: (args) => pick(args, ["text", "timestamp"]),
  }),
  siteTool({
    name: "notes_delete",
    title: "Delete note",
    description: "Permanently delete one note.",
    access: "write",
    destructive: true,
    permission: "notes:write",
    owner: "W2",
    method: "DELETE",
    path: (args) => `/notes/${enc(args.noteId)}`,
    shape: { noteId: zId("Note") },
  }),

  // ---------------------------------------------------------------- alerts (W6)
  siteTool({
    name: "alerts_list",
    title: "List alerts",
    description: "Configured alerts (goal, new sale, traffic spike, digest) and their delivery.",
    access: "read",
    permission: "alerts:read",
    owner: "W6",
    method: "GET",
    path: () => "/alerts",
  }),
  siteTool({
    name: "alerts_create",
    title: "Create alert",
    description:
      "Create an alert. Enabled alerts send notifications (email or Telegram) to the destination.",
    access: "write",
    permission: "alerts:write",
    owner: "W6",
    method: "POST",
    path: () => "/alerts",
    shape: {
      name: z.string().min(1).max(100),
      trigger: zAlertTrigger,
      template: zAlertTemplate,
      destination: zAlertDestination.optional(),
      isEnabled: z.boolean().optional(),
    },
    body: (args) => pick(args, ["name", "trigger", "template", "destination", "isEnabled"]),
  }),
  siteTool({
    name: "alerts_update",
    title: "Update alert",
    description: "Change an alert's name, trigger, message, destination or enabled state.",
    access: "write",
    permission: "alerts:write",
    owner: "W6",
    method: "PUT",
    path: (args) => `/alerts/${enc(args.alertId)}`,
    shape: {
      alertId: zId("Alert"),
      name: z.string().min(1).max(100).optional(),
      trigger: zAlertTrigger.optional(),
      template: zAlertTemplate.partial().optional(),
      destination: zAlertDestination.optional(),
      isEnabled: z.boolean().optional(),
    },
    body: (args) => pick(args, ["name", "trigger", "template", "destination", "isEnabled"]),
  }),
  siteTool({
    name: "alerts_delete",
    title: "Delete alert",
    description: "Permanently delete an alert.",
    access: "write",
    destructive: true,
    permission: "alerts:write",
    owner: "W6",
    method: "DELETE",
    path: (args) => `/alerts/${enc(args.alertId)}`,
    shape: { alertId: zId("Alert") },
  }),
  siteTool({
    name: "alerts_history",
    title: "Alert history",
    description: "Recent alert deliveries (sent / failed) with counts.",
    access: "read",
    permission: "alerts:read",
    owner: "W6",
    method: "GET",
    path: () => "/alerts/history",
    shape: {
      alertId: z.string().max(128).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    query: (args) => pick(args, ["alertId", "limit"]),
  }),

  // ---------------------------------------------------------------- integrations (W3)
  siteTool({
    name: "integrations_status",
    title: "Payment integrations status",
    description:
      "Connection status of Stripe, Polar, Lemon Squeezy, Paddle, Dodo, Creem, Shopify and WooCommerce, for diagnosing missing revenue. Connecting providers is dashboard-only.",
    access: "read",
    permission: "settings:read",
    owner: "W3",
    method: "GET",
    path: () => "/integrations",
  }),

  // ---------------------------------------------------------------- bot traffic controls (W6)
  siteTool({
    name: "bot_traffic_settings_get",
    title: "Bot traffic settings",
    description: "Bot traffic settings plus every crawler company and agent with its state.",
    access: "read",
    permission: "settings:read",
    owner: "W6",
    method: "GET",
    path: () => "/bot-traffic/settings",
  }),
  siteTool({
    name: "bot_traffic_settings_update",
    title: "Update bot traffic settings",
    description:
      'Update verification, authentication, display, companies or individual crawlers (owners only). `settings` takes the PATCH fields, e.g. {"verifiedOnly": true, "disableCompanies": ["OpenAI"]}.',
    access: "write",
    permission: "settings:write",
    owner: "W6",
    method: "PATCH",
    path: () => "/bot-traffic/settings",
    oauthOwnerOnly: true,
    shape: { settings: z.record(z.string(), z.unknown()) },
    body: (args) => args.settings,
  }),
  siteTool({
    name: "bot_traffic_token_get",
    title: "Bot traffic token status",
    description: "Whether a dfbot_ request token exists (masked; never the secret).",
    access: "read",
    permission: "settings:read",
    oauth: ["bot-credentials:read"],
    owner: "W6",
    method: "GET",
    path: () => "/bot-traffic/token",
    oauthOwnerOnly: true,
  }),
  siteTool({
    name: "bot_traffic_token_create",
    title: "Create bot traffic token",
    description: "Create a dfbot_ ingestion token; the full value is returned once.",
    access: "write",
    destructive: true,
    permission: "settings:write",
    oauth: ["bot-credentials:write"],
    owner: "W6",
    method: "POST",
    path: () => "/bot-traffic/token",
    oauthOwnerOnly: true,
  }),
  siteTool({
    name: "bot_traffic_token_rotate",
    title: "Rotate bot traffic token",
    description: "Replace the dfbot_ token; the previous value stops working immediately.",
    access: "write",
    destructive: true,
    permission: "settings:write",
    oauth: ["bot-credentials:write"],
    owner: "W6",
    method: "PUT",
    path: () => "/bot-traffic/token",
    oauthOwnerOnly: true,
  }),
  siteTool({
    name: "bot_traffic_token_delete",
    title: "Delete bot traffic token",
    description: "Revoke the dfbot_ token and turn request authentication off.",
    access: "write",
    destructive: true,
    permission: "settings:write",
    oauth: ["bot-credentials:write"],
    owner: "W6",
    method: "DELETE",
    path: () => "/bot-traffic/token",
    oauthOwnerOnly: true,
  }),
  {
    name: "bot_traffic_usage",
    title: "Bot traffic usage",
    description:
      "Account-wide bot traffic usage per website. Needs an all-websites credential; with OAuth, every website you own must be in the connection.",
    input: z.object({}).strict(),
    access: "read",
    permission: "analytics:read",
    oauth: ["account-usage:read"],
    owner: "W6",
    site: false,
    callOptions: { allSites: true },
    guard: async (_args, tc) => {
      const conn = tc.caller.connection;
      if (!conn) return;
      const owned = await tc.env.DB.prepare(
        `SELECT m.site_id FROM memberships m JOIN sites s ON s.id = m.site_id
          WHERE m.user_id = ? AND m.role = 'owner' AND s.deleted_at IS NULL`,
      )
        .bind(tc.caller.auth.user.id)
        .all<{ site_id: string }>();
      const missing = (owned.results ?? []).filter((r) => !conn.siteIds.includes(r.site_id));
      if (missing.length) {
        throw new ToolError(
          "Account-wide usage needs every website you own in this connection. Reconnect and select all of them.",
        );
      }
    },
    request: () => ({ method: "GET", path: "/api/v1/admin/bot-traffic/usage" }),
  },
];

export { bindToConnection };
