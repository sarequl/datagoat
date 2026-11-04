import { useEffect, useRef, useState } from "react";

/** Width of an element, tracked with ResizeObserver (fallback for test environments). */
export function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Tiny trend line for KPI tiles (decorative: the value and delta carry the meaning). */
export function Sparkline({
  values,
  color = "currentColor",
  width = 96,
  height = 28,
}: {
  values: Array<number | null>;
  color?: string;
  width?: number;
  height?: number;
}) {
  const pts = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const nums = pts.filter((v): v is number => v !== null);
  if (nums.length < 2) return <svg aria-hidden="true" width={width} height={height} />;
  const max = Math.max(...nums);
  const min = Math.min(...nums, 0);
  const span = max - min || 1;
  const step = width / Math.max(1, pts.length - 1);
  let d = "";
  pts.forEach((v, i) => {
    if (v === null) return;
    const x = i * step;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    d += `${d ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
