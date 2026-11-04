/**
 * Mutable mock state (signed-in user, websites, and the settings resources the settings pages
 * edit: team, invites, keys, tokens, integrations). `resetMockState()` restores the defaults.
 */
import type {
  AccessToken,
  GrowthIntegrationStatus,
  IntegrationsStatus,
  OAuthConnection,
  PendingInvite,
  TeamMember,
  Website,
  WebsiteKey,
} from "../../../shared/api-types";
import {
  accessTokens,
  demoUser,
  pendingInvites,
  websites as seedWebsites,
  team,
  websiteKeys,
} from "./fixtures/core";
import { growthIntegration, integrations, oauthConnections } from "./fixtures/growth";

export interface MockState {
  signedIn: boolean;
  needsSetup: boolean;
  user: typeof demoUser;
  websites: Website[];
  /** Per website id. Missing entries are seeded from the fixtures on first use. */
  team: Record<string, TeamMember[]>;
  invites: Record<string, PendingInvite[]>;
  siteKeys: Record<string, WebsiteKey[]>;
  accessTokens: AccessToken[];
  integrations: Record<string, IntegrationsStatus>;
  growth: Record<string, GrowthIntegrationStatus>;
  oauthConnections: OAuthConnection[];
  /** Realtime polls answered per website created during the session (install verification). */
  installPolls: Record<string, number>;
}

function initial(): MockState {
  return {
    signedIn: false,
    needsSetup: false,
    user: { ...demoUser },
    websites: seedWebsites.map((w) => ({ ...w })),
    team: {},
    invites: {},
    siteKeys: {},
    accessTokens: accessTokens.map((t) => ({ ...t })),
    integrations: {},
    growth: {},
    oauthConnections: oauthConnections.map((c) => ({ ...c })),
    installPolls: {},
  };
}

export const state: MockState = initial();

export function resetMockState(overrides: Partial<MockState> = {}): void {
  Object.assign(state, initial(), overrides);
}

const isSeed = (siteId: string) => seedWebsites.some((w) => w._id === siteId);

export function teamOf(siteId: string): TeamMember[] {
  state.team[siteId] ??= isSeed(siteId)
    ? team.map((m) => ({ ...m }))
    : [{ ...(team[0] as TeamMember), joinedAt: new Date().toISOString() }];
  return state.team[siteId];
}

export function invitesOf(siteId: string): PendingInvite[] {
  state.invites[siteId] ??= isSeed(siteId) ? pendingInvites.map((i) => ({ ...i })) : [];
  return state.invites[siteId];
}

export function keysOf(siteId: string): WebsiteKey[] {
  state.siteKeys[siteId] ??= isSeed(siteId) ? websiteKeys(siteId) : [];
  return state.siteKeys[siteId];
}

export function integrationsOf(siteId: string): IntegrationsStatus {
  state.integrations[siteId] ??= isSeed(siteId)
    ? structuredClone(integrations)
    : {
        stripe: { connected: false },
        lemonsqueezy: { connected: false },
        polar: { connected: false },
        paddle: { connected: false, keyExpiresAt: null },
        shopify: { connected: false },
        woocommerce: { connected: false },
        dodo: { connected: false },
        creem: { connected: false },
        currency: state.websites.find((w) => w._id === siteId)?.currency ?? "USD",
        details: [],
      };
  return state.integrations[siteId];
}

export function growthOf(
  siteId: string,
  kind: GrowthIntegrationStatus["kind"],
): GrowthIntegrationStatus {
  const key = `${siteId}:${kind}`;
  state.growth[key] ??= isSeed(siteId)
    ? growthIntegration(kind)
    : { ...growthIntegration(kind), connected: false, status: null };
  return state.growth[key];
}

/** True for websites added during this mock session (not in the seed fixtures). */
export function isNewSite(siteId: string): boolean {
  return !isSeed(siteId) && state.websites.some((w) => w._id === siteId);
}
