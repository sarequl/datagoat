# DataGoat with Django

Add the tag to your base template:

```django
{# templates/base.html #}
<head>
  {% if not request.user.is_staff %}
    <script
      defer
      data-website-id="{{ DATAGOAT_WEBSITE_ID }}"
      data-domain="example.com"
      src="https://a.example.com/js/script.js"
    ></script>
  {% endif %}
</head>
```

Provide `DATAGOAT_WEBSITE_ID` with a context processor, or hard-code it. The `is_staff` check
keeps your own admin visits out (optional).

## Identify signed-in users

```django
{% if request.user.is_authenticated %}
<script>
  window.datafast = window.datafast || function () { (window.datafast.q = window.datafast.q || []).push(arguments); };
  window.datafast("identify", { user_id: "{{ request.user.pk|escapejs }}", name: "{{ request.user.get_full_name|escapejs }}" });
</script>
{% endif %}
```

## Revenue attribution (Stripe Checkout)

```python
import stripe
from django.conf import settings
from django.shortcuts import redirect


def visitor_metadata(request):
    vid = request.COOKIES.get("datafast_visitor_id")
    sid = request.COOKIES.get("datafast_session_id")
    meta = {}
    if vid:
        meta["datafast_visitor_id"] = vid
        if sid:
            meta["datafast_session_id"] = sid
    return meta


def checkout(request):
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{"price": settings.STRIPE_PRICE_ID, "quantity": 1}],
        success_url="https://example.com/thanks?session_id={CHECKOUT_SESSION_ID}",
        cancel_url="https://example.com/pricing",
        metadata=visitor_metadata(request),
    )
    return redirect(session.url)
```

Server-side goals: `POST /api/v1/goals` with a `df_` key (see the API docs).

First-party proxy: [proxy-django.md](proxy-django.md).
