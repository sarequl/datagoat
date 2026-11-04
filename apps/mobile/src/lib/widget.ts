/**
 * Home-screen widget snapshot. The app stores this JSON after each refresh of the sites screen;
 * a native widget extension (not in this repository, see docs/architecture/mobile.md) only has to
 * read and draw it.
 */
import { formatCount, formatMoney } from "./format";

export const WIDGET_STORAGE_KEY = "datagoat.widget.v1";
/** Keeps the JSON well under secure storage's ~2 KB per-value guidance. */
export const WIDGET_MAX_SITES = 6;

export interface WidgetSite {
  id: string;
  name: string;
  visitorsToday: number;
  revenueToday: number;
  currency: string;
  live: number;
}

export interface WidgetSnapshot {
  version: 1;
  updatedAt: string;
  sites: Array<
    WidgetSite & {
      /** Pre-formatted strings, so the widget needs no number formatting of its own. */
      display: { visitors: string; revenue: string; live: string };
    }
  >;
}

export function buildWidgetSnapshot(sites: WidgetSite[], now = new Date()): WidgetSnapshot {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    sites: sites.slice(0, WIDGET_MAX_SITES).map((s) => ({
      ...s,
      display: {
        visitors: formatCount(s.visitorsToday),
        revenue: formatMoney(s.revenueToday, s.currency, true),
        live: formatCount(s.live),
      },
    })),
  };
}
