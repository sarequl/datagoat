/**
 * Small JSON narrowing helpers for provider payloads. Provider webhooks are
 * untrusted, dynamically shaped input, so every field is read through these
 * guards instead of casts.
 */

export type JsonObject = Record<string, unknown>;

export function obj(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function int(value: unknown): number | null {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

/** Reads a nested field, e.g. `get(data, 'customer', 'email')`. */
export function get(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const next = obj(current);
    if (!next) return undefined;
    current = next[key];
  }
  return current;
}

export function getStr(root: unknown, ...path: string[]): string | null {
  return str(get(root, ...path));
}

export function getNum(root: unknown, ...path: string[]): number | null {
  return num(get(root, ...path));
}

export function getObj(root: unknown, ...path: string[]): JsonObject | null {
  return obj(get(root, ...path));
}

export function getTime(root: unknown, ...path: string[]): number | null {
  return toUnixSeconds(get(root, ...path));
}

/**
 * Provider timestamps arrive as unix seconds, unix milliseconds, or ISO-8601
 * strings. Returns unix seconds, or null when the value is unusable.
 */
export function toUnixSeconds(value: unknown): number | null {
  const n = num(value);
  if (n !== null) {
    if (n <= 0) return null;
    // Heuristic: 13-digit epoch ms vs 10-digit epoch s.
    if (n > 1e11) return Math.floor(n / 1000);
    return Math.floor(n);
  }
  const s = str(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}
