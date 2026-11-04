#!/usr/bin/env node
// Updates a deployed copy of DataGoat to a newer upstream version.
//
// The Deploy to Cloudflare button copies DataGoat into the user's own GitHub
// account and writes their resource ids (D1 database, KV namespace, ...) into
// that copy's wrangler.jsonc. This script replaces the copy's files with the
// upstream version and then re-applies everything that belongs to the copy:
//
//   - wrangler.jsonc: the Worker name, account_id, routes and every
//     account-specific id on each binding, matched by binding name
//   - package.json: the package name
//   - files listed under "keep" in .datagoat-update.json
//
// Usage:
//   node scripts/update-from-upstream.mjs --from <upstream checkout> --to <copy> [--version <sha>]
//
// Both directories must be git checkouts. Only tracked files are compared.
// Nothing is committed; the caller (the "Update DataGoat" workflow) commits.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Files that always belong to the copy and are never replaced or deleted. */
const ALWAYS_KEEP = new Set([".datagoat-update.json", ".datagoat-version"]);

/** Per-binding keys whose values are specific to the user's Cloudflare account. */
const BINDING_KEYS = [
  "database_id",
  "database_name",
  "preview_database_id",
  "id",
  "preview_id",
  "bucket_name",
  "preview_bucket_name",
  "namespace_id",
  "index_name",
  "queue",
  "service",
];

