/**
 * Output: `--json` prints compact JSON (the response `data`, for piping into jq); otherwise
 * lists print as aligned tables and objects as `key: value` lines.
 */

export interface Column {
  key: string;
  label?: string;
  /** Format a cell value. */
  format?: (value: unknown, row: Record<string, unknown>) => string;
}

const MAX_CELL = 48;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map((v) => cell(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function truncate(text: string, max = MAX_CELL): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function get(row: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
    return undefined;
  }, row);
}

/** Columns for rows without a declared layout: the scalar fields of the first row. */
export function autoColumns(rows: Array<Record<string, unknown>>, max = 8): Column[] {
  const first = rows[0] ?? {};
  return Object.entries(first)
    .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
    .slice(0, max)
    .map(([key]) => ({ key }));
}

export function table(rows: Array<Record<string, unknown>>, columns?: Column[]): string {
  if (rows.length === 0) return "No results.\n";
  const cols = columns?.length ? columns : autoColumns(rows);
  const header = cols.map((c) => c.label ?? c.key);
  const body = rows.map((row) =>
    cols.map((c) => truncate(c.format ? c.format(get(row, c.key), row) : cell(get(row, c.key)))),
  );
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? 0;
        return /^-?[\d.,]+%?$/.test(c) ? c.padStart(w) : c.padEnd(w);
      })
      .join("  ")
      .trimEnd();
  return `${[line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n")}\n`;
}

export function keyValues(obj: Record<string, unknown>, indent = ""): string {
  const entries = Object.entries(obj);
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  return entries
    .map(([k, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= 12) {
        return `${indent}${k}:\n${keyValues(v as Record<string, unknown>, `${indent}  `)}`;
      }
      return `${indent}${k.padEnd(width)}  ${cell(v)}`;
    })
    .join("\n")
    .concat(indent ? "" : "\n");
}

export interface Printer {
  json: boolean;
  out(text: string): void;
}

/** Print API data: tables for arrays, key/values for objects, JSON with --json. */
export function print(p: Printer, data: unknown, columns?: Column[]): void {
  if (p.json) {
    p.out(`${JSON.stringify(data)}\n`);
    return;
  }
  if (Array.isArray(data)) {
    if (data.length > 0 && data.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      if (data.length === 1 && !columns) {
        p.out(keyValues(data[0] as Record<string, unknown>));
        return;
      }
      p.out(table(data as Array<Record<string, unknown>>, columns));
      return;
    }
    p.out(data.length ? `${data.map((d) => cell(d)).join("\n")}\n` : "No results.\n");
    return;
  }
  if (data && typeof data === "object") {
    p.out(keyValues(data as Record<string, unknown>));
    return;
  }
  p.out(`${cell(data)}\n`);
}
