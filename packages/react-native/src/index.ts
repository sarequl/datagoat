/**
 * @datagoat/react-native: DataGoat analytics for React Native and Expo apps.
 * Screens, goals and identify with an offline queue, posting to your DataGoat collector.
 */
export {
  type Adapters,
  createMemoryStorage,
  DataGoatClient,
  type DataGoatConfig,
  type EventBody,
  mobileUserAgent,
  type NetworkAdapter,
  type Params,
  type PlatformInfo,
  SDK_VERSION,
  SESSION_TIMEOUT_MS,
  type StorageLike,
  screenPath,
} from "./core.js";
export {
  createNativeClient,
  type NativeOptions,
  type NetInfoLike,
  nativePlatform,
  netInfoAdapter,
} from "./native.js";
export {
  DataGoatProvider,
  type DataGoatProviderProps,
  type NavigationRefLike,
  trackNavigation,
  useDataGoat,
  useDataGoatIdentify,
  useDataGoatScreen,
  useDataGoatTrack,
} from "./react.js";
