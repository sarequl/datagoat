import { type FormEvent, useState } from "react";
import type { AccessToken, WebsiteKey } from "../../../../shared/api-types";
import { type Grant, PERMISSIONS, type Permission } from "../../../../shared/permissions";
import { useMe } from "../../api/hooks";
import { Button, Card, Input, Notice } from "../../components/ui";
import { formatDate, formatNumber, formatRelative } from "./lib/format";
import {
  useAccess,
  useAccessTokens,
  useCreateAccessToken,
  useCreateWebsiteKey,
  useRevokeAccessToken,
  useRevokeWebsiteKey,
  useRollWebsiteKey,
  useSiteId,
  useWebsiteKeys,
} from "./lib/hooks";
import {
  Badge,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  Field,
  PageHeader,
  QueryState,
  ReadOnlyNotice,
  SecretReveal,
  Select,
} from "./lib/ui";

const MAX_SITE_KEYS = 10;

/** API keys: dg_ website keys (create, roll, revoke) and dgt_ account tokens with scopes. */
export default function ApiKeysPage() {
  const siteId = useSiteId();
  return (
    <div className="space-y-5">
      <PageHeader
        title="API keys"
        description="Use the DataFast-compatible API from your server, scripts, the CLI or AI agents. Keys are shown once and stored hashed."
      />
      <WebsiteKeysSection siteId={siteId} />
      <AccessTokensSection siteId={siteId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Website keys (dg_)
// ---------------------------------------------------------------------------

function WebsiteKeysSection({ siteId }: { siteId: string }) {
  const access = useAccess(siteId);
  const keys = useWebsiteKeys(siteId);
  const create = useCreateWebsiteKey(siteId);
  const roll = useRollWebsiteKey(siteId);
  const revoke = useRevokeWebsiteKey(siteId);
  const [name, setName] = useState("");
  const [includePii, setIncludePii] = useState(false);
  const [secret, setSecret] = useState<{ title: string; key: string } | null>(null);
  const [confirm, setConfirm] = useState<{ action: "roll" | "revoke"; key: WebsiteKey } | null>(
    null,
  );
  const list = keys.data ?? [];
  const full = list.length >= MAX_SITE_KEYS;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name: name.trim() || null, includePii },
      {
        onSuccess: (k) => {
          if (k?.key)
            setSecret({ title: `Website key ${k.name ?? ""} created`.trim(), key: k.key });
          setName("");
          setIncludePii(false);
        },
      },
    );
  };
  const pending = confirm?.action === "roll" ? roll : revoke;

  return (
    <Card title="Website API keys (dg_)">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Scoped to this website with every website permission: analytics, goals, payments,
          identify, funnels and settings. Ideal for your backend.
        </p>
        {!access.canManageKeys ? (
          <ReadOnlyNotice role={access.role} action="create or revoke keys" />
        ) : null}
        {secret ? (
          <SecretReveal title={secret.title} secret={secret.key} onDone={() => setSecret(null)}>
            <CodeBlock
              label="example request"
              code={`curl ${window.location.origin}/api/v1/analytics/overview \\\n  -H "Authorization: Bearer ${secret.key}"`}
            />
          </SecretReveal>
        ) : null}
        {access.canManageKeys ? (
          <form className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={submit}>
            <Field
              label="Key name"
              hint={full ? `At most ${MAX_SITE_KEYS} keys per website.` : undefined}
            >
              <Input
                value={name}
                maxLength={100}
                placeholder="Production backend"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={create.isPending || full}>
              {create.isPending ? "Creating…" : "Create key"}
            </Button>
            <div className="sm:col-span-2">
              <Checkbox
                label="Include customer names and emails (PII)"
                hint="Without it, the key sees null instead of names and emails."
                checked={includePii}
                onChange={setIncludePii}
              />
            </div>
          </form>
        ) : null}
        {create.error ? <Notice tone="error">{create.error.message}</Notice> : null}
        {keys.data ? (
          list.length ? (
            <ul className="divide-y divide-line rounded-md border border-line">
              {list.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {k.name ?? "Unnamed key"}
                      {k.includePii ? <Badge tone="warning">PII</Badge> : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted">{k.displayKey}</div>
                    <div className="text-xs text-muted">
                      Created {formatDate(k.createdAt)} · last used {formatRelative(k.lastUsedAt)}
                      {k.usageCount ? ` · ${formatNumber(k.usageCount)} requests` : ""}
                    </div>
                  </div>
                  {access.canManageKeys ? (
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => setConfirm({ action: "roll", key: k })}
                        aria-label={`Roll ${k.name ?? k.displayKey}`}
                      >
                        Roll
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-error-text"
                        onClick={() => setConfirm({ action: "revoke", key: k })}
                        aria-label={`Revoke ${k.name ?? k.displayKey}`}
                      >
                        Revoke
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No website keys yet.</p>
          )
        ) : (
          <QueryState query={keys} />
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.action === "roll"
            ? `Roll ${confirm.key.name ?? "this key"}?`
            : `Revoke ${confirm?.key.name ?? "this key"}?`
        }
        tone={confirm?.action === "roll" ? "primary" : "danger"}
        confirmLabel={confirm?.action === "roll" ? "Roll key" : "Revoke key"}
        pending={pending.isPending}
        error={pending.error}
        onCancel={() => {
          setConfirm(null);
          roll.reset();
          revoke.reset();
        }}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.action === "roll")
            roll.mutate(confirm.key.id, {
              onSuccess: (k) => {
                if (k?.key) setSecret({ title: `${k.name ?? "Key"} rolled`, key: k.key });
                setConfirm(null);
              },
            });
          else revoke.mutate(confirm.key.id, { onSuccess: () => setConfirm(null) });
        }}
      >
        <p>
          {confirm?.action === "roll"
            ? "A new secret replaces the old one. The old secret stops working immediately, so update your servers right after."
            : "Requests with this key fail from now on. This cannot be undone."}
        </p>
      </ConfirmDialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Account tokens (dgt_)
// ---------------------------------------------------------------------------

const PERMISSION_GROUPS: ReadonlyArray<{ label: string; permissions: Permission[] }> = [
  { label: "Analytics", permissions: ["analytics:read"] },
  { label: "Goals", permissions: ["goals:read", "goals:write"] },
  { label: "Payments", permissions: ["payments:read", "payments:write"] },
  { label: "Identify", permissions: ["identify:write"] },
  { label: "Websites", permissions: ["websites:read", "websites:write"] },
  { label: "Settings", permissions: ["settings:read", "settings:write"] },
  { label: "Funnels", permissions: ["funnels:read", "funnels:write"] },
  { label: "Alerts", permissions: ["alerts:read", "alerts:write"] },
  { label: "Team", permissions: ["team:read", "team:write"] },
  { label: "API keys", permissions: ["api-keys:read", "api-keys:write"] },
  { label: "Notes", permissions: ["notes:read", "notes:write"] },
];

const READ_ONLY: Permission[] = PERMISSIONS.filter((p) => p.endsWith(":read"));

function AccessTokensSection({ siteId }: { siteId: string }) {
  const me = useMe();
  const tokens = useAccessTokens();
  const create = useCreateAccessToken();
  const revoke = useRevokeAccessToken();
  const websites = me.data?.websites ?? [];
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<"full" | "read" | "custom">("read");
  const [custom, setCustom] = useState<Permission[]>(["analytics:read"]);
  const [scope, setScope] = useState<"all" | "some">("all");
  const [siteIds, setSiteIds] = useState<string[]>([siteId]);
  const [includePii, setIncludePii] = useState(false);
  const [expires, setExpires] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AccessToken | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const permissions: Grant[] = preset === "full" ? ["*"] : preset === "read" ? READ_ONLY : custom;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!permissions.length) {
      setFormError("Choose at least one permission.");
      return;
    }
    if (scope === "some" && !siteIds.length) {
      setFormError("Choose at least one website, or allow all websites.");
      return;
    }
    setFormError(null);
    create.mutate(
      {
        name: name.trim() || null,
        permissions,
        websiteIds: scope === "all" ? [] : siteIds,
        includePii,
        expiresInDays: expires ? Number(expires) : null,
      },
      {
        onSuccess: (t) => {
          if (t.key) setSecret(t.key);
          setName("");
        },
      },
    );
  };

  const toggle = <T,>(list: T[], value: T, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
  const siteName = (id: string) => {
    const w = websites.find((x) => x._id === id);
    return w ? (w.name ?? w.domain) : id;
  };

  return (
    <Card title="Account access tokens (dgt_)" className="scroll-mt-4">
      <div id="tokens" className="space-y-4">
        <p className="text-sm text-muted">
          Belong to you, not a website: they act with your role on each website, limited to the
          permissions you pick. Pass <code>websiteId</code> on each request. Use them for the CLI,
          the MCP server and AI agents.
        </p>
        {secret ? (
          <SecretReveal title="Access token created" secret={secret} onDone={() => setSecret(null)}>
            <CodeBlock
              label="example request"
              code={`curl "${window.location.origin}/api/v1/analytics/overview?websiteId=${siteId}" \\\n  -H "Authorization: Bearer ${secret}"`}
            />
          </SecretReveal>
        ) : null}
        <form className="space-y-4 rounded-md border border-line p-3" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Token name">
              <Input
                value={name}
                maxLength={100}
                placeholder="Claude Code"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Expires">
              <Select value={expires} onChange={(e) => setExpires(e.target.value)}>
                <option value="">Never</option>
                <option value="7">In 7 days</option>
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="365">In 1 year</option>
              </Select>
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Permissions</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              {(
                [
                  ["read", "Read only"],
                  ["full", "Full access"],
                  ["custom", "Custom"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="token-preset"
                    checked={preset === value}
                    onChange={() => setPreset(value)}
                    className="accent-[var(--dg-primary)]"
                  />
                  {label}
                </label>
              ))}
            </div>
            {preset === "custom" ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {PERMISSION_GROUPS.map((g) => (
                  <div key={g.label} className="rounded-md border border-line p-2">
                    <div className="mb-1 text-xs font-medium text-muted">{g.label}</div>
                    {g.permissions.map((p) => (
                      <Checkbox
                        key={p}
                        label={<code className="text-xs">{p}</code>}
                        checked={custom.includes(p)}
                        onChange={(on) => setCustom((list) => toggle(list, p, on))}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Websites</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="token-scope"
                  checked={scope === "all"}
                  onChange={() => setScope("all")}
                  className="accent-[var(--dg-primary)]"
                />
                All my websites
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="token-scope"
                  checked={scope === "some"}
                  onChange={() => setScope("some")}
                  className="accent-[var(--dg-primary)]"
                />
                Only selected websites
              </label>
            </div>
            {scope === "some" ? (
              <div className="space-y-1">
                {websites.map((w) => (
                  <Checkbox
                    key={w._id}
                    label={w.name ?? w.domain}
                    checked={siteIds.includes(w._id)}
                    onChange={(on) => setSiteIds((list) => toggle(list, w._id, on))}
                  />
                ))}
              </div>
            ) : null}
          </fieldset>
          <Checkbox
            label="Include customer names and emails (PII)"
            checked={includePii}
            onChange={setIncludePii}
          />
          {formError ? <Notice tone="error">{formError}</Notice> : null}
          {create.error ? <Notice tone="error">{create.error.message}</Notice> : null}
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create token"}
          </Button>
        </form>
        {tokens.data ? (
          tokens.data.length ? (
            <ul className="divide-y divide-line rounded-md border border-line">
              {tokens.data.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-sm font-medium">{t.name ?? "Unnamed token"}</div>
                    <div className="truncate font-mono text-xs text-muted">{t.displayKey}</div>
                    <div className="flex flex-wrap gap-1">
                      {t.permissions.includes("*") ? (
                        <Badge tone="warning">Full access</Badge>
                      ) : (
                        t.permissions.map((p) => <Badge key={p}>{p}</Badge>)
                      )}
                    </div>
                    <div className="text-xs text-muted">
                      {t.websiteIds.length
                        ? `Websites: ${t.websiteIds.map(siteName).join(", ")}`
                        : "All websites"}{" "}
                      · last used {formatRelative(t.lastUsedAt)}
                      {t.usageCount ? ` · ${formatNumber(t.usageCount)} requests` : ""} ·{" "}
                      {t.expiresAt ? `expires ${formatDate(t.expiresAt)}` : "never expires"}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    className="text-error-text"
                    onClick={() => setRevoking(t)}
                    aria-label={`Revoke ${t.name ?? t.displayKey}`}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No access tokens yet.</p>
          )
        ) : (
          <QueryState query={tokens} />
        )}
      </div>
      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.name ?? "this token"}?`}
        confirmLabel="Revoke token"
        pending={revoke.isPending}
        error={revoke.error}
        onCancel={() => {
          setRevoking(null);
          revoke.reset();
        }}
        onConfirm={() =>
          revoking && revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null) })
        }
      >
        <p>Anything using this token (CLI, MCP clients, scripts) loses access immediately.</p>
      </ConfirmDialog>
    </Card>
  );
}
