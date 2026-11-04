# DataGoat with Astro

Add the tag to the layout every page uses:

```astro
---
// src/layouts/Layout.astro
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script
      is:inline
      defer
      data-website-id="dfid_XXXXXXXXXXXXXXXX"
      data-domain="example.com"
      src="https://a.example.com/js/script.js"
    ></script>
  </head>
  <body>
    <slot />
  </body>
</html>
```

`is:inline` matters: without it Astro bundles and rewrites the script and the `data-*`
attributes are lost.

## View transitions

With `<ClientRouter />` (view transitions), Astro swaps pages without a full load. The tracker
follows `history.pushState`, which Astro's router uses, so each page change is recorded. Keep the
tag in the shared `<head>` (do not add `transition:persist` duplicates on other layouts).

## Goals

```astro
<button data-fast-goal="newsletter_signup" data-fast-goal-source="footer">Subscribe</button>
```

or from a script: `window.datafast("newsletter_signup", { source: "footer" })`.

First-party proxy for server or hybrid output: [proxy-astro.md](proxy-astro.md).
