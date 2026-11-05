/**
 * Realtime 3D globe (lazy chunk) on cobe (MIT, WebGL, ~5 KB). Visitors are markers coloured by
 * purchase likelihood; drag to rotate, auto-rotation optional, focusing a visitor turns the globe
 * to them. Each marker also gets a focusable button positioned with CSS anchor positioning where
 * the browser supports it; the visitor list next to the globe is the keyboard path everywhere.
 * Without WebGL the 2D map is shown instead.
 */
import createGlobe, { type Globe as CobeGlobe, type Marker } from "cobe";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { MAP_STYLES, type MapStyle } from "../lib/mapStyles";
import { useWidth } from "./Sparkline";
import { type MapMarker, MarkerMap } from "./WorldMap";

export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

function supportsAnchors(): boolean {
  try {
    return typeof CSS !== "undefined" && CSS.supports("anchor-name: --a");
  } catch {
    return false;
  }
}

/** cobe angles that face a location. */
export function locationToAngles(lat: number, lng: number): [number, number] {
  return [Math.PI - ((lng * Math.PI) / 180 - Math.PI / 2), (lat * Math.PI) / 180];
}

function toRgb(color: string): [number, number, number] {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return [0.88, 0.4, 0.25];
}

/** The centre of the 20°×20° cell holding the most markers (where most visitors are). */
export function busiest(markers: { lat: number; lng: number }[]): { lat: number; lng: number } {
  const cells = new Map<string, { n: number; lat: number; lng: number }>();
  let best: { n: number; lat: number; lng: number } | null = null;
  for (const m of markers) {
    const key = `${Math.floor(m.lat / 20)}:${Math.floor(m.lng / 20)}`;
    const cell = cells.get(key) ?? { n: 0, lat: 0, lng: 0 };
    cell.n += 1;
    cell.lat += m.lat;
    cell.lng += m.lng;
    cells.set(key, cell);
    if (!best || cell.n > best.n) best = cell;
  }
  return best ? { lat: best.lat / best.n, lng: best.lng / best.n } : { lat: 0, lng: 0 };
}

/** Radians per frame: about one turn an hour at 60 fps, a slow drift rather than a spin. */
export const AUTO_ROTATE_PER_FRAME = 0.00003;

const markerId = (id: string) => `v${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

export default function Globe({
  markers,
  style,
  autoRotate,
  focus,
  selectedId,
  onSelect,
}: {
  markers: MapMarker[];
  style: MapStyle;
  autoRotate: boolean;
  focus?: { lat: number; lng: number } | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const [webgl] = useState(hasWebGL);
  const [anchors] = useState(supportsAnchors);
  const { ref, width } = useWidth<HTMLDivElement>(560);
  const host = useRef<HTMLDivElement>(null);
  const size = Math.max(240, Math.min(width, 640));
  const state = useRef({
    phi: 0,
    theta: 0.3,
    targetPhi: null as number | null,
    targetTheta: 0.3,
    drag: null as null | { x: number; y: number; phi: number; theta: number },
  });
  const autoRef = useRef(autoRotate);
  autoRef.current = autoRotate;
  const cobeMarkers: Marker[] = useMemo(
    () =>
      markers.map((m) => ({
        location: [m.lat, m.lng] as [number, number],
        size: (m.id === selectedId ? 0.09 : 0.05) * (m.size ?? 1),
        color: toRgb(m.color),
        id: markerId(m.id),
      })),
    [markers, selectedId],
  );
  const markersRef = useRef(cobeMarkers);
  markersRef.current = cobeMarkers;

  // Start facing the visitors: the first time markers arrive (and nothing is focused), turn to
  // the busiest spot; auto-rotation carries on from there.
  const centred = useRef(false);
  const start = useMemo(() => (markers.length ? busiest(markers) : null), [markers]);
  const aim = focus ?? (centred.current ? null : start);
  useEffect(() => {
    if (aim?.lat === undefined || aim.lng === undefined) return;
    centred.current = true;
    const [phi, theta] = locationToAngles(aim.lat, aim.lng);
    const s = state.current;
    // rotate the shortest way round
    const twoPi = Math.PI * 2;
    let target = phi;
    while (target - s.phi > Math.PI) target -= twoPi;
    while (s.phi - target > Math.PI) target += twoPi;
    s.targetPhi = target;
    s.targetTheta = Math.max(-1, Math.min(1, theta));
  }, [aim?.lat, aim?.lng]);

  useEffect(() => {
    if (!webgl || !host.current) return;
    const container = host.current;
    const canvas = document.createElement("canvas");
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.style.cursor = "grab";
    canvas.setAttribute("aria-hidden", "true");
    container.append(canvas);
    const palette = MAP_STYLES[style].globe;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let globe: CobeGlobe | null = null;
    try {
      globe = createGlobe(canvas, {
        devicePixelRatio: dpr,
        width: size,
        height: size,
        phi: state.current.phi,
        theta: state.current.theta,
        dark: palette.dark,
        diffuse: 1.2,
        mapSamples: 16000,
        mapBrightness: palette.brightness,
        baseColor: palette.base,
        markerColor: [0.88, 0.4, 0.25],
        glowColor: palette.glow,
        markers: markersRef.current,
        markerElevation: 0.02,
      });
    } catch {
      globe = null;
    }
    const s = state.current;
    const down = (e: PointerEvent) => {
      s.drag = { x: e.clientX, y: e.clientY, phi: s.phi, theta: s.theta };
      s.targetPhi = null;
      canvas.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!s.drag) return;
      s.phi = s.drag.phi + (e.clientX - s.drag.x) / 150;
      s.theta = Math.max(-1, Math.min(1, s.drag.theta + (e.clientY - s.drag.y) / 300));
    };
    const up = () => {
      s.drag = null;
      canvas.style.cursor = "grab";
    };
    canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    let raf = 0;
    const frame = () => {
      if (s.targetPhi !== null) {
        s.phi += (s.targetPhi - s.phi) * 0.08;
        s.theta += (s.targetTheta - s.theta) * 0.08;
        if (Math.abs(s.targetPhi - s.phi) < 0.001) s.targetPhi = null;
      } else if (autoRef.current && !s.drag) {
        s.phi += AUTO_ROTATE_PER_FRAME;
      }
      globe?.update({ phi: s.phi, theta: s.theta, markers: markersRef.current });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      globe?.destroy();
      container.replaceChildren();
    };
  }, [webgl, size, style]);

  if (!webgl) {
    return (
      <div>
        <p className="mb-2 text-xs text-muted" role="status">
          The 3D globe needs WebGL, which this browser does not provide. Showing the 2D map.
        </p>
        <MarkerMap markers={markers} style={style} selectedId={selectedId} onSelect={onSelect} />
      </div>
    );
  }

  return (
    <div ref={ref} className="flex w-full justify-center" data-testid="realtime-globe">
      <div className="relative" style={{ width: size, height: size }}>
        <div ref={host} className="absolute inset-0" />
        {anchors
          ? markers.map((m) => {
              const id = markerId(m.id);
              const css = {
                position: "absolute",
                positionAnchor: `--cobe-${id}`,
                left: "anchor(center)",
                top: "anchor(center)",
                translate: "-50% -50%",
                opacity: `var(--cobe-visible-${id}, 0)`,
              } as CSSProperties;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-label={m.label}
                  aria-pressed={m.id === selectedId}
                  onClick={() => onSelect?.(m.id)}
                  style={css}
                  className="size-4 rounded-full focus-visible:outline-2"
                />
              );
            })
          : null}
      </div>
    </div>
  );
}
