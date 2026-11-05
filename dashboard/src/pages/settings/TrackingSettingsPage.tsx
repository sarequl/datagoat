import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { BotLevel, PrivacyMode, Website } from "../../../../shared/api-types";
import { Card, Notice } from "../../components/ui";
import { isValidHostname, normaliseHostname } from "./lib/format";
import { useAccess, useSiteId, useUpdateWebsite, useWebsite } from "./lib/hooks";
import { htmlSnippet, variantFor } from "./lib/snippets";
import {
  CodeBlock,
  ListEditor,
  QueryState,
  RadioCards,
  ReadOnlyNotice,
  SaveRow,
  SettingsLayout,
  Toggle,
} from "./lib/ui";

/** Website settings > Tracking & privacy: privacy mode, GPC, bot filtering, allowed hostnames. */
export default function TrackingSettingsPage() {
  const siteId = useSiteId();
  const website = useWebsite(siteId);
  const access = useAccess(siteId);
  const disabled = !access.canEditSettings;
  return (
    <SettingsLayout siteId={siteId} domain={website.data?.domain}>
      {website.data ? (
        <div className="space-y-5">
          {disabled ? <ReadOnlyNotice role={access.role} action="change settings" /> : null}
          <PrivacyCard website={website.data} disabled={disabled} />
          <BotCard website={website.data} disabled={disabled} />
          <HostnamesCard website={website.data} disabled={disabled} />
          <ProxyCard website={website.data} />
        </div>
      ) : (
        <QueryState query={website} />
      )}
    </SettingsLayout>
  );
}

const PRIVACY_OPTIONS = [
  {
    value: "cookie",
    label: "Cookies (default)",
    description:
      "First-party cookies keep a visitor's journey across days. Best revenue attribution and returning-visitor metrics.",
  },
  {
    value: "cookieless",
    label: "Cookieless",
    description:
      "No cookies. Visitors are counted with a hash of IP and browser that changes every day, so returning visitors and multi-day journeys are not linked. Loads script.cookieless.js.",
  },
  {
    value: "consent",
    label: "Consent-based",
    description:
      'Cookieless until your consent banner calls window.datagoat("consent", true), then cookies. Calling it with false deletes them.',
  },
] as const satisfies ReadonlyArray<{ value: PrivacyMode; label: string; description: string }>;

function PrivacyCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  const [mode, setMode] = useState<PrivacyMode>(website.privacyMode);
  const scriptChanges = variantFor(mode, false) !== variantFor(website.privacyMode, false);
  const snippet = htmlSnippet({
    trackingId: website.trackingId,
    domain: website.domain,
    origin: window.location.origin,
    variant: variantFor(mode, false),
  });
  return (
    <Card title="Privacy mode">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ privacyMode: mode });
        }}
      >
        <RadioCards
          legend="Privacy mode"
          name="privacy-mode"
          options={PRIVACY_OPTIONS}
          value={mode}
          onChange={setMode}
          disabled={disabled}
        />
        {scriptChanges ? (
          <Notice>
            This mode needs a different script. After saving, replace the tag on your site with:
          </Notice>
        ) : null}
        {scriptChanges ? <CodeBlock code={snippet} label="updated snippet" /> : null}
        {mode !== "cookie" && website.privacyMode === "cookie" ? (
          <p className="text-xs text-warning-text">
            Switching away from cookies makes revenue attribution and multi-day journeys less
            complete. Keep cookies unless you have a privacy or compliance reason.
          </p>
        ) : null}
        <p className="text-xs text-muted">
          Whether a mode removes the need for a consent banner depends on your jurisdiction and how
          you use the data. That is a legal question for you, not a guarantee from DataGoat.
        </p>
        <SaveRow
          dirty={mode !== website.privacyMode}
          pending={update.isPending}
          error={update.error}
          saved={update.isSuccess}
          disabled={disabled}
        />
      </form>
      <div className="mt-5 border-t border-line pt-4">
        <GpcToggle website={website} disabled={disabled} />
      </div>
    </Card>
  );
}

