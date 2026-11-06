/**
 * TanStack Query hooks for the website resources the analytics pages read and write
 * (docs/api/contract.md §6–§11). Keys follow `[area, websiteId, ...params]`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdsSummary,
  Funnel,
  FunnelResult,
  FunnelStep,
  GithubCommit,
  GoalColor,
  GoalCustomization,
  Mention,
  Metadata,
  MrrSummary,
  Note,
  PaymentRow,
  RealtimeMap,
  RealtimeReplay,
  RevenueSummary,
  SearchConsoleStatus,
  Segment,
  TrackedGoal,
  VisitorListRow,
  VisitorProfile,
  Website,
} from "../../../shared/api-types";
import { api, apiGet, type Query } from "../api/client";

const admin = (websiteId: string) => `/api/v1/admin/websites/${encodeURIComponent(websiteId)}`;

export function useWebsite(websiteId: string) {
  return useQuery({
    queryKey: ["website", websiteId],
    queryFn: async () => (await apiGet<Website[]>(admin(websiteId)))[0] as Website,
    staleTime: 60_000,
  });
}

export function useMetadata(websiteId: string) {
  return useQuery({
    queryKey: ["metadata", websiteId],
    queryFn: async () =>
      (await apiGet<Metadata[]>("/api/v1/analytics/metadata", { websiteId }))[0] as Metadata,
    staleTime: 60_000,
  });
}

export function useSetKpi(websiteId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (kpi: string | null) =>
      (await api.put<Website[]>(admin(websiteId), { kpi })).data[0] as Website,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["metadata", websiteId] });
      void qc.invalidateQueries({ queryKey: ["website", websiteId] });
    },
  });
}

// Notes -------------------------------------------------------------------

export function useNotes(websiteId: string, params: Query, enabled = true) {
  return useQuery({
    queryKey: ["notes", websiteId, params],
    queryFn: () => apiGet<Note[]>(`${admin(websiteId)}/notes`, { limit: 1000, ...params }),
    enabled,
  });
}

export function useNoteMutations(websiteId: string) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ["notes", websiteId] });
  return {
    create: useMutation({
      mutationFn: async (body: { text: string; timestamp: string }) =>
        (await api.post<Note[]>(`${admin(websiteId)}/notes`, body)).data[0] as Note,
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: async ({ id, ...body }: { id: string; text?: string; timestamp?: string }) =>
        (await api.put<Note[]>(`${admin(websiteId)}/notes/${id}`, body)).data[0] as Note,
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => api.delete(`${admin(websiteId)}/notes/${id}`),
      onSuccess: done,
    }),
  };
}

// Chart overlays (W6) -------------------------------------------------------

export function useCommits(websiteId: string, params: Query, enabled = true) {
  return useQuery({
    queryKey: ["github-commits", websiteId, params],
    queryFn: () => apiGet<GithubCommit[]>("/api/v1/github/commits", { websiteId, ...params }),
    enabled,
    retry: false,
  });
}

export function useMentions(websiteId: string, params: Query, enabled = true) {
  return useQuery({
    queryKey: ["mentions", websiteId, params],
    queryFn: () => apiGet<Mention[]>("/api/v1/mentions", { websiteId, limit: 100, ...params }),
    enabled,
    retry: false,
  });
}

// Segments ----------------------------------------------------------------

export function useSegments(websiteId: string, enabled = true) {
  return useQuery({
    queryKey: ["segments", websiteId],
    queryFn: () => apiGet<Segment[]>(`${admin(websiteId)}/segments`),
    enabled,
  });
}

export function useSegmentMutations(websiteId: string) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ["segments", websiteId] });
  return {
    create: useMutation({
      mutationFn: async (body: { name: string; filters: Record<string, string> }) =>
        (await api.post<Segment[]>(`${admin(websiteId)}/segments`, body)).data[0] as Segment,
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: async ({
        id,
        ...body
      }: {
        id: string;
        name?: string;
        filters?: Record<string, string>;
      }) => (await api.put<Segment[]>(`${admin(websiteId)}/segments/${id}`, body)).data[0],
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => api.delete(`${admin(websiteId)}/segments/${id}`),
      onSuccess: done,
    }),
  };
}

// Goals -------------------------------------------------------------------

export function useTrackedGoals(websiteId: string, enabled = true) {
  return useQuery({
    queryKey: ["tracked-goals", websiteId],
    queryFn: () => apiGet<TrackedGoal[]>(`${admin(websiteId)}/goals`),
    enabled,
  });
}

export function useGoalCustomizations(websiteId: string, enabled = true) {
  return useQuery({
    queryKey: ["goal-customizations", websiteId],
    queryFn: async () => {
      const res = await api.get<GoalCustomization[]>(`${admin(websiteId)}/goals/customizations`);
      return {
        items: res.data,
        colors: (res.raw.colors as GoalColor[] | undefined) ?? [],
      };
    },
    enabled,
  });
}

export function useGoalCustomizationMutations(websiteId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["goal-customizations", websiteId] });
    void qc.invalidateQueries({ queryKey: ["tracked-goals", websiteId] });
  };
  return {
    save: useMutation({
      mutationFn: async (body: {
        goalName: string;
        displayName?: string | null;
        color?: string | null;
        description?: string | null;
        hidden?: boolean;
      }) => api.patch<GoalCustomization[]>(`${admin(websiteId)}/goals/customizations`, body),
      onSuccess: done,
    }),
    reset: useMutation({
      mutationFn: async (goalName: string) =>
        api.delete(`${admin(websiteId)}/goals/customizations`, undefined, { goalName }),
      onSuccess: done,
    }),
  };
}

// Funnels -----------------------------------------------------------------

export function useFunnels(websiteId: string) {
  return useQuery({
    queryKey: ["funnels", websiteId],
    queryFn: () => apiGet<Funnel[]>(`${admin(websiteId)}/funnels`),
  });
}

export function useFunnelResult(
  websiteId: string,
  funnelId: string,
  params: Query,
  enabled = true,
) {
  return useQuery({
    queryKey: ["funnel-result", websiteId, funnelId, params],
    queryFn: async () =>
      (
        await apiGet<FunnelResult[]>(`/api/v1/analytics/funnels/${encodeURIComponent(funnelId)}`, {
          websiteId,
          ...params,
        })
      )[0] as FunnelResult,
    enabled: enabled && Boolean(funnelId),
    placeholderData: (prev) => prev,
  });
}

export function useFunnelMutations(websiteId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["funnels", websiteId] });
    void qc.invalidateQueries({ queryKey: ["funnel-result", websiteId] });
  };
  return {
    create: useMutation({
      mutationFn: async (body: { name: string; steps: FunnelStep[] }) =>
        (await api.post<Funnel[]>(`${admin(websiteId)}/funnels`, body)).data[0] as Funnel,
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: async ({
        id,
        ...body
      }: {
        id: string;
        name?: string;
        steps?: FunnelStep[];
        isActive?: boolean;
      }) => (await api.put<Funnel[]>(`${admin(websiteId)}/funnels/${id}`, body)).data[0] as Funnel,
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: async (id: string) => api.delete(`${admin(websiteId)}/funnels/${id}`),
      onSuccess: done,
    }),
  };
}

// Visitors ----------------------------------------------------------------

export function useVisitors(websiteId: string, params: Query) {
  return useQuery({
    queryKey: ["visitors", websiteId, params],
    queryFn: () => api.get<VisitorListRow[]>("/api/v1/visitors", { websiteId, ...params }),
    placeholderData: (prev) => prev,
  });
}

export function useVisitor(websiteId: string, visitorId: string) {
  return useQuery({
    queryKey: ["visitor", websiteId, visitorId],
    queryFn: () =>
      apiGet<VisitorProfile>(`/api/v1/visitors/${encodeURIComponent(visitorId)}`, { websiteId }),
  });
}

// Realtime ----------------------------------------------------------------

const sharePath = (token: string, endpoint: string) =>
  `/api/share/${encodeURIComponent(token)}/analytics/${endpoint}`;

/** Live map data; `shareToken` reads it through a public share link instead. */
export function useRealtimeMap(
  websiteId: string,
  refetchInterval: number | false = 15_000,
  shareToken?: string,
) {
  return useQuery({
    queryKey: ["realtime-map", shareToken ? `share:${shareToken}` : websiteId],
    queryFn: () =>
      shareToken
        ? apiGet<RealtimeMap>(sharePath(shareToken, "realtime/map"))
        : apiGet<RealtimeMap>("/api/v1/analytics/realtime/map", { websiteId }),
    refetchInterval,
  });
}

