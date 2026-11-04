# GitHub commit markers

Show commits (message, author, +/− lines, branch, time) on the analytics chart, filterable by
prefix such as `feat:` (`GET /api/v1/github/commits?q=feat:`). One repository per website.

## Connect

`PUT /api/v1/admin/websites/:id/integrations/github` with `{"repo": "owner/name", "branch": null}`
(or the Integrations page). Then either:

- **Public repository:** nothing else; the API is read without a token (60 requests/hour per IP).
- **Token:** add `"accessToken"`: a fine-grained personal access token with *Contents: read* and
  *Metadata: read* on that repository.
- **OAuth:** create a GitHub OAuth app (or a GitHub App with *Contents: read*), set its callback to
  `https://<host>/api/connect/github/callback`, set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`,
  and click Connect. `GET /api/v1/github/repos` then lists the repositories you can pick.

`github.sync` runs hourly: it imports commits since the newest one stored (90 days on the first
run) and fills in line stats for 10 commits per run.

## Instant updates (optional)

Add a webhook on the repository: payload URL and secret are shown in the integration's settings
(`webhookUrl`, `webhookSecret`, visible to members who can change settings), content type
`application/json`, event "Just the push event". Pushes to the configured branch (default branch
when none is set) are stored immediately; deliveries without a valid `X-Hub-Signature-256` are
rejected.
