/**
 * Per-type validation of `extraData` (plan §3.3, §3.4). The server accepts what either tracker
 * sends: DataFast's client caps parameter names at 32 characters, ours and the docs at 64, and the
 * server accepts 64 so events from both are kept.
 *
 * | type            | extraData                                                           |
 * | --------------- | ------------------------------------------------------------------- |
 * | `custom`        | `{eventName, ...params}` (≤ 10 params)                              |
 * | `identify`      | `{user_id, name?, image?, ...profile}`                              |
 * | `payment`       | one of `{stripe_session_id}`, `{polar_checkout_id}`,                |
 * |                 | `{lemonsqueezy_order_id}`, `{paddle_transaction_id}`, `{email}`     |
 * | `external_link` | `{url, text}`                                                       |
 * | `engagement`    | `{active_ms, max_scroll}` (DataGoat tracker extension)              |
 */
import { badRequest } from "../lib/errors";
import type { TrackerBody } from "./body";

export const MAX_GOAL_NAME = 64;
export const MAX_PARAMS = 10;
export const MAX_PARAM_NAME = 64;
export const MAX_PARAM_VALUE = 255;

const GOAL_NAME_RE = /^[a-z0-9_:-]+$/;
const PARAM_NAME_RE = /^[a-z0-9_-]+$/;
const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

export type PaymentProvider = "stripe" | "polar" | "lemonsqueezy" | "paddle";

export type ParsedEvent =
  | { type: "pageview" }
  | { type: "custom"; name: string; props: Record<string, string> }
  | {
      type: "identify";
      userId: string;
      name: string | null;
      image: string | null;
      email: string | null;
      profile: Record<string, string | number | boolean>;
    }
  | { type: "payment"; provider: PaymentProvider; ref: string }
  | { type: "payment"; provider: "email"; email: string }
  | { type: "external_link"; url: string; text: string | null }
  | { type: "engagement"; activeMs: number; maxScroll: number | null };

/** Goal names: lowercased, spaces to `_`, `a-z 0-9 _ - :`, at most 64 characters. */
export function normaliseGoalName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (!name || name.length > MAX_GOAL_NAME || !GOAL_NAME_RE.test(name)) return null;
  return name;
}

/** Strip markup and script-ish fragments from a value and cap it at 255 characters. */
export function sanitiseValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      return null;
    }
  }
  text = text
    .replace(/[<>]/g, "")
    .replace(/javascript:|vbscript:|data:/gi, "")
    .replace(/\bon\w+\s*=/gi, "")
    .trim();
  return text.slice(0, MAX_PARAM_VALUE);
}

/** Validate goal parameters; any invalid name or more than 10 parameters rejects the event. */
export function parseParams(
  input: Record<string, unknown>,
  skip: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (skip.includes(rawKey)) continue;
    const key = rawKey.toLowerCase();
    if (!key || key.length > MAX_PARAM_NAME || !PARAM_NAME_RE.test(key)) {
      throw badRequest(`Invalid custom parameter name: ${rawKey.slice(0, 80)}`);
    }
    const value = sanitiseValue(rawValue);
    if (value === null) continue;
    count += 1;
    if (count > MAX_PARAMS) throw badRequest(`Maximum ${MAX_PARAMS} custom parameters allowed`);
    out[key] = value;
  }
  return out;
}

export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function httpUrl(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const PAYMENT_KEYS: ReadonlyArray<[string, PaymentProvider, RegExp]> = [
  ["stripe_session_id", "stripe", /^cs_[A-Za-z0-9_]{6,250}$/],
  ["polar_checkout_id", "polar", /^[A-Za-z0-9_-]{6,128}$/],
  ["lemonsqueezy_order_id", "lemonsqueezy", /^[A-Za-z0-9_-]{1,128}$/],
  ["paddle_transaction_id", "paddle", /^txn_[A-Za-z0-9]{6,64}$/],
];

const PROFILE_SKIP = ["user_id", "name", "image"];

export function parseEvent(body: TrackerBody): ParsedEvent {
  const x = body.extraData;
  switch (body.type) {
    case "pageview":
      return { type: "pageview" };
    case "custom": {
      const name = normaliseGoalName(x.eventName);
      if (!name) throw badRequest("extraData.eventName must be a valid goal name");
      if (name === "identify") throw badRequest("The goal name identify is reserved");
      return { type: "custom", name, props: parseParams(x, ["eventName"]) };
    }
    case "identify": {
      const userId =
        typeof x.user_id === "number" ? String(x.user_id) : sanitiseValue(x.user_id) || null;
      if (!userId) throw badRequest("extraData.user_id is required");
      const profile: Record<string, string | number | boolean> = {};
      let count = 0;
      for (const [rawKey, value] of Object.entries(x)) {
        if (PROFILE_SKIP.includes(rawKey)) continue;
        const key = rawKey.toLowerCase();
        if (!key || key.length > MAX_PARAM_NAME || !PARAM_NAME_RE.test(key)) continue;
        if (count >= MAX_PARAMS) break;
        if (typeof value === "number" && Number.isFinite(value)) profile[key] = value;
        else if (typeof value === "boolean") profile[key] = value;
        else {
          const text = sanitiseValue(value);
          if (!text) continue;
          profile[key] = text;
        }
        count += 1;
      }
      const email = normaliseEmail(x.email) ?? normaliseEmail(userId);
      return {
        type: "identify",
        userId: userId.slice(0, 255),
        name: sanitiseValue(x.name) || null,
        image: httpUrl(x.image, 500),
        email,
        profile,
      };
    }
    case "payment": {
      for (const [key, provider, re] of PAYMENT_KEYS) {
        const ref = x[key];
        if (ref === undefined) continue;
        const value = typeof ref === "number" ? String(ref) : ref;
        if (typeof value !== "string" || !re.test(value)) {
          throw badRequest(`extraData.${key} is not a valid ${provider} reference`);
        }
        return { type: "payment", provider, ref: value };
      }
      if (x.email !== undefined) {
        const email = normaliseEmail(x.email);
        if (!email) throw badRequest("extraData.email is not a valid email address");
        return { type: "payment", provider: "email", email };
      }
      throw badRequest(
        "payment extraData needs stripe_session_id, polar_checkout_id, lemonsqueezy_order_id, paddle_transaction_id or email",
      );
    }
    case "external_link": {
      const url = httpUrl(x.url, 2048);
      if (!url) throw badRequest("extraData.url must be an http(s) URL");
      return { type: "external_link", url, text: sanitiseValue(x.text) || null };
    }
    case "engagement": {
      const active = Number(x.active_ms);
      const scroll = Number(x.max_scroll);
      return {
        type: "engagement",
        activeMs: Number.isFinite(active)
          ? Math.max(0, Math.min(Math.round(active), 3_600_000))
          : 0,
        maxScroll: Number.isFinite(scroll) ? Math.max(0, Math.min(Math.round(scroll), 100)) : null,
      };
    }
  }
}
