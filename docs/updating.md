# Updating your DataGoat deployment

The Deploy to Cloudflare button copies DataGoat into your own GitHub account and connects that copy to Cloudflare Workers Builds. The copy does not follow this repository on its own, so DataGoat ships a GitHub workflow, **Update DataGoat**, that runs inside your copy and brings in new versions.

## How it works

1. Every day, or when you run it by hand, the workflow fetches the latest DataGoat.
2. It replaces your copy's files with the new version, then puts back what belongs to your copy:
   - in `wrangler.jsonc`: the Worker name, `account_id`, routes and custom domains, and every resource id (D1 database, KV namespace, rate-limit namespaces and so on), matched by binding name
   - in `package.json`: the package name
   - any file you list under `keep` in `.datagoat-update.json`
3. It pushes the result or opens a pull request. Cloudflare rebuilds and redeploys, and new database migrations run as part of the deploy.

Your data lives in your D1 database and is never touched by an update.

## Choose push or pull request

Create `.datagoat-update.json` at the root of your copy:

```json
{ "mode": "push" }
```

| Mode | What happens |
|---|---|
| `pr` (default) | Opens an "Update DataGoat" pull request. Merge it to deploy. Needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests". |
| `push` | Commits the update straight to your default branch, which redeploys at once. |

To keep your own changes to a file, list it:

```json
{ "mode": "pr", "keep": ["src/custom/my-tweak.ts"] }
```

Files you keep are never replaced or deleted. Changes you make to other DataGoat files are overwritten by the next update, so keep customisations in kept files.

## Run an update now

In your copy on GitHub: **Actions → Update DataGoat → Run workflow**.

## Copies made before this workflow existed

Copy `.github/workflows/update-datagoat.yml` from this repository into your copy once, commit it, and run it. After that it updates itself, including future changes to the workflow.

## Updating by hand

From a clone of your copy, with this repository cloned next to it:

```bash
node ../datagoat/scripts/update-from-upstream.mjs --from ../datagoat --to . --version "$(git -C ../datagoat rev-parse HEAD)"
```

Review the changes with `git diff`, then commit and push.
