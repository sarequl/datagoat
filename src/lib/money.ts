/**
 * Money helpers. Amounts are stored as integer minor units; the API reports major units
 * (DataFast's `revenue: 249` means 249.00 in the website currency).
 */

/** ISO 4217 currencies whose minor unit is not 2 decimals. */
const EXPONENTS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/** 29.99 USD → 2999. Rounds half away from zero to the currency's minor unit. */
export function toMinor(amountMajor: number, currency: string): number {
  const factor = 10 ** currencyExponent(currency);
  const scaled = amountMajor * factor;
  return Math.sign(scaled) * Math.round(Math.abs(scaled) + Number.EPSILON);
}

/** 2999 USD → 29.99 */
export function toMajor(amountMinor: number, currency: string): number {
  const exp = currencyExponent(currency);
  return Number((amountMinor / 10 ** exp).toFixed(exp));
}

/** Round to 2 decimals for derived money metrics (revenue per visitor). */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
