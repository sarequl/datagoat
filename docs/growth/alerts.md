# Alerts, digests and weekly reports

Alerts notify you when something happens on a website. They are managed on the **Alerts** page
or with DataFast's Account API (`/api/v1/admin/websites/:id/alerts`, `alerts:read`/`alerts:write`),
so DataFast's CLI and scripts work unchanged.

| Trigger | When it fires | Checked |
| --- | --- | --- |
| Goal completed (`{goalName}`, DataFast) | A visitor completes the goal | every minute |
| New sale (`{type: "new_sale", includeRenewals, includeFreeTrials}`) | A payment is recorded (renewals on by default, free trials off) | every minute |
| Traffic spike (`{type: "traffic_spike", multiplier, minSessions}`) | The last hour had `multiplier` (default 4) times the trailing hourly average and at least `minSessions` (20) sessions | hourly at :03 |
| Daily digest | Yesterday's numbers (website timezone) | from 07:00 UTC |
| Weekly digest | Last Monday–Sunday versus the week before | Mondays from 07:00 UTC |

Each alert has one destination:

- **Email** to an address or, by default, the website owners. Needs an email provider (below).
- **Telegram**: create a bot with [@BotFather](https://t.me/BotFather), send it a message, read the
  chat id from `https://api.telegram.org/bot<token>/getUpdates`, and enter both. The token is
  stored encrypted. Set `TELEGRAM_BOT_TOKEN` to give every alert a default bot.
- **Webhook**: a public `https://` URL. DataGoat POSTs JSON (`event`, `alert`, `website`, `subject`,
  `message`, `data`) with `X-DataGoat-Signature: t=<unix>,v1=<hex>`, where `v1` is
  HMAC-SHA256(signing secret, `"<t>.<raw body>"`). The secret is shown once when the alert is
  created; rotate it with `destination.rotateSecret: true`.

Messages are templates with `{{variable}}` placeholders: `website`, `domain`, `goal`, `amount`,
`kind`, `country`, `city`, `region`, `device`, `browser`, `os`, `referrer`, `source`, `channel`,
`page`, `utm_source`, `utm_campaign`, `visitor_id`, `visitors`, `baseline`, `time`,
`dashboard_url`. Use **Test** to send a sample through the destination.

## Delivery, retries and limits

Every notification goes through the outbox and is delivered by the `outbox.deliver` job within a
minute. Failures are retried after 1, 5, 30, 120 and 720 minutes (or the provider's `Retry-After`);
after the sixth attempt, or at once for permanent errors (bad token, unknown chat, 4xx), it is
marked failed. The **History** table and `GET …/alerts/history` show every sent and failed
delivery; counters (`triggerCount`, `dailyCount`, `monthlyCount`) count successful ones.

Rate limits protect your inbox and the Free plan: at most 10 new notifications per alert per
minute (the rest follow over the next minutes) and `ALERT_DAILY_LIMIT` (default 100) per alert per
UTC day, after which one "limit reached" notice is sent.

## Email provider

Set `EMAIL_FROM` (e.g. `DataGoat <alerts@example.com>`, a sender your provider has verified) and
one of:

- `RESEND_API_KEY` — [Resend](https://resend.com) API key.
- `POSTMARK_SERVER_TOKEN` — [Postmark](https://postmarkapp.com) server token.

With email configured DataGoat also:

- sends the **weekly email report** every Monday to the owners of websites with "Send weekly
  reports" on (visitors, pageviews, revenue, payments, bounce rate, session length versus the
  previous week, top channels, referrers, pages and countries; HTML and plain text);
- emails owners on **traffic spikes** for websites with "Viral traffic alerts" on;
- emails **team invites** (the invite link is still returned by the API, `emailQueued: true`);
- serves `POST /api/auth/password-resets {email}`, which emails a one-hour reset link (one per
  account every 5 minutes; the answer never reveals whether the account exists). Without email,
  use `npm run reset-password`.

## Attack mode

Attack mode is the `strict` bot filter (`isAttackModeEnabled` / `botLevel: "strict"` on the
website). Turn it on by hand, or enable **Auto-enable on abnormal bot traffic** on the Bot traffic
page (`PUT /api/v1/admin/websites/:id/bot-traffic/attack-mode {autoEnable, multiplier, minHits,
durationMinutes}`). Every 5 minutes `attack.detect` compares:

- bot hits blocked by the ingest filter in the last 5 minutes with the trailing 7-day average, and
- sessions in the last 15 minutes with the trailing average, when at least 80% of them are
  bot-like (one pageview, no interaction, under a second).

When either reaches `multiplier` (default 5) times normal and `minHits` (100), attack mode turns on
for `durationMinutes` (240), the event is recorded, and owners (email) and the website's
traffic-spike alerts are notified. It switches back to the previous level afterwards, unless you
changed the level yourself in the meantime. A viral spike of real visitors does not trigger it.
