/**
 * Tracking-snippet builder for the install guide and the tracking settings. The attributes are
 * DataFast's (plan §3.1). `data-api-url` is always set to the DataGoat Worker so events reach it
 * whatever host serves the script (a first-party custom domain, or the Worker itself).
 */
import type { PrivacyMode } from "../../../../../shared/api-types";

export type ScriptVariant = "default" | "cookieless" | "hash";

export interface SnippetOptions {
  trackingId: string;
  domain: string;
  /** Origin that serves /js/script.js and /api/events, e.g. https://a.example.com */
  origin: string;
  variant: ScriptVariant;
  allowLocalhost?: boolean;
  /** Extra root domains for cross-domain linking (`data-allowed-hostnames`). */
  allowedHostnames?: string[];
}

export const SCRIPT_FILES: Record<ScriptVariant, string> = {
  default: "script.js",
  cookieless: "script.cookieless.js",
  hash: "script.hash.js",
};

/** The build a site should load: cookieless mode needs the cookieless script. */
export function variantFor(privacyMode: PrivacyMode, hashRouting: boolean): ScriptVariant {
  if (privacyMode === "cookieless") return "cookieless";
  return hashRouting ? "hash" : "default";
}

export function trimOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function scriptSrc(o: Pick<SnippetOptions, "origin" | "variant">): string {
  return `${trimOrigin(o.origin)}/js/${SCRIPT_FILES[o.variant]}`;
}

export function apiUrl(o: Pick<SnippetOptions, "origin">): string {
  return `${trimOrigin(o.origin)}/api/events`;
}

