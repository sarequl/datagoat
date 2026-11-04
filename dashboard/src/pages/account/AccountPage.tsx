import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useMe } from "../../api/hooks";
import { Button, Card, Input, Notice } from "../../components/ui";
import { formatDate, formatRelative } from "../settings/lib/format";
import {
  useChangePassword,
  useLogoutEverywhere,
  useOAuthConnections,
  useRevokeConnection,
  useUpdateProfile,
} from "../settings/lib/hooks";
import { Badge, ConfirmDialog, Field, PageHeader, QueryState } from "../settings/lib/ui";

/** Account: profile, password, sign out everywhere, websites and connected AI apps. */
export default function AccountPage() {
  const me = useMe();
  const user = me.data?.user;
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Account" description={user?.email} />
      {user ? <ProfileCard name={user.name} email={user.email} /> : null}
      <PasswordCard />
      <SessionsCard />
      <WebsitesCard />
      <ConnectionsCard />
    </div>
  );
}

function ProfileCard({ name, email }: { name: string | null; email: string }) {
  const update = useUpdateProfile();
  const [value, setValue] = useState(name ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate({ name: value.trim() });
  };
  return (
    <Card title="Profile">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Name">
          <Input
            required
            maxLength={100}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <Field label="Email" hint="Your sign-in email. To change it, ask the instance operator.">
          <Input value={email} readOnly />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            disabled={update.isPending || !value.trim() || value.trim() === (name ?? "")}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
          <span aria-live="polite" className="text-sm">
            {update.error ? (
              <span className="text-error-text">{update.error.message}</span>
            ) : update.isSuccess ? (
              <span className="text-success-text">Saved</span>
            ) : null}
          </span>
        </div>
      </form>
    </Card>
  );
}

function PasswordCard() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setError("The new password needs at least 8 characters.");
    if (next !== repeat) return setError("The two new passwords do not match.");
    setError(null);
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setRepeat("");
        },
      },
    );
  };
  return (
    <Card title="Password">
      <form className="grid gap-4 sm:grid-cols-3" onSubmit={submit}>
        <Field label="Current password">
          <Input
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <Input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="Repeat new password">
          <Input
            type="password"
            required
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        <div className="space-y-3 sm:col-span-3">
          {error || change.error ? (
            <Notice tone="error">{error ?? change.error?.message}</Notice>
          ) : null}
          {change.isSuccess ? <Notice tone="success">{change.data.message}</Notice> : null}
          <Button type="submit" disabled={change.isPending}>
            {change.isPending ? "Changing…" : "Change password"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SessionsCard() {
  const logoutAll = useLogoutEverywhere();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <Card title="Sessions">
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Signed in on a shared or lost device? Sign out of every browser at once, including this
          one. API keys and access tokens keep working; revoke them on the API keys page.
        </p>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Sign out everywhere
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title="Sign out everywhere?"
        confirmLabel="Sign out everywhere"
        pending={logoutAll.isPending}
        error={logoutAll.error}
        onCancel={() => setOpen(false)}
        onConfirm={() =>
          logoutAll.mutate(undefined, { onSuccess: () => void navigate({ to: "/login" }) })
        }
      >
        <p>Every dashboard session ends, including this one. You will need to sign in again.</p>
      </ConfirmDialog>
    </Card>
  );
}

function WebsitesCard() {
  const me = useMe();
  const websites = me.data?.websites ?? [];
  return (
    <Card title="Your websites">
      {websites.length ? (
        <ul className="divide-y divide-line">
          {websites.map((w) => (
            <li key={w._id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{w.name ?? w.domain}</span>{" "}
                <span className="text-muted">{w.domain}</span>
              </span>
              <Badge tone={w.role === "owner" ? "primary" : "neutral"}>
                <span className="capitalize">{w.role}</span>
              </Badge>
              <Link
                to="/app/$siteId/settings/general"
                params={{ siteId: w._id }}
                className="text-primary-text underline"
              >
                Settings
              </Link>
              <Link
                to="/app/$siteId/keys"
                params={{ siteId: w._id }}
                hash="tokens"
                className="text-primary-text underline"
              >
                Tokens
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No websites yet.</p>
      )}
      <Link
        to="/app/new-site"
        className="mt-3 inline-flex rounded-md border border-line px-3 py-2 text-sm hover:bg-surface-2"
      >
        Add website
      </Link>
    </Card>
  );
}

function ConnectionsCard() {
  const connections = useOAuthConnections();
  const revoke = useRevokeConnection();
  const [pending, setPending] = useState<string | null>(null);
  return (
    <Card title="Connected AI apps">
      <p className="mb-3 text-sm text-muted">
        Apps you allowed through MCP sign-in, such as Claude or ChatGPT. Revoking ends their access
        at once.
      </p>
      {connections.data ? (
        connections.data.length ? (
          <ul className="divide-y divide-line">
            {connections.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.client.name ?? c.client.id}</div>
                  <div className="text-xs text-muted">
                    {c.scopes.join(", ")} · connected {formatDate(c.createdAt)} · last used{" "}
                    {formatRelative(c.lastUsedAt)} · expires {formatDate(c.expiresAt)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  className="text-error-text"
                  disabled={revoke.isPending}
                  aria-label={`Revoke ${c.client.name ?? c.client.id}`}
                  onClick={() => setPending(c.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No connected apps.</p>
        )
      ) : (
        <QueryState query={connections} />
      )}
      <ConfirmDialog
        open={pending !== null}
        title="Revoke this app?"
        confirmLabel="Revoke"
        pending={revoke.isPending}
        error={revoke.error}
        onCancel={() => setPending(null)}
        onConfirm={() => pending && revoke.mutate(pending, { onSuccess: () => setPending(null) })}
      >
        <p>The app can no longer read your analytics until you connect it again.</p>
      </ConfirmDialog>
    </Card>
  );
}