export function useRealtimeCount(websiteId: string, enabled = true) {
  return useQuery({
    queryKey: ["realtime", websiteId],
    queryFn: async () =>
      (
        (
          await apiGet<Array<{ visitors: number }>>("/api/v1/analytics/realtime", {
            websiteId,
            fields: "visitors",
          })
        )[0] ?? { visitors: 0 }
      ).visitors,
    refetchInterval: 30_000,
    enabled,
  });
}

export function useRealtimeReplay(websiteId: string, enabled: boolean, shareToken?: string) {
  return useQuery({
    queryKey: ["realtime-replay", shareToken ? `share:${shareToken}` : websiteId],
    queryFn: () =>
      shareToken
        ? apiGet<RealtimeReplay>(sharePath(shareToken, "realtime/replay"))
        : apiGet<RealtimeReplay>("/api/v1/analytics/realtime/replay", { websiteId }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// Revenue (W3) ------------------------------------------------------------

export function usePayments(websiteId: string, params: Query) {
  return useQuery({
    queryKey: ["payments", websiteId, params],
    queryFn: () => api.get<PaymentRow[]>("/api/v1/payments", { websiteId, ...params }),
    placeholderData: (prev) => prev,
  });
}

/** Current MRR of live subscriptions (DG `/api/v1/analytics/revenue/mrr`). */
export function useMrr(websiteId: string, enabled = true) {
  return useQuery({
    queryKey: ["mrr", websiteId],
    queryFn: () => apiGet<MrrSummary>("/api/v1/analytics/revenue/mrr", { websiteId }),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** Meta Ads spend and ROAS for the period; `campaigns === 0` when Meta Ads is not set up. */
export function useAdsSummary(websiteId: string, params: Query, enabled = true) {
  return useQuery({
    queryKey: ["ads-summary", websiteId, params],
    queryFn: () => apiGet<AdsSummary>("/api/v1/ads/summary", { websiteId, ...params }),
    enabled,
    retry: false,
  });
}

/** Whether Google Search Console is connected (decides the overview's Keyword tab). */
export function useSearchConsoleConnected(websiteId: string, enabled = true) {
  return useQuery({
    queryKey: ["gsc-connected", websiteId],
    queryFn: async () =>
      (
        await apiGet<SearchConsoleStatus>("/api/v1/search-console/status", {
          websiteId,
          properties: 0,
        })
      ).connected,
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useRevenueSummary(websiteId: string, params: Query) {
  return useQuery({
    queryKey: ["revenue-summary", websiteId, params],
    queryFn: () => apiGet<RevenueSummary>("/api/v1/analytics/revenue", { websiteId, ...params }),
    placeholderData: (prev) => prev,
  });
}
