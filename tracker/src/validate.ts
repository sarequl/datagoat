/**
 * Goal and parameter rules shared by `window.datafast(...)` and the HTML attributes (plan §3.3):
 * goal names `a-z 0-9 _ - :` up to 64 characters (lowercased, spaces become `_`); at most 10
 * parameters; parameter names `^[a-z0-9_-]+$` up to 64 characters; values sanitised and capped
 * at 255 characters. An invalid parameter rejects the whole event, as DataFast's script does.
 */

export type Params = Record<string, string | number | boolean>;

export function goalName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase().replace(/\s+/g, "_");
  return /^[a-z0-9_:-]{1,64}$/.test(name) ? name : null;
}

export function clean(value: unknown): string {
  return String(value)
    .replace(/[<>'"&]/g, "")
    .replace(/javascript:|vbscript:|data:|on\w+\s*=/gi, "")
    .trim()
    .slice(0, 255);
}

/** Returns the cleaned parameters, or a string describing why they were rejected. */
export function params(input: unknown): Params | string {
  const out: Params = {};
  if (input === null || input === undefined) return out;
  if (typeof input !== "object") return "parameters must be an object";
  let count = 0;
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(key)) return `invalid parameter name "${rawKey}"`;
    if (++count > 10) return "maximum 10 custom parameters allowed";
    out[key] = typeof value === "number" || typeof value === "boolean" ? value : clean(value);
  }
  return out;
}
