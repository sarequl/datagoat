/**
 * Data hooks for the settings, admin and account pages (docs/api/contract.md §2, §3, §8, §10–§12).
 * Query keys follow [area, websiteId, ...].
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import type {
  AccessToken,
  CreateAccessTokenRequest,
  CreatedInvite,
  GrowthIntegrationStatus,
  IntegrationsStatus,
  MessageResult,
  OAuthConnection,
  PendingInvite,
  Realtime,
  ShareLink,
  TeamMember,
  TrackedGoal,
  Usage,
  Website,
  WebsiteKey,
  WebsiteUpdate,
} from "../../../../../shared/api-types";
import { type Permission, type Role, roleAllows } from "../../../../../shared/permissions";
import { api, apiGet } from "../../../api/client";
import { queryKeys, useMe } from "../../../api/hooks";

const W = (siteId: string) => `/api/v1/admin/websites/${encodeURIComponent(siteId)}`;

export const settingsKeys = {
  website: (siteId: string) => ["settings", siteId, "website"] as const,
  team: (siteId: string) => ["settings", siteId, "team"] as const,
  invites: (siteId: string) => ["settings", siteId, "invites"] as const,
  keys: (siteId: string) => ["settings", siteId, "keys"] as const,
  integrations: (siteId: string) => ["settings", siteId, "integrations"] as const,
  growth: (siteId: string, kind: GrowthKind) => ["settings", siteId, "growth", kind] as const,
  share: (siteId: string) => ["settings", siteId, "share"] as const,
  usage: (siteId: string) => ["settings", siteId, "usage"] as const,
  goals: (siteId: string) => ["settings", siteId, "goals"] as const,
  realtime: (siteId: string) => ["settings", siteId, "realtime"] as const,
  tokens: ["account", "tokens"] as const,
  connections: ["account", "oauth-connections"] as const,
};

export function useSiteId(): string {
  const { siteId } = useParams({ strict: false }) as { siteId?: string };
  return siteId ?? "";
}

/** The signed-in user's role on a website and what it allows (shared/permissions.ts). */
export function useAccess(siteId: string) {
  const me = useMe();
  const role: Role = me.data?.websites.find((w) => w._id === siteId)?.role ?? "viewer";
  const can = (permission: Permission) => roleAllows(role, permission);
  return {
    role,
    userId: me.data?.user.id ?? null,
    isOwner: role === "owner",
    canEditSettings: can("settings:write"),
    canManageTeam: can("team:write"),
    canManageKeys: can("api-keys:write"),
  };
}

// ---------------------------------------------------------------------------
// Website settings
// ---------------------------------------------------------------------------

export function useWebsite(siteId: string) {
  return useQuery({
    queryKey: settingsKeys.website(siteId),
    queryFn: async () => (await apiGet<Website[]>(W(siteId)))[0] as Website,
    enabled: Boolean(siteId),
  });
}

export function useUpdateWebsite(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: WebsiteUpdate) =>
      (await api.put<Website[]>(W(siteId), body)).data[0] as Website,
    onSuccess: (website, body) => {
      qc.setQueryData(settingsKeys.website(siteId), website);
      if ("name" in body || "domain" in body || "timezone" in body || "currency" in body) {
        void qc.invalidateQueries({ queryKey: queryKeys.me });
        void qc.invalidateQueries({ queryKey: queryKeys.websites });
      }
      if ("isPublicDashboardEnabled" in body || "isPublicDataEnabled" in body) {
        void qc.invalidateQueries({ queryKey: settingsKeys.share(siteId) });
      }
    },
  });
}

export function useDeleteWebsite(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.delete<MessageResult[]>(W(siteId))).data[0],
    onSuccess: async () => {
      qc.removeQueries({ queryKey: ["settings", siteId] });
      await qc.invalidateQueries({ queryKey: queryKeys.me });
      await qc.invalidateQueries({ queryKey: queryKeys.websites });
    },
  });
}

/** Goals seen on the website (for the #1 KPI picker). */
export function useTrackedGoals(siteId: string) {
  return useQuery({
    queryKey: settingsKeys.goals(siteId),
    queryFn: () => apiGet<TrackedGoal[]>(`${W(siteId)}/goals`),
    enabled: Boolean(siteId),
  });
}

