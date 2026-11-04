/**
 * DataGoat tracker — PLACEHOLDER entry (owned by W1).
 *
 * The real tracker implements DataFast's script-tag attributes, cookies, `window.datafast()` API,
 * goals, scroll goals, outbound clicks, cross-domain linking, SPA and hash routing, and posts to
 * `/api/events` (plan §3). This placeholder only installs `window.datafast` with a queue so pages
 * that call it before the real tracker ships do not throw. It sends nothing.
 *
 * Build-time constants (tracker/build.mjs): __DG_VARIANT__ = "default" | "cookieless" | "hash".
 */
declare const __DG_VARIANT__: "default" | "cookieless" | "hash";

type DatafastFn = ((...args: unknown[]) => void) & {
  q?: unknown[][];
  visitorId?: string;
  variant?: string;
};

interface TrackerWindow {
  datafast?: DatafastFn;
  datagoat?: DatafastFn;
}

export function install(w: TrackerWindow): DatafastFn {
  const existing = w.datafast;
  const queue: unknown[][] = existing?.q ?? [];
  const fn: DatafastFn = (...args: unknown[]) => {
    queue.push(args);
  };
  fn.q = queue;
  fn.variant = __DG_VARIANT__;
  w.datafast = fn;
  w.datagoat = fn;
  return fn;
}

install(globalThis as unknown as TrackerWindow);
