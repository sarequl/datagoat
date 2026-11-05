# Payments API (any provider)

For providers without a native integration (or your own billing), send payments from your server.
The endpoint is DataFast-compatible: DataFast code works by changing the base URL.
([How attribution works](README.md))

```js
await fetch("https://analytics.example.com/api/v1/payments", {
  method: "POST",
  headers: { Authorization: `Bearer ${DATAGOAT_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    amount: 29.99, // major units
    currency: "USD",
    transaction_id: "txn_98hj", // idempotency key
    datagoat_visitor_id: req.cookies.datagoat_visitor_id,
    email: "customer@example.com",
    customer_id: "cus_42",
  }),
});
```

Use a `dg_` website key, or a `dgt_` token with `payments:write` and `?websiteId=`.

| Field                               | Notes                                                                 |
| ----------------------------------- | --------------------------------------------------------------------- |
| `amount`, `currency`, `transaction_id` | required; amount ≥ 0                                               |
| `datagoat_visitor_id` / `visitorId` | strongly recommended (`datafast_visitor_id` is also accepted)         |
| `email` / `customer_email`          | matches identified visitors; links trials to later payments          |
| `name` / `customer_name`            | stored when the website stores customer emails                       |
| `customer_id`                       | renewals with the same id attribute to the first visitor             |
| `renewal: true`                     | a renewal                                                             |
| `refunded: true`                    | a refund of `transaction_id` (negative, on the original visitor)     |
| `is_free_trial: true` or `amount: 0` | a free trial                                                         |
| `timestamp`                         | ISO 8601, defaults to now                                             |

Responses are plain JSON (no `status` wrapper):

```json
{ "message": "Payment recorded and attributed successfully", "transaction_id": "txn_98hj" }
```

A repeated `transaction_id` answers `{"message": "Payment already recorded …"}` and records
nothing. A visitor id with no pageviews on the website stores the payment as unattributed and
answers a message only. Invalid input answers **400** `{"error": "…"}`.

Delete with `DELETE /api/v1/payments?transaction_id=…`, `?datagoat_visitor_id=…[&startAt&endAt]`
or `?startAt=…&endAt=…` (bulk; `start`/`end` accepted).

## Tracking from the browser instead

On the page customers reach after paying, `window.datagoat("payment", { email: user.email })`
links the visitor to that email; payments from any connected provider with the same customer email
are then attributed (immediately, or within the hour for payments that arrived first).
