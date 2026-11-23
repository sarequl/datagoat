import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { GrowthIntegrationStatus, IntegrationsStatus } from "../../../../shared/api-types";
import { BrandTile } from "../../components/BrandMarks";
import { Button, Input, Notice, Spinner } from "../../components/ui";
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
  Toggle,
} from "./lib/ui";

/**
 * Integrations, laid out like a SaaS integrations directory: a toolbar (category tabs with
 * counts, search), connected integrations first, then the rest by category. Every integration
 * is one row (`#integration-<id>`) with a logo tile, status, a one-line summary and its actions;
 * setup steps and forms open inside the row.
 */
type Category = "payments" | "growth";

/**
 * Growth integrations. X and Reddit are separate rows; both are stored in the "x" connection
 * (shared brand keywords, `redditEnabled` for Reddit), so a row's `id` can differ from its kind.
 */
const GROWTH: ReadonlyArray<{ id: string; kind: GrowthKind; name: string; description: string }> = [
  {
    id: "google-search-console",
    kind: "google-search-console",
    name: "Google Search Console",
    description: "Search keywords, clicks and impressions next to your traffic and revenue.",
  },
  {
    id: "github",
    kind: "github",
    name: "GitHub",
    description: "Commits as markers on your charts.",
  },
  {
    id: "x",
    kind: "x",
    name: "X",
    description: "Brand mentions on X, and the X posts and profiles that send you visitors.",
  },
  {
    id: "reddit",
    kind: "x",
    name: "Reddit",
    description: "Reddit posts that mention your brand or domain, on your charts.",
  },
  {
    id: "meta-ads",
    kind: "meta-ads",
    name: "Meta Ads",
    description: "Facebook and Instagram ad spend with ROAS.",
  },
];

/** The X connection's errors split by platform (each starts with its provider name). */
export function platformErrors(lastError: string | null | undefined) {
  const parts = (lastError ?? "").split("; ").filter(Boolean);
  const reddit = parts.filter((p) => p.startsWith("Reddit"));
  const x = parts.filter((p) => !p.startsWith("Reddit"));
  return { x: x.length ? x.join("; ") : null, reddit: reddit.length ? reddit.join("; ") : null };
}

/** Reddit search runs when it is switched on and this server has Reddit app credentials. */
export function redditActive(s: GrowthIntegrationStatus | undefined): boolean {
  return Boolean(
    s?.connected && s.settings.redditEnabled !== false && s.settings.redditConfigured === true,
  );
}

/** X search or attribution runs with the site's token, the server token or a connected account. */
export function xActive(s: GrowthIntegrationStatus | undefined): boolean {
  return Boolean(
    s?.connected &&
      s.settings.xEnabled !== false &&
      (s.hasCredentials || s.settings.usesServerToken === true),
  );
}

function growthConnected(id: string, s: GrowthIntegrationStatus | undefined): boolean {
  if (id === "x") return xActive(s);
  if (id === "reddit") return redditActive(s);
  return Boolean(s?.connected);
}

