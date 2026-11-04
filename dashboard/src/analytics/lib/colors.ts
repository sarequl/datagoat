/**
 * Chart colours. Series use the design tokens (CSS variables) so they follow the theme; the KPI
 * colour scheme (website setting `kpiColorScheme`) recolours revenue/KPI bars as DataFast does.
 */

export const KPI_SCHEMES: Record<string, { label: string; color: string }> = {
  orange: { label: "Orange", color: "#e78468" },
  red: { label: "Red", color: "#ff5861" },
  pink: { label: "Pink", color: "#f472b6" },
  purple: { label: "Purple", color: "#a78bfa" },
  indigo: { label: "Indigo", color: "#818cf8" },
  blue: { label: "Blue", color: "#00b5ff" },
  teal: { label: "Teal", color: "#00cdb7" },
  green: { label: "Green", color: "#00a96e" },
  yellow: { label: "Yellow", color: "#ffbe00" },
};

/** Revenue/KPI bar colour for a website's scheme (default: DataFast's coral revenue colour). */
export function kpiColor(scheme: string | null | undefined): string {
  return (scheme && KPI_SCHEMES[scheme]?.color) || "var(--dg-revenue)";
}

export const VISITORS_COLOR = "var(--dg-secondary)";
export const REVENUE_COLOR = "var(--dg-revenue)";

/** Fallback colours for goals without a customised colour. */
export const GOAL_FALLBACK = [
  "#8dcdff",
  "#e78468",
  "#00cdb7",
  "#a78bfa",
  "#ffbe00",
  "#f472b6",
  "#00b5ff",
  "#00a96e",
];

export function goalColor(name: string, custom: string | null | undefined, index: number): string {
  if (custom) return custom;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GOAL_FALLBACK[(index >= 0 ? index : h) % GOAL_FALLBACK.length] as string;
}

const COLD: [number, number, number] = [141, 205, 255]; // #8dcdff
const WARM: [number, number, number] = [255, 190, 0]; // #ffbe00
const HOT: [number, number, number] = [255, 88, 97]; // #ff5861

function mix(a: [number, number, number], b: [number, number, number], t: number) {
  return a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * t)) as [number, number, number];
}

/** Purchase-likelihood colour: cold blue (0) → amber (50) → hot red (100). */
export function likelihoodRgb(score: number | null | undefined): [number, number, number] {
  if (score === null || score === undefined || Number.isNaN(score)) return [163, 163, 163];
  const s = Math.max(0, Math.min(100, score)) / 100;
  return s < 0.5 ? mix(COLD, WARM, s * 2) : mix(WARM, HOT, (s - 0.5) * 2);
}

export function likelihoodColor(score: number | null | undefined): string {
  const [r, g, b] = likelihoodRgb(score);
  return `rgb(${r}, ${g}, ${b})`;
}

export function likelihoodLabel(score: number | null | undefined): string {
  if (score === null || score === undefined) return "No prediction";
  if (score >= 75) return "Very likely to buy";
  if (score >= 50) return "Likely to buy";
  if (score >= 25) return "Warm";
  return "Cold";
}
