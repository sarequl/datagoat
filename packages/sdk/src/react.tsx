"use client";

/**
 * @datagoat/sdk/react: a provider that adds the tracker once, and hooks for goals and identify.
 *
 *   <DataGoatProvider websiteId="dfid_..." domain="example.com" host="https://a.example.com">
 *     <App />
 *   </DataGoatProvider>
 *
 *   const { track } = useDataGoat();
 *   <button onClick={() => track("signup", { plan: "pro" })}>Sign up</button>
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import {
  consent,
  type DataGoatOptions,
  type GoalParams,
  getSessionId,
  getVisitorId,
  type IdentifyProfile,
  identify,
  init,
  payment,
  track,
} from "./index.js";

export interface DataGoatApi {
  track(goal: string, params?: GoalParams): boolean;
  identify(userId: string, profile?: IdentifyProfile): boolean;
  payment(email: string): boolean;
  consent(granted: boolean): boolean;
  getVisitorId(): string | null;
  getSessionId(): string | null;
}

const api: DataGoatApi = { track, identify, payment, consent, getVisitorId, getSessionId };
const DataGoatContext = createContext<DataGoatApi>(api);

export interface DataGoatProviderProps extends DataGoatOptions {
  children?: ReactNode;
}

export function DataGoatProvider({ children, ...options }: DataGoatProviderProps) {
  // Re-run only when the identity of the tracker changes, not on every render.
  const key = JSON.stringify(options);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialised options
  useEffect(() => {
    init(options);
  }, [key]);
  return <DataGoatContext.Provider value={api}>{children}</DataGoatContext.Provider>;
}

/** `{track, identify, payment, consent, getVisitorId, getSessionId}`; works with or without the provider. */
export function useDataGoat(): DataGoatApi {
  return useContext(DataGoatContext);
}

/** Identify the signed-in user whenever it changes (pass null when signed out). */
export function useIdentify(userId: string | null | undefined, profile?: IdentifyProfile): void {
  const key = profile ? JSON.stringify(profile) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialised profile
  useEffect(() => {
    if (userId) identify(userId, profile);
  }, [userId, key]);
}

/** Fire a goal once when a component mounts (e.g. a paywall or a thank-you screen). */
export function useGoalOnMount(goal: string, params?: GoalParams): void {
  const key = useMemo(() => JSON.stringify(params ?? {}), [params]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialised params
  useEffect(() => {
    track(goal, params);
  }, [goal, key]);
}