function GpcToggle({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  return (
    <div className="space-y-2">
      <Toggle
        label="Honor Global Privacy Control"
        description="Browsers that send the Sec-GPC: 1 signal are tracked cookieless, whatever the mode above."
        checked={website.honorGpc}
        disabled={disabled || update.isPending}
        onChange={(v) => update.mutate({ honorGpc: v })}
      />
      {update.error ? <Notice tone="error">{update.error.message}</Notice> : null}
    </div>
  );
}

const BOT_OPTIONS = [
  {
    value: "off",
    label: "Off",
    description: "Count every request that runs the script. Not recommended.",
  },
  {
    value: "standard",
    label: "Standard",
    description:
      "Drops known bots, crawlers, headless browsers and automation tools. Recommended for most sites.",
  },
  {
    value: "strict",
    label: "Strict (attack mode)",
    description:
      "Also drops traffic that looks automated even when it does not say it is a bot. Use while your site is being spammed; a few real visitors may be dropped.",
  },
] as const satisfies ReadonlyArray<{ value: BotLevel; label: string; description: string }>;

function BotCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  const [level, setLevel] = useState<BotLevel>(website.botLevel);
  return (
    <Card title="Bot filtering">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ botLevel: level });
        }}
      >
        <RadioCards
          legend="Bot filtering level"
          name="bot-level"
          options={BOT_OPTIONS}
          value={level}
          onChange={setLevel}
          disabled={disabled}
        />
        <p className="text-xs text-muted">
          Filtered bots are never stored and do not use your Cloudflare quota for database writes.
          AI crawlers are reported separately on the{" "}
          <Link
            to="/app/$siteId/bot-traffic"
            params={{ siteId: website._id }}
            className="text-primary-text underline"
          >
            Bot traffic
          </Link>{" "}
          page.
        </p>
        <SaveRow
          dirty={level !== website.botLevel}
          pending={update.isPending}
          error={update.error}
          saved={update.isSuccess}
          disabled={disabled}
        />
      </form>
    </Card>
  );
}

function HostnamesCard({ website, disabled }: { website: Website; disabled: boolean }) {
  const update = useUpdateWebsite(website._id);
  const [hosts, setHosts] = useState(website.allowedHostnames);
  const [allowAll, setAllowAll] = useState(website.isAllHostnamesAllowed);
  const dirty =
    JSON.stringify(hosts) !== JSON.stringify(website.allowedHostnames) ||
    allowAll !== website.isAllHostnamesAllowed;
  return (
    <Card title="Allowed hostnames">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate(
            { allowedHostnames: hosts, isAllHostnamesAllowed: allowAll },
            {
              onSuccess: (w) => {
                setHosts(w.allowedHostnames);
                setAllowAll(w.isAllHostnamesAllowed);
              },
            },
          );
        }}
      >
        <p className="text-sm text-muted">
          Events are accepted from {website.domain} and its subdomains. Add other domains that run
          the same script, such as your app on another root domain, to track visitors across them.
          Also list them in the script's data-allowed-hostnames so visitor IDs carry over.
        </p>
        <ListEditor
          label="Allowed hostnames"
          items={hosts}
          onChange={setHosts}
          disabled={disabled || allowAll}
          placeholder="app.example.io"
          normalise={normaliseHostname}
          validate={(v) => (isValidHostname(v) ? null : `${v} is not a valid hostname.`)}
          max={100}
        />
        <Toggle
          label="Accept events from any hostname"
          description="Useful for white-label sites on many domains. Anyone who copies your snippet can then send events."
          checked={allowAll}
          disabled={disabled}
          onChange={setAllowAll}
        />
        <SaveRow
          dirty={dirty}
          pending={update.isPending}
          error={update.error}
          saved={update.isSuccess}
          disabled={disabled}
        />
      </form>
    </Card>
  );
}

function ProxyCard({ website }: { website: Website }) {
  const host = `a.${website.domain}`;
  return (
    <Card title="First-party script domain">
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Ad blockers often block analytics hosts. Serving the script from a neutral subdomain of
          your own site keeps more visitors and revenue attribution. DataGoat runs on your
          Cloudflare account, so this needs no proxy code:
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            In Cloudflare, open Workers &amp; Pages, select the DataGoat Worker, then Settings &gt;
            Domains &amp; Routes &gt; Add &gt; Custom domain.
          </li>
          <li>
            Enter a neutral subdomain such as <code>{host}</code> (avoid names like analytics or
            tracking). Your domain's DNS must be on Cloudflare; the certificate is issued
            automatically.
          </li>
          <li>
            On the{" "}
            <Link
              to="/app/$siteId/settings/install"
              params={{ siteId: website._id }}
              className="text-primary-text underline"
            >
              Installation
            </Link>{" "}
            page, set Script host to <code>https://{host}</code> and copy the new tag. It loads the
            script from your subdomain and sends events there with data-api-url.
          </li>
        </ol>
        <p className="text-xs text-muted">
          Without Cloudflare DNS, proxy <code>/js/script.js</code> and <code>/api/events</code>{" "}
          through your own server instead (see docs/install.md).
        </p>
      </div>
    </Card>
  );
}
