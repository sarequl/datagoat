/**
 * Login throttling with the LOGIN_THROTTLE KV namespace (the only KV use in DataGoat).
 *
 * Only failed attempts write (two KV writes: per IP and per email), so normal traffic never writes
 * KV. Windows are 15 minutes. KV is eventually consistent across locations, which makes the limit
 * approximate; that is acceptable for brute-force protection.
 */
import { sha256Hex } from "../lib/crypto";
import { ApiError } from "../lib/errors";

export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const MAX_FAILURES_PER_IP = 20;
export const MAX_FAILURES_PER_EMAIL = 8;

interface Counter {
  count: number;
  first: number;
}

async function keys(ip: string, email: string): Promise<{ ipKey: string; emailKey: string }> {
  return {
    ipKey: `login:ip:${await sha256Hex(`ip:${ip}`)}`,
    emailKey: `login:email:${await sha256Hex(`email:${email.toLowerCase()}`)}`,
  };
}

async function read(kv: KVNamespace, key: string, now: number): Promise<Counter | null> {
  const value = await kv.get<Counter>(key, "json");
  if (!value || now - value.first > LOGIN_WINDOW_SECONDS * 1000) return null;
  return value;
}

/** Throws 429 when the IP or the email has too many recent failures. */
export async function assertLoginAllowed(
  kv: KVNamespace,
  ip: string,
  email: string,
  now = Date.now(),
): Promise<void> {
  const { ipKey, emailKey } = await keys(ip, email);
  const [byIp, byEmail] = await Promise.all([read(kv, ipKey, now), read(kv, emailKey, now)]);
  const blocked =
    (byIp && byIp.count >= MAX_FAILURES_PER_IP ? byIp : null) ??
    (byEmail && byEmail.count >= MAX_FAILURES_PER_EMAIL ? byEmail : null);
  if (blocked) {
    const retryAfter = Math.max(
      1,
      Math.ceil((blocked.first + LOGIN_WINDOW_SECONDS * 1000 - now) / 1000),
    );
    throw new ApiError(
      429,
      `Too many failed login attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
      {
        headers: { "Retry-After": String(retryAfter) },
      },
    );
  }
}

/** Record a failed attempt for the IP and the email. */
export async function recordLoginFailure(
  kv: KVNamespace,
  ip: string,
  email: string,
  now = Date.now(),
): Promise<void> {
  const { ipKey, emailKey } = await keys(ip, email);
  await Promise.all(
    [ipKey, emailKey].map(async (key) => {
      const current = (await read(kv, key, now)) ?? { count: 0, first: now };
      const next: Counter = { count: current.count + 1, first: current.first };
      const ttl = Math.max(60, Math.ceil((next.first + LOGIN_WINDOW_SECONDS * 1000 - now) / 1000));
      await kv.put(key, JSON.stringify(next), { expirationTtl: ttl });
    }),
  );
}
