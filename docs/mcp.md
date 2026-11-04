# MCP server

DataGoat includes a [Model Context Protocol](https://modelcontextprotocol.io) server, so AI
assistants such as Claude, ChatGPT and Cursor can read your analytics and, if you allow it, make
changes such as adding chart notes or creating funnels.

- **Endpoint:** `https://<your-datagoat>/mcp` (also served at `/api/mcp`, the path DataFast uses).
- **Transport:** Streamable HTTP, stateless, JSON responses. No sessions and no server-sent events,
  so it runs on the Workers Free plan.
- **Authentication:** OAuth sign-in (recommended where the client supports it) or a Bearer token: a
  `dft_` account token or a `df_` website key.

Every MCP tool calls the same handler as the matching `/api/v1` REST endpoint, inside the Worker.
Validation, permissions, website access, roles and rate limits are therefore identical to the API.

## Connect with OAuth

OAuth lets you pick the websites and permissions on a DataGoat consent page. The client never sees
your password, session or API keys, and you can revoke it at any time.

1. Add the server URL `https://<your-datagoat>/mcp` to your client and choose OAuth / sign in.
2. Your browser opens DataGoat. Sign in if needed.
3. Select the websites the app may use and the permissions. Read permissions are pre-selected;
   write and sensitive permissions are off until you tick them.
4. Choose **Allow access**. The client receives a token and refreshes it automatically.

The client registers itself with DataGoat (dynamic client registration) or presents a client
metadata document URL; either way you do not create anything by hand.

### Claude Code

```sh
claude mcp add --transport http datagoat https://<your-datagoat>/mcp
```

Then run `/mcp` inside Claude Code, select `datagoat` and authenticate.

### Claude Desktop and claude.ai

Open **Settings → Connectors → Add custom connector**, enter a name (`DataGoat`) and the URL
`https://<your-datagoat>/mcp`, then connect and approve access in the browser. Custom connectors
are configured in Claude's settings; availability depends on your Claude plan.

### ChatGPT

In ChatGPT, turn on developer mode (**Settings → Apps & Connectors → Advanced**), create a
connector with the URL `https://<your-datagoat>/mcp` and choose **OAuth** as the authentication.
Approve access on the DataGoat page that opens. ChatGPT's own client metadata document is accepted,
as is dynamic registration.

### Cursor

Add the server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) without headers and
Cursor offers to sign in:

```json
{
  "mcpServers": {
    "datagoat": { "url": "https://<your-datagoat>/mcp" }
  }
}
```

## Connect with a token

Use this for clients that ask for a Bearer token, for CI agents, or if you prefer to manage the
credential yourself.

1. In the dashboard, open **Account → API tokens** and create an account token (`dft_…`). Give it
   only what the agent needs, for example `websites:read` and `analytics:read`, and restrict it to
   specific websites if you can. A website key (`df_…`, **Website → API keys**) also works and is
   limited to its website.
2. Configure the client with the URL and an `Authorization: Bearer <token>` header. Keep the token
   in the client's secret store or an environment variable, never in a repository.

**Claude Code**

```sh
claude mcp add --transport http datagoat https://<your-datagoat>/mcp \
  --header "Authorization: Bearer $DATAGOAT_TOKEN"
```

