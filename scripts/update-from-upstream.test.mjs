// Run with: node --test scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountValues, mergeWrangler } from "./update-from-upstream.mjs";

const upstream = `// DataGoat Worker configuration. Placeholder ids: the Deploy button fills them in.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "datagoat",
  "main": "src/index.ts",
  "compatibility_date": "2026-12-01",
  "assets": { "directory": "./public", "run_worker_first": ["/api/*", "/mcp"] },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "datagoat",
      "database_id": "00000000-0000-4000-8000-000000000000", // filled in on deploy
      "migrations_dir": "migrations"
    }
  ],
  "kv_namespaces": [{ "binding": "LOGIN_THROTTLE", "id": "00000000000000000000000000000000" }],
  "r2_buckets": [{ "binding": "ARCHIVE", "bucket_name": "datagoat-archive" }],
  "ratelimits": [
    { "name": "INGEST_IP_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }
  ],
  "triggers": { "crons": ["* * * * *"] }
}
`;

const local = `{
  "name": "datagoat-personal",
  "account_id": "abc123",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "routes": [{ "pattern": "analytics.example.com", "custom_domain": true }],
  "d1_databases": [
    { "binding": "DB", "database_name": "datagoat", "database_id": "cb9dc290-b539-4c32-92f1-e01e73f0b76e", "migrations_dir": "migrations" }
  ],
  "kv_namespaces": [{ "binding": "LOGIN_THROTTLE", "id": "90404b519e604d40bfdd2014752846e5" }],
  "ratelimits": [
    { "name": "INGEST_IP_LIMITER", "namespace_id": "4242", "simple": { "limit": 60, "period": 60 } }
  ]
}
`;

test("keeps the copy's name, ids, account and routes, takes everything else from upstream", () => {
  const merged = mergeWrangler(upstream, local);
  const values = accountValues(merged);

  assert.equal(values.top.name, '"datagoat-personal"');
  assert.equal(values.top.account_id, '"abc123"');
  assert.match(values.top.routes, /analytics\.example\.com/);
  assert.equal(values.bindings['"DB"'].database_id, '"cb9dc290-b539-4c32-92f1-e01e73f0b76e"');
  assert.equal(values.bindings['"LOGIN_THROTTLE"'].id, '"90404b519e604d40bfdd2014752846e5"');
  assert.equal(values.bindings['"INGEST_IP_LIMITER"'].namespace_id, '"4242"');

  // Upstream changes survive.
  assert.match(merged, /"compatibility_date": "2026-12-01"/);
  assert.match(merged, /"\/mcp"/);
  assert.match(merged, /"crons": \["\* \* \* \* \*"\]/);
  // A binding the copy does not have yet keeps upstream's value.
  assert.equal(values.bindings['"ARCHIVE"'].bucket_name, '"datagoat-archive"');
  // Comments are preserved.
  assert.match(merged, /\/\/ filled in on deploy/);
  assert.match(merged, /^\/\/ DataGoat Worker configuration/);
});

test("produces valid JSON once comments are stripped", () => {
  const merged = mergeWrangler(upstream, local);
  const stripped = merged.replace(/\/\/[^\n]*/g, "");
  assert.doesNotThrow(() => JSON.parse(stripped));
});

test("is a no-op when upstream and copy are identical", () => {
  assert.equal(mergeWrangler(local, local), local);
});

test("ignores strings that look like keys inside values and comments", () => {
  const tricky = `{
  // "name": "not-this",
  "name": "datagoat",
  "vars": { "NOTE": "\\"name\\": \\"x\\"" }
}
`;
  const merged = mergeWrangler(tricky, `{ "name": "mine" }`);
  assert.match(merged, /\/\/ "name": "not-this"/);
  assert.match(merged, /^ {2}"name": "mine",$/m);
  assert.match(merged, /"NOTE": "\\"name\\": \\"x\\""/);
});
