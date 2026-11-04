import { useEffect, useState } from "react";

export type Theme = "dark" | "light" | "system";
const KEY = "dg-theme";
/** Dark is the default theme. */
export const DEFAULT_THEME: Theme = "dark";

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

const NEXT: Record<Theme, Theme> = { dark: "light", light: "system", system: "dark" };
const LABEL: Record<Theme, string> = { dark: "Dark", light: "Light", system: "System" };

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme === DEFAULT_THEME) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // storage unavailable
    }
  }, [theme]);
  return (
    <button
      type="button"
      onClick={() => setTheme(NEXT[theme])}
      className="rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2"
      aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[NEXT[theme]]}`}
    >
      Theme: {LABEL[theme]}
    </button>
  );
}
