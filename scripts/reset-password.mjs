#!/usr/bin/env node
// Prints a one-time password reset link without email (plan §13).
//
//   npm run reset-password -- user@example.com https://analytics.example.com          # remote D1
//   npm run reset-password -- user@example.com http://localhost:8787 --local          # local D1
//
// It inserts a hashed, 1-hour token into password_resets with `wrangler d1 execute` (you need
// Cloudflare access to the database, which is the proof of ownership) and prints the link.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const [email, baseUrl, ...flags] = process.argv.slice(2);
if (!email || !baseUrl || !/^https?:\/\//.test(baseUrl)) {
  console.error("Usage: npm run reset-password -- <email> <dashboard base URL> [--local]");
  process.exit(1);
}
const where = flags.includes("--local") ? "--local" : "--remote";
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(`reset:${token}`).digest("hex");
const now = Date.now();
const safeEmail = email.trim().toLowerCase().replace(/'/g, "''");
const sql = `INSERT INTO password_resets (token_hash, user_id, created_at, expires_at)
  SELECT '${hash}', id, ${now}, ${now + 3_600_000} FROM users WHERE email = '${safeEmail}';
  SELECT changes() AS inserted;`;
const out = execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "DB", where, "--json", "--command", sql],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const results = JSON.parse(out);
const inserted = results.at(-1)?.results?.[0]?.inserted ?? 0;
if (!inserted) {
  console.error(`No user with email ${email}.`);
  process.exit(1);
}
console.log(
  `Reset link (valid for 1 hour, single use):\n${baseUrl.replace(/\/$/, "")}/reset-password/${token}`,
);
