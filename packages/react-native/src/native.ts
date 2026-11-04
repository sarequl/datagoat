/**
 * React Native wiring: platform info from `Platform` / `Dimensions`, flushing when the app goes to
 * the background, and an optional adapter for `@react-native-community/netinfo`.
 */
import { AppState, Dimensions, Platform } from "react-native";
import {
  type Adapters,
  DataGoatClient,
  type DataGoatConfig,
  type NetworkAdapter,
  type PlatformInfo,
  type StorageLike,
} from "./core.js";

export function nativePlatform(): PlatformInfo {
  const screen = Dimensions.get("screen");
  const win = Dimensions.get("window");
  const constants = (Platform.constants ?? {}) as Record<string, unknown>;
  const osVersion =
    Platform.OS === "android"
      ? String(constants.Release ?? Platform.Version)
      : String(Platform.Version ?? "");
  let locale = "en-US";
  let timeZone = "UTC";
  try {
    const intl = Intl.DateTimeFormat().resolvedOptions();
    locale = intl.locale || locale;
    timeZone = intl.timeZone || timeZone;
  } catch {
    // Hermes without Intl: keep the defaults
  }
  return {
    os: Platform.OS,
    osVersion,
    model: typeof constants.Model === "string" ? constants.Model : undefined,
    screen: { width: screen.width, height: screen.height },
    window: { width: win.width, height: win.height },
    locale,
    timeZone,
  };
}

/** Structural type of `@react-native-community/netinfo`'s default export. */
export interface NetInfoLike {
  fetch(): Promise<{ isConnected: boolean | null; isInternetReachable?: boolean | null }>;
  addEventListener(
    listener: (state: {
      isConnected: boolean | null;
      isInternetReachable?: boolean | null;
    }) => void,
  ): () => void;
}

export function netInfoAdapter(netInfo: NetInfoLike): NetworkAdapter {
  return {
    async isOnline() {
      const state = await netInfo.fetch();
      return state.isConnected !== false && state.isInternetReachable !== false;
    },
    subscribe(onOnline) {
      let wasOnline = true;
      return netInfo.addEventListener((state) => {
        const online = state.isConnected !== false && state.isInternetReachable !== false;
        if (online && !wasOnline) onOnline();
        wasOnline = online;
      });
    },
  };
}

export interface NativeOptions {
  /** Persistent storage, usually `@react-native-async-storage/async-storage`'s default export. */
  storage: StorageLike;
  /** `@react-native-community/netinfo`'s default export, to pause sending while offline. */
  netInfo?: NetInfoLike;
  fetch?: typeof fetch;
}

/** Create a client for this device, start periodic flushing and flush when backgrounded. */
export function createNativeClient(
  config: DataGoatConfig,
  options: NativeOptions,
): { client: DataGoatClient; dispose(): void } {
  const adapters: Adapters = {
    storage: options.storage,
    platform: nativePlatform(),
    network: options.netInfo ? netInfoAdapter(options.netInfo) : undefined,
    fetch: options.fetch,
  };
  const client = new DataGoatClient(config, adapters);
  client.start();
  const sub = AppState.addEventListener("change", (state) => {
    if (state === "background" || state === "inactive" || state === "active") void client.flush();
  });
  return {
    client,
    dispose() {
      sub.remove();
      client.stop();
    },
  };
}
