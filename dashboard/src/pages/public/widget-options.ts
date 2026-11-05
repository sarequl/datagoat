/**
 * Embeddable widgets (DataFast's "Widgets" tab): the options in the iframe URL
 * (`/share/<token>/widget?type=…&period=…&theme=…&color=…`) and the embed code the settings page
 * generates. Shared by the widget page and the settings generator.
 */
export const WIDGET_TYPES = ["visitors", "revenue", "live", "chart"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const WIDGET_PERIODS = ["24h", "7d", "30d"] as const;
export type WidgetPeriod = (typeof WIDGET_PERIODS)[number];
export type WidgetTheme = "light" | "dark";

export const WIDGET_LABELS: Record<WidgetType, string> = {
  visitors: "Visitors",
  revenue: "Revenue",
  live: "Visitors online now",
  chart: "Visitors chart",
};
export const PERIOD_LABELS: Record<WidgetPeriod, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export interface WidgetOptions {
  type: WidgetType;
  period: WidgetPeriod;
  theme: WidgetTheme;
  /** Accent colour as 6 hex digits, without `#`. */
  color: string;
}

export const DEFAULT_WIDGET: WidgetOptions = {
  type: "visitors",
  period: "30d",
  theme: "dark",
  color: "e16540",
};

/** Default iframe size per widget. */
export const WIDGET_SIZE: Record<WidgetType, { width: number; height: number }> = {
  visitors: { width: 320, height: 140 },
  revenue: { width: 320, height: 140 },
  live: { width: 260, height: 100 },
  chart: { width: 480, height: 220 },
};

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function parseWidgetOptions(search: string): WidgetOptions {
  const q = new URLSearchParams(search);
  const color = (q.get("color") ?? "").replace(/^#/, "");
  return {
    type: pick(q.get("type"), WIDGET_TYPES, DEFAULT_WIDGET.type),
    period: pick(q.get("period"), WIDGET_PERIODS, DEFAULT_WIDGET.period),
    theme: pick(q.get("theme"), ["light", "dark"] as const, DEFAULT_WIDGET.theme),
    color: /^[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_WIDGET.color,
  };
}

export function widgetUrl(origin: string, token: string, o: WidgetOptions): string {
  const q = new URLSearchParams({ type: o.type, period: o.period, theme: o.theme, color: o.color });
  return `${origin}/share/${encodeURIComponent(token)}/widget?${q.toString()}`;
}

export function embedCode(
  origin: string,
  token: string,
  o: WidgetOptions,
  size: { width: number; height: number },
  title: string,
): string {
  const src = widgetUrl(origin, token, o).replace(/&/g, "&amp;");
  const t = title.replace(/"/g, "&quot;");
  return `<iframe src="${src}" width="${size.width}" height="${size.height}" title="${t}" style="border:0;border-radius:12px;overflow:hidden" loading="lazy"></iframe>`;
}

/** Start and end (whole hours) and bucket for a widget period. */
export function widgetRange(period: WidgetPeriod, now: number) {
  const HOUR = 3_600_000;
  const hours = period === "24h" ? 24 : period === "7d" ? 168 : 720;
  const end = Math.ceil(now / HOUR) * HOUR;
  return {
    startAt: new Date(end - hours * HOUR).toISOString(),
    endAt: new Date(end).toISOString(),
    interval: period === "24h" ? "hour" : "day",
  };
}
