/**
 * TanStack Query hooks for the foundation endpoints (auth, setup, websites). Feature teams add
 * their own hooks next to their pages and use `queryKeys` conventions: [area, websiteId, ...params].
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreatedWebsite,
  CreateWebsiteRequest,
  LoginRequest,
  Me,
  SetupRequest,
  SetupResult,
  SetupStatus,
  WebsiteSummary,
} from "../../../shared/api-types";
import { ApiClientError, api, apiGet } from "./client";

export const queryKeys = {
  me: ["auth", "me"] as const,
  setup: ["setup"] as const,
  websites: ["admin", "websites"] as const,
};

/** Current user, or null when signed out (401). */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await apiGet<Me>("/api/auth/me");
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

export function useSetupStatus() {
  return useQuery({ queryKey: queryKeys.setup, queryFn: () => apiGet<SetupStatus>("/api/setup") });
}

export function useWebsites() {
  return useQuery({
    queryKey: queryKeys.websites,
    queryFn: () => apiGet<WebsiteSummary[]>("/api/v1/admin/websites"),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: LoginRequest) => (await api.post<Me>("/api/auth/login", body)).data,
    onSuccess: (me) => {
      qc.setQueryData(queryKeys.me, me);
      qc.setQueryData(queryKeys.websites, me.websites);
    },
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: SetupRequest) =>
      (await api.post<SetupResult>("/api/setup", body)).data,
    onSuccess: (result) => {
      qc.setQueryData(queryKeys.me, result);
      qc.setQueryData(queryKeys.websites, result.websites);
      qc.setQueryData(queryKeys.setup, { needsSetup: false, configErrors: [] });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post("/api/auth/logout")).data,
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(queryKeys.me, null);
    },
  });
}

export function useCreateWebsite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateWebsiteRequest) =>
      (await api.post<CreatedWebsite[]>("/api/v1/admin/websites", body)).data[0] as CreatedWebsite,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.websites });
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}
