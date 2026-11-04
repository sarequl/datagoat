/**
 * OAuth scopes for MCP connections (DataFast's MCP OAuth permission list).
 *
 * Most scopes are DataGoat API permissions (shared/permissions.ts) and grant exactly that
 * permission to the connection. A few are MCP-only and gate tools whose REST endpoint uses a
 * broader permission: `account:*` (profile), `access-tokens:*` (dft_ tokens, REST `api-keys:*`),
 * `visitors:*` (visitor journeys and identifiers), `bot-credentials:*` (dfbot_ ingestion tokens,
 * REST `settings:*`) and `account-usage:read` (account-wide bot traffic usage).
 *
 * There is no wildcard: a connection holds the scopes the user ticked on the consent page.
 */
import { isPermission, type Permission } from "../../../shared/permissions";

export interface ScopeInfo {
  scope: string;
  label: string;
  description: string;
  /** Read scopes are pre-selected on the consent page; sensitive ones never are. */
  access: "read" | "write";
  sensitive: boolean;
}

export const OAUTH_SCOPES: readonly ScopeInfo[] = [
  {
    scope: "websites:read",
    label: "List websites",
    description: "Names, domains and your team role for the selected websites.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "analytics:read",
    label: "Read analytics",
    description:
      "Traffic, revenue, goals and goal parameters, funnels results, realtime counts and social mentions. Recorded URLs and custom parameters may contain personal data.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "visitors:read",
    label: "Read visitor journeys",
    description:
      "Search visitors and read individual journeys and purchases, without names or emails. Also needs analytics:read.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "visitors:details",
    label: "Read visitor identities",
    description:
      "Customer names and emails on visitors and payments, and the raw realtime map. Also needs analytics:read and visitors:read.",
    access: "read",
    sensitive: true,
  },
  {
    scope: "goals:read",
    label: "Read goals",
    description: "Tracked goals and their display settings.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "goals:write",
    label: "Manage goals",
    description: "Record or delete goal events and change goal display settings.",
    access: "write",
    sensitive: false,
  },
  {
    scope: "funnels:read",
    label: "Read funnels",
    description: "Funnel definitions.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "funnels:write",
    label: "Manage funnels",
    description: "Create, edit and delete funnels.",
    access: "write",
    sensitive: false,
  },
  {
    scope: "notes:read",
    label: "Read notes",
    description: "Manual chart notes, their text and timestamps.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "notes:write",
    label: "Manage notes",
    description: "Create, edit and delete manual chart notes.",
    access: "write",
    sensitive: false,
  },
  {
    scope: "alerts:read",
    label: "Read alerts",
    description: "Alerts and their delivery history.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "alerts:write",
    label: "Manage alerts",
    description: "Create, edit and delete alerts, including who gets notified.",
    access: "write",
    sensitive: false,
  },
  {
    scope: "settings:read",
    label: "Read settings",
    description: "Website settings, payment integration status and bot traffic settings.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "settings:write",
    label: "Change settings",
    description: "Edit website names, domains, timezones, display and bot traffic settings.",
    access: "write",
    sensitive: false,
  },
  {
    scope: "team:read",
    label: "Read team",
    description: "Team members with names, emails and roles.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "team:write",
    label: "Manage team",
    description: "Invite, remove or change team members. Only website owners can do this.",
    access: "write",
    sensitive: true,
  },
  {
    scope: "account:read",
    label: "Read your account",
    description: "Your profile, email and plan information.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "account:write",
    label: "Change your account",
    description: "Change your display name.",
    access: "write",
    sensitive: true,
  },
  {
    scope: "websites:write",
    label: "Create websites",
    description: "Create websites in your account. Websites created this way join this connection.",
    access: "write",
    sensitive: true,
  },
  {
    scope: "api-keys:read",
    label: "Read website API keys",
    description: "API key names and prefixes for the selected websites. Secrets are never shown.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "api-keys:write",
    label: "Manage website API keys",
    description:
      "Create, roll or delete df_ keys. New keys expire with this connection. Owners only.",
    access: "write",
    sensitive: true,
  },
  {
    scope: "access-tokens:read",
    label: "Read account tokens",
    description: "dft_ token metadata within this connection's websites and permissions.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "access-tokens:write",
    label: "Manage account tokens",
    description:
      "Create or delete dft_ tokens limited to this connection's access. New tokens expire with it.",
    access: "write",
    sensitive: true,
  },
  {
    scope: "bot-credentials:read",
    label: "Read bot traffic token status",
    description: "Whether a bot traffic ingestion token exists, masked. Owners only.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "bot-credentials:write",
    label: "Manage bot traffic tokens",
    description: "Create, rotate or delete dfbot_ ingestion tokens. Owners only.",
    access: "write",
    sensitive: true,
  },
  {
    scope: "account-usage:read",
    label: "Read bot traffic usage",
    description: "Account-wide bot traffic usage. Requires every website you own to be selected.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "payments:read",
    label: "Read payments",
    description: "Lets credentials created through this connection read payments.",
    access: "read",
    sensitive: false,
  },
  {
    scope: "payments:write",
    label: "Record payments",
    description: "Lets credentials created through this connection record or delete payments.",
    access: "write",
    sensitive: true,
  },
  {
    scope: "identify:write",
    label: "Identify visitors",
    description: "Lets credentials created through this connection identify visitors.",
    access: "write",
    sensitive: true,
  },
];

export type OAuthScope = string;

export const SUPPORTED_SCOPES: readonly string[] = OAUTH_SCOPES.map((s) => s.scope);

export function isSupportedScope(scope: string): boolean {
  return SUPPORTED_SCOPES.includes(scope);
}

/** The scopes pre-selected on the consent page when the client asked for nothing specific. */
export const DEFAULT_SCOPES: readonly string[] = OAUTH_SCOPES.filter(
  (s) => s.access === "read" && !s.sensitive && !["account-usage:read"].includes(s.scope),
).map((s) => s.scope);

/** Parse a space-separated `scope` parameter, keeping supported scopes in catalog order. */
export function parseScopeParam(value: string | null | undefined): string[] {
  if (!value) return [];
  const asked = new Set(value.split(/\s+/).filter(Boolean));
  return SUPPORTED_SCOPES.filter((s) => asked.has(s));
}

/** The DataGoat API permissions a connection holds directly (scopes that are permissions). */
export function permissionsOfScopes(scopes: readonly string[]): Permission[] {
  return scopes.filter((s): s is Permission => isPermission(s));
}