/** Ordered `[attribute, value]` pairs (without `defer` and `src`). */
export function dataAttributes(o: SnippetOptions): Array<[string, string]> {
  const attrs: Array<[string, string]> = [
    ["data-website-id", o.trackingId],
    ["data-domain", o.domain],
  ];
  if (o.allowedHostnames?.length)
    attrs.push(["data-allowed-hostnames", o.allowedHostnames.join(",")]);
  if (o.allowLocalhost) attrs.push(["data-allow-localhost", "true"]);
  attrs.push(["data-api-url", apiUrl(o)]);
  return attrs;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The plain `<script>` tag on one or several lines. */
export function htmlSnippet(o: SnippetOptions, multiline = true): string {
  const parts = [
    "defer",
    ...dataAttributes(o).map(([k, v]) => `${k}="${escapeAttr(v)}"`),
    `src="${escapeAttr(scriptSrc(o))}"`,
  ];
  if (!multiline) return `<script ${parts.join(" ")}></script>`;
  return `<script\n  ${parts.join("\n  ")}\n></script>`;
}

/** Queue stub so calls made before the script loads are kept (DataFast's pattern). */
export const QUEUE_SNIPPET = `<script>
  window.datafast = window.datafast || function () {
    (window.datafast.q = window.datafast.q || []).push(arguments);
  };
</script>`;

function jsString(v: string): string {
  return JSON.stringify(v);
}

/** A script that injects the tracker; for tag managers that drop data-* attributes. */
export function injectorSnippet(o: SnippetOptions): string {
  const lines = dataAttributes(o).map(
    ([k, v]) => `    s.setAttribute(${jsString(k)}, ${jsString(v)});`,
  );
  return `<script>
  (function () {
    var s = document.createElement("script");
    s.defer = true;
    s.src = ${jsString(scriptSrc(o))};
${lines.join("\n")}
    document.head.appendChild(s);
  })();
</script>`;
}

function jsxProps(o: SnippetOptions, indent: string): string {
  return dataAttributes(o)
    .map(([k, v]) => `${indent}${k}=${jsString(v)}`)
    .join("\n");
}

export type Platform =
  | "html"
  | "nextjs"
  | "react"
  | "vue"
  | "wordpress"
  | "webflow"
  | "framer"
  | "shopify"
  | "gtm"
  | "datafast";

export interface PlatformGuide {
  id: Platform;
  label: string;
  steps: string[];
  code: string;
  /** Language label for the code block. */
  language: string;
  note?: string;
}

export const PLATFORMS: ReadonlyArray<{ id: Platform; label: string }> = [
  { id: "html", label: "HTML" },
  { id: "nextjs", label: "Next.js" },
  { id: "react", label: "React" },
  { id: "vue", label: "Vue / Nuxt" },
  { id: "wordpress", label: "WordPress" },
  { id: "webflow", label: "Webflow" },
  { id: "framer", label: "Framer" },
  { id: "shopify", label: "Shopify" },
  { id: "gtm", label: "Google Tag Manager" },
  { id: "datafast", label: "Switch from DataFast" },
];

export function platformGuide(platform: Platform, o: SnippetOptions): PlatformGuide {
  const tag = htmlSnippet(o);
  const label = PLATFORMS.find((p) => p.id === platform)?.label ?? platform;
  switch (platform) {
    case "html":
      return {
        id: platform,
        label,
        language: "html",
        steps: [
          "Paste the tag inside the <head> of every page, or in the shared layout or template.",
          "Deploy, then open your site in a new tab to send the first pageview.",
        ],
        code: tag,
      };
    case "nextjs":
      return {
        id: platform,
        label,
        language: "tsx",
        steps: [
          "App Router: add the script to app/layout.tsx. Pages Router: put the same <Script> in pages/_app.tsx.",
          "Client-side navigations are tracked automatically; no route listener is needed.",
        ],
        code: `import Script from "next/script";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script
          src=${jsString(scriptSrc(o))}
${jsxProps(o, "          ")}
          strategy="afterInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}`,
      };
    case "react":
      return {
        id: platform,
        label,
        language: "html",
        steps: [
          "Vite, Create React App and other single-page apps: add the tag to the <head> of index.html.",
          "React Router and other history-based routers are tracked automatically.",
        ],
        code: `<!-- index.html -->
<head>
  ${htmlSnippet(o, false)}
</head>`,
      };
    case "vue":
      return {
        id: platform,
        label,
        language: "ts",
        steps: [
          "Vue with Vite: add the plain HTML tag to the <head> of index.html.",
          "Nuxt: register the script in nuxt.config.ts as below.",
        ],
        code: `// nuxt.config.ts
export default defineNuxtConfig({
  app: {
    head: {
      script: [
        {
          src: ${jsString(scriptSrc(o))},
          defer: true,
${dataAttributes(o)
  .map(([k, v]) => `          ${jsString(k)}: ${jsString(v)},`)
  .join("\n")}
        },
      ],
    },
  },
});`,
      };
    case "wordpress":
      return {
        id: platform,
        label,
        language: "php",
        steps: [
          "Easiest: install the DataGoat WordPress plugin (packages/wordpress-plugin), enter this website ID and your DataGoat URL in Settings > DataGoat.",
          "Without the plugin: add this to your child theme's functions.php, or paste the HTML tag into a header-code plugin.",
          "WooCommerce stores: the plugin also connects orders for revenue (see Integrations).",
        ],
        code: `add_action('wp_head', function () {
  ?>
  ${htmlSnippet(o, false)}
  <?php
});`,
      };
    case "webflow":
      return {
        id: platform,
        label,
        language: "html",
        steps: [
          "Open Site settings > Custom code.",
          "Paste the tag into Head code and save.",
          "Publish the site; custom code only runs on the published domain.",
        ],
        code: tag,
      };
    case "framer":
      return {
        id: platform,
        label,
        language: "html",
        steps: [
          "Open Site settings > General > Custom code.",
          'Paste the tag into "End of <head> tag" and save.',
          "Publish the site to make it live.",
        ],
        code: tag,
      };
    case "shopify":
      return {
        id: platform,
        label,
        language: "liquid",
        steps: [
          "Recommended: connect Shopify on the Integrations page. The app adds tracking to the storefront and imports orders as revenue.",
          "Manual install: Online Store > Themes > Edit code > layout/theme.liquid, paste the tag just before </head> and save.",
          "The manual tag tracks the storefront only; connect the app to attribute orders.",
        ],
        code: `{% comment %} layout/theme.liquid, before </head> {% endcomment %}
${tag}`,
      };
    case "gtm":
      return {
        id: platform,
        label,
        language: "html",
        steps: [
          "In Google Tag Manager, create a new tag of type Custom HTML.",
          "Paste the code below. It creates the script element so the data-* attributes survive.",
          "Trigger: All Pages (Page View). Save, then Submit and Publish the container.",
        ],
        code: injectorSnippet(o),
        note: "Ad blockers that block Tag Manager also block the tracker. A direct tag is more reliable.",
      };
    case "datafast":
      return {
        id: platform,
        label,
        language: "html",
        steps: [
          "Keep your existing DataFast tag and change three things: the src URL, the data-website-id and a new data-api-url, as below.",
          "window.datafast(...) calls, data-fast-goal attributes, the datafast_visitor_id cookie and your checkout metadata keep working unchanged.",
          "Server code that calls DataFast's API: change the base URL to this instance's /api/v1 and use a DataGoat API key (API keys page).",
        ],
        code: `<!-- Before (DataFast) -->
<script
  defer
  data-website-id="dfid_your_old_id"
  data-domain="${escapeAttr(o.domain)}"
  src="https://datafa.st/js/${SCRIPT_FILES[o.variant]}"
></script>

<!-- After (DataGoat) -->
${tag}`,
      };
  }
}

/** Consent-mode calls (our extension; DataFast's script would treat them as goals). */
export const CONSENT_SNIPPET = `// After the visitor accepts analytics cookies:
window.datafast("consent", true);

// If they decline or withdraw consent (cookies are deleted):
window.datafast("consent", false);`;

/** Browser-console commands that stop counting your own visits on a site. */
export const IGNORE_ON = "localStorage.datafast_ignore = 'true'";
export const IGNORE_OFF = "delete localStorage.datafast_ignore";
