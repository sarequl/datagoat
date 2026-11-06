/**
 * Colours of the realtime 2D map and 3D globe, one set per dashboard theme (the map follows the
 * app's light or dark theme). Rendered locally from Natural Earth shapes; no tile server is
 * contacted.
 */
export type MapStyle = "dark" | "light";

export interface MapPalette {
  label: string;
  /** Dark background: panels drawn over the map use the dark theme. */
  dark: boolean;
  ocean: string;
  land: string;
  border: string;
  /** cobe globe colours (0–1 RGB) */
  globe: {
    base: [number, number, number];
    glow: [number, number, number];
    dark: number;
    brightness: number;
  };
}

export const MAP_STYLES: Record<MapStyle, MapPalette> = {
  dark: {
    label: "Dark",
    dark: true,
    ocean: "#141414",
    land: "#2b2b2b",
    border: "#3d3d3d",
    globe: { base: [0.25, 0.25, 0.25], glow: [0.35, 0.35, 0.35], dark: 1, brightness: 5 },
  },
  light: {
    label: "Light",
    dark: false,
    ocean: "#f3f3f1",
    land: "#dcdcd8",
    border: "#c4c4bf",
    globe: { base: [0.95, 0.95, 0.93], glow: [0.9, 0.9, 0.9], dark: 0, brightness: 3 },
  },
};
