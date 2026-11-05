# Proxy DataGoat with Express

Two routes in your Express app, using Node's built-in `fetch` (Node 18+). Read the
[proxy rules](proxy.md) first.

```js
import express from "express";

const COLLECTOR = process.env.DATAGOAT_HOST ?? "https://datagoat.yourname.workers.dev";
const app = express();

// Behind a load balancer or another proxy, let Express read the client IP from X-Forwarded-For.
app.set("trust proxy", true);

function forwardHeaders(req) {
  const prior = req.headers["x-forwarded-for"];
  const headers = {
    "user-agent": req.get("user-agent") ?? "",
    "x-real-ip": req.ip,
    "x-forwarded-for": prior ? `${prior}, ${req.socket.remoteAddress}` : req.ip,
  };
  if (req.get("sec-gpc")) headers["sec-gpc"] = req.get("sec-gpc");
  return headers;
}

app.get("/js/script.js", async (req, res) => {
  const upstream = await fetch(`${COLLECTOR}/js/script.js`, { headers: forwardHeaders(req) });
  res
    .status(upstream.status)
    .set("content-type", "application/javascript; charset=utf-8")
    .set("cache-control", "public, max-age=3600")
    .send(await upstream.text());
});

// Raw body: events are sent as text/plain (sendBeacon) or application/json; do not re-encode them.
app.post("/api/events", express.text({ type: "*/*", limit: "16kb" }), async (req, res) => {
  const upstream = await fetch(`${COLLECTOR}/api/events`, {
    method: "POST",
    headers: { ...forwardHeaders(req), "content-type": req.get("content-type") ?? "text/plain" },
    body: typeof req.body === "string" ? req.body : "",
  });
  res
    .status(upstream.status)
    .set("content-type", upstream.headers.get("content-type") ?? "application/json")
    .set("cache-control", "no-store")
    .send(await upstream.text());
});
```

Register these routes before any global `express.json()` middleware, or exclude `/api/events` from
it, so the body reaches the route as text.

With `http-proxy-middleware` instead:

```js
import { createProxyMiddleware } from "http-proxy-middleware";

app.use(
  ["/js/script.js", "/api/events"],
  createProxyMiddleware({
    target: "https://datagoat.yourname.workers.dev",
    changeOrigin: true, // Host + SNI of the Workers hostname
    xfwd: true,         // X-Forwarded-For / -Proto / -Host
    pathRewrite: (path, req) => req.originalUrl,
    on: { proxyReq: (proxyReq, req) => { proxyReq.removeHeader("cookie"); proxyReq.setHeader("x-real-ip", req.ip); } },
  }),
);
```

Script tag:

```html
<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```
