/**
 * React bindings: provider and hooks.
 *
 *   <DataGoatProvider config={{ websiteId, domain, host }} storage={AsyncStorage} netInfo={NetInfo}>
 *     <App />
 *   </DataGoatProvider>
 *
 *   useDataGoatScreen("HomeScreen");
 *   const track = useDataGoatTrack();  track("upgrade_click", { source: "home" });
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { DataGoatClient, DataGoatConfig, Params } from "./core.js";
import { createNativeClient, type NativeOptions } from "./native.js";

const Context = createContext<DataGoatClient | null>(null);

export interface DataGoatProviderProps extends NativeOptions {
  config: DataGoatConfig;
  children?: ReactNode;
}

export function DataGoatProvider({
  config,
  storage,
  netInfo,
  fetch,
  children,
}: DataGoatProviderProps) {
  const [client, setClient] = useState<DataGoatClient | null>(null);
  const configKey = JSON.stringify(config);
  const deps = useRef({ storage, netInfo, fetch });
  deps.current = { storage, netInfo, fetch };
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialised config
  useEffect(() => {
    const { client: created, dispose } = createNativeClient(config, deps.current);
    setClient(created);
    return () => {
      void created.flush();
      dispose();
    };
  }, [configKey]);
  return <Context.Provider value={client}>{children}</Context.Provider>;
}

/** The client (null until the provider has mounted). */
export function useDataGoat(): DataGoatClient | null {
  return useContext(Context);
}

/** `track(goal, params)`, safe to call before the client exists (the call is dropped then). */
export function useDataGoatTrack(): (goal: string, params?: Params) => void {
  const client = useDataGoat();
  return useCallback(
    (goal: string, params?: Params) => {
      void client?.track(goal, params);
    },
    [client],
  );
}

/** Report a screen view when the component mounts and whenever `name` changes. */
export function useDataGoatScreen(name: string): void {
  const client = useDataGoat();
  useEffect(() => {
    if (client && name) void client.trackScreen(name);
  }, [client, name]);
}

/** Identify the signed-in user (call on every app start while signed in). */
export function useDataGoatIdentify(userId: string | null | undefined, profile?: Params): void {
  const client = useDataGoat();
  const key = profile ? JSON.stringify(profile) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialised profile
  useEffect(() => {
    if (client && userId) void client.identify(userId, profile);
  }, [client, userId, key]);
}

/** Structural type of a React Navigation container ref. */
export interface NavigationRefLike {
  getCurrentRoute(): { name: string } | undefined;
  addListener(event: "state", cb: () => void): () => void;
}

/**
 * Track every React Navigation screen change: `trackNavigation(client, navigationRef)` in the
 * container's `onReady`. Returns an unsubscribe function.
 */
export function trackNavigation(client: DataGoatClient, ref: NavigationRefLike): () => void {
  const report = () => {
    const route = ref.getCurrentRoute();
    if (route?.name) void client.trackScreen(route.name);
  };
  report();
  return ref.addListener("state", report);
}
