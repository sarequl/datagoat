/**
 * MCP OAuth consent (W7). `GET /oauth/authorize` validates the app's request and sends the
 * browser here with a signed `request`; the user signs in if needed, picks websites and
 * permissions, and the decision goes to `POST /oauth/authorize`, which answers with the app's
 * redirect URL (an authorization code, or access_denied).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  OAuthConsentDetails,
  OAuthDecisionRequest,
  OAuthDecisionResult,
  OAuthScopeInfo,
} from "../../../../shared/api-types";
import { ApiClientError, api, apiGet } from "../../api/client";
import { useLogin, useLogout } from "../../api/hooks";
import { Button, Field, Input, Notice, Spinner } from "../../components/ui";

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen justify-center px-4 py-10">
      <div className="w-full max-w-lg space-y-6">
        <div className="space-y-1 text-center">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-lg bg-primary font-bold text-primary-fg">
            D
          </div>
          <h1 className="text-xl font-semibold">{title}</h1>
        </div>
        <div className="space-y-5 rounded-lg border border-line bg-surface p-6">{children}</div>
      </div>
    </main>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: onSignedIn });
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-sm text-muted">Sign in to DataGoat to choose what this app may access.</p>
      {login.error ? <Notice tone="error">{login.error.message}</Notice> : null}
      <Field label="Email">
        <Input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Password">
        <Input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button type="submit" className="w-full" disabled={login.isPending}>
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

function ScopeList({
  title,
  scopes,
  selected,
  toggle,
}: {
  title: string;
  scopes: OAuthScopeInfo[];
  selected: Set<string>;
  toggle: (scope: string) => void;
}) {
  if (scopes.length === 0) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-semibold">{title}</legend>
      {scopes.map((s) => (
        <label key={s.scope} className="flex items-start gap-3 rounded-md p-1 hover:bg-surface-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={selected.has(s.scope)}
            onChange={() => toggle(s.scope)}
          />
          <span className="text-sm">
            <span className="font-medium">{s.label}</span>{" "}
            <code className="text-xs text-muted">{s.scope}</code>
            {s.sensitive ? (
              <span className="ml-2 rounded border border-line px-1 text-xs text-error-text">
                sensitive
              </span>
            ) : null}
            {s.requested ? <span className="ml-2 text-xs text-muted">requested</span> : null}
            <span className="block text-xs text-muted">{s.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function Consent({
  details,
  requestToken,
}: {
  details: OAuthConsentDetails;
  requestToken: string;
}) {
  const qc = useQueryClient();
  const logout = useLogout();
  const [scopes, setScopes] = useState(
    () => new Set(details.scopes.filter((s) => s.defaultChecked).map((s) => s.scope)),
  );
  const [sites, setSites] = useState(() => new Set(details.websites.map((w) => w._id)));
  const decide = useMutation({
    mutationFn: async (body: OAuthDecisionRequest) =>
      (await api.post<OAuthDecisionResult>("/oauth/authorize", body)).data,
    onSuccess: (result) => window.location.assign(result.redirectTo),
  });
  const toggle = (set: Set<string>, update: (s: Set<string>) => void, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    update(next);
  };
  const read = details.scopes.filter((s) => s.access === "read");
  const write = details.scopes.filter((s) => s.access === "write");
  const name = details.client.name ?? "An unnamed app";
  const submit = (approve: boolean) =>
    decide.mutate({
      request: requestToken,
      approve,
      ...(approve ? { scopes: [...scopes], websiteIds: [...sites] } : {}),
    });

  return (
    <Shell title={`Allow ${name} to access DataGoat?`}>
      <div className="space-y-1 text-sm">
        <p>
          <span className="font-medium">{name}</span>{" "}
          <span className="text-muted">(name supplied by the app, not verified)</span> will be sent
          back to <code className="text-xs">{details.client.redirectHost}</code>.
        </p>
        <p className="text-muted">
          Signed in as {details.user?.email}.{" "}
          <button
            type="button"
            className="underline"
            onClick={() =>
              logout.mutate(undefined, {
                onSuccess: () => void qc.invalidateQueries({ queryKey: ["oauth", "consent"] }),
              })
            }
          >
            Not you?
          </button>
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">Websites</legend>
        {details.websites.length === 0 ? (
          <p className="text-sm text-muted">You have no websites yet.</p>
        ) : (
          details.websites.map((w) => (
            <label key={w._id} className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={sites.has(w._id)}
                onChange={() => toggle(sites, setSites, w._id)}
              />
              <span>
                {w.name ?? w.domain}{" "}
                <span className="text-muted">
                  ({w.domain}, {w.role})
                </span>
              </span>
            </label>
          ))
        )}
        {details.websites.length > 0 && sites.size === 0 ? (
          <p className="text-xs text-muted">
            No website selected: only account permissions will work.
          </p>
        ) : null}
      </fieldset>

      <ScopeList
        title="Read"
        scopes={read}
        selected={scopes}
        toggle={(s) => toggle(scopes, setScopes, s)}
      />
      <ScopeList
        title="Change"
        scopes={write}
        selected={scopes}
        toggle={(s) => toggle(scopes, setScopes, s)}
      />

      <p className="text-xs text-muted">
        The app gets a token for this connection only, never your password or API keys. Access
        follows your current role on each website, lasts up to 90 days, and can be revoked at any
        time under Account → Connected apps.
      </p>
      {decide.error ? <Notice tone="error">{decide.error.message}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={decide.isPending} onClick={() => submit(false)}>
          Cancel
        </Button>
        <Button disabled={decide.isPending || scopes.size === 0} onClick={() => submit(true)}>
          {decide.isPending ? "Connecting…" : "Allow access"}
        </Button>
      </div>
    </Shell>
  );
}

export default function OAuthConsentPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestToken = params.get("request") ?? "";
  const error = params.get("error");
  const qc = useQueryClient();
  const details = useQuery({
    queryKey: ["oauth", "consent", requestToken],
    queryFn: () => apiGet<OAuthConsentDetails>("/oauth/consent/details", { request: requestToken }),
    enabled: Boolean(requestToken) && !error,
    retry: false,
  });

  useEffect(() => {
    document.title = "Authorize app · DataGoat";
  }, []);

  if (error || !requestToken) {
    return (
      <Shell title="This app cannot connect">
        <Notice tone="error">
          {params.get("error_description") ??
            "The authorization request is missing. Start again from your app."}
        </Notice>
        {error ? <p className="text-xs text-muted">Error code: {error}</p> : null}
      </Shell>
    );
  }
  if (details.isPending) return <Spinner />;
  if (details.error) {
    const expired = details.error instanceof ApiClientError && details.error.status === 410;
    return (
      <Shell title={expired ? "This request expired" : "This app cannot connect"}>
        <Notice tone="error">{details.error.message}</Notice>
      </Shell>
    );
  }
  if (!details.data.user) {
    return (
      <Shell title={`Connect ${details.data.client.name ?? "an app"} to DataGoat`}>
        <SignIn onSignedIn={() => void qc.invalidateQueries({ queryKey: ["oauth", "consent"] })} />
      </Shell>
    );
  }
  return <Consent details={details.data} requestToken={requestToken} />;
}
