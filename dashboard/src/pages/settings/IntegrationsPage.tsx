import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { GrowthIntegrationStatus, IntegrationsStatus } from "../../../../shared/api-types";
import { Button, Card, Input, Notice } from "../../components/ui";
import { formatDate, formatRelative } from "./lib/format";
import {
  connectUrl,
  type GrowthKind,
  useAccess,
  useGithubRepos,
  useGrowthIntegration,
  useIntegrations,
  useProviderAction,
  useSaveGrowthIntegration,
  useSiteId,
  useWebsite,
} from "./lib/hooks";
import { PROVIDERS, type ProviderDef } from "./lib/providers";
import {
  Badge,
  CodeBlock,
  ConfirmDialog,
  CopyField,
  Field,
  FieldGroup,
  ListEditor,
  PageHeader,
  QueryState,
  ReadOnlyNotice,
} from "./lib/ui";

/**
 * Integrations: payment providers (connect, status, re-sync, disconnect) and growth sources
 * (Search Console, GitHub, X and Reddit mentions, Meta Ads), each with setup steps.
 */
export default function IntegrationsPage() {
  const siteId = useSiteId();
  const access = useAccess(siteId);
  const status = useIntegrations(siteId);
  const website = useWebsite(siteId);
  const disabled = !access.canEditSettings;
  const [hash] = useState(() => window.location.hash.replace(/^#/, ""));

  useEffect(() => {
    if (!hash || !status.data) return;
    document.getElementById(`integration-${hash}`)?.scrollIntoView?.({ block: "start" });
  }, [hash, status.data]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect revenue so every channel, campaign and page shows the money it brings, and add growth sources to your charts."
      />
      {disabled ? <ReadOnlyNotice role={access.role} action="connect integrations" /> : null}
      <section aria-labelledby="revenue-heading" className="space-y-3">
        <h2 id="revenue-heading" className="text-base font-semibold">
          Revenue
        </h2>
        {status.data ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {PROVIDERS.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                status={status.data}
                siteId={siteId}
                siteCurrency={website.data?.currency ?? status.data.currency}
                disabled={disabled}
                initiallyOpen={hash === p.id}
              />
            ))}
          </div>
        ) : (
          <QueryState query={status} />
        )}
        <p className="text-xs text-muted">
          No supported provider? Send payments from your server with{" "}
          <code>POST /api/v1/payments</code> and a key from the{" "}
          <Link to="/app/$siteId/keys" params={{ siteId }} className="text-primary-text underline">
            API keys
          </Link>{" "}
          page.
        </p>
      </section>
      <section aria-labelledby="growth-heading" className="space-y-3">
        <h2 id="growth-heading" className="text-base font-semibold">
          Growth
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <SearchConsoleCard siteId={siteId} disabled={disabled} />
          <GithubCard siteId={siteId} disabled={disabled} />
          <MentionsCard siteId={siteId} domain={website.data?.domain} disabled={disabled} />
          <MetaAdsCard siteId={siteId} disabled={disabled} />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment providers
// ---------------------------------------------------------------------------

type Detail = NonNullable<IntegrationsStatus["details"]>[number];

function providerState(status: IntegrationsStatus, id: ProviderDef["id"]) {
  const flag = (status as unknown as Record<string, { connected?: boolean } | undefined>)[id];
  const detail: Detail | undefined = status.details?.find((d) => d.provider === id);
  const connected = Boolean(flag?.connected) || (detail ? detail.status !== "disconnected" : false);
  return { connected, detail };
}

function StatusBadge({ connected, detail }: { connected: boolean; detail?: Detail }) {
  if (!connected) return <Badge>Not connected</Badge>;
  if (detail?.status === "error") return <Badge tone="error">Error</Badge>;
  if (detail?.status === "pending") return <Badge tone="warning">Connecting</Badge>;
  return <Badge tone="success">Connected</Badge>;
}

function ProviderCard({
  provider,
  status,
  siteId,
  siteCurrency,
  disabled,
  initiallyOpen,
}: {
  provider: ProviderDef;
  status: IntegrationsStatus;
  siteId: string;
  siteCurrency: string;
  disabled: boolean;
  initiallyOpen: boolean;
}) {
  const { connected, detail } = providerState(status, provider.id);
  const action = useProviderAction(siteId);
  const [open, setOpen] = useState(initiallyOpen && !connected);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const paddleExpiry = provider.id === "paddle" ? status.paddle.keyExpiresAt : null;

  const run = (kind: "resync" | "disconnect") =>
    action.mutate(
      { provider: provider.id, action: kind },
      {
        onSuccess: (r) => {
          setMessage(r.message);
          setConfirming(false);
        },
      },
    );

  return (
    <div id={`integration-${provider.id}`} className="min-w-0 scroll-mt-4">
      <Card
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{provider.name}</span>
            <StatusBadge connected={connected} detail={detail} />
          </span>
        }
        className="h-full"
      >
        <div className="space-y-3 text-sm">
          <p className="text-muted">{provider.description}</p>
          {connected ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {detail?.accountName ? (
                <>
                  <dt className="text-muted">Account</dt>
                  <dd>{detail.accountName}</dd>
                </>
              ) : null}
              <dt className="text-muted">Last sync</dt>
              <dd>{formatRelative(detail?.lastSyncedAt ?? null)}</dd>
              {detail && !detail.backfillComplete ? (
                <>
                  <dt className="text-muted">History</dt>
                  <dd>Importing past payments…</dd>
                </>
              ) : null}
              {paddleExpiry ? (
                <>
                  <dt className="text-muted">Key expires</dt>
                  <dd>{formatDate(paddleExpiry)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {detail?.lastError ? <Notice tone="error">{detail.lastError}</Notice> : null}
          {message ? <Notice tone="success">{message}</Notice> : null}
          {action.error && !confirming ? (
            <Notice tone="error">{action.error.message}</Notice>
          ) : null}
          {!disabled ? (
            connected ? (
              <div className="flex flex-wrap gap-2">
                {provider.resync ? (
                  <Button
                    variant="secondary"
                    disabled={action.isPending}
                    onClick={() => run("resync")}
                  >
                    Re-sync
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  className="text-error-text"
                  onClick={() => setConfirming(true)}
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button
                variant={open ? "secondary" : "primary"}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                {open ? "Cancel" : `Connect ${provider.name}`}
              </Button>
            )
          ) : null}
          {open && !connected && !disabled ? (
            <ConnectPanel
              provider={provider}
              siteId={siteId}
              siteCurrency={siteCurrency}
              onConnected={(msg) => {
                setMessage(msg);
                setOpen(false);
              }}
            />
          ) : null}
        </div>
      </Card>
      <ConfirmDialog
        open={confirming}
        title={`Disconnect ${provider.name}?`}
        confirmLabel="Disconnect"
        pending={action.isPending}
        error={action.error}
        onCancel={() => {
          setConfirming(false);
          action.reset();
        }}
        onConfirm={() => run("disconnect")}
      >
        <p>
          DataGoat stops importing new {provider.name} payments and deletes the stored credentials.
          Payments already imported stay in your reports.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function ConnectPanel({
  provider,
  siteId,
  siteCurrency,
  onConnected,
}: {
  provider: ProviderDef;
  siteId: string;
  siteCurrency: string;
  onConnected: (message: string) => void;
}) {
  const action = useProviderAction(siteId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const webhookUrl = `${window.location.origin}/webhooks/${provider.id}/${siteId}`;

  const shopifyUrl = `/api/apps/shopify/install?shop=${encodeURIComponent(
    (values.shop ?? "").trim().toLowerCase(),
  )}&websiteId=${encodeURIComponent(siteId)}`;

  /** Validates every field; returns the body, or null after showing the errors. */
  const validate = (): Record<string, string> | null => {
    const found: Record<string, string> = {};
    const body: Record<string, string> = {};
    for (const f of provider.fields) {
      const v = (values[f.name] ?? "").trim();
      if (!v && f.optional) continue;
      const problem = f.validate?.(v) ?? (v ? null : `${f.label} is required.`);
      if (problem) found[f.name] = problem;
      body[f.name] = v;
    }
    setErrors(found);
    return Object.keys(found).length ? null : body;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = validate();
    if (!body) return;
    action.mutate(
      { provider: provider.id, action: "connect", body },
      {
        onSuccess: (r) =>
          onConnected(
            r.currency && r.currency !== siteCurrency
              ? `${r.message}. Payments in ${r.currency} are converted to ${siteCurrency}.`
              : r.message,
          ),
      },
    );
  };

  return (
    <div className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
      <ol className="list-decimal space-y-1 pl-5">
        {provider.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {provider.connect === "woocommerce" ? (
        <div className="space-y-2">
          <CopyField visibleLabel value={window.location.origin} label="DataGoat URL" />
          <CopyField visibleLabel value={siteId} label="Website ID" />
          <Link
            to="/app/$siteId/keys"
            params={{ siteId }}
            className="inline-flex rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg"
          >
            Create an API key
          </Link>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit} noValidate>
          {provider.fields.map((f) => (
            <Field key={f.name} label={f.label} error={errors[f.name]} hint={f.hint}>
              <Input
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={f.placeholder}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              />
            </Field>
          ))}
          {provider.webhook ? (
            <CopyField
              visibleLabel
              value={webhookUrl}
              label={`${provider.name} webhook URL`}
              hint="Paste this into the provider's webhook settings."
            />
          ) : null}
          {action.error ? <Notice tone="error">{action.error.message}</Notice> : null}
          {provider.connect === "shopify" ? (
            <a
              href={shopifyUrl}
              onClick={(e) => {
                if (!validate()) e.preventDefault();
              }}
              className="inline-flex rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg"
            >
              Install app
            </a>
          ) : (
            <>
              <Button type="submit" disabled={action.isPending}>
                {action.isPending ? "Checking…" : `Connect ${provider.name}`}
              </Button>
              <p className="text-xs text-muted">
                Credentials are checked with {provider.name}, then stored encrypted in your D1
                database. They never leave your Cloudflare account except to call {provider.name}.
              </p>
            </>
          )}
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Growth integrations (W6 endpoints)
// ---------------------------------------------------------------------------

function GrowthShell({
  kind,
  siteId,
  title,
  description,
  steps,
  disabled,
  oauthHint,
  children,
}: {
  kind: GrowthKind;
  siteId: string;
  title: string;
  description: string;
  steps: string[];
  disabled: boolean;
  /** Shown instead of the Connect button when the server has no OAuth client for this provider. */
  oauthHint: string;
  children?: (state: GrowthIntegrationStatus) => ReactNode;
}) {
  const status = useGrowthIntegration(siteId, kind);
  const save = useSaveGrowthIntegration(siteId, kind);
  const [confirming, setConfirming] = useState(false);
  const s = status.data;
  return (
    <div id={`integration-${kind}`} className="min-w-0 scroll-mt-4">
      <Card
        className="h-full"
        title={
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{title}</span>
            {s ? (
              s.connected ? (
                s.status === "error" ? (
                  <Badge tone="error">Error</Badge>
                ) : (
                  <Badge tone="success">Connected</Badge>
                )
              ) : (
                <Badge>Not connected</Badge>
              )
            ) : null}
          </span>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-muted">{description}</p>
          {s ? (
            <>
              {s.lastError ? <Notice tone="error">{s.lastError}</Notice> : null}
              {s.connected ? (
                <p className="text-xs text-muted">Last sync {formatRelative(s.lastSyncedAt)}.</p>
              ) : (
                <ol className="list-decimal space-y-1 pl-5">
                  {steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              )}
              {children?.(s)}
              {!disabled ? (
                s.connected ? (
                  <Button
                    variant="ghost"
                    className="text-error-text"
                    onClick={() => setConfirming(true)}
                  >
                    Disconnect
                  </Button>
                ) : s.oauthConfigured === false ? (
                  <p className="text-xs text-muted">{oauthHint}</p>
                ) : (
                  <a
                    href={connectUrl(kind, siteId)}
                    className="inline-flex rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg"
                  >
                    Connect {title}
                  </a>
                )
              ) : null}
            </>
          ) : (
            <QueryState query={status} />
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={confirming}
        title={`Disconnect ${title}?`}
        confirmLabel="Disconnect"
        pending={save.isPending}
        error={save.error}
        onCancel={() => {
          setConfirming(false);
          save.reset();
        }}
        onConfirm={() =>
          save.mutate({ disconnect: true }, { onSuccess: () => setConfirming(false) })
        }
      >
        <p>DataGoat deletes the stored credentials and stops syncing. Synced data stays.</p>
      </ConfirmDialog>
    </div>
  );
}

function SaveSettings({
  save,
  onSave,
  dirty,
  disabled,
}: {
  save: ReturnType<typeof useSaveGrowthIntegration>;
  onSave: () => void;
  dirty: boolean;
  disabled: boolean;
}) {
  if (disabled) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" disabled={!dirty || save.isPending} onClick={onSave}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
      <span aria-live="polite" className="text-xs">
        {save.error ? (
          <span className="text-error-text">{save.error.message}</span>
        ) : save.isSuccess && !dirty ? (
          <span className="text-success-text">Saved</span>
        ) : null}
      </span>
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

function SearchConsoleCard({ siteId, disabled }: { siteId: string; disabled: boolean }) {
  return (
    <GrowthShell
      kind="google-search-console"
      siteId={siteId}
      title="Google Search Console"
      description="See the search queries that bring visitors, with estimated revenue per keyword."
      steps={[
        "Your site must be verified in Google Search Console, and you need owner or full user access to the property.",
        "Choose Connect and sign in with that Google account.",
        "Pick the property below. Search data can take 24 to 48 hours to appear.",
      ]}
      disabled={disabled}
      oauthHint="Google sign-in is not set up on this server: the operator sets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (docs/growth/search-console.md)."
    >
      {(s) =>
        s.connected ? (
          <PropertyForm siteId={siteId} initial={str(s.settings.property)} disabled={disabled} />
        ) : null
      }
    </GrowthShell>
  );
}

function PropertyForm({
  siteId,
  initial,
  disabled,
}: {
  siteId: string;
  initial: string;
  disabled: boolean;
}) {
  const save = useSaveGrowthIntegration(siteId, "google-search-console");
  const [property, setProperty] = useState(initial);
  return (
    <div className="space-y-2">
      <Field label="Property" hint="sc-domain:example.com or https://www.example.com/">
        <Input
          value={property}
          disabled={disabled}
          onChange={(e) => setProperty(e.target.value)}
          placeholder="sc-domain:example.com"
        />
      </Field>
      <SaveSettings
        save={save}
        dirty={property.trim() !== initial}
        disabled={disabled}
        onSave={() => save.mutate({ settings: { property: property.trim() } })}
      />
    </div>
  );
}

function GithubCard({ siteId, disabled }: { siteId: string; disabled: boolean }) {
  return (
    <GrowthShell
      kind="github"
      siteId={siteId}
      title="GitHub"
      description="Show commits on your chart to see which releases move traffic and revenue. Only commit messages and stats are read, never code."
      steps={[
        "Enter the repository below (owner/name); one repository per website. A public repository needs nothing else.",
        "For a private repository, paste a fine-grained token with Contents: read and Metadata: read, or choose Connect GitHub to sign in.",
        "Optional: add a push webhook with the URL and secret shown after saving, for instant updates.",
      ]}
      disabled={disabled}
      oauthHint="Sign-in with GitHub is not set up on this server (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, see docs/growth/github.md). A repository name, plus a token for private repositories, is enough."
    >
      {(s) => <RepoForm key={String(s.connected)} siteId={siteId} state={s} disabled={disabled} />}
    </GrowthShell>
  );
}

const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

function RepoForm({
  siteId,
  state,
  disabled,
}: {
  siteId: string;
  state: GrowthIntegrationStatus;
  disabled: boolean;
}) {
  const save = useSaveGrowthIntegration(siteId, "github");
  const repos = useGithubRepos(siteId, Boolean(state.hasCredentials) && !disabled);
  const settings = state.settings;
  const initialRepo = str(settings.repo);
  const initialBranch = str(settings.branch);
  const [repo, setRepo] = useState(initialRepo);
  const [branch, setBranch] = useState(initialBranch);
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<{ repo?: string; token?: string }>({});
  const listId = `github-repos-${siteId}`;
  const dirty = repo.trim() !== initialRepo || branch.trim() !== initialBranch || token !== "";
  const onSave = () => {
    const found: { repo?: string; token?: string } = {};
    if (!GITHUB_REPO.test(repo.trim())) found.repo = "Use the owner/name form, e.g. acme/website.";
    if (token && token.trim().length < 10) found.token = "This does not look like a GitHub token.";
    setErrors(found);
    if (found.repo || found.token) return;
    const body: Record<string, unknown> = { repo: repo.trim() };
    if (branch.trim() !== initialBranch) body.branch = branch.trim() || null;
    if (token.trim()) body.accessToken = token.trim();
    save.mutate({ settings: body }, { onSuccess: () => setToken("") });
  };
  const webhookSecret = str(settings.webhookSecret);
  return (
    <div className="space-y-2">
      <Field label="Repository" error={errors.repo} hint="owner/name">
        <Input
          value={repo}
          disabled={disabled}
          placeholder="acme/website"
          list={repos.data?.length ? listId : undefined}
          onChange={(e) => {
            setRepo(e.target.value);
            setErrors({ ...errors, repo: undefined });
          }}
        />
      </Field>
      {repos.data?.length ? (
        <datalist id={listId}>
          {repos.data.map((r) => (
            <option key={r.fullName} value={r.fullName} />
          ))}
        </datalist>
      ) : null}
      <Field label="Branch" hint="Leave empty for the default branch.">
        <Input
          value={branch}
          disabled={disabled}
          placeholder="main"
          onChange={(e) => setBranch(e.target.value)}
        />
      </Field>
      {!disabled ? (
        <Field
          label="Access token"
          error={errors.token}
          hint={
            state.hasCredentials
              ? "A token is stored. Paste a new one to replace it."
              : "Optional for public repositories. A fine-grained token with Contents: read and Metadata: read."
          }
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="github_pat_…"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setErrors({ ...errors, token: undefined });
            }}
          />
        </Field>
      ) : null}
      <SaveSettings save={save} dirty={dirty} disabled={disabled} onSave={onSave} />
      {state.connected ? (
        <div className="space-y-2">
          <CopyField
            visibleLabel
            label="Push webhook URL"
            value={
              str(settings.webhookUrl) || `${window.location.origin}/webhooks/github/${siteId}`
            }
          />
          {webhookSecret ? (
            <CopyField
              visibleLabel
              label="Webhook secret"
              value={webhookSecret}
              hint="In the repository: Settings > Webhooks > Add webhook, content type application/json, just the push event."
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MentionsCard({
  siteId,
  domain,
  disabled,
}: {
  siteId: string;
  domain?: string;
  disabled: boolean;
}) {
  return (
    <GrowthShell
      kind="x"
      siteId={siteId}
      title="X and Reddit"
      description="Mentions of your brand on X and Reddit appear on your chart, and tweets with your links get traffic and revenue attributed."
      steps={[
        `Your domain${domain ? ` (${domain})` : ""} is searched automatically on X and Reddit.`,
        "Add keywords below (brand, product, @handle or #hashtag). They are shared by X and Reddit search.",
        "Choose Connect to link your X account for tweet link attribution.",
      ]}
      disabled={disabled}
      oauthHint="Sign-in with X is not set up on this server (X_CLIENT_ID and X_CLIENT_SECRET, see docs/growth/mentions.md). Keyword search uses the server's X bearer token when one is set; Reddit needs nothing."
    >
      {(s) => (
        <KeywordsForm
          key={String(s.connected)}
          siteId={siteId}
          settings={s.settings}
          disabled={disabled}
        />
      )}
    </GrowthShell>
  );
}

function KeywordsForm({
  siteId,
  settings,
  disabled,
}: {
  siteId: string;
  settings: Record<string, unknown>;
  disabled: boolean;
}) {
  const save = useSaveGrowthIntegration(siteId, "x");
  const initialKeywords = strs(settings.keywords);
  const initialHandles = strs(settings.handles);
  const [keywords, setKeywords] = useState(initialKeywords);
  const [handles, setHandles] = useState(initialHandles);
  const dirty =
    JSON.stringify(keywords) !== JSON.stringify(initialKeywords) ||
    JSON.stringify(handles) !== JSON.stringify(initialHandles);
  return (
    <div className="space-y-3">
      <FieldGroup
        label="Keywords"
        hint="4 to 15 characters each, case-insensitive. Avoid generic words."
      >
        <ListEditor
          label="Mention keywords"
          items={keywords}
          onChange={setKeywords}
          disabled={disabled}
          placeholder="YourProduct"
          max={20}
          validate={(v) =>
            v.length < 4 || v.length > 15 ? "Keywords are 4 to 15 characters." : null
          }
        />
      </FieldGroup>
      <FieldGroup label="Link-in-bio handles" hint="X accounts whose profile links to your site.">
        <ListEditor
          label="Link-in-bio handles"
          items={handles}
          onChange={setHandles}
          disabled={disabled}
          placeholder="@yourhandle"
          max={10}
          normalise={(v) => v.trim().replace(/^@?/, "@")}
          validate={(v) =>
            /^@\w{1,15}$/.test(v) ? null : "An X handle is @ followed by up to 15 letters."
          }
        />
      </FieldGroup>
      <SaveSettings
        save={save}
        dirty={dirty}
        disabled={disabled}
        onSave={() => save.mutate({ settings: { keywords, handles } })}
      />
    </div>
  );
}

const META_UTM =
  "utm_source=meta&utm_medium=paid-social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}";

function MetaAdsCard({ siteId, disabled }: { siteId: string; disabled: boolean }) {
  return (
    <GrowthShell
      kind="meta-ads"
      siteId={siteId}
      title="Meta Ads"
      description="Ad spend from Facebook and Instagram campaigns next to the revenue they bring, with ROAS."
      steps={[
        "Choose Connect and sign in with the Facebook account that can see your ad accounts.",
        "Select the ad accounts and campaigns to track below.",
        "Add UTM parameters to every ad so visits match campaigns (template below).",
      ]}
      disabled={disabled}
      oauthHint="Facebook sign-in is not set up on this server (META_APP_ID and META_APP_SECRET, see docs/growth/meta-ads.md). Paste a system-user access token below instead."
    >
      {(s) => (
        <div className="space-y-3">
          {s.connected || s.oauthConfigured === false ? (
            <AdsForm
              key={String(s.connected)}
              siteId={siteId}
              settings={s.settings}
              hasCredentials={Boolean(s.hasCredentials)}
              disabled={disabled}
            />
          ) : null}
          <CodeBlock code={META_UTM} label="Meta URL parameters" wrap />
        </div>
      )}
    </GrowthShell>
  );
}

function AdsForm({
  siteId,
  settings,
  hasCredentials,
  disabled,
}: {
  siteId: string;
  settings: Record<string, unknown>;
  hasCredentials: boolean;
  disabled: boolean;
}) {
  const save = useSaveGrowthIntegration(siteId, "meta-ads");
  const initialAccounts = strs(settings.adAccountIds);
  const initialCampaigns = strs(settings.campaignIds);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [token, setToken] = useState("");
  const dirty =
    token !== "" ||
    JSON.stringify(accounts) !== JSON.stringify(initialAccounts) ||
    JSON.stringify(campaigns) !== JSON.stringify(initialCampaigns);
  return (
    <div className="space-y-3">
      <FieldGroup label="Ad account IDs">
        <ListEditor
          label="Ad account IDs"
          items={accounts}
          onChange={setAccounts}
          disabled={disabled}
          placeholder="act_1234567890"
          validate={(v) => (/^(act_)?\d+$/.test(v) ? null : "Ad account IDs look like act_123….")}
        />
      </FieldGroup>
      <FieldGroup
        label="Campaign IDs"
        hint="Leave empty to track every campaign of these accounts."
      >
        <ListEditor
          label="Campaign IDs"
          items={campaigns}
          onChange={setCampaigns}
          disabled={disabled}
          placeholder="120200000000000000"
          validate={(v) => (/^\d+$/.test(v) ? null : "Campaign IDs are numbers.")}
        />
      </FieldGroup>
      {!disabled ? (
        <Field
          label="Access token"
          hint={
            hasCredentials
              ? "A token is stored. Paste a new one to replace it."
              : "A Meta system-user token with ads_read, if you do not sign in with Facebook."
          }
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      ) : null}
      <SaveSettings
        save={save}
        dirty={dirty}
        disabled={disabled}
        onSave={() =>
          save.mutate(
            {
              settings: {
                adAccountIds: accounts,
                campaignIds: campaigns,
                ...(token.trim() ? { accessToken: token.trim() } : {}),
              },
            },
            { onSuccess: () => setToken("") },
          )
        }
      />
    </div>
  );
}
