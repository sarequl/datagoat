/**
 * Geo from `request.cf` (plan §8 step 9): country (ISO alpha-2), region, city, latitude and
 * longitude, filled in by Cloudflare at the edge on every plan. Nothing is looked up or stored
 * beyond these coarse fields; the client IP is never stored.
 */
export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  asn: number | null;
}

type Cf = Record<string, unknown> | undefined;

function text(v: unknown, max = 100): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function coord(v: unknown, limit: number): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > limit) return null;
  return Math.round(n * 100) / 100; // ~1 km: enough for maps, no finer
}

export function geoFromCf(cf: Cf): Geo {
  const raw = text(cf?.country, 2)?.toUpperCase() ?? null;
  // XX = unknown, T1 = Tor exit: no real country.
  const country = raw && /^[A-Z]{2}$/.test(raw) && raw !== "XX" && raw !== "T1" ? raw : null;
  const asn = typeof cf?.asn === "number" ? cf.asn : null;
  return {
    country,
    region: country ? text(cf?.region) : null,
    city: country ? text(cf?.city) : null,
    lat: coord(cf?.latitude, 90),
    lon: coord(cf?.longitude, 180),
    asn,
  };
}
