# Accounts, roles and API credentials

## First run

`/setup?token=<SETUP_TOKEN>` creates the first owner (email + password) and optionally the first
website. It works once; afterwards everyone signs in at `/login`.

## Dashboard sign-in

- Passwords: PBKDF2-SHA256 via Web Crypto with a per-user salt; 50,000 iterations by default to
  fit the Free plan's CPU limit, up to 100,000 (the Workers maximum) via `PASSWORD_ITERATIONS`. Hashes record their iteration count and are upgraded on login when the configured
  count changes.
- Session: an HttpOnly, Secure, SameSite=Lax cookie (`dg_session`, 30 days) holding a random token
  and its HMAC (`SESSION_SECRET`); the server stores only a hash, so sign-out and password changes
  revoke sessions immediately.
- Throttling: 8 failed attempts per email or 20 per IP within 15 minutes return 429 (KV, written
  only on failures).
- Password change signs out every other session.
- Forgotten passwords: **Forgot password?** on the sign-in page (`/forgot-password`) emails a
  one-time link to `/reset-password/<token>` that works for one hour
  (`POST /api/auth/password-resets`; the answer is the same for unknown emails, and at most one
  email per account is sent every 5 minutes). It needs an email provider
  ([growth/alerts.md](growth/alerts.md)); without one the page shows the server's answer, and the
  operator runs `npm run reset-password` instead ([deploy.md](deploy.md)).

## Roles

Per website: **owner** (everything, including team and deletion), **member** (all settings, keys,
funnels, goals, alerts, integrations), **viewer** (read-only). Invite people from Team settings; the
invite link (7 days) lets a new person create an account or an existing user join.

## API credentials

DataGoat uses DataFast's two token types, so DataFast integrations work by changing the base URL:

- `df_…` **website key** (Website settings → API keys): one website, every website-level permission,
  acting at most as a member. Send `Authorization: Bearer df_…`; no `websiteId` needed.
- `dft_…` **account token** (Account → API tokens): chosen permissions (`analytics:read`,
  `settings:write`, … or `*`) and optionally a website allowlist; pass `?websiteId=` on website
  endpoints. A token can never exceed the permissions or websites of whoever creates it.

Keys are shown once and stored as SHA-256 hashes. Keys without the PII option never see customer
names or emails. Each credential is limited to 60 requests per minute (`X-RateLimit-*` headers).
Website deletion is only possible from the dashboard, as in DataFast.
