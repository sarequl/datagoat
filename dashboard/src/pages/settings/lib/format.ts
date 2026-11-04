/** Formatting and reference lists shared by the settings pages. */

const dateFmt = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const dateTimeFmt = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const numberFmt = new Intl.NumberFormat("en");

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "–" : dateFmt.format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "–" : dateTimeFmt.format(d);
}

/** "3 minutes ago", "in 5 days"; "Never" for null. */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "Never";
  const diff = t - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 86_400_000],
    ["month", 30 * 86_400_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

export function formatNumber(n: number): string {
  return numberFmt.format(n);
}

/** Decimal units, as Cloudflare quotes D1 limits (500 MB, 10 GB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function percent(value: number, limit: number): number {
  if (!limit) return 0;
  return Math.min(100, Math.max(0, (value / limit) * 100));
}

// ---------------------------------------------------------------------------
// Timezones and currencies
// ---------------------------------------------------------------------------

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

type SupportedValuesOf = (key: "timeZone" | "currency") => string[];

function supported(key: "timeZone" | "currency"): string[] | null {
  const fn = (Intl as unknown as { supportedValuesOf?: SupportedValuesOf }).supportedValuesOf;
  try {
    return fn ? fn(key) : null;
  } catch {
    return null;
  }
}

/** IANA timezones for pickers; always includes UTC and `current`. */
export function timezoneOptions(current?: string): string[] {
  const list = new Set(supported("timeZone") ?? FALLBACK_TIMEZONES);
  list.add("UTC");
  if (current) list.add(current);
  return [...list].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Common reporting currencies first, then every ISO 4217 code the browser knows. */
const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "INR", "BRL", "CHF", "SEK"];

export function currencyOptions(current?: string): Array<{ code: string; label: string }> {
  const all = new Set([...COMMON_CURRENCIES, ...(supported("currency") ?? [])]);
  if (current) all.add(current.toUpperCase());
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "currency" });
  } catch {
    names = null;
  }
  const label = (code: string) => {
    const name = names?.of(code);
    return name && name !== code ? `${code} – ${name}` : code;
  };
  const rest = [...all].filter((c) => !COMMON_CURRENCIES.includes(c)).sort();
  return [...COMMON_CURRENCIES, ...rest].map((code) => ({ code, label: label(code) }));
}

// ---------------------------------------------------------------------------
// Countries (ISO 3166-1 alpha-2, matching the server's list)
// ---------------------------------------------------------------------------

export const COUNTRY_CODES: readonly string[] =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW T1".split(
    " ",
  );

const SPECIAL_COUNTRIES: Record<string, string> = { T1: "Tor network", XK: "Kosovo" };
let regionNames: Intl.DisplayNames | null | undefined;

export function countryName(code: string): string {
  const upper = code.toUpperCase();
  if (SPECIAL_COUNTRIES[upper]) return SPECIAL_COUNTRIES[upper];
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

export function countryFlag(code: string): string {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper) || upper === "T1") return "";
  return String.fromCodePoint(...[...upper].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** Countries sorted by English name. */
export function countryOptions(): Array<{ code: string; name: string }> {
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Validation mirrors of the server rules (src/api/v1/account/websites-service.ts)
// ---------------------------------------------------------------------------

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpOrCidr(value: string): boolean {
  const [addr = "", prefix, extra] = value.trim().split("/");
  if (extra !== undefined) return false;
  if (IPV4.test(addr))
    return prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32);
  const isV6 =
    addr.includes(":") && /^[0-9a-fA-F:.]+$/.test(addr) && (addr.match(/::/g)?.length ?? 0) <= 1;
  if (!isV6) return false;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128);
}

/** Lower-cases and strips scheme, path, port and a trailing dot, like the server. */
export function normaliseHostname(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v.replace(/:\d+$/, "").replace(/\.$/, "");
  return v;
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)(localhost|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63})$/;

export function isValidHostname(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

export const GOAL_NAME_RE = /^[a-z0-9_:-]{1,64}$/;
