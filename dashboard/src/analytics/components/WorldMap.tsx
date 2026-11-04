/**
 * 2D world maps (lazy chunk): a country choropleth for the Location card and the realtime
 * visitor map. Shapes are Natural Earth 1:110m (world-atlas, ISC) projected with d3-geo (ISC).
 */
import { geoNaturalEarth1, geoPath } from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { type KeyboardEvent, useMemo } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import world from "world-atlas/countries-110m.json";
import type { CountryRow } from "../../../../shared/api-types";
import { formatMoney, formatNumber } from "../lib/format";
import { NAME_TO_ALPHA2, NUMERIC_TO_ALPHA2 } from "../lib/geo";
import { MAP_STYLES, type MapStyle } from "../lib/mapStyles";

const W = 960;
const H = 480;

type CountryFeature = Feature<Geometry, { name: string }> & { code: string };

let cached: CountryFeature[] | null = null;

function countries(): CountryFeature[] {
  if (cached) return cached;
  const topo = world as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<
    Geometry,
    { name: string }
  >;
  cached = fc.features
    .filter((f) => f.properties.name !== "Antarctica")
    .map((f) => ({
      ...f,
      code: NUMERIC_TO_ALPHA2[String(f.id)] ?? NAME_TO_ALPHA2[f.properties.name] ?? "",
    }));
  return cached;
}

function useProjection() {
  return useMemo(() => {
    const features = countries();
    const projection = geoNaturalEarth1().fitSize([W, H], {
      type: "FeatureCollection",
      features,
    } as FeatureCollection);
    return { features, projection, path: geoPath(projection) };
  }, []);
}

function onActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

/** Countries shaded by visitors; countries with data are focusable and filter on click. */
export default function ChoroplethMap({
  rows,
  currency,
  money,
  onPick,
}: {
  rows: CountryRow[];
  currency: string;
  money: boolean;
  onPick?: (country: string) => void;
}) {
  const { features, path } = useProjection();
  const byCode = useMemo(() => {
    const m = new Map<string, CountryRow>();
    for (const r of rows) {
      if (r.code) m.set(r.code.toUpperCase(), r);
    }
    return m;
  }, [rows]);
  const byName = useMemo(() => new Map(rows.map((r) => [r.country, r])), [rows]);
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Visitors by country map"
      >
        {features.map((f) => {
          const row = byCode.get(f.code) ?? byName.get(f.properties.name);
          const d = path(f) ?? "";
          if (!row) {
            return (
              <path
                key={f.properties.name}
                d={d}
                fill="var(--dg-surface-2)"
                stroke="var(--dg-line-strong)"
                strokeWidth={0.5}
              />
            );
          }
          const label = `${row.country}: ${formatNumber(row.visitors)} visitors${
            money ? `, ${formatMoney(row.revenue, currency)} revenue` : ""
          }`;
          const pick = () => onPick?.(row.code ?? row.country);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: SVG shapes cannot be <button>s; role is set when clickable
            <path
              key={f.properties.name}
              d={d}
              role={onPick ? "button" : undefined}
              tabIndex={onPick ? 0 : undefined}
              aria-label={onPick ? `Filter by ${label}` : label}
              onClick={pick}
              onKeyDown={onPick ? onActivate(pick) : undefined}
              fill={`color-mix(in srgb, var(--dg-secondary) ${Math.round(25 + (row.visitors / max) * 75)}%, var(--dg-surface-2))`}
              stroke="var(--dg-line-strong)"
              strokeWidth={0.5}
              className="cursor-pointer outline-none hover:opacity-80 focus-visible:stroke-[var(--dg-primary)] focus-visible:stroke-2"
            >
              <title>{label}</title>
            </path>
          );
        })}
      </svg>
    </figure>
  );
}

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  color: string;
  label: string;
  size?: number;
}

/** Realtime 2D map: land in the chosen style plus one focusable dot per live visitor. */
export function MarkerMap({
  markers,
  style,
  selectedId,
  onSelect,
}: {
  markers: MapMarker[];
  style: MapStyle;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  const { features, projection, path } = useProjection();
  const palette = MAP_STYLES[style];
  return (
    <figure className="m-0" data-testid="realtime-2d-map">
      <figcaption className="sr-only">
        World map, {palette.label} style, {markers.length} visitors
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        style={{ background: palette.ocean }}
      >
        <title>World map</title>
        {features.map((f) => (
          <path
            key={f.properties.name}
            d={path(f) ?? ""}
            fill={palette.land}
            stroke={palette.border}
            strokeWidth={0.6}
          />
        ))}
        {markers.map((m) => {
          const p = projection([m.lng, m.lat]);
          if (!p) return null;
          const r = (m.size ?? 1) * 6;
          const selected = m.id === selectedId;
          const select = () => onSelect?.(m.id);
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG groups cannot be <button>s
            <g
              key={m.id}
              role="button"
              tabIndex={0}
              aria-label={m.label}
              aria-pressed={selected}
              onClick={select}
              onKeyDown={onActivate(select)}
              className="cursor-pointer outline-none [&:focus-visible>circle:last-child]:stroke-[var(--dg-primary)]"
            >
              <circle cx={p[0]} cy={p[1]} r={r * 2.2} fill={m.color} opacity={0.25}>
                <animate
                  attributeName="r"
                  values={`${r};${r * 2.6};${r}`}
                  dur="2.4s"
                  repeatCount="indefinite"
                />
              </circle>
              <circle
                cx={p[0]}
                cy={p[1]}
                r={selected ? r * 1.4 : r}
                fill={m.color}
                stroke={selected ? "var(--dg-text)" : "rgba(0,0,0,0.35)"}
                strokeWidth={selected ? 2.5 : 1}
              >
                <title>{m.label}</title>
              </circle>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
