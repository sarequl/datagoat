# Proxy DataGoat with Flask

Read the [proxy rules](proxy.md) first.

```python
import os
import requests
from flask import Flask, Response, request
from werkzeug.middleware.proxy_fix import ProxyFix

COLLECTOR = os.environ.get("DATAGOAT_HOST", "https://datagoat.yourname.workers.dev")

app = Flask(__name__)
# Behind one load balancer or reverse proxy: trust its X-Forwarded-For so remote_addr is the visitor.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)

_script_cache = {"body": None}


def forward_headers():
    prior = request.headers.get("X-Forwarded-For")
    headers = {
        "User-Agent": request.headers.get("User-Agent", ""),
        "X-Real-IP": request.remote_addr or "",
        "X-Forwarded-For": f"{prior}, {request.remote_addr}" if prior else (request.remote_addr or ""),
    }
    if request.headers.get("Sec-GPC"):
        headers["Sec-GPC"] = request.headers["Sec-GPC"]
    return headers


@app.get("/js/script.js")
def datagoat_script():
    if _script_cache["body"] is None:
        upstream = requests.get(f"{COLLECTOR}/js/script.js", headers=forward_headers(), timeout=5)
        upstream.raise_for_status()
        _script_cache["body"] = upstream.content
    return Response(
        _script_cache["body"],
        mimetype="application/javascript",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.post("/api/events")
def datagoat_events():
    headers = forward_headers()
    headers["Content-Type"] = request.content_type or "text/plain"
    upstream = requests.post(
        f"{COLLECTOR}/api/events", data=request.get_data(), headers=headers, timeout=5
    )
    return Response(
        upstream.content,
        status=upstream.status_code,
        content_type=upstream.headers.get("Content-Type", "application/json"),
        headers={"Cache-Control": "no-store"},
    )
```

The in-process script cache lives until the worker restarts; use Flask-Caching with a one-hour
timeout if you want it to refresh by itself. If Flask-WTF's CSRF protection is on, exempt
`datagoat_events`.

Script tag:

```html
<script defer data-website-id="dgid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```
