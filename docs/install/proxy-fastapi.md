# Proxy DataGoat with FastAPI

Uses `httpx` (async). Read the [proxy rules](proxy.md) first.

```python
import os
import time

import httpx
from fastapi import FastAPI, Request, Response

COLLECTOR = os.environ.get("DATAGOAT_HOST", "https://datagoat.yourname.workers.dev")

app = FastAPI()
client = httpx.AsyncClient(timeout=5)
_script = {"body": b"", "at": 0.0}


def forward_headers(request: Request) -> dict[str, str]:
    peer = request.client.host if request.client else ""
    prior = request.headers.get("x-forwarded-for")
    headers = {
        "user-agent": request.headers.get("user-agent", ""),
        "x-real-ip": prior.split(",")[0].strip() if prior else peer,
        "x-forwarded-for": f"{prior}, {peer}" if prior else peer,
    }
    if request.headers.get("sec-gpc"):
        headers["sec-gpc"] = request.headers["sec-gpc"]
    return headers


@app.get("/js/script.js")
async def datagoat_script(request: Request) -> Response:
    if not _script["body"] or time.time() - _script["at"] > 3600:
        upstream = await client.get(f"{COLLECTOR}/js/script.js", headers=forward_headers(request))
        upstream.raise_for_status()
        _script.update(body=upstream.content, at=time.time())
    return Response(
        _script["body"],
        media_type="application/javascript",
        headers={"cache-control": "public, max-age=3600"},
    )


@app.post("/api/events")
async def datagoat_events(request: Request) -> Response:
    headers = forward_headers(request)
    headers["content-type"] = request.headers.get("content-type", "text/plain")
    upstream = await client.post(f"{COLLECTOR}/api/events", content=await request.body(), headers=headers)
    return Response(
        upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
        headers={"cache-control": "no-store"},
    )
```

Only trust an incoming `X-Forwarded-For` when your app runs behind a proxy you control (Uvicorn:
`--proxy-headers --forwarded-allow-ips=<proxy ip>`); otherwise drop the `prior` value and forward
`request.client.host` alone.

Script tag:

```html
<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```
