import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState } from "react";
import type { Overview, Website } from "../../../../shared/api-types";
import { apiGet } from "../../api/client";
import { Button, Card, Input, Notice } from "../../components/ui";
import {
  currencyOptions,
  formatNumber,
  isValidHostname,
  normaliseHostname,
  timezoneOptions,
} from "./lib/format";
import {
  changedFields,
  useAccess,
  useRealtimeVisitors,
  useSiteId,
  useUpdateWebsite,
  useWebsite,
} from "./lib/hooks";
import { PROVIDERS } from "./lib/providers";
import {
  CONSENT_SNIPPET,
  PLATFORMS,
  type Platform,
  platformGuide,
  QUEUE_SNIPPET,
  type SnippetOptions,
  trimOrigin,
  variantFor,
} from "./lib/snippets";
import {
  Checkbox,
  CodeBlock,
  Field,
  QueryState,
  SaveRow,
  Select,
  SettingsLayout,
  Tabs,
} from "./lib/ui";

const ORIGIN_KEY = (siteId: string) => `datagoat.scriptOrigin.${siteId}`;

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode): the choice just is not remembered
  }
}

/**
 * Onboarding and installation guide: confirm domain, timezone and currency, copy the snippet for
 * the site's platform, wait for the first event, then connect revenue. New websites land here
 * after first-run setup and "Add website".
 */
export default function InstallPage() {
  const siteId = useSiteId();
  const website = useWebsite(siteId);
  const welcome = new URLSearchParams(window.location.search).has("welcome");
  return (
    <SettingsLayout siteId={siteId} domain={website.data?.domain}>
      {website.data ? (
        <div className="space-y-5">
          {welcome ? (
            <Notice tone="success">
              {website.data.domain} is added. Three short steps and you will see your first
              visitors.
            </Notice>
          ) : null}
          <ol className="space-y-5">
            <li>
              <DetailsStep website={website.data} />
            </li>
            <li>
              <SnippetStep website={website.data} />
            </li>
            <li>
              <VerifyStep website={website.data} />
            </li>
            <li>
              <RevenueStep website={website.data} />
            </li>
          </ol>
        </div>
      ) : (
        <QueryState query={website} />
      )}
    </SettingsLayout>
  );
}

function StepTitle({ n, children }: { n: number; children: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-fg"
      >
        {n}
      </span>
      <span>
        <span className="sr-only">Step {n}: </span>
        {children}
      </span>
    </span>
  );
}

type Details = Pick<Website, "domain" | "timezone" | "currency">;

function DetailsStep({ website }: { website: Website }) {
  const access = useAccess(website._id);
  const update = useUpdateWebsite(website._id);
  const original: Details = {
    domain: website.domain,
    timezone: website.timezone,
    currency: website.currency,
  };
  const [draft, setDraft] = useState<Details>(original);
  const [error, setError] = useState<string | null>(null);
  const timezones = useMemo(() => timezoneOptions(website.timezone), [website.timezone]);
  const currencies = useMemo(() => currencyOptions(website.currency), [website.currency]);
  const dirty = Object.keys(changedFields(original, draft)).length > 0;
  const disabled = !access.canEditSettings;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const domain = normaliseHostname(draft.domain);
    if (!isValidHostname(domain)) {
      setError("Enter a domain like example.com.");
      return;
    }
    update.mutate(changedFields(original, { ...draft, domain }), {
      onSuccess: (w) => setDraft({ domain: w.domain, timezone: w.timezone, currency: w.currency }),
    });
  };

  return (
    <Card title={<StepTitle n={1}>Website details</StepTitle>}>
      <form className="grid gap-4 sm:grid-cols-3" onSubmit={submit}>
        <Field label="Domain" error={error} hint="Root domain; subdomains are tracked too.">
          <Input
            value={draft.domain}
            disabled={disabled}
            onChange={(e) => {
              setDraft({ ...draft, domain: e.target.value });
              setError(null);
            }}
          />
        </Field>
        <Field label="Timezone">
          <Select
            value={draft.timezone}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency">
          <Select
            value={draft.currency}
            disabled={disabled}
            onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
          >
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-3">
          <SaveRow
            dirty={dirty}
            pending={update.isPending}
            error={update.error}
            saved={update.isSuccess}
            disabled={disabled}
          />
        </div>
      </form>
    </Card>
  );
}