export default function IntegrationsPage() {
  const siteId = useSiteId();
  const access = useAccess(siteId);
  const status = useIntegrations(siteId);
  const website = useWebsite(siteId);
  const disabled = !access.canEditSettings;
  const [hash] = useState(() => window.location.hash.replace(/^#/, ""));
  const [category, setCategory] = useState<Category>(() =>
    GROWTH.some((g) => g.id === hash) ? "growth" : "payments",
  );
  const [query, setQuery] = useState("");
  const gsc = useGrowthIntegration(siteId, "google-search-console");
  const github = useGrowthIntegration(siteId, "github");
  const x = useGrowthIntegration(siteId, "x");
  const meta = useGrowthIntegration(siteId, "meta-ads");
  const growthStatus: Record<GrowthKind, GrowthIntegrationStatus | undefined> = {
    "google-search-console": gsc.data,
    github: github.data,
    x: x.data,
    "meta-ads": meta.data,
  };

  useEffect(() => {
    if (!hash || !status.data) return;
    document.getElementById(`integration-${hash}`)?.scrollIntoView?.({ block: "start" });
  }, [hash, status.data]);

  // Which integrations count as "connected" is decided once the statuses load, and kept for the
  // visit, so a row does not jump to another section the moment it is connected or disconnected.
  const [initial, setInitial] = useState<Set<string> | null>(null);
  const loaded = Boolean(status.data && gsc.data && github.data && x.data && meta.data);
  useEffect(() => {
    if (!loaded || initial || !status.data) return;
    const ids = PROVIDERS.filter((p) => providerState(status.data, p.id).connected).map(
      (p) => p.id,
    );
    const kinds = GROWTH.filter((g) => growthConnected(g.id, growthStatus[g.kind])).map(
      (g) => g.id,
    );
    setInitial(new Set<string>([...ids, ...kinds]));
  });
  const wasConnected = (id: string) => initial?.has(id) ?? false;
  const q = query.trim().toLowerCase();
  const matches = (name: string, description: string) =>
    !q || `${name} ${description}`.toLowerCase().includes(q);
  const providers =
    status.data && initial
      ? PROVIDERS.filter((p) => matches(p.name, p.description)).map((p) => ({
          p,
          connected: wasConnected(p.id),
        }))
      : [];
  const growth = initial
    ? GROWTH.filter((g) => matches(g.name, g.description)).map((g) => ({
        g,
        connected: wasConnected(g.id),
      }))
    : [];
  const showPayments = category === "payments";
  const showGrowth = category === "growth";

  const providerRow = (p: ProviderDef) =>
    status.data ? (
      <ProviderCard
        key={p.id}
        provider={p}
        status={status.data}
        siteId={siteId}
        siteCurrency={website.data?.currency ?? status.data.currency}
        disabled={disabled}
        initiallyOpen={hash === p.id}
      />
    ) : null;
  const growthRow = (id: string) => {
    const props = { key: id, siteId, disabled };
    if (id === "google-search-console") return <SearchConsoleCard {...props} />;
    if (id === "github") return <GithubCard {...props} />;
    if (id === "x") return <XCard {...props} domain={website.data?.domain} />;
    if (id === "reddit") return <RedditCard {...props} domain={website.data?.domain} />;
    return <MetaAdsCard {...props} />;
  };
  // One list per tab; connected integrations first (stable sort keeps the catalogue order).
  const byConnected = <T extends { connected: boolean }>(rows: T[]) =>
    [...rows].sort((a, b) => Number(b.connected) - Number(a.connected));
  const paymentRows = showPayments ? byConnected(providers) : [];
  const growthRows = showGrowth ? byConnected(growth) : [];
  const tabs: Array<{ id: Category; label: string }> = [
    { id: "payments", label: "Payments" },
    { id: "growth", label: "Growth" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect your payment provider so every channel, campaign and page shows the revenue it brings, and add growth sources to your charts."
      />
      {disabled ? <ReadOnlyNotice role={access.role} action="connect integrations" /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          aria-label="Category"
          className="flex gap-1 rounded-lg bg-surface-2 p-1"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={category === t.id}
              onClick={() => setCategory(t.id)}
              className={`rounded-md px-3 py-1 text-sm ${
                category === t.id ? "sel-raised" : "text-muted hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Input
          type="search"
          aria-label="Search integrations"
          placeholder="Search integrations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ml-auto max-w-64"
        />
      </div>
      {!status.data ? <QueryState query={status} /> : !initial ? <Spinner /> : null}
      {paymentRows.length ? (
        <IntegrationSection
          id="payments"
          title="Payments"
          description="Revenue, refunds and subscriptions, matched to the visit that brought each customer."
        >
          {paymentRows.map((r) => providerRow(r.p))}
        </IntegrationSection>
      ) : null}
      {growthRows.length ? (
        <IntegrationSection
          id="growth"
          title="Growth"
          description="Search, code, social and ad data shown next to your traffic."
        >
          {growthRows.map((r) => growthRow(r.g.id))}
        </IntegrationSection>
      ) : null}
      {initial && !paymentRows.length && !growthRows.length ? (
        <p className="py-8 text-center text-sm text-muted">No integrations match “{query}”.</p>
      ) : null}
      <p className="text-xs text-muted">
        No supported provider? Send payments from your server with{" "}
        <code>POST /api/v1/payments</code> and a key from the{" "}
        <Link to="/app/$siteId/keys" params={{ siteId }} className="text-primary-text underline">
          API keys
        </Link>{" "}
        page.
      </p>
    </div>
  );
}

function IntegrationSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3" aria-labelledby={`${id}-heading`}>
      <div>
        {/* The tab already names the list; the heading labels the region for screen readers. */}
        <h2 id={`${id}-heading`} className="sr-only">
          {title}
        </h2>
        {description ? <p className="text-xs text-muted">{description}</p> : null}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/**
 * One integration: header (logo, name, status, summary, actions) and an optional body for setup
 * steps, forms and notices.
 */
function IntegrationRow({
  id,
  name,
  status,
  summary,
  actions,
  children,
}: {
  id: string;
  name: string;
  status?: ReactNode;
  summary: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      id={`integration-${id}`}
      aria-labelledby={`integration-${id}-name`}
      className="min-w-0 scroll-mt-4 overflow-hidden rounded-xl border border-line bg-surface"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
        <BrandTile id={id} name={name} />
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`integration-${id}-name`} className="text-sm font-semibold">
              {name}
            </h3>
            {status}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted">{summary}</div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children ? (
        <div className="space-y-3 border-t border-line bg-surface-2/50 px-4 py-4 text-sm">
          {children}
        </div>
      ) : null}
    </section>
  );
}

const Dot = () => <span aria-hidden="true">·</span>;

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
  // Rows that are not connected say so with their Connect button; no badge needed.
  if (!connected) return null;
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

  const notices =
    detail?.lastError || message || (action.error && !confirming) ? (
      <>
        {detail?.lastError ? <Notice tone="error">{detail.lastError}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}
        {action.error && !confirming ? <Notice tone="error">{action.error.message}</Notice> : null}
      </>
    ) : null;
  const panel =
    open && !connected && !disabled ? (
      <ConnectPanel
        provider={provider}
        siteId={siteId}
        siteCurrency={siteCurrency}
        onConnected={(msg) => {
          setMessage(msg);
          setOpen(false);
        }}
      />
    ) : null;

  return (
    <div className="min-w-0">
      <IntegrationRow
        id={provider.id}
        name={provider.name}
        status={<StatusBadge connected={connected} detail={detail} />}
        summary={
          connected ? (
            <>
              {detail?.accountName ? (
                <>
                  <span>{detail.accountName}</span>
                  <Dot />
                </>
              ) : null}
              <span>Last sync {formatRelative(detail?.lastSyncedAt ?? null)}</span>
              {detail && !detail.backfillComplete ? (
                <>
                  <Dot />
                  <span>Importing past payments…</span>
                </>
              ) : null}
              {paddleExpiry ? (
                <>
                  <Dot />
                  <span>Key expires {formatDate(paddleExpiry)}</span>
                </>
              ) : null}
            </>
          ) : (
            <span>{provider.description}</span>
          )
        }
        actions={
          disabled ? null : connected ? (
            <>
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
            </>
          ) : (
            <Button
              variant="secondary"
              aria-expanded={open}
              aria-label={open ? "Cancel" : `Connect ${provider.name}`}
              onClick={() => setOpen(!open)}
            >
              {open ? "Cancel" : "Connect"}
            </Button>
          )
        }
      >
        {notices || panel ? (
          <>
            {notices}
            {panel}
          </>
        ) : null}
      </IntegrationRow>
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
    <div className="space-y-3">
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
  errorOf = (st) => st.lastError,
  activeOf = (st) => st.connected,
  onDisconnect,
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
  /** This row's part of the connection's last error (X and Reddit share one connection). */
  errorOf?: (state: GrowthIntegrationStatus) => string | null;
  /** Whether this row counts as connected. */
  activeOf?: (state: GrowthIntegrationStatus) => boolean;
  /** Replaces deleting the connection (X turns itself off and keeps Reddit's settings). */
  onDisconnect?: (save: ReturnType<typeof useSaveGrowthIntegration>, done: () => void) => void;
}) {
  const status = useGrowthIntegration(siteId, kind);
  const save = useSaveGrowthIntegration(siteId, kind);
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(() => window.location.hash === `#${kind}`);
  const s = status.data;
  const lastError = s ? errorOf(s) : null;
  const active = s ? activeOf(s) : false;
  const badge = s ? (
    active ? (
      lastError ? (
        <Badge tone="error">Error</Badge>
      ) : (
        <Badge tone="success">Connected</Badge>
      )
    ) : null
  ) : null;
  const oauth = s && !active && s.oauthConfigured !== false && !disabled;
  return (
    <div className="min-w-0">
      <IntegrationRow
        id={kind}
        name={title}
        status={badge}
        summary={
          s && active ? (
            <span>Last sync {formatRelative(s.lastSyncedAt)}</span>
          ) : (
            <span>{description}</span>
          )
        }
        actions={
          s ? (
            <>
              {oauth ? (
                <a
                  href={connectUrl(kind, siteId)}
                  aria-label={`Connect ${title}`}
                  className="inline-flex items-center rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2"
                >
                  Connect
                </a>
              ) : null}
              <Button
                variant={oauth ? "ghost" : "secondary"}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                {open ? "Close" : active ? "Manage" : oauth ? "Details" : "Set up"}
              </Button>
            </>
          ) : null
        }
      >
        {!s ? (
          <QueryState query={status} />
        ) : lastError || open ? (
          <>
            {lastError ? <Notice tone="error">{lastError}</Notice> : null}
            {open ? (
              <>
                {active ? (
                  <p className="text-muted">{description}</p>
                ) : (
                  <ol className="list-decimal space-y-1 pl-5">
                    {steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                )}
                {children?.(s)}
                {!disabled && !active && s.oauthConfigured === false ? (
                  <p className="text-xs text-muted">{oauthHint}</p>
                ) : null}
                {!disabled && active ? (
                  <Button
                    variant="ghost"
                    className="-ml-3 text-error-text"
                    onClick={() => setConfirming(true)}
                  >
                    Disconnect {title}
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
      </IntegrationRow>
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
          onDisconnect
            ? onDisconnect(save, () => setConfirming(false))
            : save.mutate({ disconnect: true }, { onSuccess: () => setConfirming(false) })
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

function XCard({
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
      title="X"
      description="Posts on X that mention your brand appear on your chart, and X posts and profiles that link to you get their visitors and revenue attributed."
      steps={[
        `Your domain${domain ? ` (${domain})` : ""} is searched on X automatically.`,
        "Add brand keywords and the X handles whose profiles link to your site, then Save.",
        "Choose Connect to sign in with X, or paste an X API bearer token on the Mentions page.",
      ]}
      disabled={disabled}
      oauthHint="Sign-in with X is not set up on this server (X_CLIENT_ID and X_CLIENT_SECRET, see docs/growth/mentions.md). Search then uses the server's X_BEARER_TOKEN, or a bearer token pasted on the Mentions page."
      errorOf={(st) => platformErrors(st.lastError).x}
      activeOf={xActive}
      onDisconnect={(save, done) =>
        save.mutate({ settings: { xEnabled: false, clearCredentials: true } }, { onSuccess: done })
      }
    >
      {(st) => (
        <XForm
          key={`${st.connected}-${strs(st.settings.keywords).join(",")}`}
          siteId={siteId}
          settings={st.settings}
          disabled={disabled}
        />
      )}
    </GrowthShell>
  );
}

function KeywordsField({
  keywords,
  onChange,
  disabled,
  shared,
}: {
  keywords: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  shared: "X" | "Reddit";
}) {
  return (
    <FieldGroup
      label="Brand keywords"
      hint={`4 to 15 characters each, case-insensitive. Avoid generic words. Shared with ${shared}.`}
    >
      <ListEditor
        label="Mention keywords"
        items={keywords}
        onChange={onChange}
        disabled={disabled}
        placeholder="YourProduct"
        max={20}
        validate={(v) =>
          v.length < 4 || v.length > 15 ? "Keywords are 4 to 15 characters." : null
        }
      />
    </FieldGroup>
  );
}

function XForm({
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
  const off = settings.xEnabled === false;
  const dirty =
    off ||
    JSON.stringify(keywords) !== JSON.stringify(initialKeywords) ||
    JSON.stringify(handles) !== JSON.stringify(initialHandles);
  return (
    <div className="space-y-3">
      <KeywordsField
        keywords={keywords}
        onChange={setKeywords}
        disabled={disabled}
        shared="Reddit"
      />
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
      {settings.xConfigured === false ? (
        <Notice>
          X search needs an X API bearer token: set X_BEARER_TOKEN as a Worker secret for every
          website, or paste one in the Mentions page settings for this website. X charges per
          request (see docs/growth/mentions.md).
        </Notice>
      ) : null}
      <SaveSettings
        save={save}
        dirty={dirty}
        disabled={disabled}
        onSave={() => save.mutate({ settings: { keywords, handles, xEnabled: true } })}
      />
    </div>
  );
}

/**
 * Reddit search. Stored in the X connection (`redditEnabled`, shared keywords); it runs when this
 * server has Reddit app credentials, which Reddit requires.
 */
function RedditCard({
  siteId,
  domain,
  disabled,
}: {
  siteId: string;
  domain?: string;
  disabled: boolean;
}) {
  const status = useGrowthIntegration(siteId, "x");
  const save = useSaveGrowthIntegration(siteId, "x");
  const s = status.data;
  const [open, setOpen] = useState(() => window.location.hash === "#reddit");
  const ready = s?.settings.redditConfigured === true;
  const on = s ? s.settings.redditEnabled !== false : true;
  const active = redditActive(s);
  const error = s ? platformErrors(s.lastError).reddit : null;
  const initialKeywords = strs(s?.settings.keywords);
  const [keywords, setKeywords] = useState(initialKeywords);
  const [enabled, setEnabled] = useState(on);
  // Keep the form in step when the X row saves the shared keywords.
  useEffect(() => {
    setKeywords(strs(s?.settings.keywords));
    setEnabled(s ? s.settings.redditEnabled !== false : true);
  }, [s]);
  const dirty = enabled !== on || JSON.stringify(keywords) !== JSON.stringify(initialKeywords);
  const badge = !s ? null : !ready ? (
    <Badge>Needs setup</Badge>
  ) : active ? (
    error ? (
      <Badge tone="error">Error</Badge>
    ) : (
      <Badge tone="success">Connected</Badge>
    )
  ) : null;
  return (
    <div className="min-w-0">
      <IntegrationRow
        id="reddit"
        name="Reddit"
        status={badge}
        summary={
          active ? (
            <span>Last sync {formatRelative(s?.lastSyncedAt ?? null)}</span>
          ) : (
            <span>Reddit posts that mention your brand or domain, on your charts.</span>
          )
        }
        actions={
          s ? (
            <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Close" : active ? "Manage" : "Set up"}
            </Button>
          ) : null
        }
      >
        {!s ? (
          <QueryState query={status} />
        ) : error || open ? (
          <>
            {error ? <Notice tone="error">{error}</Notice> : null}
            {open ? (
              <div className="space-y-3">
                <p className="text-muted">
                  Reddit posts that mention your domain
                  {domain ? ` (${domain})` : ""} or your brand keywords appear on your chart and on
                  the Mentions page. Checked every few hours.
                </p>
                {!ready ? (
                  <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
                    <p className="font-medium">Add Reddit app keys to this server (once)</p>
                    <ol className="list-decimal space-y-1 pl-5 text-muted">
                      <li>
                        At reddit.com/prefs/apps, create an app of type “web app” and request Data
                        API access if Reddit asks.
                      </li>
                      <li>
                        In Cloudflare: Workers &amp; Pages → your DataGoat Worker → Settings →
                        Variables and Secrets, add the secrets REDDIT_CLIENT_ID and
                        REDDIT_CLIENT_SECRET.
                      </li>
                      <li>Come back here; Reddit search starts on the next sync.</li>
                    </ol>
                  </div>
                ) : null}
                <Toggle
                  label="Search Reddit for this website"
                  description="Uses your domain and the brand keywords below."
                  checked={enabled}
                  onChange={setEnabled}
                  disabled={disabled}
                />
                <KeywordsField
                  keywords={keywords}
                  onChange={setKeywords}
                  disabled={disabled}
                  shared="X"
                />
                <SaveSettings
                  save={save}
                  dirty={dirty}
                  disabled={disabled}
                  onSave={() => save.mutate({ settings: { keywords, redditEnabled: enabled } })}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </IntegrationRow>
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
