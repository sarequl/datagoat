#!/usr/bin/env node
// End-to-end smoke test of a deployed DataGoat instance over HTTP.
//
//   npm run smoke -- --url https://analytics.example.com
//   npm run smoke -- --url https://analytics.example.com --setup-token T --email you@x.com --password P
//
// Without credentials it only reads: health and schema, setup state, the dashboard and its assets,
// the three tracker scripts, auth guards, JSON 404s and the 501 stubs of unbuilt routes.
// With --setup-token/--email/--password it also completes first-run setup if it is still pending
// (this CREATES THE OWNER ACCOUNT with those credentials), then signs in, reads /api/auth/me and
// the website list, and signs out. With --email/--password alone it signs in on an installed
// instance. Exit code 1 when any check fails.

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const base = arg("url")?.replace(/\/$/, "");
if (!base || !/^https?:\/\//.test(base)) {
  console.error(
    "Usage: npm run smoke -- --url <deployment URL> [--setup-token <t>] [--email <e> --password <p>]",
  );
  process.exit(2);
}
const setupToken = arg("setup-token");
const email = arg("email");
const password = arg("password");
const timeoutMs = Number(arg("timeout") ?? 15000);

const results = [];
let cookie = "";

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") headers.set("origin", base);
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const session = setCookie.find((c) => c.startsWith("dg_session="));
  if (session) cookie = session.split(";")[0];
  return { res, text, json };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(true, name, detail);
  } catch (err) {
    record(false, name, err instanceof Error ? err.message : String(err));
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

let setupState = null;

await check("GET /api/health answers and the schema is current", async () => {
  const { res, json, text } = await request("/api/health");
  expect(res.status === 200, `status ${res.status}: ${text.slice(0, 200)}`);
  expect(json?.data?.ok === true, "data.ok is not true");
  expect(json.data.schema === "current", `schema: ${json.data.schema}`);
  expect(res.headers.get("x-request-id"), "missing X-Request-Id");
  return `${json.data.migrations} migration(s)`;
});

await check("GET /api/setup reports setup state and valid secrets", async () => {
  const { res, json, text } = await request("/api/setup");
  expect(res.status === 200, `status ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
  setupState = json.data;
  expect(
    setupState.configErrors.length === 0,
    `config errors: ${setupState.configErrors.join("; ")}`,
  );
  return setupState.needsSetup
    ? "setup pending: open /setup?token=<SETUP_TOKEN>"
    : "setup complete";
});

await check("dashboard HTML is served at / and for SPA routes", async () => {
  for (const path of ["/", "/login", "/app/some-site/overview"]) {
    const { res, text } = await request(path);
    expect(res.status === 200, `${path}: status ${res.status}`);
    expect(/<div id="root"><\/div>/.test(text), `${path}: not the dashboard HTML`);
  }
});

await check("dashboard JavaScript and CSS assets load", async () => {
  const { text } = await request("/");
  const assets = [...text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  expect(assets.length > 0, "index.html references no /assets/ files");
  for (const asset of assets) {
    const { res } = await request(asset);
    expect(res.status === 200, `${asset}: status ${res.status}`);
  }
  return `${assets.length} asset(s)`;
});

await check("tracker scripts are served as JavaScript", async () => {
  for (const file of ["script.js", "script.cookieless.js", "script.hash.js"]) {
    const { res, text } = await request(`/js/${file}`);
    expect(res.status === 200, `${file}: status ${res.status}`);
    expect(
      /javascript/.test(res.headers.get("content-type") ?? ""),
      `${file}: content-type ${res.headers.get("content-type")}`,
    );
    expect(/datafast/.test(text), `${file}: does not define window.datafast`);
  }
});

await check("API rejects unauthenticated requests with JSON 401", async () => {
  for (const path of ["/api/auth/me", "/api/v1/admin/websites"]) {
    const { res, json } = await request(path);
    expect(res.status === 401, `${path}: status ${res.status}`);
    expect(json?.status === "error" && json.error?.code === 401, `${path}: not the error envelope`);
    expect(
      res.headers.get("cache-control") === "no-store",
      `${path}: Cache-Control ${res.headers.get("cache-control")}`,
    );
  }
});

await check("unknown API routes answer JSON 404", async () => {
  const { res, json } = await request("/api/v1/definitely-not-a-route");
  expect(res.status === 404 && json?.error?.code === 404, `status ${res.status}`);
});

const STUBS = [
  ["POST", "/api/events", "W1"],
  ["GET", "/api/v1/analytics/overview", "W2"],
  ["POST", "/api/v1/payments", "W3"],
  ["POST", "/api/ai-crawls", "W6"],
  ["POST", "/mcp", "W7"],
];

await check("routes of unbuilt features answer 501 (or are implemented)", async () => {
  const summary = [];
  for (const [method, path, owner] of STUBS) {
    const { res, json, text } = await request(path, {
      method,
      body: method === "GET" ? undefined : "{}",
    });
    if (res.status === 501) {
      expect(json?.error?.message?.includes(`owner: ${owner}`), `${path}: 501 without owner`);
      summary.push(`${path} 501`);
    } else {
      expect(res.status < 500, `${method} ${path}: status ${res.status} ${text.slice(0, 120)}`);
      summary.push(`${path} ${res.status} (implemented)`);
    }
  }
  return summary.join(", ");
});

if (setupToken || (email && password)) {
  if (setupState?.needsSetup) {
    await check("first-run setup creates the owner", async () => {
      expect(
        setupToken && email && password,
        "setup is pending: pass --setup-token, --email and --password",
      );
      const { res, json, text } = await request("/api/setup", {
        method: "POST",
        body: JSON.stringify({ token: setupToken, email, password }),
      });
      expect(
        res.status === 200,
        `status ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`,
      );
      expect(cookie, "no session cookie set");
      return `owner ${json.data.user.email}`;
    });
  } else {
    await check("sign in", async () => {
      expect(email && password, "pass --email and --password to sign in");
      const { res, json } = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      expect(res.status === 200, `status ${res.status}: ${json?.error?.message}`);
      expect(cookie, "no session cookie set");
    });
  }
  await check("session reads /api/auth/me and the website list", async () => {
    const me = await request("/api/auth/me");
    expect(me.res.status === 200, `me: status ${me.res.status}`);
    const sites = await request("/api/v1/admin/websites");
    expect(sites.res.status === 200, `websites: status ${sites.res.status}`);
    return `${me.json.data.user.email}, ${sites.json.data.length} website(s)`;
  });
  await check("sign out ends the session", async () => {
    const out = await request("/api/auth/logout", { method: "POST" });
    expect(out.res.status === 200, `logout: status ${out.res.status}`);
    const me = await request("/api/auth/me");
    expect(me.res.status === 401, `me after logout: status ${me.res.status}`);
  });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length ? "FAILED" : "OK"}: ${results.length - failed.length}/${results.length} checks passed against ${base}`,
);
process.exitCode = failed.length ? 1 : 0;