function SnippetStep({ website }: { website: Website }) {
  const [platform, setPlatform] = useState<Platform>("html");
  const [origin, setOrigin] = useState(
    () => readStored(ORIGIN_KEY(website._id)) ?? window.location.origin,
  );
  const [hashRouting, setHashRouting] = useState(false);
  const [allowLocalhost, setAllowLocalhost] = useState(false);
  const cleanOrigin = /^https?:\/\/[^/\s]+$/i.test(trimOrigin(origin))
    ? trimOrigin(origin)
    : window.location.origin;
  const options: SnippetOptions = {
    trackingId: website.trackingId,
    domain: website.domain,
    origin: cleanOrigin,
    variant: variantFor(website.privacyMode, hashRouting),
    allowLocalhost,
    allowedHostnames: website.allowedHostnames,
  };
  const guide = platformGuide(platform, options);

  return (
    <Card title={<StepTitle n={2}>Add the tracking script</StepTitle>}>
      <div className="space-y-4">
        <Tabs label="Platform" tabs={PLATFORMS} value={platform} onChange={setPlatform}>
          <div className="space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {guide.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <CodeBlock code={guide.code} label={`${guide.label} snippet`} />
            {guide.note ? <p className="text-xs text-muted">{guide.note}</p> : null}
          </div>
        </Tabs>
        <details className="rounded-md border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium">Script options</summary>
          <div className="mt-3 space-y-3">
            <Field
              label="Script host"
              hint="Serve the script from a subdomain of your site (a Cloudflare custom domain on this Worker) so fewer ad blockers stop it. Leave as is to use this DataGoat address."
            >
              <Input
                value={origin}
                placeholder="https://a.example.com"
                onChange={(e) => {
                  setOrigin(e.target.value);
                  const v = trimOrigin(e.target.value);
                  writeStored(
                    ORIGIN_KEY(website._id),
                    v && v !== window.location.origin ? v : null,
                  );
                }}
              />
            </Field>
            <Checkbox
              label="Hash-based routing (example.com/#/pricing)"
              hint={
                website.privacyMode === "cookieless"
                  ? "Not available with the cookieless script."
                  : "Loads script.hash.js, which tracks the part after # as the page."
              }
              checked={hashRouting && website.privacyMode !== "cookieless"}
              disabled={website.privacyMode === "cookieless"}
              onChange={setHashRouting}
            />
            <Checkbox
              label="Track localhost while developing"
              hint="Adds data-allow-localhost. Remove it in production to keep test visits out."
              checked={allowLocalhost}
              onChange={setAllowLocalhost}
            />
          </div>
        </details>
        <PrivacyNote website={website} />
      </div>
    </Card>
  );
}

function PrivacyNote({ website }: { website: Website }) {
  const settings = (
    <Link
      to="/app/$siteId/settings/tracking"
      params={{ siteId: website._id }}
      className="text-primary-text underline"
    >
      Tracking &amp; privacy
    </Link>
  );
  if (website.privacyMode === "cookieless")
    return (
      <p className="text-xs text-muted">
        This website uses cookieless mode, so the snippet loads script.cookieless.js. Change it in{" "}
        {settings}.
      </p>
    );
  if (website.privacyMode === "consent")
    return (
      <div className="space-y-2 text-sm">
        <p className="text-xs text-muted">
          Consent mode: visitors are counted without cookies until your consent banner calls the
          tracker. Add the queue snippet before the tag so early calls are kept, then call:
        </p>
        <CodeBlock
          code={`${QUEUE_SNIPPET}\n\n<script>\n${CONSENT_SNIPPET}\n</script>`}
          label="consent snippet"
        />
        <p className="text-xs text-muted">Change the mode in {settings}.</p>
      </div>
    );
  return (
    <p className="text-xs text-muted">
      Cookie mode (default) gives the most complete revenue attribution. Cookieless and consent
      modes are in {settings}.
    </p>
  );
}

