/**
 * Countries. Sessions store ISO 3166-1 alpha-2 codes (from `request.cf.country`). DataFast's API
 * accepts and returns country names ("United States") and also accepts codes in filters, so the
 * query layer converts both ways here. Names come from Intl.DisplayNames (English).
 */

const CODES =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(
    " ",
  );

/** Cloudflare pseudo-codes: T1 = Tor, XX = unknown. */
const SPECIAL: Record<string, string> = { T1: "Tor network", XX: "Unknown", XK: "Kosovo" };

/** Extra spellings accepted in filters. Keys are lowercase. */
const ALIASES: Record<string, string> = {
  usa: "US",
  "united states of america": "US",
  america: "US",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  britain: "GB",
  russia: "RU",
  "russian federation": "RU",
  "south korea": "KR",
  korea: "KR",
  "north korea": "KP",
  turkey: "TR",
  türkiye: "TR",
  czechia: "CZ",
  "czech republic": "CZ",
  holland: "NL",
  "the netherlands": "NL",
  vietnam: "VN",
  "ivory coast": "CI",
  uae: "AE",
  "hong kong": "HK",
  taiwan: "TW",
  macau: "MO",
};

let displayNames: Intl.DisplayNames | null | undefined;

function names(): Intl.DisplayNames | null {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
}

const CODE_SET = new Set(CODES);
let nameIndex: Map<string, string> | undefined;

function index(): Map<string, string> {
  if (!nameIndex) {
    nameIndex = new Map();
    for (const code of CODES) {
      nameIndex.set(countryName(code).toLowerCase(), code);
    }
    for (const [alias, code] of Object.entries(ALIASES)) nameIndex.set(alias, code);
  }
  return nameIndex;
}

export function isCountryCode(value: string): boolean {
  return CODE_SET.has(value.toUpperCase()) || value.toUpperCase() in SPECIAL;
}

/** English name for an ISO code ("US" → "United States"). Unknown codes return the input. */
export function countryName(code: string): string {
  const upper = code.toUpperCase();
  if (SPECIAL[upper]) return SPECIAL[upper];
  if (!CODE_SET.has(upper)) return code;
  try {
    return names()?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/** Resolve a filter value (code or name, any case) to an ISO code, or null when unknown. */
export function toCountryCode(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 2 && isCountryCode(trimmed)) return trimmed.toUpperCase();
  return index().get(trimmed.toLowerCase()) ?? null;
}

/** Flag emoji for an ISO code ("US" → 🇺🇸); null for pseudo-codes. */
export function countryFlag(code: string): string | null {
  const upper = code.toUpperCase();
  if (!CODE_SET.has(upper)) return null;
  return String.fromCodePoint(...[...upper].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export const COUNTRY_CODES: readonly string[] = CODES;