/**
 * Installation check: visitors active in the last minutes. Polls while `poll` is true so the
 * install page notices the first event without a reload.
 */
export function useRealtimeVisitors(siteId: string, poll: boolean) {
  return useQuery({
    queryKey: settingsKeys.realtime(siteId),
    queryFn: async () =>
      (await apiGet<Realtime[]>("/api/v1/analytics/realtime", { websiteId: siteId }))[0]
        ?.visitors ?? 0,
    enabled: Boolean(siteId),
    refetchInterval: poll ? 5000 : false,
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export function useTeam(siteId: string) {
  return useQuery({
    queryKey: settingsKeys.team(siteId),
    queryFn: () => apiGet<TeamMember[]>(`${W(siteId)}/team`),
  });
}

export function usePendingInvites(siteId: string) {
  return useQuery({
    queryKey: settingsKeys.invites(siteId),
    queryFn: () => apiGet<PendingInvite[]>(`${W(siteId)}/team/invites`),
  });
}

function useTeamMutation<V, R>(siteId: string, fn: (vars: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: settingsKeys.team(siteId) });
      void qc.invalidateQueries({ queryKey: settingsKeys.invites(siteId) });
    },
  });
}

export function useInvite(siteId: string) {
  return useTeamMutation(
    siteId,
    async (body: { email: string; role: "member" | "viewer" }) =>
      (await api.post<CreatedInvite[]>(`${W(siteId)}/team`, body)).data[0] as CreatedInvite,
  );
}

export function useChangeRole(siteId: string) {
  return useTeamMutation(
    siteId,
    async (body: { userId: string; role: Role }) =>
      (await api.put<MessageResult[]>(`${W(siteId)}/team`, body)).data[0],
  );
}

export function useRemoveMember(siteId: string) {
  return useTeamMutation(
    siteId,
    async (userId: string) =>
      (await api.delete<MessageResult[]>(`${W(siteId)}/team`, { userId })).data[0],
  );
}

export function useRevokeInvite(siteId: string) {
  return useTeamMutation(
    siteId,
    async (invitationId: string) =>
      (
        await api.delete<MessageResult[]>(
          `${W(siteId)}/team/invites/${encodeURIComponent(invitationId)}`,
        )
      ).data[0],
  );
}

// ---------------------------------------------------------------------------
// API keys (df_) and account tokens (dft_)
// ---------------------------------------------------------------------------

export function useWebsiteKeys(siteId: string) {
  return useQuery({
    queryKey: settingsKeys.keys(siteId),
    queryFn: () => apiGet<WebsiteKey[]>(`${W(siteId)}/apikeys`),
  });
}

function useKeyMutation<V>(siteId: string, fn: (vars: V) => Promise<WebsiteKey | undefined>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.keys(siteId) }),
  });
}

export function useCreateWebsiteKey(siteId: string) {
  return useKeyMutation(
    siteId,
    async (body: { name: string | null; includePii: boolean }) =>
      (await api.post<WebsiteKey[]>(`${W(siteId)}/apikeys`, body)).data[0],
  );
}

export function useRollWebsiteKey(siteId: string) {
  return useKeyMutation(
    siteId,
    async (keyId: string) =>
      (await api.put<WebsiteKey[]>(`${W(siteId)}/apikeys/${encodeURIComponent(keyId)}`)).data[0],
  );
}

export function useRevokeWebsiteKey(siteId: string) {
  return useKeyMutation(siteId, async (keyId: string) => {
    await api.delete(`${W(siteId)}/apikeys/${encodeURIComponent(keyId)}`);
    return undefined;
  });
}

export function useAccessTokens() {
  return useQuery({
    queryKey: settingsKeys.tokens,
    queryFn: () => apiGet<AccessToken[]>("/api/v1/admin/access-tokens"),
  });
}

export function useCreateAccessToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateAccessTokenRequest) =>
      (await api.post<AccessToken[]>("/api/v1/admin/access-tokens", body)).data[0] as AccessToken,
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.tokens }),
  });
}