function VerifyStep({ website }: { website: Website }) {
  const total = useQuery({
    queryKey: ["settings", website._id, "install-total"],
    queryFn: async () =>
      (
        await apiGet<Overview[]>("/api/v1/analytics/overview", {
          websiteId: website._id,
          fields: "pageviews",
        })
      )[0]?.pageviews ?? 0,
    retry: false,
  });
  const already = (total.data ?? 0) > 0;
  const live = useRealtimeVisitors(website._id, !already);
  const visitors = live.data ?? 0;
  const verified = already || visitors > 0;
  const checking = live.isFetching || total.isFetching;

  return (
    <Card title={<StepTitle n={3}>Verify the installation</StepTitle>}>
      <div className="space-y-3 text-sm">
        <div aria-live="polite">
          {verified ? (
            <Notice tone="success">
              DataGoat is receiving events from {website.domain}.{" "}
              {visitors > 0
                ? `${formatNumber(visitors)} ${visitors === 1 ? "visitor" : "visitors"} on the site right now.`
                : `${formatNumber(total.data ?? 0)} pageviews so far.`}
            </Notice>
          ) : live.error ? (
            <Notice tone="error">Could not check for events: {live.error.message}</Notice>
          ) : (
            <div
              role="status"
              className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-muted"
            >
              <span className="size-3 animate-pulse rounded-full bg-warning" aria-hidden="true" />
              Waiting for the first event. Open your site in a new tab; this checks every few
              seconds.
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={checking}
            onClick={() => {
              void live.refetch();
              void total.refetch();
            }}
          >
            {checking ? "Checking…" : "Check now"}
          </Button>
          <a
            href={`https://${website.domain}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-md border border-line px-3 py-2 text-sm hover:bg-surface-2"
          >
            Open {website.domain}
          </a>
          {verified ? (
            <Link
              to="/app/$siteId/overview"
              params={{ siteId: website._id }}
              className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg"
            >
              Go to dashboard
            </Link>
          ) : null}
        </div>
        {!verified ? (
          <details className="rounded-md border border-line p-3">
            <summary className="cursor-pointer font-medium">Nothing showing up?</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>
                Check that data-domain is <code>{website.domain}</code> and data-website-id is{" "}
                <code>{website.trackingId}</code>.
              </li>
              <li>
                Visits from localhost are ignored unless the tag has data-allow-localhost="true".
              </li>
              <li>
                An ad blocker or a browser with <code>localStorage.datafast_ignore</code> set does
                not send events. Try a private window.
              </li>
              <li>
                A Content-Security-Policy must allow this DataGoat host in script-src and
                connect-src.
              </li>
              <li>
                Other hostnames must be listed under allowed hostnames in Tracking &amp; privacy.
              </li>
              <li>Your IP, country or the page may be excluded on the Exclusions tab.</li>
            </ul>
          </details>
        ) : null}
      </div>
    </Card>
  );
}

function RevenueStep({ website }: { website: Website }) {
  return (
    <Card title={<StepTitle n={4}>Connect revenue (recommended)</StepTitle>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Connect your payment provider to see which channels, campaigns and pages bring paying
          customers, not just visitors.
        </p>
        <ul className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <li key={p.id}>
              <Link
                to="/app/$siteId/integrations"
                params={{ siteId: website._id }}
                hash={p.id}
                className="inline-flex items-center rounded-md border border-line px-3 py-1.5 hover:bg-surface-2"
              >
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          No provider? Send payments from your server with the Payments API (POST /api/v1/payments)
          using a key from{" "}
          <Link
            to="/app/$siteId/keys"
            params={{ siteId: website._id }}
            className="text-primary-text underline"
          >
            API keys
          </Link>
          .
        </p>
      </div>
    </Card>
  );
}
