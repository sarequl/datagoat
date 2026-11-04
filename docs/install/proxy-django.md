# Proxy DataGoat with Django

Two views forward the paths with `requests` (or `httpx`). Read the [proxy rules](proxy.md) first.

```python
# analytics_proxy/views.py
import requests
from django.conf import settings
from django.core.cache import cache
from django.http import HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

COLLECTOR = getattr(settings, "DATAGOAT_HOST", "https://datagoat.yourname.workers.dev")


def _client_ip(request):
    # With a load balancer in front, configure it to set X-Forwarded-For and trust it here.
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    return forwarded.split(",")[0].strip() if forwarded else request.META.get("REMOTE_ADDR", "")


def _headers(request):
    prior = request.META.get("HTTP_X_FORWARDED_FOR")
    peer = request.META.get("REMOTE_ADDR", "")
    headers = {
        "User-Agent": request.META.get("HTTP_USER_AGENT", ""),
        "X-Real-IP": _client_ip(request),
        "X-Forwarded-For": f"{prior}, {peer}" if prior else peer,
    }
    if request.META.get("HTTP_SEC_GPC"):
        headers["Sec-GPC"] = request.META["HTTP_SEC_GPC"]
    return headers


@require_GET
def script(request):
    body = cache.get("datagoat-script")
    if body is None:
        upstream = requests.get(f"{COLLECTOR}/js/script.js", headers=_headers(request), timeout=5)
        upstream.raise_for_status()
        body = upstream.content
        cache.set("datagoat-script", body, 3600)
    response = HttpResponse(body, content_type="application/javascript; charset=utf-8")
    response["Cache-Control"] = "public, max-age=3600"
    return response


@csrf_exempt
@require_POST
def events(request):
    headers = _headers(request)
    headers["Content-Type"] = request.META.get("CONTENT_TYPE") or "text/plain"
    upstream = requests.post(f"{COLLECTOR}/api/events", data=request.body, headers=headers, timeout=5)
    response = HttpResponse(
        upstream.content,
        status=upstream.status_code,
        content_type=upstream.headers.get("Content-Type", "application/json"),
    )
    response["Cache-Control"] = "no-store"
    return response
```

```python
# urls.py
from django.urls import path
from analytics_proxy import views

urlpatterns = [
    path("js/script.js", views.script),
    path("api/events", views.events),
    # ...
]
```

`requests` sets `Host` and TLS SNI from the URL. Script tag in your base template (see
[django.md](django.md)):

```html
<script defer data-website-id="dfid_XXXXXXXXXXXXXXXX" data-domain="example.com" src="/js/script.js"></script>
```
