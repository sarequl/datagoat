/** MCP OAuth consent fixtures (W7). */
import type { OAuthConsentDetails, OAuthScopeInfo } from "../../../../shared/api-types";
import { demoUser } from "./core";

export const MOCK_CONSENT_REQUEST = "mock-consent-request";
export const MOCK_REDIRECT = "https://client.example/callback";

const scope = (
  s: string,
  label: string,
  access: "read" | "write",
  sensitive = false,
  requested = false,
): OAuthScopeInfo => ({
  scope: s,
  label,
  description: `${label}.`,
  access,
  sensitive,
  requested,
  defaultChecked: access === "read" && !sensitive,
});

export function consentDetails(
  signedIn: boolean,
  websites: Array<{ _id: string; domain: string; name: string | null }>,
): OAuthConsentDetails {
  return {
    client: {
      id: "dgc_mockclient",
      name: "Claude",
      clientUri: null,
      logoUri: null,
      redirectUri: MOCK_REDIRECT,
      redirectHost: "client.example",
    },
    scopes: [
      scope("websites:read", "List websites", "read"),
      scope("analytics:read", "Read analytics", "read", false, true),
      scope("visitors:details", "Read visitor identities", "read", true),
      scope("notes:write", "Manage notes", "write"),
      scope("api-keys:write", "Manage website API keys", "write", true),
    ],
    resource: "http://localhost:5173/mcp",
    expiresAt: "2026-11-04T12:10:00.000Z",
    user: signedIn ? demoUser : null,
    websites: signedIn ? websites.map((w) => ({ ...w, role: "owner" as const })) : [],
  };
}
