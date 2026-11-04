/**
 * @datagoat/sdk/next: Next.js helpers.
 *
 * App Router, in app/layout.tsx (a server component, no "use client" needed):
 *
 *   import { DataGoatScript } from "@datagoat/sdk/next";
 *   <html><head><DataGoatScript websiteId="dfid_..." domain="example.com" /></head>...</html>
 *
 * First-party proxy, in next.config.mjs:
 *
 *   import { withDataGoat } from "@datagoat/sdk/next";
 *   export default withDataGoat({ ...yourConfig }, { host: "https://datagoat.example.workers.dev" });
 *
 * Checkout (route handler or server action):
 *
 *   import { cookies } from "next/headers";
 *   import { checkoutMetadata } from "@datagoat/sdk/next";
 *   metadata: checkoutMetadata(await cookies())
 */
import { type DataGoatOptions, scriptAttributes } from "./index.js";

export {
  checkoutMetadata,
  getSessionId,
  getVisitorId,
  lemonSqueezyCheckoutData,
} from "./server.js";

/** The documented pre-load queue, so goals and identify calls before the script loads are kept. */
export const QUEUE_SNIPPET =
  "window.datafast=window.datafast||function(){(window.datafast.q=window.datafast.q||[]).push(arguments)};";

export interface DataGoatScriptProps extends DataGoatOptions {
  /** Also render the pre-load queue snippet (default true). */
  queue?: boolean;
}

/** Renders the tracker `<script defer ...>` (and the queue). Use in `<head>` of the root layout. */
export function DataGoatScript({ queue = true, nonce, ...options }: DataGoatScriptProps) {
  const attrs = scriptAttributes(options);
  return (
    <>
      {queue ? (
        <script
          id="datagoat-queue"
          nonce={nonce}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: constant snippet, no user input
          dangerouslySetInnerHTML={{ __html: QUEUE_SNIPPET }}
        />
      ) : null}
      <script defer nonce={nonce} {...attrs} />
    </>
  );
}

export interface Rewrite {
  source: string;
  destination: string;
  [key: string]: unknown;
}

type RewritesResult =
  | Rewrite[]
  | { beforeFiles?: Rewrite[]; afterFiles?: Rewrite[]; fallback?: Rewrite[] };

interface NextConfigLike {
  rewrites?: () => Promise<RewritesResult> | RewritesResult;
  [key: string]: unknown;
}

export interface ProxyOptions {
  /** Origin of your DataGoat collector, e.g. https://datagoat.yourname.workers.dev. */
  host: string;
  /** Path the script is served from on your site. Default `/js/script.js`. */
  scriptPath?: string;
  /** Path events are posted to on your site. Default `/api/events`. Set `data-api-url` to match. */
  eventsPath?: string;
  /** Which tracker build to proxy. Default `default`. */
  variant?: DataGoatOptions["variant"];
}

const FILES = {
  default: "script.js",
  cookieless: "script.cookieless.js",
  hash: "script.hash.js",
} as const;

/** The two rewrites that serve the tracker and its collector from your own domain. */
export function dataGoatRewrites(options: ProxyOptions): Rewrite[] {
  const host = options.host.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(host)) throw new Error("@datagoat/sdk: host must be an http(s) origin");
  return [
    {
      source: options.scriptPath ?? "/js/script.js",
      destination: `${host}/js/${FILES[options.variant ?? "default"]}`,
    },
    { source: options.eventsPath ?? "/api/events", destination: `${host}/api/events` },
  ];
}

/**
 * Wrap your Next.js config with the proxy rewrites. They run before your own files and routes,
 * so the paths cannot be shadowed. Next.js forwards the visitor's IP in `X-Forwarded-For`.
 */
export function withDataGoat<T extends NextConfigLike>(
  config: T,
  options: ProxyOptions,
): Omit<T, "rewrites"> & { rewrites(): Promise<RewritesResult> } {
  const ours = dataGoatRewrites(options);
  const previous = config.rewrites;
  return {
    ...config,
    async rewrites(): Promise<RewritesResult> {
      const existing = previous ? await previous() : [];
      if (Array.isArray(existing)) return { beforeFiles: ours, afterFiles: existing };
      return { ...existing, beforeFiles: [...ours, ...(existing.beforeFiles ?? [])] };
    },
  };
}
