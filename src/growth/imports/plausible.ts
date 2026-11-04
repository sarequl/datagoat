/**
 * Plausible CSV export → DataGoat imported daily aggregates. Runs unchanged in the Worker and in
 * the browser (Web APIs only): the dashboard parses the export locally and uploads rows in chunks
 * (which fits the Free plan's CPU limits); `POST …/imports/:id/file` parses smaller exports on the
 * server.
 *
 * Plausible's export (site settings → Imports & Exports → Export data) is a ZIP of CSV files named
 * `imported_<table>_<from>_<to>.csv`, one per table: visitors, sources, pages, entry_pages,
 * exit_pages, locations, devices, browsers, operating_systems (and custom_events, which DataFast
 * and DataGoat do not import: goals are reconfigured). Columns are read by header name, so extra or
 * reordered columns are fine. `visit_duration` is in seconds.
 */
import { readZip, ZipError } from "./zip";

export const IMPORT_DIMENSIONS = [
  "",
  "page",
  "entry_page",
  "exit_page",
  "referrer",
  "channel",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
] as const;
export type ImportDimension = (typeof IMPORT_DIMENSIONS)[number];

export interface ImportRow {
  day: string;
  dimension: ImportDimension;
  value: string;
  visitors: number;
  visits: number;
  pageviews: number;
  bounces: number;
  /** Total visit duration in milliseconds. */
  durationSum: number;
}

