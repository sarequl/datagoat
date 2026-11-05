/**
 * Map styles for the realtime 2D map and 3D globe (DataFast's Outdoors / Dark / Light /
 * Satellite). Rendered locally from Natural Earth shapes; no tile server is contacted.
 */
export type MapStyle = "outdoors" | "dark" | "light" | "satellite";

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
  outdoors: {
    label: "Outdoors",
    dark: false,
    ocean: "#cfe5ee",
    land: "#e4ecd3",
    border: "#b5c39f",
    globe: { base: [0.55, 0.7, 0.5], glow: [0.75, 0.88, 0.95], dark: 0, brightness: 5 },
  },
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
  satellite: {
    label: "Satellite",
    dark: true,
    ocean: "#0b1d33",
    land: "#3d4a2c",
    border: "#5a6a43",
    globe: { base: [0.18, 0.24, 0.14], glow: [0.2, 0.35, 0.6], dark: 1, brightness: 6 },
  },
};

export const MAP_STYLE_KEYS = Object.keys(MAP_STYLES) as MapStyle[];
