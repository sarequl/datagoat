# Proxy DataGoat with Firebase Hosting

Firebase Hosting rewrites cannot point at an external URL, so a small Cloud Function does the
proxying and Hosting rewrites the two paths to it. Read the [proxy rules](proxy.md) first.

## 1. The function

```bash
firebase init functions   # if you have no functions yet
```

`functions/index.js` (Node 20+, no extra packages):

```js
const { onRequest } = require("firebase-functions/v2/https");

const COLLECTOR = process.env.DATAGOAT_HOST || "https://datagoat.yourname.workers.dev";

exports.datagoatProxy = onRequest({ cors: false }, async (req, res) => {
  const path = req.path === "/js/script.js" ? "/js/script.js" : req.path === "/api/events" ? "/api/events" : null;
  if (!path) return res.status(404).end();

  // Firebase Hosting puts the visitor's address first in X-Forwarded-For; req.ip is that address.
  const headers = {
    "user-agent": req.get("user-agent") || "",
    "x-real-ip": req.ip,
    "x-forwarded-for": req.get("x-forwarded-for") || req.ip,
  };
  if (req.get("sec-gpc")) headers["sec-gpc"] = req.get("sec-gpc");

  const init = { method: req.method, headers };
  if (req.method === "POST") {
    headers["content-type"] = req.get("content-type") || "text/plain";
    init.body = req.rawBody; // the unparsed request body
  }
  const upstream = await fetch(`${COLLECTOR}${path}`, init);
  res.status(upstream.status);
  res.set("content-type", upstream.headers.get("content-type") || "application/json");
  res.set("cache-control", path === "/js/script.js" ? "public, max-age=3600" : "no-store");
  res.send(Buffer.from(await upstream.arrayBuffer()));
});
```

## 2. Hosting rewrites

`firebase.json`:

```json
{
  "hosting": {
    "public": "public",
    "rewrites": [
      { "source": "/js/script.js", "function": { "functionId": "datagoatProxy" } },
      { "source": "/api/events", "function": { "functionId": "datagoatProxy" } }
    ]
  }
}
```

Hosting serves matching static files before rewrites: make sure your `public/` has no
`js/script.js`.

## 3. Deploy and tag

```bash
firebase deploy --only hosting,functions
```

```html
<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```

Hosting caches function responses only when they send `Cache-Control: public`, so the script is
cached for an hour and events never are.