/** Top-level keys whose values are specific to the user's deployment. */
const TOP_LEVEL_KEYS = ["name", "account_id", "routes", "route", "workers_dev"];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) throw new Error(`Bad arguments near ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  if (!args.from || !args.to) {
    throw new Error(
      "Usage: update-from-upstream.mjs --from <upstream> --to <copy> [--version <sha>]",
    );
  }
  return args;
}

function trackedFiles(dir) {
  const out = execFileSync("git", ["-C", dir, "ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

/**
 * Scans JSONC text and returns every member as
 * { key, depth, valueStart, valueEnd, objectStart } where depth is the object
 * nesting depth of the member (1 = top level) and objectStart is the offset of
 * the "{" of the object that contains it. Strings and comments are skipped.
 */
export function scanMembers(text) {
  const members = [];
  const stack = []; // { type: "{" | "[", start, key }
  let i = 0;
  let lastString = null;
  let lastStringEnd = -1;

  const readString = (start) => {
    let j = start + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  };

  const valueEnd = (start) => {
    // End of a JSON value starting at `start`.
    if (text[start] === '"') return readString(start);
    if (text[start] === "{" || text[start] === "[") {
      let depth = 0;
      let j = start;
      while (j < text.length) {
        const ch = text[j];
        if (ch === '"') {
          j = readString(j);
          continue;
        }
        if (ch === "/" && text[j + 1] === "/") {
          j = text.indexOf("\n", j);
          if (j === -1) return text.length;
          continue;
        }
        if (ch === "/" && text[j + 1] === "*") {
          j = text.indexOf("*/", j) + 2;
          continue;
        }
        if (ch === "{" || ch === "[") depth++;
        if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) return j + 1;
        }
        j++;
      }
      return text.length;
    }
    let j = start;
    while (j < text.length && !/[,}\]\s]/.test(text[j])) j++;
    return j;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i) + 2;
      continue;
    }
    if (ch === '"') {
      const end = readString(i);
      lastString = JSON.parse(text.slice(i, end));
      lastStringEnd = end;
      i = end;
      continue;
    }
    if (ch === ":" && lastString !== null && lastStringEnd <= i) {
      let v = i + 1;
      while (/\s/.test(text[v])) v++;
      const top = stack[stack.length - 1];
      if (top?.type === "{") {
        const depth = stack.filter((s) => s.type === "{").length;
        members.push({
          key: lastString,
          depth,
          objectStart: top.start,
          valueStart: v,
          valueEnd: valueEnd(v),
        });
      }
      lastString = null;
      i = v;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push({ type: ch, start: i });
    if (ch === "}" || ch === "]") stack.pop();
    if (ch === "," || ch === "{" || ch === "[") lastString = null;
    i++;
  }
  return members;
}

/** Returns { top: {key: rawValue}, bindings: {objectKey: {key: rawValue}} } from JSONC text. */
export function accountValues(text) {
  const members = scanMembers(text);
  const top = {};
  for (const m of members) {
    if (m.depth === 1 && TOP_LEVEL_KEYS.includes(m.key)) {
      top[m.key] = text.slice(m.valueStart, m.valueEnd);
    }
  }
  const bindings = {};
  for (const object of groupByObject(members)) {
    const ident = bindingIdentity(text, object);
    if (!ident) continue;
    const values = {};
    for (const m of object) {
      if (BINDING_KEYS.includes(m.key)) values[m.key] = text.slice(m.valueStart, m.valueEnd);
    }
    bindings[ident] = values;
  }
  return { top, bindings };
}

function groupByObject(members) {
  const groups = new Map();
  for (const m of members) {
    if (m.depth < 2) continue;
    if (!groups.has(m.objectStart)) groups.set(m.objectStart, []);
    groups.get(m.objectStart).push(m);
  }
  return [...groups.values()];
}

/** A binding object is identified by its "binding" (or "name" for ratelimits) value. */
function bindingIdentity(text, object) {
  const byKey = Object.fromEntries(object.map((m) => [m.key, m]));
  const idMember = byKey.binding ?? (byKey.namespace_id ? byKey.name : undefined);
  if (!idMember) return null;
  return text.slice(idMember.valueStart, idMember.valueEnd);
}

/** Writes the copy's account values into the upstream wrangler.jsonc text. */
export function mergeWrangler(upstreamText, localText) {
  const local = accountValues(localText);
  const members = scanMembers(upstreamText);
  const edits = [];

  for (const m of members) {
    if (m.depth === 1 && m.key in local.top) {
      edits.push({ start: m.valueStart, end: m.valueEnd, value: local.top[m.key] });
    }
  }
  const presentTop = new Set(members.filter((m) => m.depth === 1).map((m) => m.key));
  const missingTop = Object.keys(local.top).filter((k) => !presentTop.has(k));

  for (const object of groupByObject(members)) {
    const ident = bindingIdentity(upstreamText, object);
    const values = ident ? local.bindings[ident] : undefined;
    if (!values) continue;
    for (const m of object) {
      if (m.key in values) {
        edits.push({ start: m.valueStart, end: m.valueEnd, value: values[m.key] });
      }
    }
  }

  let out = upstreamText;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
  }

  if (missingTop.length > 0) {
    // Keys the copy added at top level (e.g. account_id, routes): re-add them
    // right after the opening brace of the root object.
    const rootOpen = out.indexOf("{", firstCodeOffset(out));
    const insert = missingTop.map((k) => `\n  ${JSON.stringify(k)}: ${local.top[k]},`).join("");
    out = out.slice(0, rootOpen + 1) + insert + out.slice(rootOpen + 1);
  }
  return out;
}

function firstCodeOffset(text) {
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
    } else if (text.startsWith("/*", i)) {
      i = text.indexOf("*/", i) + 2;
    } else if (/\s/.test(text[i])) {
      i++;
    } else {
      return i;
    }
  }
  return 0;
}

function mergePackageJson(upstreamText, localText) {
  const upstream = JSON.parse(upstreamText);
  const local = JSON.parse(localText);
  if (local.name) upstream.name = local.name;
  return `${JSON.stringify(upstream, null, 2)}\n`;
}

function readKeepList(dir) {
  const file = join(dir, ".datagoat-update.json");
  if (!existsSync(file)) return [];
  const config = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(config.keep) ? config.keep : [];
}

function main() {
  const { from, to, version } = parseArgs(process.argv.slice(2));
  const keep = new Set([...ALWAYS_KEEP, ...readKeepList(to)]);

  const localWrangler = existsSync(join(to, "wrangler.jsonc"))
    ? readFileSync(join(to, "wrangler.jsonc"), "utf8")
    : null;
  const localPackage = existsSync(join(to, "package.json"))
    ? readFileSync(join(to, "package.json"), "utf8")
    : null;

  const upstreamFiles = trackedFiles(from);
  const upstreamSet = new Set(upstreamFiles);
  let removed = 0;
  for (const file of trackedFiles(to)) {
    if (!upstreamSet.has(file) && !keep.has(file)) {
      rmSync(join(to, file), { force: true });
      removed++;
    }
  }

  let copied = 0;
  for (const file of upstreamFiles) {
    if (keep.has(file)) continue;
    const target = join(to, file);
    mkdirSync(dirname(target), { recursive: true });
    let content = readFileSync(join(from, file));
    if (file === "wrangler.jsonc" && localWrangler) {
      content = mergeWrangler(content.toString("utf8"), localWrangler);
    } else if (file === "package.json" && localPackage) {
      content = mergePackageJson(content.toString("utf8"), localPackage);
    }
    writeFileSync(target, content);
    copied++;
  }

  if (version) writeFileSync(join(to, ".datagoat-version"), `${version}\n`);
  console.log(`Updated ${copied} files, removed ${removed}, kept ${keep.size} copy-owned paths.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
