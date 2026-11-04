/**
 * The few react-native APIs this package uses, so it type-checks inside the DataGoat monorepo
 * without installing React Native. Apps get the real types from their own react-native install.
 */
declare module "react-native" {
  export const Platform: {
    OS: "ios" | "android" | "web" | "windows" | "macos";
    Version: number | string;
    constants?: Record<string, unknown>;
  };
  export const Dimensions: {
    get(dim: "window" | "screen"): {
      width: number;
      height: number;
      scale: number;
      fontScale: number;
    };
  };
  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";
  export const AppState: {
    currentState: AppStateStatus;
    addEventListener(type: "change", listener: (state: AppStateStatus) => void): { remove(): void };
  };
}
