// Test stand-in for "react-native" (aliased in packages/vitest.config.ts).
type Listener = (state: string) => void;
const listeners = new Set<Listener>();

export const Platform = {
  OS: "ios" as const,
  Version: "18.1",
  constants: { systemName: "iOS" } as Record<string, unknown>,
};

export const Dimensions = {
  get: (dim: "window" | "screen") =>
    dim === "screen"
      ? { width: 393, height: 852, scale: 3, fontScale: 1 }
      : { width: 393, height: 800, scale: 3, fontScale: 1 },
};

export const AppState = {
  currentState: "active",
  addEventListener(_type: "change", listener: Listener) {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
  /** Test helper. */
  emit(state: string) {
    for (const l of listeners) l(state);
  },
  listenerCount: () => listeners.size,
};