export interface ParsedExport {
  rows: ImportRow[];
  rangeStart: string | null;
  rangeEnd: string | null;
  tables: string[];
  skipped: string[];
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF line ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < s.length) {
    const ch = s[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

const TABLES = [
  "visitors",
  "sources",
  "pages",
  "entry_pages",
  "exit_pages",
  "locations",
  "devices",
  "browsers",
  "operating_systems",
  "custom_events",
] as const;
type Table = (typeof TABLES)[number];

export function tableOf(fileName: string): Table | null {
  const base = (fileName.split("/").pop() ?? fileName).toLowerCase();
  const m = /^imported_([a-z_]+?)(?:_\d{8}_\d{8})?\.csv$/.exec(base);
  if (!m?.[1]) return null;
  return (TABLES as readonly string[]).includes(m[1]) ? (m[1] as Table) : null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function deviceOf(v: string): string {
  const x = v.trim().toLowerCase();
  if (x.startsWith("desktop") || x === "laptop") return "desktop";
  if (x.startsWith("mobile") || x === "phone") return "mobile";
  if (x.startsWith("tablet")) return "tablet";
  return x;
}

export class Aggregator {
  private map = new Map<string, ImportRow>();
  min: string | null = null;
  max: string | null = null;

  add(
    day: string,
    dimension: ImportDimension,
    value: string,
    m: Omit<ImportRow, "day" | "dimension" | "value">,
  ) {
    if (!DAY_RE.test(day)) return;
    const v = value.slice(0, 500);
    const key = `${day}\u0000${dimension}\u0000${v}`;
    const e = this.map.get(key);
    if (e) {
      e.visitors += m.visitors;
      e.visits += m.visits;
      e.pageviews += m.pageviews;
      e.bounces += m.bounces;
      e.durationSum += m.durationSum;
    } else this.map.set(key, { day, dimension, value: v, ...m });
    if (!this.min || day < this.min) this.min = day;
    if (!this.max || day > this.max) this.max = day;
  }

  rows(): ImportRow[] {
    return [...this.map.values()].sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.dimension.localeCompare(b.dimension) ||
        a.value.localeCompare(b.value),
    );
  }
}

export function addTable(agg: Aggregator, table: Table, csv: string[][]): boolean {
  const [header, ...rows] = csv;
  if (!header) return false;
  const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  if (!col.has("date")) return false;
  const get = (r: string[], name: string) => {
    const i = col.get(name);
    return i === undefined ? undefined : r[i];
  };
  for (const r of rows) {
    const day = (get(r, "date") ?? "").slice(0, 10);
    const metrics = {
      visitors: num(get(r, "visitors")),
      visits: num(get(r, "visits") ?? get(r, "entrances") ?? get(r, "exits")),
      pageviews: num(get(r, "pageviews")),
      bounces: num(get(r, "bounces")),
      durationSum: num(get(r, "visit_duration")) * 1000,
    };
    switch (table) {
      case "visitors":
        agg.add(day, "", "", metrics);
        break;
      case "sources": {
        const source = (get(r, "source") ?? "").trim();
        agg.add(day, "referrer", source || "Direct / None", metrics);
        const channel = (get(r, "channel") ?? "").trim();
        if (channel) agg.add(day, "channel", channel, metrics);
        for (const k of [
          "utm_source",
          "utm_medium",
          "utm_campaign",
          "utm_term",
          "utm_content",
        ] as const) {
          const v = (get(r, k) ?? "").trim();
          if (v) agg.add(day, k, v, metrics);
        }
        break;
      }
      case "pages": {
        const page = (get(r, "page") ?? "").trim();
        if (page) agg.add(day, "page", page, metrics);
        break;
      }
      case "entry_pages": {
        const page = (get(r, "entry_page") ?? "").trim();
        if (page)
          agg.add(day, "entry_page", page, {
            ...metrics,
            visits: num(get(r, "entrances") ?? get(r, "visits")),
          });
        break;
      }
      case "exit_pages": {
        const page = (get(r, "exit_page") ?? "").trim();
        if (page)
          agg.add(day, "exit_page", page, {
            ...metrics,
            visits: num(get(r, "exits") ?? get(r, "visits")),
          });
        break;
      }
      case "locations": {
        const country = (get(r, "country") ?? "").trim().toUpperCase();
        if (/^[A-Z]{2}$/.test(country) && country !== "ZZ")
          agg.add(day, "country", country, metrics);
        const region = (get(r, "region") ?? "").trim();
        if (region && region !== "0") agg.add(day, "region", region, metrics);
        // Plausible exports cities as GeoNames ids; they are kept as given (e.g. "5391959").
        const city = (get(r, "city") ?? "").trim();
        if (city && city !== "0") agg.add(day, "city", city, metrics);
        break;
      }
      case "devices": {
        const device = deviceOf(get(r, "device") ?? "");
        if (device) agg.add(day, "device", device, metrics);
        break;
      }
      case "browsers": {
        const browser = (get(r, "browser") ?? "").trim();
        if (browser) agg.add(day, "browser", browser, metrics);
        break;
      }
      case "operating_systems": {
        const os = (get(r, "operating_system") ?? "").trim();
        if (os) agg.add(day, "os", os, metrics);
        break;
      }
      case "custom_events":
        return false;
    }
  }
  return true;
}

export function parseCsvFiles(files: ReadonlyArray<{ name: string; text: string }>): ParsedExport {
  const agg = new Aggregator();
  const tables: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const table = tableOf(f.name);
    if (!table || table === "custom_events") {
      skipped.push(f.name);
      continue;
    }
    if (addTable(agg, table, parseCsv(f.text))) tables.push(table);
    else skipped.push(f.name);
  }
  if (!tables.includes("visitors")) {
    throw new ZipError(
      "This does not look like a Plausible CSV export: imported_visitors_*.csv is missing",
    );
  }
  return { rows: agg.rows(), rangeStart: agg.min, rangeEnd: agg.max, tables, skipped };
}

/** Parse a Plausible export ZIP (bytes). */
export async function parsePlausibleZip(bytes: Uint8Array): Promise<ParsedExport> {
  const entries = readZip(bytes).filter((e) => e.name.toLowerCase().endsWith(".csv"));
  const decoder = new TextDecoder();
  const files: Array<{ name: string; text: string }> = [];
  for (const e of entries) {
    if (!tableOf(e.name)) continue;
    files.push({ name: e.name, text: decoder.decode(await e.read()) });
  }
  return parseCsvFiles(files);
}