export function useRevokeAccessToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tokenId: string) =>
      (await api.delete(`/api/v1/admin/access-tokens/${encodeURIComponent(tokenId)}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.tokens }),
  });
}

// ---------------------------------------------------------------------------
// Integrations (payment providers: W3; growth: W6)
// ---------------------------------------------------------------------------

export function useIntegrations(siteId: string) {
  return useQuery({
    queryKey: settingsKeys.integrations(siteId),
    queryFn: async () =>
      (await apiGet<IntegrationsStatus[]>(`${W(siteId)}/integrations`))[0] as IntegrationsStatus,
  });
}

type ProviderAction = "connect" | "resync" | "disconnect";

export function useProviderAction(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      provider: string;
      action: ProviderAction;
      body?: Record<string, string>;
    }) => {
      const path = `${W(siteId)}/integrations/${vars.provider}`;
      const res =
        vars.action === "connect"
          ? await api.post<Array<MessageResult & { currency?: string }>>(path, vars.body)
          : vars.action === "resync"
            ? await api.patch<MessageResult[]>(path)
            : await api.delete<MessageResult[]>(path);
      return res.data[0] as MessageResult & { currency?: string };
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.integrations(siteId) }),
  });
}

export type GrowthKind = "github" | "google-search-console" | "meta-ads" | "x";

export function useGrowthIntegration(siteId: string, kind: GrowthKind) {
  return useQuery({
    queryKey: settingsKeys.growth(siteId, kind),
    queryFn: () => apiGet<GrowthIntegrationStatus>(`${W(siteId)}/integrations/${kind}`),
  });
}

export function useSaveGrowthIntegration(siteId: string, kind: GrowthKind) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { settings: Record<string, unknown> } | { disconnect: true }) => {
      const path = `${W(siteId)}/integrations/${kind}`;
      const res =
        "disconnect" in vars
          ? await api.delete<GrowthIntegrationStatus>(path)
          : await api.put<GrowthIntegrationStatus>(path, vars.settings);
      return res.data;
    },
    onSuccess: (data) => qc.setQueryData(settingsKeys.growth(siteId, kind), data),
  });
}

/** Where the dashboard sends the browser to start a growth integration's OAuth flow. */
export function connectUrl(kind: GrowthKind, siteId: string): string {
  return `/api/connect/${kind}/start?websiteId=${encodeURIComponent(siteId)}`;
}

// ---------------------------------------------------------------------------
// Share link, usage
// ---------------------------------------------------------------------------

export function useShareLink(siteId: string) {
  return useQuery({
    queryKey: settingsKeys.share(siteId),
    queryFn: () => apiGet<ShareLink>(`${W(siteId)}/share`),
  });
}

export function useShareAction(siteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: "enable" | "rotate" | "disable") => {
      const path = `${W(siteId)}/share`;
      return action === "disable"
        ? (await api.delete<ShareLink>(path)).data
        : (await api.post<ShareLink>(path, {})).data;
    },
    onSuccess: (link) => {
      qc.setQueryData(settingsKeys.share(siteId), link);
      void qc.invalidateQueries({ queryKey: settingsKeys.website(siteId) });
    },
  });
}

export function useUsage(siteId: string) {
  return useQuery({
    queryKey: settingsKeys.usage(siteId),
    queryFn: () => apiGet<Usage>(`${W(siteId)}/usage`),
  });
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string }) =>
      (await api.put<Array<{ name: string | null }>>("/api/v1/admin/account", body)).data[0],
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async (body: { currentPassword: string; newPassword: string }) =>
      (await api.put<MessageResult>("/api/auth/password", body)).data,
  });
}

export function useLogoutEverywhere() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<MessageResult>("/api/auth/logout-all")).data,
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(queryKeys.me, null);
    },
  });
}

export function useOAuthConnections() {
  return useQuery({
    queryKey: settingsKeys.connections,
    queryFn: () => apiGet<OAuthConnection[]>("/api/v1/admin/oauth/connections"),
  });
}

export function useRevokeConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`/api/v1/admin/oauth/connections/${encodeURIComponent(id)}`)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: settingsKeys.connections }),
  });
}

/** Fields of `draft` that differ from `original` (shallow; arrays compared by value). */
export function changedFields<T extends object>(original: T, draft: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(draft) as Array<keyof T>) {
    const a = original[key];
    const b = draft[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[key] = b;
  }
  return out;
}