**Cursor** (`mcp.json`, with `DATAGOAT_TOKEN` in Cursor's environment)

```json
{
  "mcpServers": {
    "datagoat": {
      "url": "https://<your-datagoat>/mcp",
      "headers": { "Authorization": "Bearer ${env:DATAGOAT_TOKEN}" }
    }
  }
}
```

**Claude Desktop with a token** (through the `mcp-remote` bridge, in `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "datagoat": {
      "command": "npx",
      "args": ["mcp-remote", "https://<your-datagoat>/mcp", "--header", "Authorization:Bearer ${DATAGOAT_TOKEN}"],
      "env": { "DATAGOAT_TOKEN": "dft_…" }
    }
  }
}
```

**Codex**

```sh
codex mcp add datagoat --url https://<your-datagoat>/mcp --bearer-token-env-var DATAGOAT_TOKEN
```

Try it: *"List my DataGoat websites, then show visitors and revenue for the first one over the last
7 days."*

## Tools

Tool names follow DataFast's MCP catalog without the vendor prefix. Calls that use DataFast's names
(`datafast_analytics_overview`, `datafast_account_get`, …) are accepted too, so prompts written for
DataFast keep working.

| Group | Tools |
| --- | --- |
| Account | `whoami`, `account_update` |
| Websites | `websites_list`, `websites_get`, `websites_create`, `websites_update` |
| Analytics | `analytics_overview`, `analytics_timeseries`, `analytics_realtime`, `analytics_realtime_map`, `analytics_metadata`, `analytics_revenue` |
| Breakdowns | `analytics_pages`, `analytics_entry_pages`, `analytics_exit_pages`, `analytics_exit_clicks`, `analytics_referrers`, `analytics_channels`, `analytics_campaigns`, `analytics_countries`, `analytics_regions`, `analytics_cities`, `analytics_devices`, `analytics_browsers`, `analytics_operating_systems`, `analytics_hostnames` |
| Goals | `analytics_goals_breakdown`, `analytics_goal_properties`, `goals_list`, `goals_track`, `goals_delete_events`, `goals_customizations_list`, `goals_customizations_update`, `goals_customizations_reset` |
| Funnels | `funnels_list`, `funnels_create`, `funnels_update`, `funnels_delete`, `analytics_funnel` |
| Visitors | `visitors_search`, `visitors_get` |
| Notes | `notes_list`, `notes_create`, `notes_update`, `notes_delete` |
| Alerts | `alerts_list`, `alerts_create`, `alerts_update`, `alerts_delete`, `alerts_history` |
| Mentions | `mentions_list` |
| Bot traffic | `bot_traffic_summary`, `bot_traffic_pages`, `bot_traffic_usage`, `bot_traffic_settings_get`, `bot_traffic_settings_update`, `bot_traffic_token_get`, `bot_traffic_token_create`, `bot_traffic_token_rotate`, `bot_traffic_token_delete` |
| Team | `team_list`, `team_invite`, `team_remove`, `team_update_role` |
| Website API keys | `apikeys_list`, `apikeys_create`, `apikeys_roll`, `apikeys_delete` |
| Account tokens | `access_tokens_list`, `access_tokens_create`, `access_tokens_delete` |
| Integrations | `integrations_status` (read-only; connecting payment providers stays in the dashboard) |

Every tool's input schema is published in `tools/list`, with its REST permission and OAuth scopes
in `_meta` (`datagoat/permission`, `datagoat/oauthScopes`).

**Common arguments.** Website tools take `websiteId` (the `_id` from `websites_list`, or the
tracking id); it can be omitted with a `df_` key or a credential limited to one website. Ranges are
`period` (`today`, `yesterday`, `last24h`, `last7d`, `last30d`, `last90d`, `last12m`, `week`,
`month`, `year`, `all`, resolved in the website timezone) or `startAt` + `endAt` (`YYYY-MM-DD` or an
ISO instant with `Z` or an offset), plus an optional `timezone`. Analytics tools take `filters`, the
API's `filter_*` parameters as an object: `{"country": "US", "page": "contains:/docs"}`.

### Write tools: dry run, confirmation and retries

- A write tool called without `confirm: true` changes nothing and returns a **dry-run preview**:
  the exact REST request it would make. The assistant should show it to you and ask before
  confirming.
- `idempotencyKey` (8–128 characters) makes retries safe: a repeated call with the same key and
  arguments returns the first result instead of writing again, for 24 hours. The same key with
  different arguments is rejected. A call whose outcome is unknown is never re-run automatically.
  With OAuth the key is required.
- Credentials created by a tool (`apikeys_create`, `access_tokens_create`,
  `bot_traffic_token_create`, …) are returned once; a replay says they were already issued and
  never includes the secret.
- Website deletion and connecting or disconnecting payment providers are dashboard-only.

## OAuth permissions

| Scope | Allows |
| --- | --- |
| `websites:read` | List the selected websites and your role |
| `analytics:read` | Traffic, revenue, breakdowns, goals and goal parameters, funnel results, realtime counts, mentions, bot traffic summaries |
| `visitors:read` | Visitor search and journeys, without names or emails (needs `analytics:read`) |
| `visitors:details` | Customer names and emails, and the realtime map (sensitive) |
| `goals:read`, `goals:write` | Goals and their display settings; record or delete goal events |
| `funnels:read`, `funnels:write` | Funnel definitions; create, edit, delete |
| `notes:read`, `notes:write` | Chart notes |
| `alerts:read`, `alerts:write` | Alerts, their recipients and delivery history |
| `settings:read`, `settings:write` | Website settings, integration status, bot traffic settings |
| `team:read`, `team:write` | Team members; invite, remove, change roles (owners only) |
| `account:read`, `account:write` | Your profile; change your display name |
| `websites:write` | Create websites; new websites join the connection |
| `api-keys:read`, `api-keys:write` | Website `df_` keys (owners only for changes); new keys expire with the connection |
| `access-tokens:read`, `access-tokens:write` | Account `dft_` tokens limited to the connection's websites and permissions; they expire with it |
| `bot-credentials:read`, `bot-credentials:write` | Bot traffic `dfbot_` ingestion tokens (owners only) |
| `account-usage:read` | Account-wide bot traffic usage (every website you own must be selected) |
| `payments:read`, `payments:write`, `identify:write` | Passed on to credentials minted through the connection |

There is no wildcard scope. A tool whose scope was not granted returns an error with an
`mcp/www_authenticate` challenge (`error="insufficient_scope"`), so the client can ask you to
approve more.

## How access is enforced

- Each request checks the token, its expiry, the MCP resource it was issued for, the connection,
  the scope, your current membership and role on the website, and then the REST handler's own
  checks. A website id in a tool call is a target to check, never proof of access.
- OAuth access tokens (`dgo_…`) last 1 hour; refresh tokens (`dgr_…`) 30 days and rotate on every
  use; a connection lasts at most 90 days, then the app asks you again. Reusing an authorization
  code or an old refresh token revokes the whole connection.
- OAuth tokens work only at `/mcp` and `/api/mcp`. They are rejected by the REST API and cannot sign
  in to the dashboard.
- Tokens, codes and client secrets are stored as SHA-256 hashes. Consent requests are signed,
  expire after 10 minutes and are bound to the browser that started them. The consent page cannot
  be framed and loads no third-party scripts.
- MCP calls count against the credential's normal API budget (60 requests per minute), one per
  underlying API call.
- Revoke an app in **Account → Connected apps** (or `DELETE /api/v1/admin/oauth/connections/{id}`).
  Revocation blocks new requests and refreshes at once, and revokes keys and tokens created through
  the connection. Data the app already received is not recalled.

## OAuth reference for client developers

| Item | Value |
| --- | --- |
| Issuer | `https://<your-datagoat>` |
| Authorization server metadata | `/.well-known/oauth-authorization-server` (RFC 8414) |
| Protected resource metadata | `/.well-known/oauth-protected-resource/mcp` (RFC 9728); `/api/mcp` variant too |
| Authorization endpoint | `/oauth/authorize` (code + PKCE `S256` only; `iss` in the response, RFC 9207) |
| Token endpoint | `/oauth/token` (`application/x-www-form-urlencoded`) |
| Registration | `/oauth/register` (RFC 7591); HTTPS `client_id` metadata documents also accepted |
| Revocation | `/oauth/revoke` (RFC 7009) |
| Resource | `https://<your-datagoat>/mcp` (send it as `resource`, RFC 8707) |
| Client authentication | `none` (public clients with PKCE), `client_secret_basic`, `client_secret_post` |

- Redirect URIs must be `https://`, `http://` on a loopback address (the port may differ at
  authorization time), or a private-use scheme for native apps (`cursor://…`), and must match the
  registration exactly otherwise.
- Without `token_endpoint_auth_method`, registration follows RFC 7591 and issues a client secret
  (`client_secret_basic`). Public clients should send `"token_endpoint_auth_method": "none"`.
- Registrations expire after a year. Client metadata documents are fetched over HTTPS from public
  hosts only, without following redirects, up to 16 KB, and cached for a day.
- Unauthenticated MCP requests get `401` with
  `WWW-Authenticate: Bearer resource_metadata="https://<your-datagoat>/.well-known/oauth-protected-resource/mcp"`.
- The authorization, registration and token endpoints are rate limited per IP.
