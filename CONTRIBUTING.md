# Contributing to DataGoat

Thanks for helping build DataGoat. This document covers how to set up a
development environment, how to make a change, and how to open a pull request.

## Ground rules

- **Original code only.** DataGoat targets feature parity with commercial
  analytics products. Read their public docs if you need to understand a
  behaviour, but never copy their source, markup, styles, or copy. Their source
  is not shipped in this project and must not be added.
- **Small, verified changes.** Keep a pull request to one coherent change. Say
  what you verified and how.
- **No secrets.** Never commit API keys, tokens, webhook secrets, or a real
  `SESSION_SECRET`. Use `.env.example` for placeholders.
- **Licensing.** DataGoat is MIT. By contributing you agree your contributions
  are licensed under the same terms.

## Development setup

DataGoat is a set of packages plus a Worker. The exact layout is decided in
[`ROADMAP.md`](ROADMAP.md); until the layout lands, treat this section as a
checklist to confirm before you start.

1. Install Node.js (LTS) and [Wrangler](https://developers.cloudflare.com/workers/wrangler/).
2. Fork and clone the repository.
3. Install dependencies with your package manager of choice.
4. Copy `.env.example` to `.env` and fill in placeholder values.
5. Create a local D1 database with `wrangler d1 create datagoat-local` and apply
   migrations.
6. Run the dev server and confirm the dashboard loads.

## Making a change

1. Create a branch from `main` named `feat/<short-description>` or
   `fix/<short-description>`.
2. Make the change. Add or update tests where the behaviour is testable.
3. Run the linter, type checker, and test suite. A change is not done until the
   commands you ran pass.
4. Write a clear commit message: what changed and why.

## Pull requests

- Fill in the pull request template.
- Reference the issue you are closing, if any.
- Describe what you changed, how you tested it, and what you could not verify.
- Do not force-push over review comments; add follow-up commits.
- Keep the branch up to date with `main` before asking for a final review.

## Reporting bugs and requesting features

Use the issue templates in
[`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). Include the DataGoat
version, your Worker/D1 setup, and a minimal reproduction for bugs.

## Questions

Open a discussion or an issue tagged `question`. Maintainers are volunteers;
please be patient and kind. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
