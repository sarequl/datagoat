/** Per-viewer preferences in localStorage (pinned periods, card tabs). Never required to work. */

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`dg:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`dg:${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode, quota): the preference just isn't remembered
  }
}

/** True when a keyboard shortcut should be ignored (typing in a field, modifier held). */
export function isTypingTarget(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    t.isContentEditable ||
    Boolean(t.closest?.('[role="dialog"]'))
  );
}
